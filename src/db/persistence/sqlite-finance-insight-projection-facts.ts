import type Database from 'better-sqlite3';
import {
  financeConnectorScopedReference,
  financeIdentityNamespaceFromCredentials,
} from '@/lib/connectors/monarch-money/identity';
import type {
  FinanceInsightOperationalFactKind,
  FinanceInsightOperationalProjectionFacts,
  FinanceInsightOperationalRecurringFact,
  FinanceInsightOperationalAccountFact,
} from './finance-insights';

type SqliteDatabase = Database.Database;

/**
 * SQLite-only synchronous read of live (non-staged) Monarch reference and
 * transaction facts, normalized/scoped identically to the async
 * `FinanceInsightPersistence.projection.readOperationalProjectionFacts` port
 * (see `finance-insights.ts` and both the SQLite and PostgreSQL adapters,
 * which this module backs on the SQLite side and must stay behaviorally
 * identical to). This helper exists only because two call sites must read
 * this data synchronously from inside an active `better-sqlite3`
 * transaction/callback and therefore cannot go through the async port:
 *  - `worker-runtime.ts`'s Layer 5A projection-proof callback
 *    (`projectionProofs.snapshot`/`.dataset`).
 *  - the SQLite finance-insights adapter's own
 *    `backfill.recordWindowCapture`, which tombstones and re-derives the
 *    live window digest inside one atomic `sqlite.transaction`.
 * Every other Layer 5B caller (transaction-backfill.ts, publication.ts) must
 * use the async port instead.
 */

function normalizedName(value: unknown, maximum: number, fallback: string): string {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function amountMinor(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value * 100);
  if (!Number.isSafeInteger(rounded)) throw new Error('invalid_amount_range');
  return rounded;
}

function recurringCadence(value: string): FinanceInsightOperationalRecurringFact['cadence'] {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'weekly') return 'weekly';
  if (['biweekly', 'fortnightly', 'every2weeks'].includes(normalized)) return 'biweekly';
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (['semiannual', 'semiannually', 'twiceyearly'].includes(normalized)) return 'semiannual';
  if (['annual', 'annually', 'yearly'].includes(normalized)) return 'annual';
  return 'unknown';
}

function accountType(value: string): FinanceInsightOperationalAccountFact['accountType'] {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('check')) return 'checking';
  if (normalized.includes('saving')) return 'savings';
  if (normalized.includes('credit')) return 'credit';
  if (normalized.includes('cash')) return 'cash';
  if (normalized.includes('loan') || normalized.includes('mortgage')) return 'loan';
  if (normalized.includes('invest') || normalized.includes('broker')) return 'investment';
  return 'other';
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function loadFinanceInsightProjectionFacts(
  sqlite: SqliteDatabase,
  connectorId: string,
  transactionStart: string,
  onlyKind?: FinanceInsightOperationalFactKind,
  transactionEnd?: string,
): FinanceInsightOperationalProjectionFacts {
  const connector = sqlite.prepare(`
    SELECT credentials FROM connector_configs WHERE id = ?
  `).get(connectorId) as { credentials: string | null } | undefined;
  if (!connector) throw new Error('Finance connector identity state is unavailable');
  const identityNamespace = financeIdentityNamespaceFromCredentials(connector.credentials);
  if (!identityNamespace) throw new Error('Finance connector identity state is invalid');
  const scoped = (kind: string, value: string | null): string | null => (
    value === null
      ? null
      : financeConnectorScopedReference(identityNamespace, kind, value)
  );
  const bySourceRef = <T extends { sourceRef: string }>(left: T, right: T): number => (
    left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0
  );
  const tagRows = onlyKind && onlyKind !== 'tag'
    ? []
    : sqlite.prepare(`
    SELECT upstream_tag_id AS sourceRef, name, is_active AS active
    FROM finance_tags WHERE connector_id = ?
    ORDER BY upstream_tag_id
  `).all(connectorId) as Array<{ sourceRef: string; name: string; active: number }>;
  const transactions = onlyKind && onlyKind !== 'transaction'
    ? []
    : (sqlite.prepare(`
    SELECT upstream_transaction_id AS sourceRef, date AS occurredOn, amount,
           merchant_name AS merchantName, category_id AS categoryRef,
           account_id AS accountRef, is_pending AS isPending, tag_references AS tagReferences
    FROM finance_transactions
    WHERE connector_instance_id = ? AND lifecycle_status = 'active'
      AND date >= ? AND (? IS NULL OR date <= ?)
    ORDER BY upstream_transaction_id
  `).all(
    connectorId,
    transactionStart,
    transactionEnd ?? null,
    transactionEnd ?? null,
  ) as Array<{
    sourceRef: string;
    occurredOn: string;
    amount: number;
    merchantName: string | null;
    categoryRef: string | null;
    accountRef: string | null;
    isPending: number;
    tagReferences: unknown;
  }>).map((row) => ({
    sourceRef: scoped('transaction', row.sourceRef)!,
    occurredOn: row.occurredOn,
    amountMinor: amountMinor(row.amount)!,
    merchantName: normalizedName(row.merchantName, 160, 'Unknown merchant'),
    categoryRef: scoped('category', row.categoryRef),
    accountRef: scoped('account', row.accountRef),
    isPending: row.isPending === 1,
    recurringRef: null,
    tagRefs: [...new Set(parseTags(row.tagReferences).map((value) => scoped('tag', value)!))].sort(),
  })).sort(bySourceRef);
  const recurring = onlyKind && onlyKind !== 'recurring'
    ? []
    : (sqlite.prepare(`
    SELECT upstream_recurring_id AS sourceRef, merchant, amount, frequency,
           next_expected_date AS nextDate, upstream_category_id AS categoryRef,
           upstream_account_id AS accountRef
    FROM finance_recurring_obligations
    WHERE connector_id = ? AND is_current = 1
    ORDER BY upstream_recurring_id
  `).all(connectorId) as Array<{
    sourceRef: string;
    merchant: string;
    amount: number | null;
    frequency: string;
    nextDate: string | null;
    categoryRef: string | null;
    accountRef: string | null;
  }>).map((row) => ({
    sourceRef: scoped('recurring', row.sourceRef)!,
    displayName: normalizedName(row.merchant, 120, 'Unknown recurring item'),
    amountMinor: amountMinor(row.amount),
    cadence: recurringCadence(row.frequency),
    nextDate: row.nextDate,
    categoryRef: scoped('category', row.categoryRef),
    accountRef: scoped('account', row.accountRef),
    active: true,
  })).sort(bySourceRef);
  const category = onlyKind && onlyKind !== 'category'
    ? []
    : (sqlite.prepare(`
    SELECT upstream_category_id AS sourceRef, name, upstream_group_id AS groupRef,
           is_active AS active
    FROM finance_categories WHERE connector_id = ?
    ORDER BY upstream_category_id
  `).all(connectorId) as Array<{
    sourceRef: string;
    name: string;
    groupRef: string | null;
    active: number;
  }>).map((row) => ({
    sourceRef: scoped('category', row.sourceRef)!,
    displayName: normalizedName(row.name, 120, 'Unknown category'),
    groupRef: scoped('category-group', row.groupRef),
    active: row.active === 1,
  })).sort(bySourceRef);
  const account = onlyKind && onlyKind !== 'account'
    ? []
    : (sqlite.prepare(`
    SELECT upstream_account_id AS sourceRef, type, is_active AS active
    FROM finance_accounts WHERE connector_id = ?
    ORDER BY upstream_account_id
  `).all(connectorId) as Array<{ sourceRef: string; type: string; active: number }>)
    .map((row) => ({
      sourceRef: scoped('account', row.sourceRef)!,
      accountType: accountType(row.type),
      active: row.active === 1,
    }))
    .sort(bySourceRef);
  const tag = tagRows.map((row) => ({
    sourceRef: scoped('tag', row.sourceRef)!,
    displayName: normalizedName(row.name, 120, 'Unknown tag'),
    active: row.active === 1,
  })).sort(bySourceRef);
  return { transaction: transactions, recurring, category, account, tag };
}
