import 'server-only';

import { createHash } from 'node:crypto';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import { FinanceAttributionMutationError } from '@/db/persistence/finance-attribution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { attributionStatementDescriptors } from '@/lib/finance/transaction-evidence';
import type { ConnectorConfig } from '@/types';
import {
  createAttributionSourceRef,
  normalizeAttributionMerchant,
  resolveTyrionAttributionConfig,
  TyrionAttributionClient,
  TyrionAttributionError,
} from './attribution-client';
import { getPersistedFinanceConnectorConfigById } from './config';
import { createFinanceIdentityNamespace } from './identity';
import {
  attributionActionRequestSchema,
  attributionProjectionVersion,
  type AttributionRecordRequest,
  type AttributionRecordResponse,
  type TagProjection,
} from './attribution-writeback-contract';

export function assertAttributionProjected(projection: TagProjection | null,
  sourceRef: string, stateVersion: number): void {
  if (projection?.sourceRef !== sourceRef
    || projection.decisionVersion !== attributionProjectionVersion(stateVersion)) {
    throw new TyrionAttributionError('tag_projection_unverified',
      'Attribution is saved in Tyrion, but Monarch tag projection is not verified', true);
  }
  if (projection.status !== 'projected') {
    throw new TyrionAttributionError(
      projection.status === 'drift' ? 'transaction_tag_drift' : 'tag_projection_unavailable',
      projection.status === 'drift'
        ? 'Attribution is saved in Tyrion; Monarch tag drift needs operator review'
        : 'Attribution is saved in Tyrion; Monarch tag write-back is pending. Retry the review action',
      projection.status !== 'drift',
    );
  }
}

export async function reconcileAttributionWritebacks(
  connectorId: string,
  options: {
    idempotencyKey?: string;
    persistence?: FinanceCorePersistence;
    financeConfig?: Pick<ConnectorConfig, 'credentials' | 'settings'>;
    client?: TyrionAttributionClient;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const persistence = options.persistence ?? (await getWorkerPersistenceRepositories()).finance;
  const entries = await persistence.attribution.readWritebacks(connectorId, options.idempotencyKey);
  if (!entries.length) return;
  let client = options.client;
  let sourceConfig: ReturnType<typeof resolveTyrionAttributionConfig> | null = null;
  let firstFailure: FinanceAttributionMutationError | null = null;
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    if (entry.decidedAt !== entry.currentDecidedAt
      || entry.kidId !== entry.currentKidId || entry.action !== entry.currentAction) {
      await persistence.attribution.finishWriteback({
        id: entry.id, status: 'superseded', errorCode: null, now: new Date().toISOString(),
      });
      continue;
    }
    try {
      if (!sourceConfig) {
        const financeConfig = options.financeConfig
          ?? await getPersistedFinanceConnectorConfigById(connectorId);
        const identityNamespace = await persistence.identity.ensureNamespace({
          connectorId, candidate: createFinanceIdentityNamespace(), updatedAt: new Date().toISOString(),
        });
        sourceConfig = resolveTyrionAttributionConfig({
          ...financeConfig,
          credentials: { ...financeConfig.credentials, identityNamespace },
        });
      }
      client ??= new TyrionAttributionClient(sourceConfig);
      const sourceRef = createAttributionSourceRef(sourceConfig, connectorId, entry.upstreamTransactionId);
      const remoteKey = `mc-attribution-v1:${createHash('sha256')
        .update(JSON.stringify([sourceRef, entry.idempotencyKey])).digest('hex')}`;
      const recordRequest = (policyVersion: number): AttributionRecordRequest => ({
        contractVersion: '2.1',
        provenance: 'mission-control-normalized-v3',
        expectedPolicyVersion: policyVersion,
        expectedStateVersion: null,
        transactionId: entry.upstreamTransactionId,
        item: {
          sourceRef,
          occurredOn: entry.date,
          merchantName: normalizeAttributionMerchant(entry.merchantName ?? ''),
          businessEntityName: entry.businessContext,
          statementDescriptors: attributionStatementDescriptors(entry.statementDescriptors),
          locationEvidence: entry.locationEvidence,
          accountRef: entry.accountId ?? '',
          observedAt: entry.observedAt,
          existingManualDecision: entry.action === 'assign-kid'
            ? { action: 'assign-kid', kidId: entry.kidId ?? '', decidedAt: entry.decidedAt }
            : { action: 'parent-expense', kidId: null, decidedAt: entry.decidedAt },
        },
      });
      let requestText = entry.request;
      if (!requestText) {
        const policyVersion = await client.resolvePolicyVersion(options.signal);
        const bootstrap = await client.saveRecord(recordRequest(policyVersion), options.signal);
        requestText = await persistence.attribution.reserveWritebackRequest(entry.id, JSON.stringify({
          contractVersion: '2.1',
          provenance: 'mission-control-normalized-v2',
          sourceRef,
          expectedPolicyVersion: policyVersion,
          expectedStateVersion: bootstrap.record.stateVersion,
          idempotencyKey: remoteKey,
          confirm: true,
          action: entry.action === 'assign-kid' ? 'assign-kid' : 'mark-parent-expense',
          ...(entry.action === 'assign-kid' ? { kidId: entry.kidId } : {}),
        }));
      }
      let request = attributionActionRequestSchema.parse(JSON.parse(requestText));
      if (request.sourceRef !== sourceRef || request.idempotencyKey !== remoteKey) {
        throw new TyrionAttributionError('invalid_attribution_correlation',
          'Stored attribution write-back request does not match its receipt', false);
      }
      let result: Awaited<ReturnType<TyrionAttributionClient['applyAction']>>;
      try {
        result = await client.applyAction(request, options.signal);
      } catch (error) {
        if (!(error instanceof TyrionAttributionError)
          || error.status !== 409
          || !['attribution_state_conflict', 'policy_conflict'].includes(error.code)) throw error;
        const [current] = await persistence.attribution.readWritebacks(connectorId, entry.idempotencyKey);
        if (!current || current.decidedAt !== current.currentDecidedAt
          || current.kidId !== current.currentKidId || current.action !== current.currentAction) throw error;
        const policyVersion = error.code === 'policy_conflict'
          ? await client.resolvePolicyVersion(options.signal) : request.expectedPolicyVersion;
        if (error.code === 'policy_conflict' && policyVersion === request.expectedPolicyVersion) throw error;
        const latest = await client.saveRecord(recordRequest(policyVersion), options.signal);
        const replacement = await persistence.attribution.replaceRejectedWritebackRequest(
          entry.id, requestText, JSON.stringify({
            ...request, expectedPolicyVersion: policyVersion, expectedStateVersion: latest.record.stateVersion,
          }),
        );
        request = attributionActionRequestSchema.parse(JSON.parse(replacement));
        result = await client.applyAction(request, options.signal);
      }
      const matchesDecision = (candidate: AttributionRecordResponse['record']['attribution']) => (
        candidate.method === 'manual'
        && candidate.provenance.decisionSource === 'manual'
        && candidate.review.status !== 'pending'
        && candidate.kidId === entry.kidId
        && candidate.status === (entry.action === 'assign-kid' ? 'attributed' : 'unassigned')
      );
      if (!matchesDecision(result.attribution)) {
        throw new TyrionAttributionError('invalid_attribution_correlation',
          'Tyrion did not confirm the requested attribution decision', false);
      }
      let projection = result.projection;
      let currentStateVersion = result.stateVersion;
      if (!projection || projection.decisionVersion !== attributionProjectionVersion(currentStateVersion)) {
        const current = await client.saveRecord(
          recordRequest(await client.resolvePolicyVersion(options.signal)), options.signal,
        );
        if (!matchesDecision(current.record.attribution)
          || current.record.input.existingManualDecision?.action !== entry.action
          || current.record.input.existingManualDecision.kidId !== entry.kidId) {
          throw new TyrionAttributionError('manual_decision_conflict',
            'Tyrion has a newer different decision; review it before retrying write-back', false);
        }
        currentStateVersion = current.record.stateVersion;
        projection = current.projection;
      }
      if (projection && ['failed', 'pending'].includes(projection.status)
        && projection.decisionVersion === attributionProjectionVersion(currentStateVersion)) {
        projection = (await client.project(sourceRef, currentStateVersion, 'retry', options.signal)).projection;
      }
      assertAttributionProjected(projection, sourceRef, currentStateVersion);
      await persistence.attribution.finishWriteback({
        id: entry.id, status: 'succeeded', errorCode: null, now: new Date().toISOString(),
      });
    } catch (error) {
      const code = error instanceof TyrionAttributionError ? error.code : 'attribution_writeback_failed';
      await persistence.attribution.finishWriteback({
        id: entry.id, status: 'failed', errorCode: code, now: new Date().toISOString(),
      });
      firstFailure ??= new FinanceAttributionMutationError(code,
        error instanceof TyrionAttributionError
          ? `Decision saved locally. ${error.message}`
          : 'Decision saved locally; Tyrion/Monarch write-back is unverified. Retry the review action',
        ['transaction_tag_drift', 'manual_decision_conflict'].includes(code) ? 409 : 502);
    }
  }
  if (firstFailure) throw firstFailure;
}
