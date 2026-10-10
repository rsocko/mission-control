import 'server-only';

import { getTimezone } from '@/lib/mode';
import logger from '@/lib/logger';
import type { ConnectorConfig, DomainSyncResult } from '@/types';
import type { FinanceAttentionSignal } from '@/db/persistence/finance-attention';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { reconcileFinanceAttention } from '@/lib/finance/attention-routing';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import { MonarchBridgeClient, MonarchBridgeError } from '@/lib/connectors/monarch-money/client';
import {
  TyrionFinanceInsightClient,
  TyrionFinanceInsightError,
  resolveTyrionFinanceInsightConfig,
} from './client';
import { loadFinanceInsightPublication } from './publication';
import type { FinanceAutomationJobResult, FinanceAutomationSignal } from './automation-contract';

const CONTRACT_VERSION = '1.0';
const DEFAULT_INTERVAL_MINUTES = 15;

function enabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.TYRION_FINANCE_AUTOMATION_ENABLED?.trim().toLowerCase() === 'true';
}

function scheduleInstant(now: Date, environment: Readonly<Record<string, string | undefined>>): string {
  const parsed = Number(environment.TYRION_FINANCE_AUTOMATION_INTERVAL_MINUTES);
  const minutes = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_440
    ? parsed
    : DEFAULT_INTERVAL_MINUTES;
  const intervalMs = minutes * 60_000;
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs).toISOString();
}

export function deriveConsecutiveFailures(
  activeEpisodeStartedAt: string | null,
  now: Date,
  environment: Readonly<Record<string, string | undefined>>,
): number {
  if (!activeEpisodeStartedAt) return 1;
  const intervalMinutes = Number(
    environment.TYRION_FINANCE_AUTOMATION_INTERVAL_MINUTES,
  );
  const boundedMinutes = Number.isSafeInteger(intervalMinutes)
    && intervalMinutes > 0
    && intervalMinutes <= 1_440
    ? intervalMinutes
    : DEFAULT_INTERVAL_MINUTES;
  return Math.min(
    10_000,
    Math.max(
      1,
      Math.floor(
        (now.getTime() - Date.parse(activeEpisodeStartedAt))
        / (boundedMinutes * 60_000),
      ) + 1,
    ),
  );
}

function candidateInsightPolicy(input: {
  policyVersion: number;
  effectiveAt: string;
  currency: string;
}) {
  return {
    contractVersion: CONTRACT_VERSION,
    policyModelVersion: 'finance-policy-v1',
    detectorSetVersion: 'detectors-v1',
    policyVersion: input.policyVersion,
    effectiveAt: input.effectiveAt,
    currency: input.currency,
    timezone: getTimezone(),
    featureGates: {
      recurringAmountAnalysis: false,
      recurringAmountNotifications: false,
      largeTransactionAnalysis: false,
      varianceAnalysis: false,
      immediateLargeTransactionNotifications: false,
      monthlyMoverDigestNotifications: false,
      confirmedActions: false,
    },
    sourceClassification: {
      classifierVersion: 'classifier-v1',
      transferCategoryRefs: [],
      transferTagRefs: [],
      incomeCategoryRefs: [],
      incomeTagRefs: [],
      refundCategoryRefs: [],
      refundTagRefs: [],
      excludedCategoryRefs: [],
      excludedTagRefs: [],
    },
    recurringAmount: {
      absoluteGateMinor: 7_000,
      relativeGateBasisPoints: 2_500,
      alertDirection: 'increaseOnly',
      adjacentMonthWindow: 1,
      historyMonths: 37,
      minimumSeasonalYears: 2,
      scaledMadMultiplierMilli: 3_000,
      minimumSpreadMinor: 1_000,
    },
    largeTransaction: {
      explicitRuleMinor: 100_000,
      adaptiveMeaningfulDollarFloorMinor: 15_000,
      adaptiveMinimumAgreement: 2,
      eligibleDimensions: ['merchant', 'category', 'account', 'household'],
      historyWindowDays: 365,
      minimumBaselineSampleCount: 5,
      robustDeviationMultiplierMilli: 3_000,
      minimumSpreadMinor: 1_000,
      empiricalPercentileGateBasisPoints: 9_000,
      ratioGateBasisPoints: 20_000,
      highSeverityAmountMinor: 250_000,
      publicationLimit: 50,
      lifecycleTransitionLimit: 100,
      approvedMerchantKeys: [],
      expectedScopes: [],
      suppressedScopes: [],
    },
    variance: {
      absoluteGateMinor: 15_000,
      relativeGateBasisPoints: 3_000,
      robustDeviationMilli: 3_000,
      historyMonths: 6,
      minimumActiveMonths: 3,
      sufficientActiveMonths: 6,
      minimumBaselineTransactions: 3,
      minimumCurrentTransactions: 1,
      minimumSpreadMinor: 5_000,
      persistentOccurrenceLimit: 10,
      digestMemberLimit: 10,
      contributorLimit: 10,
      notifyingMinimumConfidence: 'high',
    },
    freshness: { newAlertMaxAgeHours: 48 },
    delivery: {
      largeTransaction: 'immediate',
      monthlyDigestDay: 2,
      monthlyDigestLocalHour: 9,
      monthlyDigestLocalMinute: 0,
      mediumConfidenceMoversNotify: false,
    },
    suppression: {
      operator: 'fixedLocalOperator',
      allowedDurationsDays: [30, 90, 180],
      permanentAllowed: false,
      undoRequired: true,
    },
    materialChange: {
      amountBoundaryMinor: 1_000,
      classificationChangeIsMaterial: true,
      correctionCreatesSuccessor: true,
    },
  };
}

function automationPolicy(policyVersion: number) {
  return {
    contractVersion: CONTRACT_VERSION,
    policyVersion,
    detectorSetVersion: 'automation-detectors-v1',
    duplicateTransactions: {
      enabled: true,
      matchWindowDays: 1,
      maxCandidates: 100,
      freshnessMaxAgeHours: 24,
    },
    connectorHealth: {
      enabled: true,
      staleAfterHours: 1,
      actionableAfterConsecutiveFailures: 3,
    },
  };
}

export function toFinanceAutomationAttentionSignal(
  signal: FinanceAutomationSignal,
  version: number,
): FinanceAttentionSignal {
  const sourceAsOf = signal.provenance.sourceAsOf ?? signal.provenance.observedAt;
  return {
    connectorId: signal.connectorRef,
    signalKind: signal.kind === 'duplicateTransaction'
      ? 'duplicateTransactionCandidate'
      : 'connectorDegraded',
    sourceRef: signal.signalId,
    sourceLifecycle: signal.state === 'open' ? 'open' : 'resolved',
    conditionSince: signal.openedAt,
    sourceAsOf,
    activityKey: `finance-automation:${signal.signalId}:${version}:${signal.updatedAt}`,
    actionable: signal.attention === 'actionable',
    attention: signal.attention,
    freshness: signal.freshness,
    settlementReason: signal.state === 'settled'
      ? signal.kind === 'connectorHealth'
        && signal.reasonCodes.includes('condition_recovered')
        ? 'connector_recovered'
        : 'authoritative_state_verified'
      : null,
    details: {
      contractVersion: signal.contractVersion,
      signalId: signal.signalId,
      kind: signal.kind,
      severity: signal.severity,
      confidence: signal.confidence,
      reasonCodes: signal.reasonCodes,
      evidence: signal.evidence,
      provenance: signal.provenance,
    },
  };
}

async function applyAndAcknowledge(
  client: TyrionFinanceInsightClient,
  result: FinanceAutomationJobResult,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const applicationSignals = automationApplicationSignals(result);
  if (applicationSignals.deliveries.length > 0) {
    await reconcileFinanceAttention({
      connectorId: result.connectorRef,
      now,
      sourceSignals: applicationSignals.deliveries,
    });
  }
  if (applicationSignals.current.length > 0) {
    await reconcileFinanceAttention({
      connectorId: result.connectorRef,
      now,
      sourceSignals: applicationSignals.current,
    });
  }
  if (result.deliveries.length === 0) return;
  const requestedKeys = result.deliveries.map((delivery) => delivery.deliveryKey);
  const acknowledgment = await client.acknowledgeAutomationDeliveries({
    contractVersion: CONTRACT_VERSION,
    acknowledgedAt: now.toISOString(),
    deliveries: result.deliveries.map((delivery) => ({
      deliveryKey: delivery.deliveryKey,
      expectedVersion: delivery.version,
    })),
  }, signal);
  if (!isCompleteAcknowledgment(requestedKeys, acknowledgment)) {
    throw new TyrionFinanceInsightError(
      'automation_delivery_version_conflict',
      'Finance automation delivery acknowledgement conflicted',
      true,
      409,
    );
  }
}

export function isCompleteAcknowledgment(
  requestedKeys: readonly string[],
  result: {
    acknowledged: readonly string[];
    conflicts: readonly string[];
  },
): boolean {
  const requested = new Set(requestedKeys);
  const returnedKeys = [...result.acknowledged, ...result.conflicts];
  return result.conflicts.length === 0
    && requested.size === requestedKeys.length
    && returnedKeys.length === requestedKeys.length
    && new Set(returnedKeys).size === returnedKeys.length
    && returnedKeys.every((key) => requested.has(key));
}

export function automationApplicationSignals(
  result: FinanceAutomationJobResult,
): { deliveries: FinanceAttentionSignal[]; current: FinanceAttentionSignal[] } {
  const deliveredSignalIds = new Set(
    result.deliveries.map((delivery) => delivery.signalId),
  );
  return {
    deliveries: result.deliveries.map((delivery) => (
      toFinanceAutomationAttentionSignal(delivery.signal, delivery.version)
    )),
    current: result.signals
      .filter((signal) => !deliveredSignalIds.has(signal.signalId))
      .map((signal) => toFinanceAutomationAttentionSignal(signal, 0)),
  };
}

export function isCorrelatedAutomationResult(
  result: FinanceAutomationJobResult,
  request: Readonly<Record<string, unknown>>,
): boolean {
  return result.connectorRef === request.connectorRef
    && result.jobKind === request.jobKind
    && result.scheduledFor === request.scheduledFor;
}

export async function runFinanceAutomation(input: {
  config: ConnectorConfig;
  syncResult: DomainSyncResult;
  publicationId: string | null;
  now?: Date;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<{ jobsRun: number; deliveriesApplied: number }> {
  const environment = input.environment ?? process.env;
  if (!enabled(environment)) return { jobsRun: 0, deliveriesApplied: 0 };
  const now = input.now ?? new Date();
  const scheduledFor = scheduleInstant(now, environment);
  const client = new TyrionFinanceInsightClient(
    resolveTyrionFinanceInsightConfig(input.config, environment),
  );
  const jobs: Array<Record<string, unknown>> = [];
  let resolvedPolicyVersion = 1;
  const publication = input.publicationId
    ? await loadFinanceInsightPublication(input.config.id, input.publicationId, () => now)
    : null;
  if (publication) {
    const repositories = await getWorkerPersistenceRepositories();
    const delivery = await repositories.finance.insights.delivery.ensureState({
      connectorId: input.config.id,
      publicationId: publication.createRequest.sourceGeneration,
      sourceSequence: publication.createRequest.sourceSequence,
      now: now.toISOString(),
    });
    if (delivery.policyVersion) {
      resolvedPolicyVersion = delivery.policyVersion;
      const transactions = publication.batches
        .filter((batch) => batch.kind === 'transaction')
        .flatMap((batch) => batch.facts);
      jobs.push({
        contractVersion: CONTRACT_VERSION,
        jobKind: 'duplicateTransactions',
        connectorRef: input.config.id,
        scheduledFor,
        evaluatedAt: now.toISOString(),
        sourceCompleteness:
          input.syncResult.status === 'fresh' && publication.alertCapable
            ? 'complete'
            : 'partial',
        source: publication.createRequest,
        transactions,
        suppressedPairs: [],
        insightPolicy: candidateInsightPolicy({
          policyVersion: delivery.policyVersion,
          effectiveAt: publication.createRequest.sourceAsOf,
          currency: publication.createRequest.currency,
        }),
        automationPolicy: automationPolicy(delivery.policyVersion),
      });
    }
  }

  let healthState: 'connected' | 'degraded' | 'unavailable' = 'unavailable';
  let lastSuccessfulSyncAt: string | null = publication?.createRequest.sourceAsOf ?? null;
  let consecutiveFailures = 1;
  try {
    const health = await new MonarchBridgeClient(input.config).getHealth(input.signal);
    healthState = health.status === 'ok' && health.reachable && health.authenticated
      ? 'connected'
      : 'degraded';
    consecutiveFailures = healthState === 'connected' ? 0 : 1;
    if (healthState === 'connected') lastSuccessfulSyncAt ??= now.toISOString();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    healthState = 'unavailable';
    logger.warn(
      { code: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable' },
      'Finance automation health observation was unavailable',
    );
  }
  if (healthState !== 'connected') {
    const activeEpisode = await (
      await getWorkerPersistenceRepositories()
    ).finance.recovery.getActiveEpisode(input.config.id);
    consecutiveFailures = deriveConsecutiveFailures(
      activeEpisode?.startedAt ?? null,
      now,
      environment,
    );
  }
  jobs.push({
    contractVersion: CONTRACT_VERSION,
    jobKind: 'connectorHealth',
    connectorRef: input.config.id,
    scheduledFor,
    evaluatedAt: now.toISOString(),
    observation: {
      observedAt: now.toISOString(),
      state: healthState,
      lastSuccessfulSyncAt,
      consecutiveFailures,
      bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
    },
    automationPolicy: automationPolicy(resolvedPolicyVersion),
  });

  let deliveriesApplied = 0;
  for (const job of jobs) {
    const result = await client.runAutomationJob(job, input.signal);
    if (!isCorrelatedAutomationResult(result, job)) {
      throw new TyrionFinanceInsightError(
        'invalid_finance_automation_correlation',
        'Tyrion finance automation response correlation is invalid',
        false,
      );
    }
    await applyAndAcknowledge(client, result, now, input.signal);
    deliveriesApplied += result.deliveries.length;
  }
  return { jobsRun: jobs.length, deliveriesApplied };
}
