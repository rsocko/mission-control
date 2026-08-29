import 'server-only';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
  type AssignFinanceTransactionKidInput,
  type AssignFinanceTransactionKidOutput,
  type UpdateFinanceTransactionCategoryInput,
  type UpdateFinanceTransactionCategoryOutput,
  assignFinanceTransactionKidOutputSchema,
  updateFinanceTransactionCategoryOutputSchema,
} from './houston-contracts';
import {
  applyManualAttributionDecision,
  FinanceAttributionMutationError,
} from '@/lib/connectors/monarch-money/attribution-service';
import {
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';
import { updateFinanceCategory } from '@/lib/connectors/monarch-money/snapshot-sync';
import type { ConnectorConfig } from '@/types';

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
  id: string;
  connectorId: string;
  date: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  confirmedCategory: string | null;
  pending: number;
  recurring: number;
  kidName: string | null;
  attributionStatus: 'attributed' | 'unassigned' | 'pending' | 'unavailable';
  confidence: 'definite' | 'likely' | 'none' | null;
  method:
    | 'manual'
    | 'account-rule'
    | 'merchant-rule'
    | 'historical-pattern'
    | 'unassigned'
    | 'unavailable'
    | null;
  assignedKidId: string | null;
  sourceFingerprint: string;
  lastSeenAt: string;
  manualDecidedAt: string | null;
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

function loadFinanceConnectorConfig(connectorId: string): ConnectorConfig {
  const row = sqlite.prepare(`
    SELECT id, type, name, enabled, sync_mode AS syncMode,
           poll_interval_minutes AS pollIntervalMinutes, capabilities,
           credentials, settings, synced_lists AS syncedLists
    FROM connector_configs
    WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
  `).get(connectorId) as {
    id: string;
    type: string;
    name: string;
    enabled: number;
    syncMode: string;
    pollIntervalMinutes: number | null;
    capabilities: string;
    credentials: string;
    settings: string;
    syncedLists: string;
  } | undefined;
  if (!row) {
    throw new HoustonFinanceToolError(
      'finance_not_configured',
      'No enabled finance connector is configured.',
    );
  }
  const capabilityValues = JSON.parse(row.capabilities) as Record<string, unknown>;
  const capability = (name: string) => capabilityValues[name] === true;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled === 1,
    syncMode: row.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
    capabilities: {
      read: capability('read'),
      write: capability('write'),
      delete: capability('delete'),
      sync: capability('sync'),
      subtasks: capability('subtasks'),
      lists: capability('lists'),
      tags: capability('tags'),
      tagWriteBack: capability('tagWriteBack'),
    },
    credentials: JSON.parse(row.credentials) as Record<string, string>,
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    syncedLists: JSON.parse(row.syncedLists) as string[],
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

function safeTransaction(row: SafeTransactionRow) {
  const transactionRef = opaqueDigest('txn', row.connectorId, row.id);
  const stateToken = transactionStateToken(row);
  return {
    target: { transactionRef, stateToken },
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

function opaqueDigest(prefix: 'txn' | 'state', ...values: Array<string | number | null>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([prefix, ...values]))
    .digest('base64url');
  return `${prefix}_${digest}`;
}

function transactionStateToken(row: SafeTransactionRow): string {
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
    conditions.push('lower(COALESCE(categories.name, t.confirmed_category, t.original_category, ?)) = lower(?)');
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
    SELECT t.id, t.connector_instance_id AS connectorId,
           t.date, t.amount, t.merchant_name AS merchant,
           COALESCE(categories.name, t.confirmed_category, t.original_category) AS category,
           t.confirmed_category AS confirmedCategory,
           t.is_pending AS pending, t.is_recurring AS recurring,
           profiles.name AS kidName, t.attribution_status AS attributionStatus,
           t.attribution_confidence AS confidence, t.attribution_method AS method,
           t.assigned_kid_id AS assignedKidId,
           t.source_fingerprint AS sourceFingerprint, t.last_seen_at AS lastSeenAt,
           t.manual_decided_at AS manualDecidedAt
    FROM finance_transactions t
    LEFT JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
    LEFT JOIN finance_categories categories
      ON categories.connector_id = t.connector_instance_id
      AND categories.upstream_category_id = t.confirmed_category
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
    SELECT COALESCE(categories.name, transactions.confirmed_category,
                    transactions.original_category, 'Uncategorized') AS category,
           COALESCE(SUM(ABS(transactions.amount)), 0) AS amount,
           COUNT(*) AS transactionCount
    FROM finance_transactions transactions
    LEFT JOIN finance_categories categories
      ON categories.connector_id = transactions.connector_instance_id
      AND categories.upstream_category_id = transactions.confirmed_category
    WHERE transactions.connector_instance_id = ?
      AND transactions.lifecycle_status = 'active'
      AND transactions.date >= ? AND transactions.date <= ?
    GROUP BY COALESCE(categories.name, transactions.confirmed_category,
                      transactions.original_category, 'Uncategorized')
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

export type HoustonFinanceApprovalAuditOutcome =
  | 'denied'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'invalid-approval';

export function recordHoustonFinanceApprovalAudit(input: {
  approvalId: string;
  correlationId: string;
  toolName: string;
  decision: 'approve' | 'deny';
  outcome: HoustonFinanceApprovalAuditOutcome;
  durationMs: number;
}): void {
  sqlite.prepare(`
    INSERT INTO houston_finance_action_audit (
      id, correlation_id, call_hash, tool, decision, outcome, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    safeText(input.correlationId, 'unavailable', 128),
    input.approvalId,
    input.toolName,
    input.decision,
    input.outcome,
    Math.max(0, Math.round(input.durationMs)),
    new Date().toISOString(),
  );
}

type MutationExecutionOptions = {
  approvalId: string;
  correlationId: string;
  signal?: AbortSignal;
  now?: Date;
};

function findMutationTarget(
  connectorId: string,
  transactionRef: string,
  expected: AssignFinanceTransactionKidInput['expected'],
): SafeTransactionRow {
  const rows = sqlite.prepare(`
    SELECT t.id, t.connector_instance_id AS connectorId,
           t.date, t.amount, t.merchant_name AS merchant,
           COALESCE(categories.name, t.confirmed_category, t.original_category) AS category,
           t.confirmed_category AS confirmedCategory,
           t.is_pending AS pending, t.is_recurring AS recurring,
           profiles.name AS kidName, t.attribution_status AS attributionStatus,
           t.attribution_confidence AS confidence, t.attribution_method AS method,
           t.assigned_kid_id AS assignedKidId,
           t.source_fingerprint AS sourceFingerprint, t.last_seen_at AS lastSeenAt,
           t.manual_decided_at AS manualDecidedAt
    FROM finance_transactions t
    LEFT JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
    LEFT JOIN finance_categories categories
      ON categories.connector_id = t.connector_instance_id
      AND categories.upstream_category_id = t.confirmed_category
    WHERE t.connector_instance_id = ? AND t.lifecycle_status = 'active'
      AND t.date = ? AND t.amount = ?
    ORDER BY t.id
    LIMIT 50
  `).all(connectorId, expected.date, expected.amount) as SafeTransactionRow[];
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
  target: SafeTransactionRow,
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

function assertMutationProjectionFresh(
  connectorId: string,
  pollIntervalMinutes: number | undefined,
  requireAttribution: boolean,
  now: Date,
): void {
  const base = transactionMeta(connectorId, pollIntervalMinutes, now);
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

function resolveProjectedKid(connectorId: string, kidName: string) {
  const rows = sqlite.prepare(`
    SELECT profiles.id, profiles.name
    FROM kid_profiles profiles
    INNER JOIN finance_attribution_subjects subjects
      ON subjects.kid_id = profiles.id AND subjects.connector_id = ?
    INNER JOIN finance_sync_state state
      ON state.connector_id = subjects.connector_id
      AND state.attribution_policy_version = subjects.policy_version
    WHERE lower(profiles.name) = lower(?)
    ORDER BY profiles.id
    LIMIT 2
  `).all(connectorId, kidName) as Array<{ id: string; name: string }>;
  if (rows.length === 0) {
    throw new HoustonFinanceToolError('finance_kid_not_found', 'No current household member matches that name.');
  }
  if (rows.length > 1) {
    throw new HoustonFinanceToolError('finance_kid_ambiguous', 'More than one current household member matches that name.');
  }
  return rows[0];
}

function resolveProjectedCategory(connectorId: string, categoryName: string) {
  const rows = sqlite.prepare(`
    SELECT upstream_category_id AS upstreamCategoryId, name
    FROM finance_categories
    WHERE connector_id = ? AND is_active = 1 AND source_is_active = 1
      AND lower(name) = lower(?)
    ORDER BY upstream_category_id
    LIMIT 2
  `).all(connectorId, categoryName) as Array<{ upstreamCategoryId: string; name: string }>;
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
  } else if (error instanceof FinanceAttributionMutationError) {
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

function replayedKidAssignment(idempotencyKey: string): string | null {
  const rows = sqlite.prepare(`
    SELECT profiles.name AS kidName
    FROM finance_attribution_audit audit
    LEFT JOIN kid_profiles profiles ON profiles.id = audit.requested_kid_id
    WHERE audit.idempotency_key = ? AND audit.result_status = 'resolved'
    LIMIT 2
  `).all(idempotencyKey) as Array<{ kidName: string | null }>;
  if (rows.length > 1) {
    throw new FinanceAttributionMutationError(
      'idempotency_conflict',
      'Approval identity matched more than one attribution decision',
      409,
    );
  }
  return rows.length === 1
    ? safeText(rows[0].kidName, 'Household member', 100)
    : null;
}

function replayedCategoryUpdate(idempotencyKey: string): string | null {
  const rows = sqlite.prepare(`
    SELECT categories.name AS categoryName
    FROM finance_mutation_audit audit
    LEFT JOIN finance_categories categories
      ON categories.connector_id = audit.connector_id
      AND categories.upstream_category_id = audit.requested_value
    WHERE audit.idempotency_key = ? AND audit.status = 'succeeded'
    LIMIT 2
  `).all(idempotencyKey) as Array<{ categoryName: string | null }>;
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

export async function assignFinanceTransactionKid(
  input: AssignFinanceTransactionKidInput,
  options: MutationExecutionOptions,
): Promise<AssignFinanceTransactionKidOutput> {
  const startedAt = performance.now();
  let outcome: HoustonFinanceApprovalAuditOutcome = 'failed';
  try {
    throwIfAborted(options.signal);
    const idempotencyKey = mutationIdempotencyKey(options);
    const replayedKidName = replayedKidAssignment(idempotencyKey);
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
    const connector = await selectConnector(options.signal);
    const transaction = findMutationTarget(connector.id, input.transactionRef, input.expected);
    const kid = resolveProjectedKid(connector.id, input.kidName);
    assertMutationProjectionFresh(
      connector.id,
      connector.pollIntervalMinutes,
      true,
      options.now ?? new Date(),
    );
    assertExpectedTransactionState(transaction, input.expected);
    const result = applyManualAttributionDecision({
      connectorId: connector.id,
      transactionId: transaction.id,
      action: 'assign-kid',
      kidId: kid.id,
      idempotencyKey,
      actorType: 'parent-admin',
      expectedTransactionVersion: {
        sourceFingerprint: transaction.sourceFingerprint,
        lastSeenAt: transaction.lastSeenAt,
        assignedKidId: transaction.assignedKidId,
        confirmedCategory: transaction.confirmedCategory,
        manualDecidedAt: transaction.manualDecidedAt,
      },
    });
    outcome = 'succeeded';
    return assignFinanceTransactionKidOutputSchema.parse({
      kind: 'finance-kid-assignment',
      status: 'updated',
      missionControlConfirmed: { kidName: safeText(kid.name, 'Household member', 100) },
      replayed: result.replayed,
      provenance: mutationProvenance(true),
    });
  } catch (error) {
    if (
      (
        error instanceof HoustonFinanceToolError
        && /changed after it was proposed|projection is not current/.test(error.message)
      )
      || (
        error instanceof FinanceAttributionMutationError
        && error.code === 'transaction_conflict'
      )
    ) {
      outcome = 'stale';
    }
    return assignFinanceTransactionKidOutputSchema.parse(
      mutationFailure('finance-kid-assignment', error),
    );
  } finally {
    recordHoustonFinanceApprovalAudit({
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
    const idempotencyKey = mutationIdempotencyKey(options);
    const replayedCategoryName = replayedCategoryUpdate(idempotencyKey);
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
    const connector = await selectConnector(options.signal);
    const transaction = findMutationTarget(connector.id, input.transactionRef, input.expected);
    const category = resolveProjectedCategory(connector.id, input.categoryName);
    assertMutationProjectionFresh(
      connector.id,
      connector.pollIntervalMinutes,
      false,
      options.now ?? new Date(),
    );
    assertExpectedTransactionState(transaction, input.expected);
    const config = loadFinanceConnectorConfig(connector.id);
    await updateFinanceCategory(
      config,
      transaction.id,
      category.upstreamCategoryId,
      idempotencyKey,
      options.signal,
      {
        sourceFingerprint: transaction.sourceFingerprint,
        lastSeenAt: transaction.lastSeenAt,
        assignedKidId: transaction.assignedKidId,
        confirmedCategory: transaction.confirmedCategory,
        manualDecidedAt: transaction.manualDecidedAt,
        categoryName: category.name,
      },
    );
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
    recordHoustonFinanceApprovalAudit({
      approvalId: options.approvalId,
      correlationId: options.correlationId,
      toolName: 'updateFinanceTransactionCategory',
      decision: 'approve',
      outcome,
      durationMs: performance.now() - startedAt,
    });
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
