import 'server-only';

import {
  FINANCE_ATTRIBUTION_PREVIEW_MAX,
  FinanceOperatorPersistenceError,
} from '@/db/persistence/finance-operator';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { resolveFinanceExternalLinks } from '@/lib/finance/external-links';
import { isFinanceConnectorType } from './config';
import {
  getTyrionAttributionPolicySelection,
  TYRION_ATTRIBUTION_POLICY_SETTING,
} from './config';
import {
  createAttributionRequests,
  normalizeAttributionMerchant,
  resolveTyrionAttributionConfig,
  TyrionAttributionClient,
  TyrionAttributionError,
} from './attribution-client';

export class FinanceAttributionReadinessError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'FinanceAttributionReadinessError';
  }
}

async function runtime() {
  return getWorkerPersistenceRepositories();
}

async function financeConnector(connectorId: string) {
  const repositories = await runtime();
  const connector = await repositories.connectors.get(connectorId);
  if (!connector) {
    throw new FinanceAttributionReadinessError('finance_connector_not_found', 404);
  }
  if (!isFinanceConnectorType(connector.type)) {
    throw new FinanceAttributionReadinessError('invalid_finance_connector_type', 400);
  }
  return { connector, repositories };
}

function mapError(error: unknown): FinanceAttributionReadinessError {
  if (error instanceof FinanceAttributionReadinessError) return error;
  if (error instanceof FinanceOperatorPersistenceError) {
    return new FinanceAttributionReadinessError(error.code, error.status);
  }
  if (error instanceof TyrionAttributionError) {
    return new FinanceAttributionReadinessError(
      error.code,
      error.status ?? (error.retryable ? 503 : 409),
    );
  }
  return new FinanceAttributionReadinessError(
    'finance_attribution_readiness_unavailable',
    500,
  );
}

export async function getFinanceAttributionPolicyReadiness(connectorId: string) {
  try {
    const { connector, repositories } = await financeConnector(connectorId);
    const [accountSummary, projection, latestBackfillPlan] = await Promise.all([
      repositories.finance.operator.readAttributionAccountSummary(connectorId),
      repositories.finance.insights.projection.readState(connectorId),
      repositories.finance.insights.backfill.readLatestPlan(connectorId),
    ]);
    const policySelection = getTyrionAttributionPolicySelection(connector.settings);
    let activePolicyVersion: number | null = null;
    let policyUpdatedAt: string | null = null;
    let policyDiscoveryError: string | null = null;
    try {
      const policy = await new TyrionAttributionClient(
        resolveTyrionAttributionConfig(connector),
      ).readCurrentPolicy();
      activePolicyVersion = policy.policyVersion;
      policyUpdatedAt = policy.policyUpdatedAt;
    } catch (error) {
      if (!(error instanceof TyrionAttributionError)) throw error;
      policyDiscoveryError = error.code;
    }
    return {
      connector: {
        enabled: connector.enabled,
        configurationUrl: resolveFinanceExternalLinks().tyrionConfiguration,
      },
      policySelection,
      activePolicyVersion,
      policyUpdatedAt,
      policyDiscoveryError,
      accountSummary,
      historyBackfill: latestBackfillPlan
        ? {
            status: latestBackfillPlan.status,
            completedWindows: latestBackfillPlan.nextWindowOrdinal,
            totalWindows: latestBackfillPlan.windowCount,
            horizonMonths: latestBackfillPlan.horizonMonths,
            coverageStart: latestBackfillPlan.coverageStart,
            coverageEnd: latestBackfillPlan.coverageEnd,
            lastErrorCode: latestBackfillPlan.lastErrorCode,
            completedAt: latestBackfillPlan.completedAt,
            updatedAt: latestBackfillPlan.updatedAt,
          }
        : null,
      historyProjection: projection
        ? {
            status: projection.status,
            generationId: projection.generationId,
            lastSuccessfulAt: projection.lastSuccessfulAt,
            sourceAsOf: projection.sourceAsOf,
            itemCount: projection.itemCount,
            coverageStart: projection.coverageStart,
            coverageEnd: projection.coverageEnd,
            windowCount: projection.windowCount,
            bridgeContractVersion: projection.bridgeContractVersion,
            lastErrorCode: projection.lastErrorCode,
            updatedAt: projection.updatedAt,
          }
        : null,
    };
  } catch (error) {
    throw mapError(error);
  }
}

export async function updateFinanceAttributionPolicySelection(
  connectorId: string,
  pinnedPolicyVersion: number | null,
) {
  try {
    const { repositories } = await financeConnector(connectorId);
    if (
      pinnedPolicyVersion !== null
      && (!Number.isSafeInteger(pinnedPolicyVersion) || pinnedPolicyVersion < 1)
    ) {
      throw new FinanceAttributionReadinessError('attribution_policy_pin_invalid', 400);
    }
    await repositories.connectors.patchSettingsState(
      connectorId,
      TYRION_ATTRIBUTION_POLICY_SETTING,
      { pinnedPolicyVersion: pinnedPolicyVersion ?? undefined },
    );
    return getFinanceAttributionPolicyReadiness(connectorId);
  } catch (error) {
    throw mapError(error);
  }
}

export async function previewFinanceAttributionPolicy(connectorId: string) {
  try {
    const { connector, repositories } = await financeConnector(connectorId);
    const config = resolveTyrionAttributionConfig(connector);
    const projection = await repositories.finance.operator.readAttributionPreview({
      connectorId,
      limit: FINANCE_ATTRIBUTION_PREVIEW_MAX,
    });
    const client = new TyrionAttributionClient(config);
    const policyVersion = await client.resolvePolicyVersion();
    const requests = createAttributionRequests(
      projection.items.map((item) => ({
        ...item,
        merchantName: normalizeAttributionMerchant(item.merchantName),
      })),
      policyVersion,
    );
    const counts = {
      status: {} as Record<string, number>,
      reason: {} as Record<string, number>,
      method: {} as Record<string, number>,
      confidence: {} as Record<string, number>,
      reviewStatus: {} as Record<string, number>,
    };
    let evaluatedPolicyVersion: number | null = null;
    let engineVersion: string | null = null;
    let evaluated = 0;
    for (const request of requests) {
      const response = await client.attribute(request);
      evaluatedPolicyVersion = response.policyVersion;
      engineVersion = response.engineVersion;
      for (const result of response.results) {
        evaluated += 1;
        counts.status[result.status] = (counts.status[result.status] ?? 0) + 1;
        counts.method[result.method] = (counts.method[result.method] ?? 0) + 1;
        counts.confidence[result.confidence] =
          (counts.confidence[result.confidence] ?? 0) + 1;
        counts.reviewStatus[result.reviewStatus] =
          (counts.reviewStatus[result.reviewStatus] ?? 0) + 1;
        for (const reason of result.reasons) {
          counts.reason[reason] = (counts.reason[reason] ?? 0) + 1;
        }
      }
    }
    const reviewRequired = counts.reviewStatus.pending ?? 0;
    return {
      generatedAt: new Date().toISOString(),
      policyVersion: evaluatedPolicyVersion,
      engineVersion,
      totalTransactions: projection.total,
      evaluated,
      truncated: projection.truncated,
      complete: !projection.truncated && evaluated === projection.total,
      ready: projection.total > 0
        && !projection.truncated
        && evaluated === projection.total
        && reviewRequired === 0,
      counts,
    };
  } catch (error) {
    throw mapError(error);
  }
}
