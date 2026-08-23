import 'server-only';

import { sqlite } from '@/db';
import {
  buildFinanceInsightHistoryWindows,
  financeInsightHistoryGenerationRef,
  FINANCE_INSIGHT_HISTORY_MONTHS,
} from '@/lib/connectors/monarch-money/finance-insight-history-sync';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import logger from '@/lib/logger';
import type { ConnectorConfig, DomainSyncResult } from '@/types';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import {
  FINANCE_INSIGHT_BATCH_SIZE,
  FINANCE_INSIGHT_FACT_KINDS,
  FINANCE_INSIGHT_ITEM_LIMITS,
  FINANCE_INSIGHT_MAX_REQUEST_BYTES,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  accountSourceFactSchema,
  categorySourceFactSchema,
  currencySchema,
  recurringSourceFactSchema,
  sourceFactBatchSchema,
  sourceGenerationCommitRequestSchema,
  sourceGenerationCreateRequestSchema,
  tagSourceFactSchema,
  transactionSourceFactSchema,
  type SourceFactBatchV1,
  type SourceFactKindV1,
  type TransactionSourceFactV1,
  type RecurringSourceFactV1,
  type CategorySourceFactV1,
  type AccountSourceFactV1,
  type TagSourceFactV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
} from './contract';
import { normalizeFinanceProviderAlias } from './provider';
import {
  ensureFinanceIdentityNamespace,
  financeConnectorScopedReference,
  validateFinanceConnectorScopedReference,
} from '@/lib/connectors/monarch-money/identity';

export const FINANCE_INSIGHT_PUBLICATION_CACHE_COUNT = 3;
export const FINANCE_INSIGHT_PUBLICATION_FALLBACK_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_ALERT_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

type SourceFact = SourceFactBatchV1['facts'][number];
type ProjectionFacts = {
  transaction: TransactionSourceFactV1[];
  recurring: RecurringSourceFactV1[];
  category: CategorySourceFactV1[];
  account: AccountSourceFactV1[];
  tag: TagSourceFactV1[];
};
type SourceFactBatches = Record<SourceFactKindV1, SourceFact[][]>;
type CaptureResult =
  | { status: 'captured' | 'idempotent'; publicationId: string; sourceSequence: number }
  | { status: 'refused' | 'failed'; code: string };

type DatasetState = {
  dataset: string;
  generationId: string | null;
  sourceAsOf: string | null;
  freshUntil: string | null;
  outcome: 'succeeded' | 'failed' | null;
  itemCount: number | null;
  contentDigest: string | null;
  bridgeContractVersion: string | null;
};

type TransactionState = {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  generationId: string | null;
  successfulAt: string | null;
  sourceAsOf: string | null;
  itemCount: number | null;
  contentDigest: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  windowCount: number | null;
  windowsDigest: string | null;
  bridgeContractVersion: string | null;
};

type TransactionWindowProof = {
  index: number;
  start: string;
  end: string;
  sourceAsOf: string;
  itemCount: number;
  digest: string;
};

type PreparedPublication = {
  generationIdentity: string;
  requestWithoutSequence: Omit<
    SourceGenerationCreateRequestV1,
    'sourceGeneration' | 'sourceSequence' | 'idempotencyKey'
  >;
  facts: ProjectionFacts;
  batches: SourceFactBatches;
};

function stableIdentifier(prefix: string, digest: string): string {
  return `${prefix}:${digest.replace('sha256:', '')}`;
}

const publicationIdPlaceholder = stableIdentifier(
  'finance-publication-v1',
  `sha256:${'0'.repeat(64)}`,
);

function sourceFactBatchValue(
  sourceGeneration: string,
  kind: SourceFactKindV1,
  batchIndex: number,
  facts: SourceFact[],
) {
  const digest = financeInsightDigestV1(facts as CanonicalJsonValue);
  const input = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    sourceGeneration,
    kind,
    batchIndex,
    facts,
    digest,
  };
  return {
    ...input,
    idempotencyKey: stableIdentifier(
      `finance-batch-v1:${kind}:${batchIndex}`,
      financeInsightDigestV1(input as CanonicalJsonValue),
    ),
  };
}

function batchRequestBytes(
  kind: SourceFactKindV1,
  batchIndex: number,
  facts: SourceFact[],
): number {
  return new TextEncoder().encode(JSON.stringify(
    sourceFactBatchValue(publicationIdPlaceholder, kind, batchIndex, facts),
  )).byteLength;
}

function partitionFacts(
  kind: SourceFactKindV1,
  facts: SourceFact[],
): SourceFact[][] {
  const batches: SourceFact[][] = [];
  let current: SourceFact[] = [];
  for (const fact of facts) {
    const candidate = [...current, fact];
    if (
      candidate.length > FINANCE_INSIGHT_BATCH_SIZE
      || batchRequestBytes(kind, batches.length, candidate) > FINANCE_INSIGHT_MAX_REQUEST_BYTES
    ) {
      if (current.length === 0) throw new Error('single_fact_exceeds_batch_limit');
      batches.push(current);
      current = [fact];
      if (
        batchRequestBytes(kind, batches.length, current)
        > FINANCE_INSIGHT_MAX_REQUEST_BYTES
      ) {
        throw new Error('single_fact_exceeds_batch_limit');
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

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

function recurringCadence(value: string): 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
  | 'semiannual' | 'annual' | 'unknown' {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'weekly') return 'weekly';
  if (['biweekly', 'fortnightly', 'every2weeks'].includes(normalized)) return 'biweekly';
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (['semiannual', 'semiannually', 'twiceyearly'].includes(normalized)) return 'semiannual';
  if (['annual', 'annually', 'yearly'].includes(normalized)) return 'annual';
  return 'unknown';
}

function accountType(value: string): 'checking' | 'savings' | 'credit' | 'cash'
  | 'loan' | 'investment' | 'other' {
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
  connectorId: string,
  transactionStart: string,
  onlyKind?: SourceFactKindV1,
  transactionEnd?: string,
): ProjectionFacts {
  const identityNamespace = ensureFinanceIdentityNamespace(connectorId);
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

export function loadFinanceInsightPublicationProjectionFacts(
  connectorId: string,
  transactionGenerationId: string,
): ProjectionFacts {
  const scoped = (kind: string, value: string | null): string | null => (
    validateFinanceConnectorScopedReference(kind, value)
  );
  const transaction = (sqlite.prepare(`
    SELECT payload
    FROM finance_insight_transaction_projection_facts
    WHERE connector_id = ? AND generation_id = ?
    ORDER BY source_ref
  `).all(connectorId, transactionGenerationId) as Array<{ payload: string }>)
    .map((row) => {
      const fact = transactionSourceFactSchema.parse(JSON.parse(row.payload));
      return transactionSourceFactSchema.parse({
        ...fact,
        sourceRef: scoped('transaction', fact.sourceRef),
        categoryRef: scoped('category', fact.categoryRef),
        accountRef: scoped('account', fact.accountRef),
        recurringRef: scoped('recurring', fact.recurringRef),
        tagRefs: fact.tagRefs.map((value) => scoped('tag', value)!),
      });
    });
  return {
    transaction,
    recurring: loadFinanceInsightProjectionFacts(connectorId, '', 'recurring').recurring,
    category: loadFinanceInsightProjectionFacts(connectorId, '', 'category').category,
    account: loadFinanceInsightProjectionFacts(connectorId, '', 'account').account,
    tag: loadFinanceInsightProjectionFacts(connectorId, '', 'tag').tag,
  };
}

function preparePublication(
  config: ConnectorConfig,
  syncResult: DomainSyncResult,
  now: Date,
): PreparedPublication | { code: string } {
  const providerType = normalizeFinanceProviderAlias(config.type);
  if (!providerType) return { code: 'unsupported_finance_provider' };
  if (syncResult.status !== 'fresh' || Object.keys(syncResult.datasetErrors ?? {}).length > 0) {
    return { code: 'partial_projection' };
  }
  const currency = currencySchema.safeParse(
    (config.settings as Record<string, unknown> | undefined)?.householdCurrency,
  );
  if (!currency.success) {
    return { code: 'household_currency_unavailable' };
  }
  const transactionState = sqlite.prepare(`
    SELECT status, successful_generation_id AS generationId,
           last_successful_at AS successfulAt, source_as_of AS sourceAsOf,
           item_count AS itemCount, content_digest AS contentDigest,
           coverage_start AS coverageStart, coverage_end AS coverageEnd,
           window_count AS windowCount, windows_digest AS windowsDigest,
           bridge_contract_version AS bridgeContractVersion
    FROM finance_insight_transaction_projection_state
    WHERE connector_id = ?
  `).get(config.id) as TransactionState | undefined;
  const transactionSuccessfulAt = Date.parse(transactionState?.successfulAt ?? '');
  const transactionSourceAsOf = Date.parse(transactionState?.sourceAsOf ?? '');
  if (
    !transactionState
    || transactionState.status !== 'succeeded'
    || !transactionState.generationId
    || !transactionState.successfulAt
    || !transactionState.sourceAsOf
    || transactionState.itemCount === null
    || !transactionState.contentDigest
    || !transactionState.coverageStart
    || !transactionState.coverageEnd
    || transactionState.windowCount !== FINANCE_INSIGHT_HISTORY_MONTHS
    || !transactionState.windowsDigest
    || transactionState.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
    || !Number.isFinite(transactionSuccessfulAt)
    || !Number.isFinite(transactionSourceAsOf)
    || transactionSuccessfulAt > now.getTime()
    || transactionSourceAsOf > now.getTime()
    || now.getTime() - transactionSourceAsOf > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
  ) {
    return { code: 'transaction_projection_unavailable' };
  }
  const requiredDatasets = new Map<SourceFactKindV1, string>([
    ['recurring', 'recurring'],
    ['category', 'categories'],
    ['account', 'accounts'],
    ['tag', 'tags'],
  ]);
  const datasetRows = sqlite.prepare(`
    SELECT dataset, current_generation_id AS generationId,
           source_as_of AS sourceAsOf, fresh_until AS freshUntil,
           last_attempt_outcome AS outcome,
           insight_item_count AS itemCount,
           insight_content_digest AS contentDigest,
           insight_bridge_contract_version AS bridgeContractVersion
    FROM finance_dataset_sync_state
    WHERE connector_id = ?
  `).all(config.id) as DatasetState[];
  const byDataset = new Map(datasetRows.map((row) => [row.dataset, row]));
  for (const dataset of requiredDatasets.values()) {
    const row = byDataset.get(dataset);
    const sourceAsOf = Date.parse(row?.sourceAsOf ?? '');
    const freshUntil = Date.parse(row?.freshUntil ?? '');
    if (
      !row
      || row.outcome !== 'succeeded'
      || !row.generationId
      || !row.sourceAsOf
      || !row.freshUntil
      || row.itemCount === null
      || !row.contentDigest
      || row.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
      || !Number.isFinite(sourceAsOf)
      || !Number.isFinite(freshUntil)
      || sourceAsOf > now.getTime()
      || freshUntil < now.getTime()
    ) {
      return { code: `${dataset}_projection_unavailable` };
    }
  }
  let facts: ProjectionFacts;
  let batches: SourceFactBatches;
  try {
    facts = loadFinanceInsightPublicationProjectionFacts(
      config.id,
      transactionState.generationId,
    );
    const validators = {
      transaction: transactionSourceFactSchema,
      recurring: recurringSourceFactSchema,
      category: categorySourceFactSchema,
      account: accountSourceFactSchema,
      tag: tagSourceFactSchema,
    } as const;
    for (const kind of FINANCE_INSIGHT_FACT_KINDS) {
      if (facts[kind].length > FINANCE_INSIGHT_ITEM_LIMITS[kind]) {
        return { code: `${kind}_generation_too_large` };
      }
      if (facts[kind].some((fact) => !validators[kind].safeParse(fact).success)) {
        return { code: 'invalid_projection_fact' };
      }
    }
    batches = {
      transaction: partitionFacts('transaction', facts.transaction),
      recurring: partitionFacts('recurring', facts.recurring),
      category: partitionFacts('category', facts.category),
      account: partitionFacts('account', facts.account),
      tag: partitionFacts('tag', facts.tag),
    };
  } catch {
    return { code: 'invalid_projection_fact' };
  }
  const factDigests = Object.fromEntries(
    FINANCE_INSIGHT_FACT_KINDS.map((kind) => [
      kind,
      financeInsightDigestV1(facts[kind] as CanonicalJsonValue),
    ]),
  ) as Record<SourceFactKindV1, string>;
  if (
    facts.transaction.length !== transactionState.itemCount
    || factDigests.transaction !== transactionState.contentDigest
  ) {
    return { code: 'transaction_projection_changed' };
  }
  for (const [kind, datasetName] of requiredDatasets) {
    const proof = byDataset.get(datasetName)!;
    if (
      facts[kind].length !== proof.itemCount
      || factDigests[kind] !== proof.contentDigest
    ) {
      return { code: `${datasetName}_projection_changed` };
    }
  }
  const coverageStart = transactionState.coverageStart;
  const coverageEnd = transactionState.coverageEnd;
  let expectedWindows: ReturnType<typeof buildFinanceInsightHistoryWindows>;
  try {
    expectedWindows = buildFinanceInsightHistoryWindows(coverageEnd);
  } catch {
    return { code: 'transaction_projection_coverage_invalid' };
  }
  const windowProofs = sqlite.prepare(`
    SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
           source_as_of AS sourceAsOf, item_count AS itemCount,
           content_digest AS digest
    FROM finance_insight_transaction_projection_windows
    WHERE connector_id = ? AND generation_id = ?
    ORDER BY window_index
  `).all(config.id, transactionState.generationId) as TransactionWindowProof[];
  const expectedWindowShape = expectedWindows.every((expected, index) => {
    const actual = windowProofs[index];
    return actual?.index === expected.index
      && actual.start === expected.start
      && actual.end === expected.end;
  });
  const windowSourceAsOf = windowProofs
    .map((window) => window.sourceAsOf)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const windowTimes = windowProofs.map((window) => Date.parse(window.sourceAsOf));
  const windowFactsValid = windowProofs.every((window) => {
    const values = facts.transaction.filter(
      (fact) => fact.occurredOn >= window.start && fact.occurredOn <= window.end,
    );
    return values.length === window.itemCount
      && financeInsightDigestV1(values as CanonicalJsonValue) === window.digest;
  });
  if (
    coverageStart !== expectedWindows[0]?.start
    || coverageEnd !== now.toISOString().slice(0, 10)
    || windowProofs.length !== FINANCE_INSIGHT_HISTORY_MONTHS
    || !expectedWindowShape
    || !windowFactsValid
    || windowProofs.reduce((sum, window) => sum + window.itemCount, 0) !== facts.transaction.length
    || financeInsightDigestV1(windowProofs as CanonicalJsonValue) !== transactionState.windowsDigest
    || windowSourceAsOf !== transactionState.sourceAsOf
    || windowTimes.some((value) => !Number.isFinite(value) || value > now.getTime())
    || Math.max(...windowTimes) - Math.min(...windowTimes) > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
    || transactionState.generationId !== financeInsightHistoryGenerationRef({
      connectorRef: config.id,
      sourceAsOf: transactionState.sourceAsOf,
      itemCount: transactionState.itemCount,
      contentDigest: transactionState.contentDigest,
      coverageStart,
      coverageEnd,
      windowCount: transactionState.windowCount,
      windowsDigest: transactionState.windowsDigest,
      bridgeContractVersion: transactionState.bridgeContractVersion,
    })
  ) {
    return { code: 'transaction_projection_coverage_invalid' };
  }
  const transactionAsOf = transactionState.sourceAsOf;
  const capturedConstituents = FINANCE_INSIGHT_FACT_KINDS.map((kind) => {
    const datasetName = requiredDatasets.get(kind);
    const dataset = datasetName ? byDataset.get(datasetName)! : null;
    const sourceAsOf = dataset?.sourceAsOf ?? transactionAsOf;
    const generationRef = dataset?.generationId ?? transactionState.generationId!;
    return {
      kind,
      generationRef,
      sourceAsOf,
      itemCount: facts[kind].length,
      digest: factDigests[kind],
    };
  });
  const constituentTimes = capturedConstituents.map((item) => Date.parse(item.sourceAsOf));
  if (
    Math.max(...constituentTimes) - Math.min(...constituentTimes)
    > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
  ) {
    return { code: 'constituent_freshness_skew' };
  }
  const manifest = FINANCE_INSIGHT_FACT_KINDS.map((kind) => {
    return {
      kind,
      batchCount: batches[kind].length,
      itemCount: facts[kind].length,
      digest: financeInsightDigestV1(
        batches[kind].map((batch) => financeInsightDigestV1(batch as CanonicalJsonValue)),
      ),
    };
  });
  const sourceAsOf = [...capturedConstituents]
    .sort((left, right) => Date.parse(left.sourceAsOf) - Date.parse(right.sourceAsOf))[0]!.sourceAsOf;
  const requestWithoutSequence: PreparedPublication['requestWithoutSequence'] = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    connectorRef: config.id,
    sourceAsOf,
    coverageStart,
    coverageEnd,
    currency: currency.data,
    bridgeContractVersion: transactionState.bridgeContractVersion,
    capturedConstituents,
    manifest,
  };
  return {
    generationIdentity: financeInsightDigestV1(requestWithoutSequence as CanonicalJsonValue),
    facts,
    batches,
    requestWithoutSequence,
  };
}

function recordCaptureOutcome(
  config: ConnectorConfig,
  now: string,
  outcome: 'refused' | 'failed',
  code: string,
): void {
  const providerType = normalizeFinanceProviderAlias(config.type) ?? 'finance-manager';
  sqlite.prepare(`
    INSERT INTO finance_insight_publication_state (
      connector_id, provider_type, last_capture_attempt_at, last_capture_outcome,
      last_error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connector_id) DO UPDATE SET
      provider_type = excluded.provider_type,
      last_capture_attempt_at = excluded.last_capture_attempt_at,
      last_capture_outcome = excluded.last_capture_outcome,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `).run(config.id, providerType, now, outcome, code, now, now);
}

export function captureFinanceInsightPublication(
  config: ConnectorConfig,
  syncResult: DomainSyncResult,
  clock: () => Date = () => new Date(),
): CaptureResult {
  const now = clock();
  const capturedAt = now.toISOString();
  try {
    return sqlite.transaction(() => {
      const prepared = preparePublication(config, syncResult, now);
      if ('code' in prepared) {
        recordCaptureOutcome(config, capturedAt, 'refused', prepared.code);
        return { status: 'refused' as const, code: prepared.code };
      }
      const state = sqlite.prepare(`
        SELECT latest_publication_id AS publicationId,
               latest_generation_identity AS generationIdentity,
               last_source_sequence AS sourceSequence
        FROM finance_insight_publication_state WHERE connector_id = ?
      `).get(config.id) as {
        publicationId: string | null;
        generationIdentity: string | null;
        sourceSequence: number;
      } | undefined;
      if (
        state?.publicationId
        && state.generationIdentity === prepared.generationIdentity
      ) {
        sqlite.prepare(`
          UPDATE finance_insight_publication_state
          SET last_capture_attempt_at = ?, last_capture_outcome = 'idempotent',
              last_error_code = NULL, updated_at = ?
          WHERE connector_id = ?
        `).run(capturedAt, capturedAt, config.id);
        return {
          status: 'idempotent' as const,
          publicationId: state.publicationId,
          sourceSequence: state.sourceSequence,
        };
      }
      const sourceSequence = (state?.sourceSequence ?? 0) + 1;
      const publicationId = stableIdentifier('finance-publication-v1', prepared.generationIdentity);
      const idempotencyKey = stableIdentifier('finance-generation-v1', prepared.generationIdentity);
      const createRequest = sourceGenerationCreateRequestSchema.parse({
        ...prepared.requestWithoutSequence,
        sourceGeneration: publicationId,
        sourceSequence,
        idempotencyKey,
      });
      const manifestDigest = financeInsightDigestV1(createRequest.manifest as CanonicalJsonValue);
      const expiresAt = new Date(now.getTime() + FINANCE_INSIGHT_PUBLICATION_FALLBACK_MS).toISOString();
      sqlite.prepare(`
        INSERT INTO finance_insight_publications (
          id, connector_id, source_sequence, generation_identity, contract_version,
          provider_type, source_as_of, coverage_start, coverage_end, currency,
          bridge_contract_version, captured_constituents, manifest, manifest_digest,
          create_request, idempotency_key, alert_capable, captured_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        publicationId,
        config.id,
        sourceSequence,
        prepared.generationIdentity,
        createRequest.contractVersion,
        normalizeFinanceProviderAlias(config.type)!,
        createRequest.sourceAsOf,
        createRequest.coverageStart,
        createRequest.coverageEnd,
        createRequest.currency,
        createRequest.bridgeContractVersion,
        JSON.stringify(createRequest.capturedConstituents),
        JSON.stringify(createRequest.manifest),
        manifestDigest,
        JSON.stringify(createRequest),
        idempotencyKey,
        capturedAt,
        expiresAt,
      );
      const insertFact = sqlite.prepare(`
        INSERT INTO finance_insight_publication_facts (
          publication_id, kind, source_ref, batch_index, fact_index, payload
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const kind of FINANCE_INSIGHT_FACT_KINDS) {
        prepared.batches[kind].forEach((batch, batchIndex) => {
          batch.forEach((fact, factIndex) => {
            insertFact.run(
              publicationId,
              kind,
              fact.sourceRef,
              batchIndex,
              factIndex,
              JSON.stringify(fact),
            );
          });
        });
      }
      sqlite.prepare(`
        INSERT INTO finance_insight_publication_state (
          connector_id, provider_type, latest_publication_id,
          latest_generation_identity, last_source_sequence,
          last_capture_attempt_at, last_capture_outcome, last_error_code,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'captured', NULL, ?, ?)
        ON CONFLICT(connector_id) DO UPDATE SET
          provider_type = excluded.provider_type,
          latest_publication_id = excluded.latest_publication_id,
          latest_generation_identity = excluded.latest_generation_identity,
          last_source_sequence = excluded.last_source_sequence,
          last_capture_attempt_at = excluded.last_capture_attempt_at,
          last_capture_outcome = 'captured',
          last_error_code = NULL,
          updated_at = excluded.updated_at
      `).run(
        config.id,
        normalizeFinanceProviderAlias(config.type)!,
        publicationId,
        prepared.generationIdentity,
        sourceSequence,
        capturedAt,
        capturedAt,
        capturedAt,
      );
      sqlite.prepare(`
        DELETE FROM finance_insight_publications
        WHERE connector_id = ?
          AND id NOT IN (
            SELECT id FROM finance_insight_publications
            WHERE connector_id = ?
            ORDER BY source_sequence DESC
            LIMIT ?
          )
      `).run(config.id, config.id, FINANCE_INSIGHT_PUBLICATION_CACHE_COUNT);
      sqlite.prepare(`
        DELETE FROM finance_insight_publications
        WHERE connector_id = ? AND expires_at < ? AND id <> ?
      `).run(config.id, capturedAt, publicationId);
      return { status: 'captured' as const, publicationId, sourceSequence };
    }).immediate();
  } catch {
    try {
      recordCaptureOutcome(config, capturedAt, 'failed', 'publication_capture_failed');
    } catch {
      logger.warn(
        { code: 'finance_insight_capture_state_unavailable', connectorId: config.id },
        'Finance insight publication capture state could not be recorded',
      );
    }
    return { status: 'failed', code: 'publication_capture_failed' };
  }
}

export function loadFinanceInsightPublication(
  connectorId: string,
  publicationId?: string,
  clock: () => Date = () => new Date(),
): {
  createRequest: SourceGenerationCreateRequestV1;
  batches: SourceFactBatchV1[];
  commitRequest: SourceGenerationCommitRequestV1;
  alertCapable: boolean;
  cacheState: 'current' | 'stale-fallback';
} | null {
  const row = sqlite.prepare(`
    SELECT id, create_request AS createRequest, manifest_digest AS manifestDigest,
           source_as_of AS sourceAsOf, alert_capable AS alertCapable, expires_at AS expiresAt
    FROM finance_insight_publications
    WHERE connector_id = ? AND (? IS NULL OR id = ?)
    ORDER BY source_sequence DESC
    LIMIT 1
  `).get(connectorId, publicationId ?? null, publicationId ?? null) as {
    id: string;
    createRequest: string;
    manifestDigest: string;
    sourceAsOf: string;
    alertCapable: number;
    expiresAt: string;
  } | undefined;
  const now = clock();
  if (!row || Date.parse(row.expiresAt) < now.getTime()) return null;
  const createRequest = sourceGenerationCreateRequestSchema.parse(JSON.parse(row.createRequest));
  const facts = sqlite.prepare(`
    SELECT kind, batch_index AS batchIndex, payload
    FROM finance_insight_publication_facts
    WHERE publication_id = ?
    ORDER BY kind, batch_index, fact_index
  `).all(row.id) as Array<{ kind: SourceFactKindV1; batchIndex: number; payload: string }>;
  const grouped = new Map<string, SourceFact[]>();
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.batchIndex}`;
    const batch = grouped.get(key) ?? [];
    batch.push(JSON.parse(fact.payload) as SourceFact);
    grouped.set(key, batch);
  }
  const batches = [...grouped.entries()].map(([key, batch]) => {
    const [kind, batchIndexText] = key.split(':') as [SourceFactKindV1, string];
    const batchIndex = Number(batchIndexText);
    return sourceFactBatchSchema.parse(
      sourceFactBatchValue(row.id, kind, batchIndex, batch),
    );
  });
  const commitInput = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    sourceGeneration: row.id,
    expectedSourceSequence: createRequest.sourceSequence,
    manifestDigest: row.manifestDigest,
  };
  const commitRequest = sourceGenerationCommitRequestSchema.parse({
    ...commitInput,
    idempotencyKey: stableIdentifier(
      'finance-commit-v1',
      financeInsightDigestV1(commitInput as CanonicalJsonValue),
    ),
  });
  const alertCapable = row.alertCapable === 1
    && now.getTime() - Date.parse(row.sourceAsOf) <= FINANCE_INSIGHT_ALERT_MAX_AGE_MS;
  return {
    createRequest,
    batches,
    commitRequest,
    alertCapable,
    cacheState: alertCapable ? 'current' : 'stale-fallback',
  };
}
