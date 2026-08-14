import 'server-only';

import { sqlite } from '@/db';
import type { FinanceFreshnessState } from '@/db/finance-schema';
import { listAttributionExceptions } from '@/lib/connectors/monarch-money/attribution-service';
import { getFinanceDatasetHealth } from '@/lib/connectors/monarch-money/dataset-sync';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
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
} from './houston-contracts';

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

type ExecutionOptions = {
  signal?: AbortSignal;
  now?: Date;
};

type TransactionProjectionMeta = {
  sourceAsOf: string | null;
  coverage: { start: string; end: string } | null;
  freshness: FinanceFreshnessState;
  lastSuccessfulSyncAt: string | null;
  attributionStatus: 'idle' | 'healthy' | 'degraded' | 'unavailable';
  attributionLastSuccessfulAt: string | null;
};

type SafeTransactionRow = {
  date: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  pending: number;
  recurring: number;
  kidName: string | null;
  attributionStatus: 'attributed' | 'unassigned' | 'pending' | 'unavailable';
  confidence: 'definite' | 'likely' | 'none' | null;
  method:
    | 'manual'
    | 'card-rule'
    | 'merchant-rule'
    | 'historical-pattern'
    | 'unassigned'
    | 'unavailable'
    | null;
};

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

async function selectConnector(signal?: AbortSignal) {
  throwIfAborted(signal);
  const connectors = sqlite.prepare(`
    SELECT id, poll_interval_minutes AS pollIntervalMinutes
    FROM connector_configs
    WHERE type IN (${FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ')})
      AND enabled = 1 AND deleted_at IS NULL
    ORDER BY created_at, id
    LIMIT 2
  `).all(...FINANCE_PROVIDER_ALIASES) as Array<{
    id: string;
    pollIntervalMinutes: number | null;
  }>;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HoustonFinanceToolError('finance_cancelled', 'The finance request was cancelled.');
  }
}

function transactionMeta(
  connectorId: string,
  pollIntervalMinutes: number | undefined,
  now: Date,
): TransactionProjectionMeta {
  const row = sqlite.prepare(`
    SELECT last_successful_source_as_of AS sourceAsOf,
           last_successful_projection_coverage_start AS coverageStart,
           last_successful_projection_coverage_end AS coverageEnd,
           last_successful_sync_at AS lastSuccessfulSyncAt,
           status, last_error_code AS lastErrorCode,
           attribution_status AS attributionStatus,
           attribution_last_successful_at AS attributionLastSuccessfulAt
    FROM finance_sync_state
    WHERE connector_id = ?
  `).get(connectorId) as {
    sourceAsOf: string | null;
    coverageStart: string | null;
    coverageEnd: string | null;
    lastSuccessfulSyncAt: string | null;
    status: 'idle' | 'running' | 'succeeded' | 'failed';
    lastErrorCode: string | null;
    attributionStatus: 'idle' | 'healthy' | 'degraded' | 'unavailable';
    attributionLastSuccessfulAt: string | null;
  } | undefined;

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
  'card-rule-conflict',
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
    case 'card-rule-conflict': return 'Tyrion found conflicting card attribution rules.';
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

function safeTransaction(row: SafeTransactionRow) {
  return {
    factsViaTyrionBridge: {
      date: row.date,
      amount: roundCurrency(row.amount),
      merchant: safeText(row.merchant, 'Unknown merchant', 120),
      category: row.category ? safeText(row.category, 'Uncategorized', 100) : null,
      pending: row.pending === 1,
      recurring: row.recurring === 1,
    },
    tyrionDerived: {
      kidName: row.kidName ? safeText(row.kidName, 'Household member', 100) : null,
      attributionStatus: row.attributionStatus,
      confidence: row.confidence,
      method: row.method,
    },
  };
}

function resolveKid(kidName: string): {
  id: string;
  name: string;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
} {
  const rows = sqlite.prepare(`
    SELECT id, name, daily_limit AS dailyLimit, weekly_limit AS weeklyLimit,
           monthly_limit AS monthlyLimit
    FROM kid_profiles
    WHERE lower(name) = lower(?)
    ORDER BY id
    LIMIT 2
  `).all(kidName) as Array<{
    id: string;
    name: string;
    dailyLimit: number | null;
    weeklyLimit: number | null;
    monthlyLimit: number | null;
  }>;
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

function queryTransactions(
  connectorId: string,
  input: FinanceTransactionSearchInput & { kidId?: string },
  range: { startDate: string; endDate: string },
): { rows: SafeTransactionRow[]; truncated: boolean } {
  const conditions = [
    't.connector_instance_id = ?',
    `t.lifecycle_status = 'active'`,
    't.date >= ?',
    't.date <= ?',
  ];
  const parameters: Array<string | number> = [connectorId, range.startDate, range.endDate];
  if (input.query) {
    conditions.push(`lower(COALESCE(t.merchant_name, '')) LIKE ? ESCAPE '\\'`);
    parameters.push(`%${input.query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (input.category) {
    conditions.push('lower(COALESCE(t.confirmed_category, t.original_category, ?)) = lower(?)');
    parameters.push('', input.category);
  }
  if (input.kidId) {
    conditions.push('t.assigned_kid_id = ?');
    parameters.push(input.kidId);
  }
  if (input.triageStatus) {
    conditions.push('t.triage_status = ?');
    parameters.push(input.triageStatus);
  }
  const limit = input.limit ?? 15;
  parameters.push(limit + 1);
  const rows = sqlite.prepare(`
    SELECT t.date, t.amount, t.merchant_name AS merchant,
           COALESCE(t.confirmed_category, t.original_category) AS category,
           t.is_pending AS pending, t.is_recurring AS recurring,
           profiles.name AS kidName, t.attribution_status AS attributionStatus,
           t.attribution_confidence AS confidence, t.attribution_method AS method
    FROM finance_transactions t
    LEFT JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ?
  `).all(...parameters) as SafeTransactionRow[];
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function getHouseholdFinanceSummary(
  input: HouseholdFinanceSummaryInput,
  options: ExecutionOptions = {},
): Promise<HouseholdFinanceSummaryOutput> {
  const now = options.now ?? new Date();
  const connector = await selectConnector(options.signal);
  const range = resolveRange(input, now);
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      transactionMeta(connector.id, connector.pollIntervalMinutes, now),
      range,
    ),
    connector.pollIntervalMinutes,
    now,
  );
  const total = sqlite.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS amount, COUNT(*) AS transactionCount
    FROM finance_transactions
    WHERE connector_instance_id = ? AND lifecycle_status = 'active'
      AND date >= ? AND date <= ?
  `).get(connector.id, range.startDate, range.endDate) as {
    amount: number;
    transactionCount: number;
  };
  const categoryRows = sqlite.prepare(`
    SELECT COALESCE(confirmed_category, original_category, 'Uncategorized') AS category,
           COALESCE(SUM(ABS(amount)), 0) AS amount, COUNT(*) AS transactionCount
    FROM finance_transactions
    WHERE connector_instance_id = ? AND lifecycle_status = 'active'
      AND date >= ? AND date <= ?
    GROUP BY COALESCE(confirmed_category, original_category, 'Uncategorized')
    ORDER BY amount DESC, category
    LIMIT 13
  `).all(connector.id, range.startDate, range.endDate) as Array<{
    category: string;
    amount: number;
    transactionCount: number;
  }>;
  const kidRows = sqlite.prepare(`
    SELECT profiles.name AS kidName, COALESCE(SUM(ABS(t.amount)), 0) AS amount,
           COUNT(*) AS transactionCount
    FROM finance_transactions t
    INNER JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
    WHERE t.connector_instance_id = ? AND t.lifecycle_status = 'active'
      AND t.date >= ? AND t.date <= ?
    GROUP BY profiles.id, profiles.name
    ORDER BY amount DESC, profiles.name
    LIMIT 13
  `).all(connector.id, range.startDate, range.endDate) as Array<{
    kidName: string;
    amount: number;
    transactionCount: number;
  }>;
  throwIfAborted(options.signal);
  const truncated = categoryRows.length > 12 || kidRows.length > 12;
  return output(householdFinanceSummaryOutputSchema, {
    kind: 'household-finance-summary',
    period: range,
    missionControlCalculated: {
      totalSpending: roundCurrency(total.amount),
      transactionCount: total.transactionCount,
      byCategory: categoryRows.slice(0, 12).map((row) => ({
        category: safeText(row.category, 'Uncategorized', 100),
        amount: roundCurrency(row.amount),
        transactionCount: row.transactionCount,
      })),
      byKid: kidRows.slice(0, 12).map((row) => ({
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
  const connector = await selectConnector(options.signal);
  const range = resolveRange(input, now);
  const kid = input.kidName ? resolveKid(input.kidName) : null;
  const result = queryTransactions(connector.id, { ...input, kidId: kid?.id }, range);
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      transactionMeta(connector.id, connector.pollIntervalMinutes, now),
      range,
    ),
    connector.pollIntervalMinutes,
    now,
  );
  throwIfAborted(options.signal);
  return output(financeTransactionSearchOutputSchema, {
    kind: 'finance-transaction-search',
    transactions: result.rows.map(safeTransaction),
    meta: meta(projection, result.truncated, '/finance', [true, true, false]),
  });
}

export async function getPendingFinanceExceptions(
  input: PendingFinanceExceptionsInput,
  options: ExecutionOptions = {},
): Promise<PendingFinanceExceptionsOutput> {
  const now = options.now ?? new Date();
  const connector = await selectConnector(options.signal);
  const limit = input.limit ?? 10;
  const result = listAttributionExceptions(connector.id, {
    status: 'current',
    limit: String(limit),
  });
  const projection = applyAttributionFreshness(
    transactionMeta(connector.id, connector.pollIntervalMinutes, now),
    connector.pollIntervalMinutes,
    now,
  );
  const subjects = new Map(
    (result.subjects as Array<{ kidId: string; name: string }>).map((subject) => [
      subject.kidId,
      subject.name,
    ]),
  );
  throwIfAborted(options.signal);
  return output(pendingFinanceExceptionsOutputSchema, {
    kind: 'pending-finance-exceptions',
    exceptions: (result.exceptions as Array<Record<string, unknown>>).map((exception) => {
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
    meta: meta(projection, result.nextCursor !== null, '/finance/review', [true, true, false]),
  });
}

export async function getKidSpending(
  input: KidSpendingInput,
  options: ExecutionOptions = {},
): Promise<KidSpendingOutput> {
  const now = options.now ?? new Date();
  const connector = await selectConnector(options.signal);
  const kid = resolveKid(input.kidName);
  const range = resolveRange(input, now);
  const result = queryTransactions(
    connector.id,
    { ...input, kidId: kid.id },
    range,
  );
  const totals = sqlite.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS amount, COUNT(*) AS transactionCount
    FROM finance_transactions
    WHERE connector_instance_id = ? AND lifecycle_status = 'active'
      AND assigned_kid_id = ? AND date >= ? AND date <= ?
  `).get(connector.id, kid.id, range.startDate, range.endDate) as {
    amount: number;
    transactionCount: number;
  };
  const projection = applyAttributionFreshness(
    applyRangeCoverage(
      transactionMeta(connector.id, connector.pollIntervalMinutes, now),
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
      totalSpending: roundCurrency(totals.amount),
      transactionCount: totals.transactionCount,
      dailyLimit: kid.dailyLimit === null ? null : roundCurrency(kid.dailyLimit),
      weeklyLimit: kid.weeklyLimit === null ? null : roundCurrency(kid.weeklyLimit),
      monthlyLimit: kid.monthlyLimit === null ? null : roundCurrency(kid.monthlyLimit),
    },
    recentTransactions: result.rows.map(safeTransaction),
    meta: meta(projection, result.truncated, '/finance', [true, true, true]),
  });
}

export async function getFinanceObligations(
  input: FinanceObligationsInput,
  options: ExecutionOptions = {},
): Promise<FinanceObligationsOutput> {
  const now = options.now ?? new Date();
  const connector = await selectConnector(options.signal);
  const health = getFinanceDatasetHealth(connector.id, now);
  const recurringHealth = health.datasets.find((dataset) => dataset.dataset === 'recurring');
  const limit = input.limit ?? 15;
  const horizonDays = input.horizonDays ?? 90;
  const horizonStart = formatDateInLocalTimezone(now);
  const horizonEnd = formatDateInLocalTimezone(new Date(now.getTime() + horizonDays * DAY_MS));
  const rows = sqlite.prepare(`
    SELECT merchant, amount, frequency, next_expected_date AS nextExpectedDate,
           category_name AS category
    FROM finance_recurring_obligations
    WHERE connector_id = ? AND is_current = 1
      AND next_expected_date >= ? AND next_expected_date <= ?
    ORDER BY next_expected_date, merchant
    LIMIT ?
  `).all(connector.id, horizonStart, horizonEnd, limit + 1) as Array<{
    merchant: string;
    amount: number;
    frequency: string;
    nextExpectedDate: string | null;
    category: string | null;
  }>;
  const page = rows.slice(0, limit);
  const aggregate = sqlite.prepare(`
    SELECT COALESCE(SUM(ABS(amount) * CASE lower(frequency)
      WHEN 'weekly' THEN 52.0 / 12.0
      WHEN 'biweekly' THEN 26.0 / 12.0
      WHEN 'every two weeks' THEN 26.0 / 12.0
      WHEN 'quarterly' THEN 1.0 / 3.0
      WHEN 'annual' THEN 1.0 / 12.0
      WHEN 'annually' THEN 1.0 / 12.0
      WHEN 'yearly' THEN 1.0 / 12.0
      ELSE 1.0
    END), 0) AS estimatedMonthlyAmount
    FROM finance_recurring_obligations
    WHERE connector_id = ? AND is_current = 1
      AND next_expected_date >= ? AND next_expected_date <= ?
  `).get(connector.id, horizonStart, horizonEnd) as { estimatedMonthlyAmount: number };
  throwIfAborted(options.signal);
  return output(financeObligationsOutputSchema, {
    kind: 'finance-obligations',
    horizonDays,
    obligations: page.map((row) => ({
      factsViaTyrionBridge: {
        merchant: safeText(row.merchant, 'Unknown merchant', 120),
        amount: roundCurrency(row.amount),
        frequency: safeText(row.frequency, 'unknown', 40),
        nextExpectedDate: row.nextExpectedDate,
        category: row.category ? safeText(row.category, 'Uncategorized', 100) : null,
      },
    })),
    missionControlCalculated: {
      estimatedMonthlyAmount: roundCurrency(aggregate.estimatedMonthlyAmount),
    },
    meta: {
      sourceAsOf: recurringHealth?.sourceAsOf ?? null,
      coverage: recurringHealth?.coverage ?? null,
      freshness: recurringHealth?.state ?? 'unavailable',
      truncated: rows.length > limit,
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
  const connector = await selectConnector(options.signal);
  const projection = applyAttributionFreshness(
    transactionMeta(connector.id, connector.pollIntervalMinutes, now),
    connector.pollIntervalMinutes,
    now,
  );
  const health = getFinanceDatasetHealth(connector.id, now);
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
