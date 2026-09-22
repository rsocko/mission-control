import 'server-only';

import type {
  FinanceAttributionFenceMode,
  FinanceAttributionRow,
  FinanceAttributionStateSnapshot,
} from '@/db/persistence/finance-attribution';
import { FINANCE_ATTRIBUTION_WRITE_MAX } from '@/db/persistence/finance-attribution';
import type { FinanceWorkerPersistence } from '@/db/persistence/finance-worker';
import type { ConnectorConfig } from '@/types';
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
import type { MonarchTransaction } from './client';
import { createFinanceIdentityNamespace } from './identity';

interface PreparedAttributionItem {
  transactionId: string;
  sourceFingerprint: string;
  item: AttributionBatchItem;
  manualDecision: ManualDecision;
  stateSnapshot: FinanceAttributionStateSnapshot;
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
  persistence: FinanceWorkerPersistence;
  generationId: string;
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

function manualDecisionFromRow(row: FinanceAttributionRow): ManualDecision {
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
  row: FinanceAttributionRow | undefined,
): FinanceAttributionStateSnapshot {
  return {
    assignedKidId: row?.assignedKidId ?? null,
    kidAssignmentMethod: row?.kidAssignmentMethod ?? null,
    manualDecisionAction: row?.manualDecisionAction ?? null,
    manualDecidedAt: row?.manualDecidedAt ?? null,
  };
}

function prepareItems(
  config: TyrionAttributionConfig,
  connectorId: string,
  transactions: MonarchTransaction[],
  observedAt: string,
  rows: Map<string, FinanceAttributionRow>,
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

export class FinanceAttributionCoordinator {
  private config: TyrionAttributionConfig | null = null;
  private client: TyrionAttributionClient | null = null;
  private policyFence: number | null = null;
  private terminalFailure: AttributionFailure | null = null;
  private attempted = false;
  private succeeded = false;
  private readonly financeConfig: Pick<ConnectorConfig, 'credentials' | 'settings'>;
  private readonly fenceMode: FinanceAttributionFenceMode;

  constructor(
    private readonly connectorId: string,
    private readonly dependencies: CoordinatorDependencies,
  ) {
    this.financeConfig = dependencies.financeConfig ?? { credentials: {}, settings: {} };
    this.fenceMode = dependencies.fenceMode ?? 'snapshot';
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
    const rows = await this.dependencies.persistence.attribution.readRows(
      this.connectorId,
      transactions.map((transaction) => transaction.id),
    );
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
        const identityNamespace = await this.dependencies.persistence.identity.ensureNamespace({
          connectorId: this.connectorId,
          candidate: createFinanceIdentityNamespace(),
          updatedAt: new Date().toISOString(),
        });
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
        await this.dependencies.persistence.attribution.applyResults({
          connectorId: this.connectorId,
          generationId: this.dependencies.generationId,
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
      stateSnapshot: FinanceAttributionStateSnapshot;
    }>,
    failure: AttributionFailure,
    now: string,
  ): Promise<void> {
    for (let offset = 0; offset < items.length; offset += FINANCE_ATTRIBUTION_WRITE_MAX) {
      await this.dependencies.persistence.attribution.persistUnavailable({
        connectorId: this.connectorId,
        generationId: this.dependencies.generationId,
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
    await this.dependencies.persistence.attribution.finish({
      connectorId: this.connectorId,
      generationId: this.dependencies.generationId,
      fenceMode: this.fenceMode,
      attemptedAt: now,
      succeeded: this.succeeded,
      terminalFailureCode: this.terminalFailure?.code ?? null,
      status,
      policyVersion: this.policyFence,
      engineVersion: TYRION_ATTRIBUTION_ENGINE_VERSION,
    });
  }
}
