import 'server-only';

import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import {
  enqueueSyncJobInCurrentTransaction,
  isDurableSyncMode,
} from '@/lib/sync/job-queue';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import type { MonarchTransaction } from './client';
import type { ConnectorConfig } from '@/types';
import type { FinanceWorkerPersistence } from '@/db/persistence/finance-worker';
import type { FinanceAttributionFenceMode } from '@/db/persistence/finance-attribution';
import { FINANCE_ATTRIBUTION_WRITE_MAX } from '@/db/persistence/finance-attribution';
import {
  createAttributionRequests,
  createAttributionAccountRef,
  createAttributionSourceRef,
  normalizeAttributionMerchant,
  resolveTyrionAttributionConfig,
  TyrionAttributionClient,
  TyrionAttributionError,
  type TyrionAttributionConfig,
} from './attribution-client';
import {
  TYRION_ATTRIBUTION_CONTRACT_VERSION,
  TYRION_ATTRIBUTION_ENGINE_VERSION,
  TYRION_ATTRIBUTION_PROVENANCE,
  type AttributionBatchItem,
  type AttributionBatchResult,
  type ManualDecision,
} from './attribution-contract';
import {
  createFinanceIdentityNamespace,
} from './identity';
import { ensureFinanceIdentityNamespace } from './identity-sqlite';

type ActorType = 'parent-admin' | 'service';
type ExceptionStatus = 'open' | 'retry_requested' | 'resolved' | 'dismissed';
type ManualAction = 'assign-kid' | 'parent-expense';

interface PersistedAttributionRow {
  id: string;
  upstreamTransactionId: string;
  assignedKidId: string | null;
  kidAssignmentMethod: string | null;
  manualDecisionAction: ManualAction | null;
  manualDecidedAt: string | null;
  sourceFingerprint: string;
  firstSeenAt: string;
}

interface PreparedAttributionItem {
  transactionId: string;
  sourceFingerprint: string;
  item: AttributionBatchItem;
  manualDecision: ManualDecision;
  stateSnapshot: AttributionStateSnapshot;
}

interface AttributionStateSnapshot {
  assignedKidId: string | null;
  kidAssignmentMethod: string | null;
  manualDecisionAction: ManualAction | null;
  manualDecidedAt: string | null;
}

interface AttributionFailure {
  code: string;
  message: string;
  retryable: boolean;
}

interface CoordinatorDependencies {
  config?: TyrionAttributionConfig;
  client?: TyrionAttributionClient;
  financeConfig?: Pick<ConnectorConfig, 'credentials' | 'settings'>;
  persistence?: FinanceWorkerPersistence;
  generationId?: string;
  fenceMode?: FinanceAttributionFenceMode;
}

function localTransactionId(connectorId: string, upstreamTransactionId: string): string {
  return `finance:${connectorId}:${upstreamTransactionId}`;
}

function sanitizedFailure(error: unknown): AttributionFailure {
  if (error instanceof TyrionAttributionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'attribution_service_unavailable',
    message: 'Tyrion attribution service is unavailable',
    retryable: true,
  };
}

function failureReason(code: string): string {
  if (code === 'policy_unavailable') return 'policy-unavailable';
  if (code === 'policy_conflict') return 'policy-version-mismatch';
  return 'engine-unavailable';
}

function failureExplanation(code: string): string {
  if (code === 'policy_unavailable') return 'Tyrion attribution policy is unavailable';
  if (code === 'policy_conflict') return 'Tyrion attribution policy version changed';
  if (code === 'attribution_timeout') return 'Tyrion attribution request timed out';
  if (code === 'attribution_not_configured' || code === 'attribution_auth_not_configured') {
    return 'Tyrion attribution is not configured';
  }
  return 'Tyrion attribution is temporarily unavailable';
}

function manualDecisionFromRow(row: PersistedAttributionRow): ManualDecision {
  if (row.kidAssignmentMethod !== 'manual') return null;
  const rawDecidedAt = row.manualDecidedAt ?? row.firstSeenAt;
  const parsedDecidedAt = Date.parse(rawDecidedAt);
  if (!Number.isFinite(parsedDecidedAt)) {
    throw new TyrionAttributionError(
      'invalid_manual_decision',
      'Stored manual attribution decision is invalid',
      false,
    );
  }
  const decidedAt = new Date(parsedDecidedAt).toISOString();
  if (row.manualDecisionAction === 'parent-expense' || !row.assignedKidId) {
    return { action: 'parent-expense', kidId: null, decidedAt };
  }
  return {
    action: 'assign-kid',
    kidId: row.assignedKidId,
    decidedAt,
  };
}

function attributionStateSnapshot(
  row: PersistedAttributionRow | undefined,
): AttributionStateSnapshot {
  return {
    assignedKidId: row?.assignedKidId ?? null,
    kidAssignmentMethod: row?.kidAssignmentMethod ?? null,
    manualDecisionAction: row?.manualDecisionAction ?? null,
    manualDecidedAt: row?.manualDecidedAt ?? null,
  };
}

function currentRows(
  connectorId: string,
  transactions: MonarchTransaction[],
): Map<string, PersistedAttributionRow> {
  if (transactions.length === 0) return new Map();
  const placeholders = transactions.map(() => '?').join(',');
  const rows = (sqlite.prepare(`
    SELECT id,
           upstream_transaction_id AS upstreamTransactionId,
           assigned_kid_id AS assignedKidId,
           kid_assignment_method AS kidAssignmentMethod,
           manual_decision_action AS manualDecisionAction,
           manual_decided_at AS manualDecidedAt,
           source_fingerprint AS sourceFingerprint,
           first_seen_at AS firstSeenAt
    FROM finance_transactions
    WHERE connector_instance_id = ?
      AND upstream_transaction_id IN (${placeholders})
  `).all(
    connectorId,
    ...transactions.map((transaction) => transaction.id),
  )) as PersistedAttributionRow[];
  return new Map(rows.map((row) => [row.upstreamTransactionId, row]));
}

function prepareItems(
  config: TyrionAttributionConfig,
  connectorId: string,
  transactions: MonarchTransaction[],
  observedAt: string,
  rows: Map<string, PersistedAttributionRow>,
): PreparedAttributionItem[] {
  return transactions.map((transaction) => {
    const row = rows.get(transaction.id);
    if (!row) {
      throw new TyrionAttributionError(
        'attribution_projection_missing',
        'Finance attribution projection is unavailable',
        false,
      );
    }
    const manualDecision = manualDecisionFromRow(row);
    return {
      transactionId: row.id,
      sourceFingerprint: row.sourceFingerprint,
      manualDecision,
      stateSnapshot: attributionStateSnapshot(row),
      item: {
        sourceRef: createAttributionSourceRef(config, connectorId, transaction.id),
        occurredOn: transaction.date,
        merchantName: normalizeAttributionMerchant(transaction.merchant.name),
        accountRef: createAttributionAccountRef(config, transaction.account.id),
        observedAt,
        existingManualDecision: manualDecision,
      },
    };
  });
}

function upsertException(
  connectorId: string,
  transactionId: string,
  sourceRef: string | null,
  sourceFingerprint: string,
  reasonCode: string,
  retryable: boolean,
  policyVersion: number | null,
  now: string,
): 'pending' | 'resolved' {
  const existing = sqlite.prepare(`
    SELECT id, status, reason_code AS reasonCode,
           source_fingerprint AS sourceFingerprint,
           policy_version AS policyVersion
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND transaction_id = ?
  `).get(connectorId, transactionId) as
    | {
        id: string;
        status: ExceptionStatus;
        reasonCode: string;
        sourceFingerprint: string;
        policyVersion: number | null;
      }
    | undefined;
  if (!existing) {
    sqlite.prepare(`
      INSERT INTO finance_attribution_exceptions (
        id, connector_id, transaction_id, source_ref, status, reason_code,
        retryable, review_state, source_fingerprint, policy_version,
        occurrence_count, created_at, first_observed_at, last_observed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, 'pending', ?, ?, 1, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      connectorId,
      transactionId,
      sourceRef,
      reasonCode,
      retryable ? 1 : 0,
      sourceFingerprint,
      policyVersion,
      now,
      now,
      now,
      now,
    );
    return 'pending';
  }
  const unchanged = existing.reasonCode === reasonCode
    && existing.sourceFingerprint === sourceFingerprint
    && existing.policyVersion === policyVersion;
  const preserveResolution = unchanged
    && (existing.status === 'resolved' || existing.status === 'dismissed');
  sqlite.prepare(`
    UPDATE finance_attribution_exceptions
    SET source_ref = COALESCE(?, source_ref), status = ?, reason_code = ?, retryable = ?,
        review_state = ?, source_fingerprint = ?, policy_version = ?,
        occurrence_count = occurrence_count + 1, last_observed_at = ?,
        resolution = CASE WHEN ? THEN resolution ELSE NULL END,
        resolved_at = CASE WHEN ? THEN resolved_at ELSE NULL END,
        updated_at = ?
    WHERE id = ?
  `).run(
    sourceRef,
    preserveResolution ? existing.status : 'open',
    reasonCode,
    retryable ? 1 : 0,
    preserveResolution ? 'resolved' : 'pending',
    sourceFingerprint,
    policyVersion,
    now,
    preserveResolution ? 1 : 0,
    preserveResolution ? 1 : 0,
    now,
    existing.id,
  );
  return preserveResolution ? 'resolved' : 'pending';
}

function preserveClosedTransactionReview(
  connectorId: string,
  transactionId: string,
  reviewState: 'pending' | 'resolved',
  now: string,
): void {
  if (reviewState !== 'resolved') return;
  sqlite.prepare(`
    UPDATE finance_transactions
    SET attribution_review_state = 'resolved', attribution_updated_at = ?
    WHERE id = ? AND connector_instance_id = ?
  `).run(now, transactionId, connectorId);
}

function resolveCurrentException(
  connectorId: string,
  transactionId: string,
  now: string,
): void {
  sqlite.prepare(`
    UPDATE finance_attribution_exceptions
    SET status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE 'resolved' END,
        review_state = 'resolved',
        resolution = CASE WHEN status = 'dismissed' THEN resolution ELSE 'reattributed' END,
        resolved_at = COALESCE(resolved_at, ?),
        updated_at = ?
    WHERE connector_id = ? AND transaction_id = ?
  `).run(now, now, connectorId, transactionId);
}

function persistUnavailable(
  connectorId: string,
  items: Array<{
    transactionId: string;
    sourceFingerprint: string;
    sourceRef: string | null;
    stateSnapshot: AttributionStateSnapshot;
  }>,
  failure: AttributionFailure,
  now: string,
): void {
  const reason = failureReason(failure.code);
  const explanation = failureExplanation(failure.code);
  sqlite.transaction(() => {
    const currentNonManual = sqlite.prepare(`
      SELECT 1 FROM finance_transactions
      WHERE id = ? AND connector_instance_id = ?
        AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
    `);
    const currentManual = sqlite.prepare(`
      SELECT 1 FROM finance_transactions
      WHERE id = ? AND connector_instance_id = ?
        AND kid_assignment_method = 'manual'
        AND manual_decision_action IS ?
        AND manual_decided_at IS ?
        AND assigned_kid_id IS ?
    `);
    const update = sqlite.prepare(`
      UPDATE finance_transactions
      SET attribution_source_ref = COALESCE(?, attribution_source_ref),
          attribution_contract_version = ?,
          attribution_status = 'unavailable',
          attribution_confidence = 'none',
          attribution_method = 'unavailable',
          attribution_explanation = ?,
          attribution_reasons = ?,
          attribution_decision_source = 'fallback',
          attribution_review_state = 'pending',
          attribution_provenance = ?,
          attribution_last_error_code = ?,
          attribution_retryable = ?,
          attribution_updated_at = ?
      WHERE id = ? AND connector_instance_id = ?
        AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
    `);
    for (const item of items) {
      const snapshotStillCurrent = item.stateSnapshot.kidAssignmentMethod === 'manual'
        ? currentManual.get(
          item.transactionId,
          connectorId,
          item.stateSnapshot.manualDecisionAction,
          item.stateSnapshot.manualDecidedAt,
          item.stateSnapshot.assignedKidId,
        )
        : currentNonManual.get(item.transactionId, connectorId);
      if (!snapshotStillCurrent) continue;
      if (item.stateSnapshot.kidAssignmentMethod !== 'manual') {
        update.run(
          item.sourceRef,
          TYRION_ATTRIBUTION_CONTRACT_VERSION,
          explanation,
          JSON.stringify([reason]),
          TYRION_ATTRIBUTION_PROVENANCE,
          failure.code,
          failure.retryable ? 1 : 0,
          now,
          item.transactionId,
          connectorId,
        );
      }
      const reviewState = upsertException(
        connectorId,
        item.transactionId,
        item.sourceRef,
        item.sourceFingerprint,
        failure.code,
        failure.retryable,
        null,
        now,
      );
      preserveClosedTransactionReview(
        connectorId,
        item.transactionId,
        reviewState,
        now,
      );
    }
  }).immediate();
}

function manualResultMatches(
  decision: ManualDecision,
  result: AttributionBatchResult,
): boolean {
  if (!decision) return true;
  if (result.method !== 'manual' || result.decisionSource !== 'manual') return false;
  if (decision.action === 'assign-kid') {
    return result.status === 'attributed' && result.kidId === decision.kidId;
  }
  return result.status === 'unassigned' && result.kidId === null;
}

function applyResults(
  connectorId: string,
  items: PreparedAttributionItem[],
  results: AttributionBatchResult[],
  now: string,
): void {
  sqlite.transaction(() => {
    const updateAutomated = sqlite.prepare(`
      UPDATE finance_transactions
      SET assigned_kid_id = ?, kid_assignment_method = ?,
          attribution_source_ref = ?, attribution_contract_version = ?,
          attribution_status = ?, attribution_confidence = ?,
          attribution_method = ?, attribution_explanation = ?,
          attribution_reasons = ?, attribution_decision_source = ?,
          attribution_policy_version = ?, attribution_engine_version = ?,
          attribution_evaluated_at = ?, attribution_review_state = ?,
          attribution_provenance = ?, attribution_last_error_code = NULL,
          attribution_retryable = 0, attribution_updated_at = ?,
          triage_status = ?
      WHERE id = ? AND connector_instance_id = ?
        AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
    `);
    const updateManual = sqlite.prepare(`
      UPDATE finance_transactions
      SET attribution_source_ref = ?, attribution_contract_version = ?,
          attribution_status = ?, attribution_confidence = ?,
          attribution_method = ?, attribution_explanation = ?,
          attribution_reasons = ?, attribution_decision_source = ?,
          attribution_policy_version = ?, attribution_engine_version = ?,
          attribution_evaluated_at = ?, attribution_review_state = ?,
          attribution_provenance = ?, attribution_last_error_code = NULL,
          attribution_retryable = 0, attribution_updated_at = ?
      WHERE id = ? AND connector_instance_id = ?
        AND kid_assignment_method = 'manual'
        AND manual_decision_action IS ?
        AND manual_decided_at IS ?
        AND assigned_kid_id IS ?
    `);
    const upsertSubject = sqlite.prepare(`
      INSERT INTO finance_attribution_subjects (
        id, connector_id, kid_id, policy_version, engine_version,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, kid_id) DO UPDATE SET
        policy_version = excluded.policy_version,
        engine_version = excluded.engine_version,
        last_seen_at = excluded.last_seen_at
    `);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const result = results[index];
      if (!manualResultMatches(item.manualDecision, result)) {
        const conflictUpdate = sqlite.prepare(`
          UPDATE finance_transactions
          SET attribution_source_ref = ?, attribution_contract_version = ?,
              attribution_status = 'pending', attribution_confidence = 'none',
              attribution_method = 'manual',
              attribution_explanation = 'Manual decision requires policy review',
              attribution_reasons = '["policy-version-mismatch"]',
              attribution_decision_source = 'manual',
              attribution_policy_version = ?, attribution_engine_version = ?,
              attribution_evaluated_at = ?, attribution_review_state = 'pending',
              attribution_provenance = ?, attribution_last_error_code = ?,
              attribution_retryable = 0, attribution_updated_at = ?
          WHERE id = ? AND connector_instance_id = ?
            AND kid_assignment_method = 'manual'
            AND manual_decision_action IS ?
            AND manual_decided_at IS ?
            AND assigned_kid_id IS ?
        `).run(
          item.item.sourceRef,
          result.contractVersion,
          result.policyVersion,
          result.engineVersion,
          result.evaluatedAt,
          TYRION_ATTRIBUTION_PROVENANCE,
          'manual_decision_conflict',
          now,
          item.transactionId,
          connectorId,
          item.stateSnapshot.manualDecisionAction,
          item.stateSnapshot.manualDecidedAt,
          item.stateSnapshot.assignedKidId,
        );
        if (conflictUpdate.changes === 0) continue;
        const reviewState = upsertException(
          connectorId,
          item.transactionId,
          item.item.sourceRef,
          item.sourceFingerprint,
          'manual_decision_conflict',
          false,
          result.policyVersion,
          now,
        );
        preserveClosedTransactionReview(
          connectorId,
          item.transactionId,
          reviewState,
          now,
        );
        continue;
      }
      const values = [
        item.item.sourceRef,
        result.contractVersion,
        result.status,
        result.confidence,
        result.method,
        result.explanation,
        JSON.stringify(result.reasons),
        result.decisionSource,
        result.policyVersion,
        result.engineVersion,
        result.evaluatedAt,
        result.reviewStatus,
        TYRION_ATTRIBUTION_PROVENANCE,
        now,
      ] as const;
      const updateResult = item.manualDecision
        ? updateManual.run(
          ...values,
          item.transactionId,
          connectorId,
          item.stateSnapshot.manualDecisionAction,
          item.stateSnapshot.manualDecidedAt,
          item.stateSnapshot.assignedKidId,
        )
        : updateAutomated.run(
          result.kidId,
          result.method,
          ...values,
          result.reviewStatus === 'pending' ? 'pending' : 'confirmed',
          item.transactionId,
          connectorId,
        );
      if (updateResult.changes === 0) {
        continue;
      }
      if (result.kidId) {
        upsertSubject.run(
          randomUUID(),
          connectorId,
          result.kidId,
          result.policyVersion,
          result.engineVersion,
          now,
          now,
        );
      }
      if (result.reviewStatus === 'pending' || result.status === 'pending') {
        const reviewState = upsertException(
          connectorId,
          item.transactionId,
          item.item.sourceRef,
          item.sourceFingerprint,
          result.reasons[0] ?? 'review-required',
          false,
          result.policyVersion,
          now,
        );
        preserveClosedTransactionReview(
          connectorId,
          item.transactionId,
          reviewState,
          now,
        );
      } else {
        resolveCurrentException(connectorId, item.transactionId, now);
      }
    }
  }).immediate();
}

export class FinanceAttributionCoordinator {
  private config: TyrionAttributionConfig | null = null;
  private client: TyrionAttributionClient | null = null;
  private policyFence: number | null = null;
  private terminalFailure: AttributionFailure | null = null;
  private attempted = false;
  private succeeded = false;
  private readonly financeConfig: Pick<ConnectorConfig, 'credentials' | 'settings'>;
  private readonly persistence: FinanceWorkerPersistence | null;
  private readonly generationId: string | null;
  private readonly fenceMode: FinanceAttributionFenceMode;

  constructor(
    private readonly connectorId: string,
    dependencies: CoordinatorDependencies = {},
  ) {
    this.financeConfig = dependencies.financeConfig ?? { credentials: {}, settings: {} };
    this.persistence = dependencies.persistence ?? null;
    this.generationId = dependencies.generationId ?? null;
    this.fenceMode = dependencies.fenceMode ?? 'snapshot';
    if (this.persistence && !this.generationId) {
      throw new Error('Finance attribution persistence requires a snapshot generation');
    }
    if (dependencies.config) {
      this.config = dependencies.config;
      this.policyFence = dependencies.config.expectedPolicyVersion;
    }
    if (dependencies.client) {
      this.client = dependencies.client;
      this.config = dependencies.client.config;
      this.policyFence = dependencies.client.config.expectedPolicyVersion;
    }
  }

  async attributePage(
    transactions: MonarchTransaction[],
    observedAt: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (transactions.length === 0) return;
    const rows = this.persistence
      ? await this.persistence.attribution.readRows(
        this.connectorId,
        transactions.map((transaction) => transaction.id),
      )
      : currentRows(this.connectorId, transactions);
    if (this.terminalFailure) {
      await this.persistUnavailable(
        transactions.map((transaction) => {
          const row = rows.get(transaction.id);
          return {
            transactionId: row?.id ?? localTransactionId(this.connectorId, transaction.id),
            sourceFingerprint: row?.sourceFingerprint ?? '',
            sourceRef: this.config
              ? createAttributionSourceRef(this.config, this.connectorId, transaction.id)
              : null,
            stateSnapshot: attributionStateSnapshot(row),
          };
        }),
        this.terminalFailure,
        new Date().toISOString(),
      );
      return;
    }
    let prepared: PreparedAttributionItem[];
    try {
      if (!this.config) {
        const identityNamespace = this.persistence
          ? await this.persistence.identity.ensureNamespace({
            connectorId: this.connectorId,
            candidate: createFinanceIdentityNamespace(),
            updatedAt: new Date().toISOString(),
          })
          : ensureFinanceIdentityNamespace(this.connectorId);
        this.config = resolveTyrionAttributionConfig({
          credentials: {
            ...(this.financeConfig.credentials ?? {}),
            identityNamespace,
          },
        });
      }
      if (!this.client) this.client = new TyrionAttributionClient(this.config);
      if (this.policyFence === null) {
        this.policyFence = this.config.expectedPolicyVersion;
      }
      prepared = prepareItems(
        this.config,
        this.connectorId,
        transactions,
        observedAt,
        rows,
      );
    } catch (error) {
      this.attempted = true;
      this.terminalFailure = sanitizedFailure(error);
      await this.persistUnavailable(
        transactions.map((transaction) => {
          const row = rows.get(transaction.id);
          return {
            transactionId: row?.id ?? localTransactionId(this.connectorId, transaction.id),
            sourceFingerprint: row?.sourceFingerprint ?? '',
            sourceRef: null,
            stateSnapshot: attributionStateSnapshot(row),
          };
        }),
        this.terminalFailure,
        new Date().toISOString(),
      );
      return;
    }

    let offset = 0;
    while (offset < prepared.length) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
      }
      const remaining = prepared.slice(offset);
      const request = createAttributionRequests(
        remaining.map((entry) => entry.item),
        this.policyFence,
      )[0];
      const batch = prepared.slice(offset, offset + request.items.length);
      this.attempted = true;
      try {
        const response = await this.client.attribute(request, signal);
        const appliedAt = new Date().toISOString();
        if (this.persistence) {
          await this.persistence.attribution.applyResults({
            connectorId: this.connectorId,
            generationId: this.generationId!,
            fenceMode: this.fenceMode,
            now: appliedAt,
            provenance: TYRION_ATTRIBUTION_PROVENANCE,
            items: batch.map((item, index) => ({
              transactionId: item.transactionId,
              sourceFingerprint: item.sourceFingerprint,
              sourceRef: item.item.sourceRef,
              stateSnapshot: item.stateSnapshot,
              hasManualDecision: item.manualDecision !== null,
              manualResultMatches: manualResultMatches(
                item.manualDecision,
                response.results[index],
              ),
              result: response.results[index],
            })),
          });
        } else {
          applyResults(
            this.connectorId,
            batch,
            response.results,
            appliedAt,
          );
        }
        this.succeeded = true;
        offset += request.items.length;
      } catch (error) {
        if (signal?.aborted) throw error;
        this.terminalFailure = sanitizedFailure(error);
        await this.persistUnavailable(
          prepared.slice(offset).map((entry) => ({
            transactionId: entry.transactionId,
            sourceFingerprint: entry.sourceFingerprint,
            sourceRef: entry.item.sourceRef,
            stateSnapshot: entry.stateSnapshot,
          })),
          this.terminalFailure,
          new Date().toISOString(),
        );
        return;
      }
    }
  }

  private async persistUnavailable(
    items: Array<{
      transactionId: string;
      sourceFingerprint: string;
      sourceRef: string | null;
      stateSnapshot: AttributionStateSnapshot;
    }>,
    failure: AttributionFailure,
    now: string,
  ): Promise<void> {
    if (!this.persistence) {
      persistUnavailable(this.connectorId, items, failure, now);
      return;
    }
    for (let offset = 0; offset < items.length; offset += FINANCE_ATTRIBUTION_WRITE_MAX) {
      await this.persistence.attribution.persistUnavailable({
        connectorId: this.connectorId,
        generationId: this.generationId!,
        fenceMode: this.fenceMode,
        now,
        items: items.slice(offset, offset + FINANCE_ATTRIBUTION_WRITE_MAX),
        failure: {
          code: failure.code,
          retryable: failure.retryable,
          reason: failureReason(failure.code),
          explanation: failureExplanation(failure.code),
        },
        contractVersion: TYRION_ATTRIBUTION_CONTRACT_VERSION,
        provenance: TYRION_ATTRIBUTION_PROVENANCE,
      });
    }
  }

  async finish(now: string): Promise<void> {
    if (!this.attempted) return;
    const unavailableCodes = new Set([
      'attribution_not_configured',
      'attribution_auth_not_configured',
      'attribution_auth_required',
      'attribution_auth_invalid',
      'attribution_forbidden',
      'attribution_route_not_available',
      'attribution_timeout',
      'attribution_service_unavailable',
      'policy_unavailable',
    ]);
    const status = this.terminalFailure
      ? unavailableCodes.has(this.terminalFailure.code) ? 'unavailable' : 'degraded'
      : 'healthy';
    if (this.persistence && this.generationId) {
      await this.persistence.attribution.finish({
        connectorId: this.connectorId,
        generationId: this.generationId,
        fenceMode: this.fenceMode,
        attemptedAt: now,
        succeeded: this.succeeded,
        terminalFailureCode: this.terminalFailure?.code ?? null,
        status,
        policyVersion: this.policyFence,
        engineVersion: TYRION_ATTRIBUTION_ENGINE_VERSION,
      });
      return;
    }
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET attribution_status = ?,
          attribution_last_attempt_at = ?,
          attribution_last_successful_at = CASE WHEN ? THEN ? ELSE attribution_last_successful_at END,
          attribution_last_error_code = ?,
          attribution_policy_version = COALESCE(?, attribution_policy_version),
          attribution_engine_version = CASE WHEN ? THEN ? ELSE attribution_engine_version END,
          updated_at = ?
      WHERE connector_id = ?
    `).run(
      status,
      now,
      this.succeeded && !this.terminalFailure ? 1 : 0,
      now,
      this.terminalFailure?.code ?? null,
      this.policyFence,
      this.succeeded ? 1 : 0,
      TYRION_ATTRIBUTION_ENGINE_VERSION,
      now,
      this.connectorId,
    );
  }
}

export class FinanceAttributionMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FinanceAttributionMutationError';
  }
}

function requireIdempotencyKey(value: string | null): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new FinanceAttributionMutationError(
      'invalid_idempotency_key',
      'A valid Idempotency-Key header is required',
      400,
    );
  }
  return key;
}

function requireFinanceConnector(connectorId: string): void {
  const connector = sqlite.prepare(`
    SELECT 1 FROM connector_configs
    WHERE id = ? AND type IN (${FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ')})
      AND enabled = 1 AND deleted_at IS NULL
  `).get(connectorId, ...FINANCE_PROVIDER_ALIASES);
  if (!connector) {
    throw new FinanceAttributionMutationError(
      'connector_not_found',
      'Finance connector was not found',
      404,
    );
  }
}

interface ManualDecisionInput {
  connectorId: string;
  transactionId: string;
  action: ManualAction;
  kidId: string | null;
  idempotencyKey: string | null;
  expectedExceptionUpdatedAt?: string;
  actorType: ActorType;
  exceptionId?: string | null;
  auditAction?: 'approve' | 'manual-resolve';
  expectedTransactionVersion?: {
    sourceFingerprint: string;
    lastSeenAt: string;
    assignedKidId: string | null;
    confirmedCategory: string | null;
    manualDecidedAt: string | null;
  };
}

interface AttributionActionAudit {
  transactionId: string;
  exceptionId: string | null;
  action: string;
  requestedKidId: string | null;
  requestedDecision: ManualAction | null;
  resultStatus: string;
}

function findAttributionActionAudit(
  connectorId: string,
  idempotencyKey: string,
): AttributionActionAudit | undefined {
  return sqlite.prepare(`
    SELECT transaction_id AS transactionId, exception_id AS exceptionId,
           action, requested_kid_id AS requestedKidId,
           requested_decision AS requestedDecision,
           result_status AS resultStatus
    FROM finance_attribution_audit
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as AttributionActionAudit | undefined;
}

function idempotencyConflict(message: string): never {
  throw new FinanceAttributionMutationError('idempotency_conflict', message, 409);
}

export function applyManualAttributionDecision(input: ManualDecisionInput): {
  status: 'resolved';
  transactionId: string;
  kidId: string | null;
  idempotencyKey: string;
  replayed: boolean;
} {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const existingAudit = findAttributionActionAudit(input.connectorId, idempotencyKey);
  if (existingAudit) {
    if (
      existingAudit.transactionId !== input.transactionId
      || existingAudit.requestedKidId !== input.kidId
      || existingAudit.requestedDecision !== input.action
      || existingAudit.action !== (input.auditAction ?? 'manual-resolve')
    ) {
      idempotencyConflict('Idempotency key was already used for another decision');
    }
    return {
      status: 'resolved',
      transactionId: input.transactionId,
      kidId: input.kidId,
      idempotencyKey,
      replayed: true,
    };
  }
  requireFinanceConnector(input.connectorId);
  if (
    input.action === 'assign-kid'
    && (!input.kidId || !identifier(input.kidId))
  ) {
    throw new FinanceAttributionMutationError(
      'invalid_manual_decision',
      'A valid Tyrion kid identifier is required',
      400,
    );
  }
  if (input.action === 'parent-expense' && input.kidId !== null) {
    throw new FinanceAttributionMutationError(
      'invalid_manual_decision',
      'Parent expense decisions cannot include a kid identifier',
      400,
    );
  }
  const now = new Date().toISOString();
  const replayed = sqlite.transaction(() => {
    const concurrentAudit = findAttributionActionAudit(input.connectorId, idempotencyKey);
    if (concurrentAudit) {
      if (
        concurrentAudit.transactionId !== input.transactionId
        || concurrentAudit.requestedKidId !== input.kidId
        || concurrentAudit.requestedDecision !== input.action
        || concurrentAudit.action !== (input.auditAction ?? 'manual-resolve')
      ) {
        idempotencyConflict('Idempotency key was already used for another decision');
      }
      return true;
    }
    const transaction = sqlite.prepare(`
      SELECT id, source_fingerprint AS sourceFingerprint,
             last_seen_at AS lastSeenAt, assigned_kid_id AS assignedKidId,
             confirmed_category AS confirmedCategory,
             manual_decided_at AS manualDecidedAt
      FROM finance_transactions
      WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
    `).get(input.transactionId, input.connectorId) as
      | {
          id: string;
          sourceFingerprint: string;
          lastSeenAt: string;
          assignedKidId: string | null;
          confirmedCategory: string | null;
          manualDecidedAt: string | null;
        }
      | undefined;
    if (!transaction) {
      throw new FinanceAttributionMutationError(
        'transaction_not_found',
        'Finance transaction was not found',
        404,
      );
    }
    const expectedVersion = input.expectedTransactionVersion;
    if (
      expectedVersion
      && (
        transaction.sourceFingerprint !== expectedVersion.sourceFingerprint
        || transaction.lastSeenAt !== expectedVersion.lastSeenAt
        || transaction.assignedKidId !== expectedVersion.assignedKidId
        || transaction.confirmedCategory !== expectedVersion.confirmedCategory
        || transaction.manualDecidedAt !== expectedVersion.manualDecidedAt
      )
    ) {
      throw new FinanceAttributionMutationError(
        'transaction_conflict',
        'Finance transaction changed after approval',
        409,
      );
    }
    if (input.action === 'assign-kid') {
      const projected = sqlite.prepare(`
        SELECT 1
        FROM finance_attribution_subjects subjects
        INNER JOIN finance_sync_state state
          ON state.connector_id = subjects.connector_id
          AND state.attribution_policy_version = subjects.policy_version
        WHERE subjects.connector_id = ? AND subjects.kid_id = ?
      `).get(input.connectorId, input.kidId);
      if (!projected) {
        throw new FinanceAttributionMutationError(
          'unknown_attribution_subject',
          'Kid identifier is not present in the current Tyrion projection',
          409,
        );
      }
    }
    if (input.exceptionId) {
      const currentException = sqlite.prepare(`
        SELECT status, updated_at AS updatedAt
        FROM finance_attribution_exceptions
        WHERE id = ? AND connector_id = ? AND transaction_id = ?
      `).get(input.exceptionId, input.connectorId, input.transactionId) as
        | { status: string; updatedAt: string }
        | undefined;
      if (!currentException || !['open', 'retry_requested'].includes(currentException.status)) {
        throw new FinanceAttributionMutationError(
          'exception_conflict',
          'This exception was already resolved by a newer decision',
          409,
        );
      }
      if (currentException.updatedAt !== input.expectedExceptionUpdatedAt) {
        throw new FinanceAttributionMutationError(
          'exception_conflict',
          'This exception changed after it was loaded',
          409,
        );
      }
      if (
        transaction.manualDecidedAt
        && Date.parse(transaction.manualDecidedAt) > Date.parse(currentException.updatedAt)
      ) {
        throw new FinanceAttributionMutationError(
          'manual_decision_superseded',
          'A newer manual decision already exists',
          409,
        );
      }
    }
    sqlite.prepare(`
      UPDATE finance_transactions
      SET assigned_kid_id = ?, kid_assignment_method = 'manual',
          manual_decision_action = ?, manual_decided_at = ?,
          attribution_status = ?, attribution_confidence = 'definite',
          attribution_method = 'manual',
          attribution_explanation = 'Confirmed by parent administrator',
          attribution_reasons = '[]', attribution_decision_source = 'manual',
          attribution_evaluated_at = ?, attribution_review_state = 'resolved',
          attribution_provenance = 'mission-control-manual-v1',
          attribution_last_error_code = NULL, attribution_retryable = 0,
          attribution_updated_at = ?, triage_status = 'confirmed'
      WHERE id = ? AND connector_instance_id = ?
    `).run(
      input.kidId,
      input.action,
      now,
      input.action === 'assign-kid' ? 'attributed' : 'unassigned',
      now,
      now,
      input.transactionId,
      input.connectorId,
    );
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'resolved', review_state = 'resolved',
          resolution = ?, resolved_at = ?, updated_at = ?
      WHERE connector_id = ? AND transaction_id = ?
        AND (? IS NULL OR id = ?)
    `).run(
      input.auditAction === 'approve' ? 'approved' : 'manual',
      now,
      now,
      input.connectorId,
      input.transactionId,
      input.exceptionId ?? null,
      input.exceptionId ?? null,
    );
    sqlite.prepare(`
      INSERT INTO finance_attribution_audit (
        id, connector_id, transaction_id, exception_id, idempotency_key,
        action, actor_type, requested_kid_id, requested_decision,
        result_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?)
    `).run(
      randomUUID(),
      input.connectorId,
      input.transactionId,
      input.exceptionId ?? null,
      idempotencyKey,
      input.auditAction ?? 'manual-resolve',
      input.actorType,
      input.kidId,
      input.action,
      now,
    );
    return false;
  }).immediate();
  return {
    status: 'resolved',
    transactionId: input.transactionId,
    kidId: input.kidId,
    idempotencyKey,
    replayed,
  };
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString('base64url');
}

function decodeCursor(value: string | null): { updatedAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const updatedAt = (parsed as { updatedAt?: unknown } | null)?.updatedAt;
    const id = (parsed as { id?: unknown } | null)?.id;
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof updatedAt === 'string'
      && updatedAt.length >= 20
      && updatedAt.length <= 35
      && Number.isFinite(Date.parse(updatedAt))
      && typeof id === 'string'
      && id.length >= 1
      && id.length <= 128
    ) {
      return { updatedAt, id };
    }
  } catch {
    // Rejected below.
  }
  throw new FinanceAttributionMutationError(
    'invalid_cursor',
    'Attribution exception cursor is invalid',
    400,
  );
}

export function listAttributionExceptions(
  connectorId: string,
  input: { status?: string | null; limit?: string | null; cursor?: string | null },
): { exceptions: unknown[]; nextCursor: string | null; subjects: unknown[] } {
  requireFinanceConnector(connectorId);
  const status = input.status ?? 'current';
  if (!['current', 'open', 'retry_requested', 'resolved', 'dismissed', 'all'].includes(status)) {
    throw new FinanceAttributionMutationError(
      'invalid_status',
      'Attribution exception status is invalid',
      400,
    );
  }
  const parsedLimit = Number(input.limit ?? 50);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw new FinanceAttributionMutationError(
      'invalid_limit',
      'Attribution exception limit must be from 1 to 100',
      400,
    );
  }
  const cursor = decodeCursor(input.cursor ?? null);
  const conditions = [
    'e.connector_id = ?',
    ...(status === 'all'
      ? []
      : status === 'current'
        ? [`e.status IN ('open', 'retry_requested')`]
        : ['e.status = ?']),
    ...(cursor ? ['(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))'] : []),
  ];
  const parameters: Array<string | number> = [
    connectorId,
    ...(status === 'all' || status === 'current' ? [] : [status]),
    ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
    parsedLimit + 1,
  ];
  const rows = sqlite.prepare(`
    SELECT e.id, e.status,
           e.reason_code AS reasonCode, e.retryable, e.review_state AS reviewState,
           e.policy_version AS policyVersion,
           e.occurrence_count AS occurrenceCount,
           e.first_observed_at AS firstObservedAt,
           e.last_observed_at AS lastObservedAt, e.updated_at AS updatedAt,
           t.date, t.merchant_name AS merchantName,
           t.assigned_kid_id AS assignedKidId,
           t.attribution_status AS attributionStatus,
           t.attribution_confidence AS confidence,
           t.attribution_method AS method,
           t.attribution_explanation AS explanation,
           t.attribution_reasons AS reasons,
           t.attribution_decision_source AS decisionSource,
           t.attribution_engine_version AS engineVersion,
           t.attribution_evaluated_at AS evaluatedAt
    FROM finance_attribution_exceptions e
    INNER JOIN finance_transactions t
      ON t.id = e.transaction_id
      AND t.connector_instance_id = e.connector_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.updated_at DESC, e.id DESC
    LIMIT ?
  `).all(...parameters) as Array<Record<string, unknown> & {
    id: string;
    updatedAt: string;
    reasons: string;
  }>;
  const hasMore = rows.length > parsedLimit;
  const page = hasMore ? rows.slice(0, parsedLimit) : rows;
  const subjects = sqlite.prepare(`
    SELECT subjects.kid_id AS kidId,
           COALESCE(NULLIF(profiles.name, ''), 'Household member') AS name
    FROM finance_attribution_subjects subjects
    INNER JOIN finance_sync_state state
      ON state.connector_id = subjects.connector_id
      AND state.attribution_policy_version = subjects.policy_version
    LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
    WHERE subjects.connector_id = ?
    ORDER BY name, subjects.kid_id
  `).all(connectorId);
  return {
    exceptions: page.map((row) => ({
      ...row,
      retryable: row.retryable === 1,
      reasons: JSON.parse(row.reasons),
    })),
    nextCursor: hasMore
      ? encodeCursor(page[page.length - 1].updatedAt, page[page.length - 1].id)
      : null,
    subjects,
  };
}

export function actOnAttributionException(input: {
  connectorId: string;
  exceptionId: string;
  action: 'approve' | 'manual-resolve' | 'dismiss' | 'retry';
  kidId?: string | null;
  expectedUpdatedAt: string;
  idempotencyKey: string | null;
  actorType: ActorType;
}): {
  status: string;
  exceptionId: string;
  idempotencyKey: string;
  replayed: boolean;
} {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const existingAudit = findAttributionActionAudit(input.connectorId, idempotencyKey);
  if (existingAudit) {
    const requestedKidId = input.action === 'manual-resolve' ? input.kidId ?? null : null;
    if (
      existingAudit.exceptionId !== input.exceptionId
      || existingAudit.action !== input.action
      || (input.action === 'manual-resolve' && existingAudit.requestedKidId !== requestedKidId)
    ) {
      idempotencyConflict('Idempotency key was already used for another action');
    }
    return {
      status: existingAudit.resultStatus,
      exceptionId: input.exceptionId,
      idempotencyKey,
      replayed: true,
    };
  }
  requireFinanceConnector(input.connectorId);
  const exception = sqlite.prepare(`
    SELECT e.id, e.transaction_id AS transactionId, e.status, e.retryable,
           e.updated_at AS updatedAt,
           t.assigned_kid_id AS assignedKidId,
           t.manual_decided_at AS manualDecidedAt
    FROM finance_attribution_exceptions e
    INNER JOIN finance_transactions t
      ON t.id = e.transaction_id
      AND t.connector_instance_id = e.connector_id
    WHERE e.id = ? AND e.connector_id = ?
  `).get(input.exceptionId, input.connectorId) as
    | {
        id: string;
        transactionId: string;
        status: string;
        retryable: number;
        updatedAt: string;
        assignedKidId: string | null;
        manualDecidedAt: string | null;
      }
    | undefined;
  if (!exception) {
    throw new FinanceAttributionMutationError(
      'exception_not_found',
      'Attribution exception was not found',
      404,
    );
  }
  if (input.action === 'approve' || input.action === 'manual-resolve') {
    const kidId = input.action === 'approve'
      ? exception.assignedKidId
      : input.kidId ?? null;
    const decision = applyManualAttributionDecision({
      connectorId: input.connectorId,
      transactionId: exception.transactionId,
      action: kidId ? 'assign-kid' : 'parent-expense',
      kidId,
      idempotencyKey,
      expectedExceptionUpdatedAt: input.expectedUpdatedAt,
      actorType: input.actorType,
      exceptionId: exception.id,
      auditAction: input.action,
    });
    return {
      status: decision.status,
      exceptionId: exception.id,
      idempotencyKey: decision.idempotencyKey,
      replayed: decision.replayed,
    };
  }
  const now = new Date().toISOString();
  const replayed = sqlite.transaction(() => {
    const concurrentAudit = findAttributionActionAudit(input.connectorId, idempotencyKey);
    if (concurrentAudit) {
      if (
        concurrentAudit.exceptionId !== input.exceptionId
        || concurrentAudit.action !== input.action
      ) {
        idempotencyConflict('Idempotency key was already used for another action');
      }
      return true;
    }
    const currentException = sqlite.prepare(`
      SELECT e.id, e.transaction_id AS transactionId, e.status, e.retryable,
             e.updated_at AS updatedAt,
             t.manual_decided_at AS manualDecidedAt
      FROM finance_attribution_exceptions e
      INNER JOIN finance_transactions t
        ON t.id = e.transaction_id
        AND t.connector_instance_id = e.connector_id
      WHERE e.id = ? AND e.connector_id = ?
    `).get(input.exceptionId, input.connectorId) as
      | {
          id: string;
          transactionId: string;
          status: string;
          retryable: number;
          updatedAt: string;
          manualDecidedAt: string | null;
        }
      | undefined;
    if (!currentException || !['open', 'retry_requested'].includes(currentException.status)) {
      throw new FinanceAttributionMutationError(
        'exception_conflict',
        'This exception was already resolved by a newer decision',
        409,
      );
    }
    if (currentException.updatedAt !== input.expectedUpdatedAt) {
      throw new FinanceAttributionMutationError(
        'exception_conflict',
        'This exception changed after it was loaded',
        409,
      );
    }
    if (input.action === 'retry' && currentException.retryable !== 1) {
      throw new FinanceAttributionMutationError(
        'exception_not_retryable',
        'Attribution exception is not retryable',
        409,
      );
    }
    if (
      currentException.manualDecidedAt
      && Date.parse(currentException.manualDecidedAt) > Date.parse(currentException.updatedAt)
    ) {
      throw new FinanceAttributionMutationError(
        'manual_decision_superseded',
        'A newer manual decision already exists',
        409,
      );
    }
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = ?, review_state = ?, resolution = ?,
          resolved_at = ?, updated_at = ?
      WHERE id = ? AND connector_id = ?
    `).run(
      input.action === 'retry' ? 'retry_requested' : 'dismissed',
      input.action === 'retry' ? 'pending' : 'resolved',
      input.action === 'dismiss' ? 'dismissed' : null,
      input.action === 'dismiss' ? now : null,
      now,
      currentException.id,
      input.connectorId,
    );
    if (input.action === 'retry') {
      sqlite.prepare(`
        UPDATE finance_transactions
        SET attribution_status = 'pending',
            attribution_review_state = 'pending',
            attribution_updated_at = ?
        WHERE id = ? AND connector_instance_id = ?
      `).run(now, currentException.transactionId, input.connectorId);
    } else {
      sqlite.prepare(`
        UPDATE finance_transactions
        SET attribution_review_state = 'resolved',
            attribution_updated_at = ?
        WHERE id = ? AND connector_instance_id = ?
      `).run(now, currentException.transactionId, input.connectorId);
    }
    sqlite.prepare(`
      INSERT INTO finance_attribution_audit (
        id, connector_id, transaction_id, exception_id, idempotency_key,
        action, actor_type, requested_kid_id, requested_decision,
        result_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      randomUUID(),
      input.connectorId,
      currentException.transactionId,
      currentException.id,
      idempotencyKey,
      input.action,
      input.actorType,
      input.action === 'retry' ? 'retry_requested' : 'dismissed',
      now,
    );
    if (input.action === 'retry' && isDurableSyncMode()) {
      enqueueSyncJobInCurrentTransaction(input.connectorId, {
        full: true,
        source: 'api',
      });
    }
    return false;
  }).immediate();
  return {
    status: input.action === 'retry' ? 'retry_requested' : 'dismissed',
    exceptionId: input.exceptionId,
    idempotencyKey,
    replayed,
  };
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}
