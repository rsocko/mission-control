import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  FINANCE_DATASETS,
  type FinanceDataset,
  type FinanceDatasetState,
  type FinanceFreshnessState,
} from '@/db/persistence/finance-datasets';
import type {
  FinanceAssistantExpectedVersion,
  FinanceAssistantMutationTool,
  FinanceAssistantTransaction,
} from '@/db/persistence/finance-assistant';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import {
  financeConnectorHealthOutputSchema,
  financeObligationsOutputSchema,
  financeTransactionSearchOutputSchema,
  householdFinanceSummaryOutputSchema,
  kidSpendingOutputSchema,
  pendingFinanceExceptionsOutputSchema,
  type FinanceConnectorHealthInput,
  type FinanceConnectorHealthOutput,
  type FinanceObligationsInput,
  type FinanceObligationsOutput,
  type FinanceTransactionSearchInput,
  type FinanceTransactionSearchOutput,
  type HouseholdFinanceSummaryInput,
  type HouseholdFinanceSummaryOutput,
  type KidSpendingInput,
  type KidSpendingOutput,
  type PendingFinanceExceptionsInput,
  type PendingFinanceExceptionsOutput,
  type AssignFinanceTransactionKidInput,
  type AssignFinanceTransactionKidOutput,
  type UpdateFinanceTransactionCategoryInput,
  type UpdateFinanceTransactionCategoryOutput,
  assignFinanceTransactionKidOutputSchema,
  updateFinanceTransactionCategoryOutputSchema,
} from './houston-contracts';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';

const MAX_OUTPUT_BYTES = 16 * 1024;
const DAY_MS = 86_400_000;

export class HoustonFinanceToolError extends Error {
  constructor(
    readonly code:
      | 'finance_not_configured'
      | 'finance_connector_ambiguous'
      | 'finance_kid_not_found'
      | 'finance_kid_ambiguous'
      | 'finance_cancelled'
      | 'finance_timeout'
      | 'finance_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'HoustonFinanceToolError';
  }
}

/**
 * Attribution mutation failure surfaced by the finance-assistant port. The
 * codes mirror the persisted attribution decision vocabulary so the redacted
 * tool-output mapping below stays byte-identical to the pre-port behavior.
 */
class HoustonFinanceAttributionError extends Error {
  constructor(
    readonly code:
      | 'idempotency_conflict'
      | 'connector_not_found'
      | 'transaction_not_found'
      | 'transaction_conflict'
      | 'unknown_attribution_subject',
    message: string,
  ) {
    super(message);
    this.name = 'HoustonFinanceAttributionError';
  }
}

type ExecutionOptions = {
  signal?: AbortSignal;
  now?: Date;
};

type FinancePersistence = FinanceCorePersistence;

type TransactionProjectionMeta = {
  sourceAsOf: string | null;
  coverage: { start: string; end: string } | null;
  freshness: FinanceFreshnessState;
  lastSuccessfulSyncAt: string | null;
  attributionStatus: 'idle' | 'healthy' | 'degraded' | 'unavailable';
  attributionLastSuccessfulAt: string | null;
};

type DatasetHealth = {
  dataset: FinanceDataset;
  state: FinanceFreshnessState;
  itemCount: number;
  sourceAsOf: string | null;
  coverage: { start: string; end: string } | null;
  warning: string | null;
};

async function financePersistence(): Promise<FinancePersistence> {
  return (await getWorkerPersistenceRepositories()).finance;
}

function safeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function roundCurrency(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function defaultRange(now: Date): { startDate: string; endDate: string } {
  const endDate = formatDateInLocalTimezone(now);
  return { startDate: `${endDate.slice(0, 7)}-01`, endDate };
}

function resolveRange(
  input: { startDate?: string; endDate?: string },
  now: Date,
): { startDate: string; endDate: string } {
  const defaults = defaultRange(now);
  const startDate = input.startDate ?? defaults.startDate;
  const endDate = input.endDate ?? defaults.endDate;
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 366 * DAY_MS) {
    throw new HoustonFinanceToolError('finance_unavailable', 'The requested finance date range is invalid.');
  }
  return { startDate, endDate };
}

async function selectConnector(
  finance: FinancePersistence,
  signal?: AbortSignal,
): Promise<{ id: string; pollIntervalMinutes: number | undefined }> {
  throwIfAborted(signal);
  const connectors = await finance.assistant.listEnabledConnectors();
  if (connectors.length === 0) {
    throw new HoustonFinanceToolError(
      'finance_not_configured',
      'No enabled finance connector is configured.',
    );
  }

  if (connectors.length > 1) {
    throw new HoustonFinanceToolError(
      'finance_connector_ambiguous',
      'Multiple finance connectors are enabled; select one in Finance settings before asking Houston.',
    );
  }
  throwIfAborted(signal);
  return {
    id: connectors[0].id,
    pollIntervalMinutes: connectors[0].pollIntervalMinutes ?? undefined,
  };
}

async function loadFinanceConnectorConfig(
  finance: FinancePersistence,
  connectorId: string,
) {
  const config = await finance.assistant.readConnectorConfig(connectorId);
  if (!config) {
    throw new HoustonFinanceToolError(
      'finance_not_configured',
      'No enabled finance connector is configured.',
    );
  }
  return config;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HoustonFinanceToolError('finance_cancelled', 'The finance request was cancelled.');
  }
}

async function transactionMeta(
  finance: FinancePersistence,
  connectorId: string,
  pollIntervalMinutes: number | undefined,
  now: Date,
): Promise<TransactionProjectionMeta> {
  const row = await finance.assistant.readProjectionState(connectorId);

  let freshness: FinanceFreshnessState = 'unavailable';
  if (row?.sourceAsOf && Number.isFinite(Date.parse(row.sourceAsOf))) {
    const staleAfterMinutes = Math.max((pollIntervalMinutes ?? 240) * 2, 60);
    freshness = now.getTime() - Date.parse(row.sourceAsOf) > staleAfterMinutes * 60_000
      ? 'stale'
      : 'fresh';
    if (row.status === 'failed' || row.lastErrorCode) freshness = 'partial';
  }
  return {
    sourceAsOf: row?.sourceAsOf ?? null,
    coverage: row?.coverageStart && row.coverageEnd
      ? { start: row.coverageStart, end: row.coverageEnd }
      : null,
    freshness,
    lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt ?? null,
    attributionStatus: row?.attributionStatus ?? 'idle',
    attributionLastSuccessfulAt: row?.attributionLastSuccessfulAt ?? null,
  };
}

/**
 * Per-dataset freshness for the persisted Monarch reference collections.
 * Mirrors the finance dataset publication rule: a dataset is only current
 * when it has a published generation whose source timestamp is in the past
 * and whose freshness window has not closed.
 */
function datasetFreshness(
  state: Pick<FinanceDatasetState, 'currentGenerationId' | 'sourceAsOf' | 'freshUntil'> | undefined,
  now: Date,
): FinanceFreshnessState {
  if (!state?.currentGenerationId || !state.sourceAsOf || !state.freshUntil) {
    return 'unavailable';
  }
  const sourceTime = Date.parse(state.sourceAsOf);
  return sourceTime <= now.getTime() && Date.parse(state.freshUntil) >= now.getTime()
    ? 'fresh'
    : 'stale';
}

function aggregateDatasetFreshness(datasets: DatasetHealth[]): FinanceFreshnessState {
  if (datasets.some((dataset) => dataset.warning)) return 'partial';
  if (datasets.length === 0 || datasets.every((dataset) => dataset.state === 'unavailable')) {
    return 'unavailable';
  }
  const states = new Set(datasets.map((dataset) => dataset.state));
  return states.size === 1 ? datasets[0].state : 'partial';
}

async function datasetHealth(
  finance: FinancePersistence,
  connectorId: string,
  now: Date,
): Promise<{ aggregate: FinanceFreshnessState; datasets: DatasetHealth[] }> {
  const rows = await finance.datasets.listState(connectorId);
  const byDataset = new Map(rows.map((row) => [row.dataset, row]));
  const datasets = FINANCE_DATASETS.map((dataset): DatasetHealth => {
    const row = byDataset.get(dataset);
    return {
      dataset,
      state: datasetFreshness(row, now),
      itemCount: row?.publishedItemCount ?? 0,
      sourceAsOf: row?.sourceAsOf ?? null,
      coverage: row?.coverageStart && row.coverageEnd
        ? { start: row.coverageStart, end: row.coverageEnd }
        : null,
      warning: row?.lastAttemptOutcome === 'failed' ? row.lastErrorCode : null,
    };
  });
  return { aggregate: aggregateDatasetFreshness(datasets), datasets };
}

function provenance(
  monarchFacts: boolean,
  tyrionDerived: boolean,
  missionControlCalculated: boolean,
) {
  return [
    {
      kind: 'monarch-fact' as const,
      label: 'Monarch facts via Tyrion Bridge',
      included: monarchFacts,
    },
    {
      kind: 'tyrion-derived' as const,
      label: 'Tyrion-derived attribution/conclusions',
      included: tyrionDerived,
    },
    {
      kind: 'mission-control-calculated' as const,
      label: 'Mission Control-calculated aggregates',
      included: missionControlCalculated,
    },
  ];
}

function mutationProvenance(confirmed: boolean) {
  return [
    {
      kind: 'monarch-fact' as const,
      label: 'Monarch facts via Tyrion Bridge',
      included: true,
    },
    {
      kind: 'tyrion-derived' as const,
      label: 'Tyrion-derived attribution/conclusions',
      included: true,
    },
    {
      kind: 'mission-control-calculated' as const,
      label: 'Mission Control-calculated aggregates',
      included: false,
    },
    {
      kind: 'mission-control-confirmed' as const,
      label: 'Mission Control-confirmed decision',
      included: confirmed,
    },
  ];
}

function meta(
  projection: Pick<TransactionProjectionMeta, 'sourceAsOf' | 'coverage' | 'freshness'>,
  truncated: boolean,
  deepLink: '/finance' | '/finance/review',
  included: [boolean, boolean, boolean],
) {
  return {
    sourceAsOf: projection.sourceAsOf,
    coverage: projection.coverage,
    freshness: projection.freshness,
    truncated,
    deepLink,
    provenance: provenance(...included),
  };
}

function applyRangeCoverage(
  projection: TransactionProjectionMeta,
  range: { startDate: string; endDate: string },
): TransactionProjectionMeta {
  if (projection.freshness === 'unavailable') return projection;
  if (!projection.coverage) return { ...projection, freshness: 'partial' };
  if (range.endDate < projection.coverage.start || range.startDate > projection.coverage.end) {
    return { ...projection, freshness: 'unavailable' };
  }
  if (
    range.startDate < projection.coverage.start
    || range.endDate > projection.coverage.end
  ) {
    return { ...projection, freshness: 'partial' };
  }
  return projection;
}

function applyAttributionFreshness(
  projection: TransactionProjectionMeta,
  pollIntervalMinutes: number | undefined,
  now: Date,
): TransactionProjectionMeta {
  if (projection.attributionStatus === 'unavailable') {
    return { ...projection, sourceAsOf: null, freshness: 'unavailable' };
  }
  const attributedAt = projection.attributionLastSuccessfulAt
    ? Date.parse(projection.attributionLastSuccessfulAt)
    : NaN;
  if (projection.attributionStatus !== 'healthy' || !Number.isFinite(attributedAt)) {
    return { ...projection, sourceAsOf: null, freshness: 'partial' };
  }
  const sourceAsOf = projection.sourceAsOf && projection.attributionLastSuccessfulAt
    ? [projection.sourceAsOf, projection.attributionLastSuccessfulAt].sort()[0]
    : projection.attributionLastSuccessfulAt;
  const staleAfterMinutes = Math.max((pollIntervalMinutes ?? 240) * 2, 60);
  if (
    projection.freshness === 'fresh'
    && now.getTime() - attributedAt > staleAfterMinutes * 60_000
  ) {
    return { ...projection, sourceAsOf, freshness: 'stale' };
  }
  return { ...projection, sourceAsOf };
}

const SAFE_ATTRIBUTION_REASONS = new Set([
  'no-match',
  'low-confidence',
  'account-rule-conflict',
  'merchant-rule-conflict',
  'historical-attribution-tie',
  'engine-unavailable',
  'policy-unavailable',
  'policy-version-mismatch',
  'manual_decision_conflict',
  'review-required',
]);

function safeAttributionReason(value: unknown): string {
  return typeof value === 'string' && SAFE_ATTRIBUTION_REASONS.has(value)
    ? value
    : 'review-required';
}

function attributionConclusion(reason: string): string {
  switch (reason) {
    case 'no-match': return 'Tyrion could not match this transaction to a household member.';
    case 'low-confidence': return 'Tyrion found only a low-confidence household attribution.';
    case 'account-rule-conflict': return 'Tyrion found conflicting account attribution rules.';
    case 'merchant-rule-conflict': return 'Tyrion found conflicting merchant attribution rules.';
    case 'historical-attribution-tie': return 'Tyrion found tied historical attribution evidence.';
    case 'engine-unavailable': return 'Tyrion attribution was unavailable for this transaction.';
    case 'policy-unavailable': return 'Tyrion attribution policy was unavailable for this transaction.';
    case 'policy-version-mismatch': return 'Tyrion attribution policy versions did not match.';
    case 'manual_decision_conflict': return 'Tyrion found a conflict with a prior manual decision.';
    default: return 'Tyrion marked this transaction for attribution review.';
  }
}

function output<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  const parsed = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_OUTPUT_BYTES) {
    throw new HoustonFinanceToolError(
      'finance_unavailable',
      'The bounded finance result could not be returned safely.',
    );
  }
  return parsed;
}

function safeTransaction(row: FinanceAssistantTransaction) {
  const transactionRef = opaqueDigest('txn', row.connectorId, row.id);
  const stateToken = transactionStateToken(row);
  return {
    target: { transactionRef, stateToken },
    factsViaTyrionBridge: {
      date: row.date,
      amount: roundCurrency(row.amount),
      merchant: safeText(row.merchant, 'Unknown merchant', 120),
      category: row.category ? safeText(row.category, 'Uncategorized', 100) : null,
      pending: row.pending,
      recurring: row.recurring,
    },
    tyrionDerived: {
      kidName: row.kidName ? safeText(row.kidName, 'Household member', 100) : null,
      attributionStatus: row.attributionStatus,
      confidence: row.confidence,
      method: row.method,
    },
  };
}

function opaqueDigest(prefix: 'txn' | 'state', ...values: Array<string | number | null>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([prefix, ...values]))
    .digest('base64url');
  return `${prefix}_${digest}`;
}

function transactionStateToken(row: FinanceAssistantTransaction): string {
  return opaqueDigest(
    'state',
    row.connectorId,
    row.id,
    row.date,
    row.amount,
    row.merchant,
    row.category,
    row.confirmedCategory,
    row.assignedKidId,
    row.sourceFingerprint,
    row.lastSeenAt,
    row.manualDecidedAt,
  );
}

async function resolveKid(finance: FinancePersistence, kidName: string) {
  const rows = await finance.assistant.matchKidsByName(kidName);
  if (rows.length === 0) {
    throw new HoustonFinanceToolError(
      'finance_kid_not_found',
      'No household member matches that name.',
    );
  }
  if (rows.length > 1) {
    throw new HoustonFinanceToolError(
      'finance_kid_ambiguous',
      'More than one household member matches that name.',
    );
  }
  return rows[0];
}

async function queryTransactions(
  finance: FinancePersistence,
  connectorId: string,
  input: FinanceTransactionSearchInput & { kidId?: string },
  range: { startDate: string; endDate: string },
) {
  return finance.assistant.searchTransactions({
    connectorId,
    startDate: range.startDate,
    endDate: range.endDate,
    merchantQuery: input.query,
    categoryName: input.category,
    kidId: input.kidId,
    triageStatus: input.triageStatus,
    limit: input.limit ?? 15,
  });
}

export async function getHouseholdFinanceSummary(
  input: HouseholdFinanceSummaryInput,
  options: ExecutionOptions = {},
): Promise<HouseholdFinanceSummaryOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const range = resolveRange(input, now);
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      await transactionMeta(finance, connector.id, connector.pollIntervalMinutes, now),
      range,
    ),
    connector.pollIntervalMinutes,
    now,
  );
  const summary = await finance.assistant.readSpendingSummary({
    connectorId: connector.id,
    startDate: range.startDate,
    endDate: range.endDate,
  });
  throwIfAborted(options.signal);
  const truncated = summary.byCategory.length > 12 || summary.byKid.length > 12;
  return output(householdFinanceSummaryOutputSchema, {
    kind: 'household-finance-summary',
    period: range,
    missionControlCalculated: {
      totalSpending: roundCurrency(summary.totalAmount),
      transactionCount: summary.transactionCount,
      byCategory: summary.byCategory.slice(0, 12).map((row) => ({
        category: safeText(row.category, 'Uncategorized', 100),
        amount: roundCurrency(row.amount),
        transactionCount: row.transactionCount,
      })),
      byKid: summary.byKid.slice(0, 12).map((row) => ({
        kidName: safeText(row.kidName, 'Household member', 100),
        amount: roundCurrency(row.amount),
        transactionCount: row.transactionCount,
      })),
    },
    meta: meta(projection, truncated, '/finance', [true, true, true]),
  });
}

export async function searchFinanceTransactions(
  input: FinanceTransactionSearchInput,
  options: ExecutionOptions = {},
): Promise<FinanceTransactionSearchOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const range = resolveRange(input, now);
  const kid = input.kidName ? await resolveKid(finance, input.kidName) : null;
  const result = await queryTransactions(
    finance,
    connector.id,
    { ...input, kidId: kid?.id },
    range,
  );
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      await transactionMeta(finance, connector.id, connector.pollIntervalMinutes, now),
      range,
    ),
    connector.pollIntervalMinutes,
    now,
  );
  throwIfAborted(options.signal);
  return output(financeTransactionSearchOutputSchema, {
    kind: 'finance-transaction-search',
    transactions: result.transactions.map(safeTransaction),
    meta: meta(projection, result.truncated, '/finance', [true, true, false]),
  });
}

export async function getPendingFinanceExceptions(
  input: PendingFinanceExceptionsInput,
  options: ExecutionOptions = {},
): Promise<PendingFinanceExceptionsOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const limit = input.limit ?? 10;
  const result = await finance.assistant.listAttributionExceptions({
    connectorId: connector.id,
    limit,
  });
  const projection = applyAttributionFreshness(
    await transactionMeta(finance, connector.id, connector.pollIntervalMinutes, now),
    connector.pollIntervalMinutes,
    now,
  );
  const subjects = new Map(result.subjects.map((subject) => [subject.kidId, subject.name]));
  throwIfAborted(options.signal);
  return output(pendingFinanceExceptionsOutputSchema, {
    kind: 'pending-finance-exceptions',
    exceptions: result.exceptions.map((exception) => {
      const reason = safeAttributionReason(exception.reasonCode);
      return {
        date: exception.date,
        merchant: safeText(exception.merchantName, 'Unknown merchant', 120),
        reason,
        retryable: exception.retryable === true,
        kidName: typeof exception.assignedKidId === 'string'
          ? safeText(subjects.get(exception.assignedKidId), 'Household member', 100)
          : null,
        confidence: exception.confidence ?? null,
        conclusion: attributionConclusion(reason),
        observedAt: exception.lastObservedAt,
      };
    }),
    meta: meta(projection, result.truncated, '/finance/review', [true, true, false]),
  });
}

export async function getKidSpending(
  input: KidSpendingInput,
  options: ExecutionOptions = {},
): Promise<KidSpendingOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const kid = await resolveKid(finance, input.kidName);
  const range = resolveRange(input, now);
  const result = await queryTransactions(
    finance,
    connector.id,
    { ...input, kidId: kid.id },
    range,
  );
  const totals = await finance.assistant.readKidSpendingTotal({
    connectorId: connector.id,
    kidId: kid.id,
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      await transactionMeta(finance, connector.id, connector.pollIntervalMinutes, now),
      range,
    ),
    connector.pollIntervalMinutes,
    now,
  );
  throwIfAborted(options.signal);
  return output(kidSpendingOutputSchema, {
    kind: 'kid-spending',
    kidName: safeText(kid.name, 'Household member', 100),
    period: range,
    missionControlCalculated: {
      totalSpending: roundCurrency(totals.totalAmount),
      transactionCount: totals.transactionCount,
      dailyLimit: kid.dailyLimit === null ? null : roundCurrency(kid.dailyLimit),
      weeklyLimit: kid.weeklyLimit === null ? null : roundCurrency(kid.weeklyLimit),
      monthlyLimit: kid.monthlyLimit === null ? null : roundCurrency(kid.monthlyLimit),
    },
    recentTransactions: result.transactions.map(safeTransaction),
    meta: meta(projection, result.truncated, '/finance', [true, true, true]),
  });
}

export async function getFinanceObligations(
  input: FinanceObligationsInput,
  options: ExecutionOptions = {},
): Promise<FinanceObligationsOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const health = await datasetHealth(finance, connector.id, now);
  const recurringHealth = health.datasets.find((dataset) => dataset.dataset === 'recurring');
  const limit = input.limit ?? 15;
  const horizonDays = input.horizonDays ?? 90;
  const horizonStart = formatDateInLocalTimezone(now);
  const horizonEnd = formatDateInLocalTimezone(new Date(now.getTime() + horizonDays * DAY_MS));
  const page = await finance.assistant.listRecurringObligations({
    connectorId: connector.id,
    horizonStart,
    horizonEnd,
    limit,
  });
  throwIfAborted(options.signal);
  return output(financeObligationsOutputSchema, {
    kind: 'finance-obligations',
    horizonDays,
    obligations: page.obligations.map((row) => ({
      factsViaTyrionBridge: {
        merchant: safeText(row.merchant, 'Unknown merchant', 120),
        amount: roundCurrency(row.amount),
        frequency: safeText(row.frequency, 'unknown', 40),
        nextExpectedDate: row.nextExpectedDate,
        category: row.category ? safeText(row.category, 'Uncategorized', 100) : null,
      },
    })),
    missionControlCalculated: {
      estimatedMonthlyAmount: roundCurrency(page.estimatedMonthlyAmount),
    },
    meta: {
      sourceAsOf: recurringHealth?.sourceAsOf ?? null,
      coverage: recurringHealth?.coverage ?? null,
      freshness: recurringHealth?.state ?? 'unavailable',
      truncated: page.truncated,
      deepLink: '/finance',
      provenance: provenance(true, false, true),
    },
  });
}

export async function getFinanceConnectorHealth(
  _input: FinanceConnectorHealthInput,
  options: ExecutionOptions = {},
): Promise<FinanceConnectorHealthOutput> {
  const now = options.now ?? new Date();
  const finance = await financePersistence();
  const connector = await selectConnector(finance, options.signal);
  const projection = applyAttributionFreshness(
    await transactionMeta(finance, connector.id, connector.pollIntervalMinutes, now),
    connector.pollIntervalMinutes,
    now,
  );
  const health = await datasetHealth(finance, connector.id, now);
  const freshnessStates = [projection.freshness, health.aggregate];
  const overall = freshnessStates.every((state) => state === 'fresh')
    ? 'healthy'
    : freshnessStates.every((state) => state === 'unavailable')
      ? 'unavailable'
      : 'degraded';
  const sourceAsOf = [
    projection.sourceAsOf,
    ...health.datasets.map((dataset) => dataset.sourceAsOf),
  ].filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  const coverageIntersection = health.datasets
    .map((dataset) => dataset.coverage)
    .filter((value): value is { start: string; end: string } => value !== null)
    .reduce<{ start: string; end: string } | null>((combined, value) => combined
      ? {
          start: combined.start > value.start ? combined.start : value.start,
          end: combined.end < value.end ? combined.end : value.end,
        }
      : value, null);
  const coverage = coverageIntersection && coverageIntersection.start <= coverageIntersection.end
    ? coverageIntersection
    : null;
  throwIfAborted(options.signal);
  return output(financeConnectorHealthOutputSchema, {
    kind: 'finance-connector-health',
    missionControlCalculated: { overall },
    bridgeProjection: {
      status: projection.freshness,
      lastSuccessfulSyncAt: projection.lastSuccessfulSyncAt,
    },
    tyrionAttribution: {
      status: projection.attributionStatus,
      lastSuccessfulAt: projection.attributionLastSuccessfulAt,
    },
    datasets: health.datasets.map((dataset) => ({
      name: dataset.dataset,
      freshness: dataset.state,
      itemCount: dataset.itemCount,
      sourceAsOf: dataset.sourceAsOf,
      coverage: dataset.coverage,
    })),
    meta: {
      sourceAsOf,
      coverage,
      freshness: overall === 'healthy'
        ? 'fresh'
        : overall === 'unavailable'
          ? 'unavailable'
          : 'partial',
      truncated: false,
      deepLink: '/finance',
      provenance: provenance(true, true, true),
    },
  });
}

export type HoustonFinanceApprovalAuditOutcome =
  | 'denied'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'invalid-approval';

export async function recordHoustonFinanceApprovalAudit(input: {
  approvalId: string;
  correlationId: string;
  toolName: FinanceAssistantMutationTool;
  decision: 'approve' | 'deny';
  outcome: HoustonFinanceApprovalAuditOutcome;
  durationMs: number;
}): Promise<void> {
  const finance = await financePersistence();
  await finance.assistant.recordApprovalAudit({
    correlationId: safeText(input.correlationId, 'unavailable', 128),
    callHash: input.approvalId,
    tool: input.toolName,
    decision: input.decision,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    createdAt: new Date().toISOString(),
  });
}

type MutationExecutionOptions = {
  approvalId: string;
  correlationId: string;
  signal?: AbortSignal;
  now?: Date;
};

async function findMutationTarget(
  finance: FinancePersistence,
  connectorId: string,
  transactionRef: string,
  expected: AssignFinanceTransactionKidInput['expected'],
): Promise<FinanceAssistantTransaction> {
  const rows = await finance.assistant.findApprovedMutationTargets({
    connectorId,
    date: expected.date,
    amount: expected.amount,
  });
  const target = rows.find(row => opaqueEqual(
    opaqueDigest('txn', row.connectorId, row.id),
    transactionRef,
  ));
  if (!target) {
    throw new HoustonFinanceToolError(
      'finance_unavailable',
      'The approved finance target is no longer available.',
    );
  }
  return target;
}

function assertExpectedTransactionState(
  target: FinanceAssistantTransaction,
  expected: AssignFinanceTransactionKidInput['expected'],
): void {
  const safe = safeTransaction(target);
  if (
    safe.target.stateToken !== expected.stateToken
    || safe.factsViaTyrionBridge.date !== expected.date
    || safe.factsViaTyrionBridge.amount !== expected.amount
    || safe.factsViaTyrionBridge.merchant !== expected.merchant
    || safe.factsViaTyrionBridge.category !== expected.category
    || safe.tyrionDerived.kidName !== expected.kidName
  ) {
    throw new HoustonFinanceToolError(
      'finance_unavailable',
      'The finance target changed after it was proposed. Review the current state and approve a new proposal.',
    );
  }
}

async function assertMutationProjectionFresh(
  finance: FinancePersistence,
  connectorId: string,
  pollIntervalMinutes: number | undefined,
  requireAttribution: boolean,
  now: Date,
): Promise<void> {
  const base = await transactionMeta(finance, connectorId, pollIntervalMinutes, now);
  const projection = requireAttribution
    ? applyAttributionFreshness(base, pollIntervalMinutes, now)
    : base;
  if (projection.freshness !== 'fresh') {
    throw new HoustonFinanceToolError(
      'finance_unavailable',
      'The finance projection is not current. Refresh finance data and approve a new proposal.',
    );
  }
}

function opaqueEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function resolveProjectedKid(
  finance: FinancePersistence,
  connectorId: string,
  kidName: string,
) {
  const rows = await finance.assistant.matchProjectedKidsByName({ connectorId, name: kidName });
  if (rows.length === 0) {
    throw new HoustonFinanceToolError('finance_kid_not_found', 'No current household member matches that name.');
  }
  if (rows.length > 1) {
    throw new HoustonFinanceToolError('finance_kid_ambiguous', 'More than one current household member matches that name.');
  }
  return rows[0];
}

async function resolveProjectedCategory(
  finance: FinancePersistence,
  connectorId: string,
  categoryName: string,
) {
  const rows = await finance.assistant.matchProjectedCategoriesByName({
    connectorId,
    name: categoryName,
  });
  if (rows.length === 0) {
    throw new HoustonFinanceToolError('finance_unavailable', 'No current finance category matches that name.');
  }
  if (rows.length > 1) {
    throw new HoustonFinanceToolError('finance_unavailable', 'More than one current finance category matches that name.');
  }
  return rows[0];
}

function mutationIdempotencyKey(
  options: MutationExecutionOptions,
): string {
  return `houston:${options.approvalId}`;
}

function expectedTransactionVersion(
  transaction: FinanceAssistantTransaction,
): FinanceAssistantExpectedVersion {
  return {
    sourceFingerprint: transaction.sourceFingerprint,
    lastSeenAt: transaction.lastSeenAt,
    assignedKidId: transaction.assignedKidId,
    confirmedCategory: transaction.confirmedCategory,
    manualDecidedAt: transaction.manualDecidedAt,
  };
}

function mutationFailure(
  kind: 'finance-kid-assignment' | 'finance-category-update',
  error: unknown,
) {
  let code:
    | 'target_not_found'
    | 'target_stale'
    | 'kid_not_found'
    | 'kid_ambiguous'
    | 'category_not_found'
    | 'category_ambiguous'
    | 'mutation_conflict'
    | 'upstream_unavailable'
    | 'mutation_unavailable' = 'mutation_unavailable';
  let message = 'The approved finance mutation could not be completed.';
  let retryable = false;
  if (error instanceof HoustonFinanceToolError) {
    if (error.code === 'finance_kid_not_found') code = 'kid_not_found';
    else if (error.code === 'finance_kid_ambiguous') code = 'kid_ambiguous';
    else if (/changed after it was proposed|projection is not current/.test(error.message)) code = 'target_stale';
    else if (/target is no longer available/.test(error.message)) code = 'target_not_found';
    else if (/No current finance category/.test(error.message)) code = 'category_not_found';
    else if (/More than one current finance category/.test(error.message)) code = 'category_ambiguous';
    message = error.message;
  } else if (error instanceof HoustonFinanceAttributionError) {
    code = /conflict|superseded|idempotency/.test(error.code)
      ? 'mutation_conflict'
      : 'mutation_unavailable';
    message = code === 'mutation_conflict'
      ? 'The attribution state changed before the approved decision could be applied.'
      : 'The approved kid assignment could not be completed.';
  } else if (error instanceof MonarchBridgeError) {
    code = /conflict|in_progress|idempotency/.test(error.code)
      ? 'mutation_conflict'
      : 'upstream_unavailable';
    message = code === 'mutation_conflict'
      ? 'Another category update conflicts with this approved proposal.'
      : 'The Tyrion Bridge did not verify the approved category update.';
    retryable = error.retryable;
  }
  return {
    kind,
    status: 'failed' as const,
    error: { code, message, retryable },
    provenance: mutationProvenance(false),
  };
}

async function replayedKidAssignment(
  finance: FinancePersistence,
  idempotencyKey: string,
): Promise<string | null> {
  const rows = await finance.assistant.findReplayedKidAssignments(idempotencyKey);
  if (rows.length > 1) {
    throw new HoustonFinanceAttributionError(
      'idempotency_conflict',
      'Approval identity matched more than one attribution decision',
    );
  }
  return rows.length === 1
    ? safeText(rows[0].kidName, 'Household member', 100)
    : null;
}

async function replayedCategoryUpdate(
  finance: FinancePersistence,
  idempotencyKey: string,
): Promise<string | null> {
  const rows = await finance.assistant.findReplayedCategoryUpdates(idempotencyKey);
  if (rows.length > 1) {
    throw new MonarchBridgeError(
      'idempotency_conflict',
      'Approval identity matched more than one category update',
      false,
      409,
    );
  }
  return rows.length === 1
    ? safeText(rows[0].categoryName, 'Previously approved category', 100)
    : null;
}

/** Mirrors the finance sync failure vocabulary persisted for mutation audit. */
function providerFailureDetails(error: unknown): { code: string; message: string } {
  if (error instanceof MonarchBridgeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && /cancel/i.test(error.message)) {
    return { code: 'sync_cancelled', message: 'Finance sync was cancelled' };
  }
  return { code: 'sync_failed', message: 'Finance snapshot sync failed' };
}

export async function assignFinanceTransactionKid(
  input: AssignFinanceTransactionKidInput,
  options: MutationExecutionOptions,
): Promise<AssignFinanceTransactionKidOutput> {
  const startedAt = performance.now();
  let outcome: HoustonFinanceApprovalAuditOutcome = 'failed';
  try {
    throwIfAborted(options.signal);
    const finance = await financePersistence();
    const idempotencyKey = mutationIdempotencyKey(options);
    const replayedKidName = await replayedKidAssignment(finance, idempotencyKey);
    if (replayedKidName) {
      outcome = 'succeeded';
      return assignFinanceTransactionKidOutputSchema.parse({
        kind: 'finance-kid-assignment',
        status: 'updated',
        missionControlConfirmed: { kidName: replayedKidName },
        replayed: true,
        provenance: mutationProvenance(true),
      });
    }
    const connector = await selectConnector(finance, options.signal);
    const transaction = await findMutationTarget(
      finance,
      connector.id,
      input.transactionRef,
      input.expected,
    );
    const kid = await resolveProjectedKid(finance, connector.id, input.kidName);
    await assertMutationProjectionFresh(
      finance,
      connector.id,
      connector.pollIntervalMinutes,
      true,
      options.now ?? new Date(),
    );
    assertExpectedTransactionState(transaction, input.expected);
    const result = await finance.assistant.applyManualKidAssignment({
      connectorId: connector.id,
      transactionId: transaction.id,
      kidId: kid.id,
      idempotencyKey,
      actorType: 'parent-admin',
      decidedAt: new Date().toISOString(),
      expectedVersion: expectedTransactionVersion(transaction),
    });
    if (result.status !== 'applied' && result.status !== 'replayed') {
      throw new HoustonFinanceAttributionError(
        result.status === 'idempotency-conflict'
          ? 'idempotency_conflict'
          : result.status === 'connector-not-found'
            ? 'connector_not_found'
            : result.status === 'transaction-not-found'
              ? 'transaction_not_found'
              : result.status === 'transaction-conflict'
                ? 'transaction_conflict'
                : 'unknown_attribution_subject',
        'The approved kid assignment could not be applied',
      );
    }
    outcome = 'succeeded';
    return assignFinanceTransactionKidOutputSchema.parse({
      kind: 'finance-kid-assignment',
      status: 'updated',
      missionControlConfirmed: { kidName: safeText(kid.name, 'Household member', 100) },
      replayed: result.status === 'replayed',
      provenance: mutationProvenance(true),
    });
  } catch (error) {
    if (
      (
        error instanceof HoustonFinanceToolError
        && /changed after it was proposed|projection is not current/.test(error.message)
      )
      || (
        error instanceof HoustonFinanceAttributionError
        && error.code === 'transaction_conflict'
      )
    ) {
      outcome = 'stale';
    }
    return assignFinanceTransactionKidOutputSchema.parse(
      mutationFailure('finance-kid-assignment', error),
    );
  } finally {
    await recordHoustonFinanceApprovalAudit({
      approvalId: options.approvalId,
      correlationId: options.correlationId,
      toolName: 'assignFinanceTransactionKid',
      decision: 'approve',
      outcome,
      durationMs: performance.now() - startedAt,
    });
  }
}

export async function updateFinanceTransactionCategory(
  input: UpdateFinanceTransactionCategoryInput,
  options: MutationExecutionOptions,
): Promise<UpdateFinanceTransactionCategoryOutput> {
  const startedAt = performance.now();
  let outcome: HoustonFinanceApprovalAuditOutcome = 'failed';
  try {
    throwIfAborted(options.signal);
    const finance = await financePersistence();
    const idempotencyKey = mutationIdempotencyKey(options);
    const replayedCategoryName = await replayedCategoryUpdate(finance, idempotencyKey);
    if (replayedCategoryName) {
      outcome = 'succeeded';
      return updateFinanceTransactionCategoryOutputSchema.parse({
        kind: 'finance-category-update',
        status: 'updated',
        factsViaTyrionBridge: { category: replayedCategoryName },
        replayed: true,
        provenance: mutationProvenance(true),
      });
    }
    const connector = await selectConnector(finance, options.signal);
    const transaction = await findMutationTarget(
      finance,
      connector.id,
      input.transactionRef,
      input.expected,
    );
    const category = await resolveProjectedCategory(finance, connector.id, input.categoryName);
    await assertMutationProjectionFresh(
      finance,
      connector.id,
      connector.pollIntervalMinutes,
      false,
      options.now ?? new Date(),
    );
    assertExpectedTransactionState(transaction, input.expected);
    const config = await loadFinanceConnectorConfig(finance, connector.id);
    const claim = await finance.assistant.claimCategoryMutation({
      connectorId: connector.id,
      transactionId: transaction.id,
      categoryId: category.upstreamCategoryId,
      expectedCategoryName: category.name,
      idempotencyKey,
      claimedAt: new Date().toISOString(),
      expectedVersion: expectedTransactionVersion(transaction),
    });
    if (claim.status !== 'already-succeeded') {
      if (claim.status !== 'claimed') throw categoryClaimError(claim.status);
      // The claim is committed before any provider I/O: no database
      // transaction is held across the externally-observable Tyrion request,
      // and success is only reported after the bridge verifies the update.
      try {
        await new MonarchBridgeClient(config).updateCategory(
          claim.upstreamTransactionId,
          category.upstreamCategoryId,
          options.signal,
        );
        const completed = await finance.assistant.completeCategoryMutation({
          connectorId: connector.id,
          transactionId: transaction.id,
          categoryId: category.upstreamCategoryId,
          idempotencyKey,
          claimToken: claim.claimToken,
          completedAt: new Date().toISOString(),
        });
        if (!completed) throw categoryClaimError('mutation-in-progress');
      } catch (error) {
        const failure = providerFailureDetails(error);
        await finance.assistant.failCategoryMutation({
          connectorId: connector.id,
          idempotencyKey,
          claimToken: claim.claimToken,
          errorCode: failure.code,
          errorMessage: failure.message,
          failedAt: new Date().toISOString(),
        });
        throw error;
      }
    }
    outcome = 'succeeded';
    return updateFinanceTransactionCategoryOutputSchema.parse({
      kind: 'finance-category-update',
      status: 'updated',
      factsViaTyrionBridge: { category: safeText(category.name, 'Category', 100) },
      replayed: false,
      provenance: mutationProvenance(true),
    });
  } catch (error) {
    if (
      (
        error instanceof HoustonFinanceToolError
        && /changed after it was proposed|projection is not current/.test(error.message)
      )
      || (
        error instanceof MonarchBridgeError
        && error.code === 'transaction_conflict'
      )
    ) {
      outcome = 'stale';
    }
    return updateFinanceTransactionCategoryOutputSchema.parse(
      mutationFailure('finance-category-update', error),
    );
  } finally {
    await recordHoustonFinanceApprovalAudit({
      approvalId: options.approvalId,
      correlationId: options.correlationId,
      toolName: 'updateFinanceTransactionCategory',
      decision: 'approve',
      outcome,
      durationMs: performance.now() - startedAt,
    });
  }
}

function categoryClaimError(
  status: 'idempotency-conflict'
    | 'transaction-not-found'
    | 'transaction-conflict'
    | 'category-conflict'
    | 'mutation-in-progress',
): MonarchBridgeError {
  switch (status) {
    case 'idempotency-conflict':
      return new MonarchBridgeError('idempotency_conflict', 'Idempotency key was already used', false, 409);
    case 'transaction-not-found':
      return new MonarchBridgeError('transaction_not_found', 'Finance transaction was not found', false, 404);
    case 'transaction-conflict':
      return new MonarchBridgeError('transaction_conflict', 'Finance transaction changed after approval', false, 409);
    case 'category-conflict':
      return new MonarchBridgeError('category_conflict', 'Finance category changed after approval', false, 409);
    case 'mutation-in-progress':
      return new MonarchBridgeError('mutation_in_progress', 'Category update is already in progress', true, 409);
  }
}

export {
  financeConnectorHealthInputSchema,
  financeConnectorHealthOutputSchema,
  financeObligationsInputSchema,
  financeObligationsOutputSchema,
  financeTransactionSearchInputSchema,
  financeTransactionSearchOutputSchema,
  householdFinanceSummaryInputSchema,
  householdFinanceSummaryOutputSchema,
  kidSpendingInputSchema,
  kidSpendingOutputSchema,
  pendingFinanceExceptionsInputSchema,
  pendingFinanceExceptionsOutputSchema,
} from './houston-contracts';
