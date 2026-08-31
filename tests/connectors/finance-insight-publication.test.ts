import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import {
  buildFinanceInsightHistoryWindows,
  financeInsightHistoryGenerationRef,
} from '@/lib/connectors/monarch-money/finance-insight-history-sync';
import type { ConnectorConfig, DomainSyncResult } from '@/types';
import {
  FINANCE_INSIGHT_MAX_REQUEST_BYTES,
  type InsightOccurrenceSummaryV1,
  type TransactionSourceFactV1,
} from '@/lib/finance-insights/contract';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-publication-'));
const databasePath = join(tempDirectory, 'publication.db');
const baseNow = new Date('2026-08-10T12:00:00.000Z');
let sqlite: Database.Database;
let captureFinanceInsightPublication:
  typeof import('@/lib/finance-insights/publication')['captureFinanceInsightPublication'];
let loadFinanceInsightPublication:
  typeof import('@/lib/finance-insights/publication')['loadFinanceInsightPublication'];
let loadFinanceInsightPublicationProjectionFacts:
  typeof import('@/lib/finance-insights/publication')['loadFinanceInsightPublicationProjectionFacts'];
let replaceFinanceInsightOccurrenceCache:
  typeof import('@/lib/finance-insights/occurrence-cache')['replaceFinanceInsightOccurrenceCache'];
let readFinanceInsightOccurrenceCache:
  typeof import('@/lib/finance-insights/occurrence-cache')['readFinanceInsightOccurrenceCache'];
let ensureFinanceIdentityNamespace:
  typeof import('@/lib/connectors/monarch-money/identity-sqlite')['ensureFinanceIdentityNamespace'];
let financeConnectorScopedReference:
  typeof import('@/lib/connectors/monarch-money/identity')['financeConnectorScopedReference'];

const completeResult: DomainSyncResult = {
  itemsAdded: 5,
  itemsUpdated: 0,
  itemsRemoved: 0,
  status: 'fresh',
  datasetErrors: {},
};

function connector(id: string, type = 'finance-manager'): ConnectorConfig {
  return {
    id,
    type,
    name: id,
    enabled: true,
    syncMode: 'poll',
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: false,
      tags: true,
      tagWriteBack: false,
      notificationOnly: true,
    },
    credentials: {},
    settings: { householdCurrency: 'USD' },
    syncedLists: [],
  };
}

async function seedProjection(
  connectorId: string,
  generationSuffix = 'one',
  now = baseNow,
): Promise<void> {
  const timestamp = now.toISOString();
  const freshUntil = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  sqlite.prepare(`
    INSERT OR IGNORE INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials, settings,
      synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', ?, 1, 'poll', '{}', '{}',
      '{"householdCurrency":"USD"}', '[]', ?, ?)
  `).run(connectorId, connectorId, timestamp, timestamp);
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_projection_state (
      connector_id, status, successful_generation_id, source_as_of,
      coverage_start, coverage_end, last_successful_at, created_at, updated_at
    ) VALUES (?, 'succeeded', ?, ?, '2023-08-01', '2026-08-10', ?, ?, ?)
  `).run(
    connectorId,
    `transaction-generation-${generationSuffix}`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  const insertDataset = sqlite.prepare(`
    INSERT INTO finance_dataset_sync_state (
      connector_id, dataset, last_attempt_outcome, last_successful_at,
      source_as_of, fresh_until, current_generation_id, source_limit,
      schema_version, config_version, created_at, updated_at
    ) VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?, '1.0', 1, ?, ?)
  `);
  for (const [dataset, limit] of [
    ['accounts', 1000],
    ['categories', 2000],
    ['tags', 1000],
    ['recurring', 5000],
  ] as const) {
    insertDataset.run(
      connectorId,
      dataset,
      timestamp,
      timestamp,
      freshUntil,
      `${dataset}-generation-${generationSuffix}`,
      limit,
      timestamp,
      timestamp,
    );
  }
  sqlite.prepare(`
    INSERT INTO finance_accounts (
      id, connector_id, upstream_account_id, display_name, type,
      is_active, source_is_active, last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'account-one', 'Invented checking', 'checking', 1, 1, ?, ?, ?)
  `).run(`finance:account:${connectorId}:account-one`, connectorId, `accounts-${generationSuffix}`, timestamp, timestamp);
  sqlite.prepare(`
    INSERT INTO finance_categories (
      id, connector_id, upstream_category_id, name, upstream_group_id,
      is_active, source_is_active, last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'category-one', 'Household', 'group-one', 1, 1, ?, ?, ?)
  `).run(`finance:category:${connectorId}:category-one`, connectorId, `categories-${generationSuffix}`, timestamp, timestamp);
  sqlite.prepare(`
    INSERT INTO finance_tags (
      id, connector_id, upstream_tag_id, name, is_active, source_is_active,
      last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'tag-one', 'Reviewed', 1, 1, ?, ?, ?)
  `).run(`finance:tag:${connectorId}:tag-one`, connectorId, `tags-${generationSuffix}`, timestamp, timestamp);
  sqlite.prepare(`
    INSERT INTO finance_recurring_obligations (
      id, connector_id, generation_id, upstream_recurring_id, merchant,
      amount, frequency, next_expected_date, upstream_account_id,
      upstream_category_id, is_current, source_as_of, created_at
    ) VALUES (?, ?, ?, 'recurring-one', 'Invented utility', -42.50, 'monthly',
      '2026-09-01', 'account-one', 'category-one', 1, ?, ?)
  `).run(
    `finance:recurring:${connectorId}:${generationSuffix}`,
    connectorId,
    `recurring-generation-${generationSuffix}`,
    timestamp,
    timestamp,
  );
  insertHistoryFact(connectorId, {
    sourceRef: 'transaction-one',
    occurredOn: '2026-08-09',
    amountMinor: -8425,
    merchantName: 'Invented market',
    categoryRef: 'category-one',
    accountRef: 'account-one',
    isPending: false,
    recurringRef: null,
    tagRefs: ['tag-one'],
  }, `transaction-generation-${generationSuffix}`);
  await refreshProjectionProof(connectorId);
}

function insertHistoryFact(
  connectorId: string,
  fact: TransactionSourceFactV1,
  generationId?: string,
): void {
  const namespace = ensureFinanceIdentityNamespace(connectorId);
  const scoped = (kind: string, value: string | null): string | null => (
    value === null ? null : financeConnectorScopedReference(namespace, kind, value)
  );
  const scopedFact = {
    ...fact,
    sourceRef: scoped('transaction', fact.sourceRef)!,
    categoryRef: scoped('category', fact.categoryRef),
    accountRef: scoped('account', fact.accountRef),
    recurringRef: scoped('recurring', fact.recurringRef),
    tagRefs: fact.tagRefs.map((value) => scoped('tag', value)!),
  };
  const resolvedGenerationId = generationId ?? (
    sqlite.prepare(`
      SELECT successful_generation_id AS generationId
      FROM finance_insight_transaction_projection_state WHERE connector_id = ?
    `).get(connectorId) as { generationId: string }
  ).generationId;
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_projection_facts (
      connector_id, generation_id, source_ref, occurred_on, payload
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    connectorId,
    resolvedGenerationId,
    scopedFact.sourceRef,
    scopedFact.occurredOn,
    JSON.stringify(scopedFact),
  );
}

async function refreshProjectionProof(connectorId: string): Promise<void> {
  const state = sqlite.prepare(`
    SELECT successful_generation_id AS generationId, source_as_of AS sourceAsOf,
           coverage_end AS coverageEnd
    FROM finance_insight_transaction_projection_state WHERE connector_id = ?
  `).get(connectorId) as {
    generationId: string;
    sourceAsOf: string;
    coverageEnd: string;
  };
  const facts = await loadFinanceInsightPublicationProjectionFacts(connectorId, state.generationId);
  const windows = buildFinanceInsightHistoryWindows(state.coverageEnd).map((window) => {
    const windowFacts = facts.transaction.filter(
      (fact) => fact.occurredOn >= window.start && fact.occurredOn <= window.end,
    );
    return {
      ...window,
      sourceAsOf: state.sourceAsOf,
      itemCount: windowFacts.length,
      digest: financeInsightDigestV1(windowFacts as CanonicalJsonValue),
    };
  });
  sqlite.prepare(`
    DELETE FROM finance_insight_transaction_projection_windows
    WHERE connector_id = ? AND generation_id = ?
  `).run(connectorId, state.generationId);
  const insertWindow = sqlite.prepare(`
    INSERT INTO finance_insight_transaction_projection_windows (
      connector_id, generation_id, window_index, coverage_start, coverage_end,
      source_as_of, item_count, content_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const window of windows) {
    insertWindow.run(
      connectorId,
      state.generationId,
      window.index,
      window.start,
      window.end,
      window.sourceAsOf,
      window.itemCount,
      window.digest,
    );
  }
  const contentDigest = financeInsightDigestV1(facts.transaction as CanonicalJsonValue);
  const windowsDigest = financeInsightDigestV1(windows as CanonicalJsonValue);
  const generationId = financeInsightHistoryGenerationRef({
    connectorRef: connectorId,
    sourceAsOf: state.sourceAsOf,
    itemCount: facts.transaction.length,
    contentDigest,
    coverageStart: windows[0]!.start,
    coverageEnd: state.coverageEnd,
    windowCount: windows.length,
    windowsDigest,
    bridgeContractVersion: 'bridge-v1',
  });
  sqlite.prepare(`
    UPDATE finance_insight_transaction_projection_facts
    SET generation_id = ?
    WHERE connector_id = ? AND generation_id = ?
  `).run(generationId, connectorId, state.generationId);
  sqlite.prepare(`
    UPDATE finance_insight_transaction_projection_windows
    SET generation_id = ?
    WHERE connector_id = ? AND generation_id = ?
  `).run(generationId, connectorId, state.generationId);
  sqlite.prepare(`
    UPDATE finance_insight_transaction_projection_state
    SET successful_generation_id = ?, item_count = ?, content_digest = ?, coverage_start = ?,
        window_count = ?, windows_digest = ?,
        bridge_contract_version = 'bridge-v1'
    WHERE connector_id = ?
  `).run(
    generationId,
    facts.transaction.length,
    contentDigest,
    windows[0]!.start,
    windows.length,
    windowsDigest,
    connectorId,
  );
  for (const [dataset, kind] of [
    ['accounts', 'account'],
    ['categories', 'category'],
    ['tags', 'tag'],
    ['recurring', 'recurring'],
  ] as const) {
    sqlite.prepare(`
      UPDATE finance_dataset_sync_state
      SET insight_item_count = ?, insight_content_digest = ?,
          insight_bridge_contract_version = 'bridge-v1'
      WHERE connector_id = ? AND dataset = ?
    `).run(
      facts[kind].length,
      financeInsightDigestV1(facts[kind] as CanonicalJsonValue),
      connectorId,
      dataset,
    );
  }
}

function projectionGenerationId(connectorId: string): string {
  return (
    sqlite.prepare(`
      SELECT successful_generation_id AS generationId
      FROM finance_insight_transaction_projection_state WHERE connector_id = ?
    `).get(connectorId) as { generationId: string }
  ).generationId;
}

function clearProjection(): void {
  for (const table of [
    'finance_insight_cutovers',
    'finance_insight_publication_delivery',
    'finance_insight_publication_facts',
    'finance_insight_publications',
    'finance_insight_publication_state',
    'finance_insight_occurrences',
    'finance_insight_occurrence_cache_state',
    'finance_insight_transaction_window_proofs',
    'finance_insight_transaction_backfill_plans',
    'finance_insight_transaction_projection_facts',
    'finance_insight_transaction_projection_windows',
    'finance_insight_transaction_projection_state',
    'finance_transactions',
    'finance_recurring_obligations',
    'finance_tags',
    'finance_categories',
    'finance_accounts',
    'finance_dataset_sync_state',
    'finance_sync_state',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
}

function summary(
  connectorId: string,
  overrides: Partial<InsightOccurrenceSummaryV1> = {},
): InsightOccurrenceSummaryV1 {
  return {
    contractVersion: '1.0',
    insightId: 'insight-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    occurrenceId: 'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    deliveryRevision: 1,
    kind: 'largeTransaction',
    entity: {
      kind: 'transaction',
      sourceRef: 'transaction-one',
      displayName: 'Invented market',
      identityQuality: 'stableSource',
    },
    analysisState: 'qualified',
    sourceLifecycle: 'open',
    resolutionReason: null,
    supersededByOccurrenceId: null,
    severity: 'high',
    confidence: 'high',
    baselineSufficiency: 'sufficient',
    reasonCodes: ['explicit_amount_rule_exceeded'],
    headline: 'Invented large transaction',
    explanation: 'The invented transaction exceeded a configured amount threshold.',
    observationPeriod: { start: '2026-08-09', end: '2026-08-09' },
    baselinePeriod: null,
    observedValue: { currency: 'USD', amountMinor: -8425 },
    expectedRange: null,
    absoluteDelta: null,
    percentageDeltaBasisPoints: null,
    currency: 'USD',
    freshness: {
      state: 'fresh',
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      maxAgeHours: 48,
      warningReason: null,
    },
    provenance: {
      connectorRef: connectorId,
      sourceGeneration: 'publication-one',
      bridgeContractVersion: 'bridge-v1',
      providerClass: 'monarchBridgeNormalized',
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      coverageStart: '2026-08-01',
      coverageEnd: '2026-08-10',
      completeness: 'complete',
      detectorSetVersion: 'detectors-v1',
      detectorVersion: 'large-transaction-v1',
      methodVersion: 'threshold-v1',
      explanationTemplateVersion: 'large-transaction-v1',
      policyVersion: 1,
      evaluationStartedAt: '2026-08-10T12:01:00.000Z',
      evaluationCompletedAt: '2026-08-10T12:01:01.000Z',
    },
    targets: [{
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: 'transaction-one',
    }],
    createdAt: '2026-08-10T12:01:01.000Z',
    updatedAt: '2026-08-10T12:01:01.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function resolvedSummary(
  connectorId: string,
  sourceGeneration: string,
  sourceAsOf: string,
  index: number,
): InsightOccurrenceSummaryV1 {
  const occurrenceSuffix = index.toString(36).padStart(43, 'A');
  const insightSuffix = index.toString(36).padStart(43, 'B');
  const lifecycleAt = new Date(Date.parse(sourceAsOf) + 2 * 60_000).toISOString();
  return summary(connectorId, {
    insightId: `insight-v1_${insightSuffix}`,
    occurrenceId: `occurrence-v1_${occurrenceSuffix}`,
    sourceLifecycle: 'resolved',
    resolutionReason: 'source_unavailable',
    provenance: {
      ...summary(connectorId).provenance,
      sourceGeneration,
      sourceAsOf,
      evaluationStartedAt: new Date(Date.parse(sourceAsOf) + 60_000).toISOString(),
      evaluationCompletedAt: new Date(Date.parse(sourceAsOf) + 61_000).toISOString(),
    },
    freshness: {
      ...summary(connectorId).freshness,
      sourceAsOf,
    },
    updatedAt: lifecycleAt,
    resolvedAt: lifecycleAt,
  });
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  sqlite = (await import('@/db')).sqlite;
  ({
    captureFinanceInsightPublication,
    loadFinanceInsightPublication,
    loadFinanceInsightPublicationProjectionFacts,
  } = await import('@/lib/finance-insights/publication'));
  ({
    replaceFinanceInsightOccurrenceCache,
    readFinanceInsightOccurrenceCache,
  } = await import('@/lib/finance-insights/occurrence-cache'));
  ({ ensureFinanceIdentityNamespace } = await import(
    '@/lib/connectors/monarch-money/identity-sqlite'
  ));
  ({ financeConnectorScopedReference } = await import(
    '@/lib/connectors/monarch-money/identity'
  ));
});

beforeEach(clearProjection);

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance insight composite publication', () => {
  it('atomically captures the exact five-kind generation and emits bounded M2 DTOs', async () => {
    await seedProjection('finance-a');
    for (let index = 2; index <= 251; index++) {
      insertHistoryFact('finance-a', {
        sourceRef: `transaction-${index}`,
        occurredOn: '2026-08-09',
        amountMinor: -100,
        merchantName: 'Invented market',
        categoryRef: 'category-one',
        accountRef: 'account-one',
        isPending: false,
        recurringRef: null,
        tagRefs: [],
      });

    }
    await refreshProjectionProof('finance-a');
    const result = await captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    );
    expect(result).toMatchObject({ status: 'captured', sourceSequence: 1 });

    const publication = await loadFinanceInsightPublication('finance-a', undefined, () => baseNow);
    expect(publication?.createRequest).toMatchObject({
      connectorRef: 'finance-a',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      coverageStart: '2023-08-01',
      coverageEnd: '2026-08-10',
    });
    expect(publication?.createRequest.capturedConstituents.map((item) => item.kind))
      .toEqual(['transaction', 'recurring', 'category', 'account', 'tag']);
    expect(publication?.batches.map((batch) => batch.kind).sort())
      .toEqual(['account', 'category', 'recurring', 'tag', 'transaction', 'transaction']);
    expect(publication?.batches.every((batch) => batch.facts.length <= 250)).toBe(true);
    expect(publication?.batches
      .filter((batch) => batch.kind === 'transaction')
      .map((batch) => batch.facts.length)).toEqual([250, 1]);
    expect(publication?.batches
      .flatMap((batch) => batch.kind === 'transaction' ? batch.facts : [])
      .find((fact) => fact.tagRefs.length === 1)).toMatchObject({
        sourceRef: expect.stringMatching(/^transaction-v1:[A-Za-z0-9_-]{43}$/),
        accountRef: expect.stringMatching(/^account-v1:[A-Za-z0-9_-]{43}$/),
        categoryRef: expect.stringMatching(/^category-v1:[A-Za-z0-9_-]{43}$/),
        tagRefs: [expect.stringMatching(/^tag-v1:[A-Za-z0-9_-]{43}$/)],
      });
    expect(publication?.alertCapable).toBe(true);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_publication_facts
    `).get()).toEqual({ count: 255 });
  });


  it('rounds finite Bridge amounts to minor units without aborting publication', async () => {
    await seedProjection('finance-fractional');
    sqlite.prepare(`
      UPDATE finance_recurring_obligations
      SET amount = 1.001
      WHERE connector_id = ?
    `).run('finance-fractional');
    await refreshProjectionProof('finance-fractional');

    await expect(captureFinanceInsightPublication(
      connector('finance-fractional'),
      completeResult,
      () => baseNow,
    )).resolves.toMatchObject({ status: 'captured' });
    const publication = await loadFinanceInsightPublication(
      'finance-fractional',
      undefined,
      () => baseNow,
    );
    expect(publication?.batches
      .find((batch) => batch.kind === 'recurring')
      ?.facts[0]).toMatchObject({
        sourceRef: expect.stringMatching(/^recurring-v1:[A-Za-z0-9_-]{43}$/),
        amountMinor: 100,
      });
  });

  it('is idempotent, monotonic, connector-isolated, and retains only three generations', async () => {
    await seedProjection('finance-a');
    const first = await captureFinanceInsightPublication(
      connector('finance-a', 'monarch-money'),
      completeResult,
      () => baseNow,
    );
    const replay = await captureFinanceInsightPublication(
      connector('finance-a', 'finance'),
      completeResult,
      () => baseNow,
    );
    expect(replay).toEqual({
      status: 'idempotent',
      publicationId: 'publicationId' in first ? first.publicationId : '',
      sourceSequence: 1,
    });

    await seedProjection('finance-b');
    const other = await captureFinanceInsightPublication(
      connector('finance-b'),
      completeResult,
      () => baseNow,
    );
    expect(other).toMatchObject({ status: 'captured', sourceSequence: 1 });

    for (let sequence = 2; sequence <= 4; sequence++) {
      const at = new Date(baseNow.getTime() + sequence * 60_000);
      sqlite.prepare(`
        UPDATE finance_insight_transaction_projection_state
        SET source_as_of = ?, last_successful_at = ?, updated_at = ?
        WHERE connector_id = 'finance-a'
      `).run(
        at.toISOString(),
        at.toISOString(),
        at.toISOString(),
      );
      await refreshProjectionProof('finance-a');
      const next = await captureFinanceInsightPublication(
        connector('finance-a'),
        completeResult,
        () => at,
      );
      expect(next).toMatchObject({ status: 'captured', sourceSequence: sequence });
    }
    expect(sqlite.prepare(`
      SELECT source_sequence AS sequence
      FROM finance_insight_publications
      WHERE connector_id = 'finance-a'
      ORDER BY source_sequence
    `).all()).toEqual([{ sequence: 2 }, { sequence: 3 }, { sequence: 4 }]);
    expect(sqlite.prepare(`
      SELECT provider_type AS providerType
      FROM finance_insight_publication_state WHERE connector_id = 'finance-a'
    `).get()).toEqual({ providerType: 'finance-manager' });
  });

  it('includes contract-significant currency in publication identity', async () => {
    await seedProjection('finance-a');
    const first = await captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    );
    const euroConfig = connector('finance-a');
    euroConfig.settings = { ...euroConfig.settings, householdCurrency: 'EUR' };
    const second = await captureFinanceInsightPublication(
      euroConfig,
      completeResult,
      () => new Date(baseNow.getTime() + 60_000),
    );

    expect(first).toMatchObject({ status: 'captured', sourceSequence: 1 });
    expect(second).toMatchObject({ status: 'captured', sourceSequence: 2 });
    const firstPublication = await loadFinanceInsightPublication(
      'finance-a',
      'publicationId' in first ? first.publicationId : '',
      () => new Date(baseNow.getTime() + 60_000),
    );
    const secondPublication = await loadFinanceInsightPublication(
      'finance-a',
      undefined,
      () => new Date(baseNow.getTime() + 60_000),
    );
    expect(secondPublication?.createRequest.currency).toBe('EUR');
    expect(secondPublication?.batches[0]?.idempotencyKey)
      .not.toBe(firstPublication?.batches[0]?.idempotencyKey);
    expect(secondPublication?.commitRequest.idempotencyKey)
      .not.toBe(firstPublication?.commitRequest.idempotencyKey);
  });

  it('requires an exact persisted ISO 4217 household currency without environment fallback', async () => {
    await seedProjection('finance-a');
    process.env.FINANCE_INSIGHTS_CURRENCY = 'EUR';
    try {
      const missing = connector('finance-a');
      missing.settings = {};
      await expect(captureFinanceInsightPublication(
        missing,
        completeResult,
        () => baseNow,
      )).resolves.toEqual({ status: 'refused', code: 'household_currency_unavailable' });

      const malformed = connector('finance-a');
      malformed.settings = { householdCurrency: 'usd' };
      await expect(captureFinanceInsightPublication(
        malformed,
        completeResult,
        () => baseNow,
      )).resolves.toEqual({ status: 'refused', code: 'household_currency_unavailable' });

      const unknown = connector('finance-a');
      unknown.settings = { householdCurrency: 'ZZZ' };
      await expect(captureFinanceInsightPublication(
        unknown,
        completeResult,
        () => baseNow,
      )).resolves.toEqual({ status: 'refused', code: 'household_currency_unavailable' });
    } finally {
      delete process.env.FINANCE_INSIGHTS_CURRENCY;
    }
  });

  it('uses Bridge provenance, not local completion time, for transaction freshness', async () => {
    await seedProjection('finance-a');
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_state
      SET source_as_of = ?
      WHERE connector_id = 'finance-a'
    `).run(new Date(baseNow.getTime() - 49 * 60 * 60 * 1_000).toISOString());
    await refreshProjectionProof('finance-a');

    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'transaction_projection_unavailable' });
  });

  it('refuses mutable rows, invalid coverage, and unacceptable constituent skew', async () => {
    await seedProjection('finance-a');
    const changedFact = {
      ...((await loadFinanceInsightPublicationProjectionFacts(
        'finance-a',
        projectionGenerationId('finance-a'),
      )).transaction[0]!),
      merchantName: 'Changed after successful sync',
    };
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_facts SET payload = ?
      WHERE connector_id = 'finance-a'
    `).run(JSON.stringify(changedFact));
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'transaction_projection_changed' });

    clearProjection();
    await seedProjection('finance-a');
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_windows
      SET coverage_start = '2026-08-02'
      WHERE connector_id = 'finance-a' AND window_index = 36
    `).run();
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_state
      SET windows_digest = ?
      WHERE connector_id = 'finance-a'
    `).run(financeInsightDigestV1(
      sqlite.prepare(`
        SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
               source_as_of AS sourceAsOf, item_count AS itemCount,
               content_digest AS digest
        FROM finance_insight_transaction_projection_windows
        WHERE connector_id = 'finance-a'
        ORDER BY window_index
      `).all() as CanonicalJsonValue,
    ));
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'transaction_projection_coverage_invalid' });

    clearProjection();
    await seedProjection('finance-a');
    sqlite.prepare(`
      DELETE FROM finance_insight_transaction_projection_windows
      WHERE connector_id = 'finance-a' AND window_index = 12
    `).run();
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'transaction_projection_coverage_invalid' });

    clearProjection();
    await seedProjection('finance-a');
    sqlite.prepare(`
      UPDATE finance_dataset_sync_state
      SET source_as_of = ?, fresh_until = ?
      WHERE connector_id = 'finance-a' AND dataset = 'recurring'
    `).run(
      new Date(baseNow.getTime() - 49 * 60 * 60 * 1_000).toISOString(),
      new Date(baseNow.getTime() + 60 * 60 * 1_000).toISOString(),
    );
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'constituent_freshness_skew' });

    clearProjection();
    await seedProjection('finance-a');
    sqlite.prepare(`
      UPDATE finance_categories SET name = 'Changed after successful sync'
      WHERE connector_id = 'finance-a'
    `).run();
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'categories_projection_changed' });
  });

  it('refuses partial, stale, and failed constituent states without replacing the cache', async () => {
    await seedProjection('finance-a');
    const captured = await captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    );
    const publicationId = 'publicationId' in captured ? captured.publicationId : '';

    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      { ...completeResult, status: 'partial', datasetErrors: { recurring: 'upstream_timeout' } },
      () => new Date(baseNow.getTime() + 60_000),
    )).resolves.toEqual({ status: 'refused', code: 'partial_projection' });

    sqlite.prepare(`
      UPDATE finance_dataset_sync_state
      SET last_attempt_outcome = 'failed'
      WHERE connector_id = 'finance-a' AND dataset = 'recurring'
    `).run();
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => new Date(baseNow.getTime() + 120_000),
    )).resolves.toEqual({ status: 'refused', code: 'recurring_projection_unavailable' });
    expect(sqlite.prepare(`
      SELECT latest_publication_id AS publicationId
      FROM finance_insight_publication_state WHERE connector_id = 'finance-a'
    `).get()).toEqual({ publicationId });

    const fallback = await loadFinanceInsightPublication(
      'finance-a',
      undefined,
      () => new Date(baseNow.getTime() + 3 * 24 * 60 * 60 * 1_000),
    );
    expect(fallback).toMatchObject({ cacheState: 'stale-fallback', alertCapable: false });
    await expect(loadFinanceInsightPublication(
      'finance-a',
      undefined,
      () => new Date(baseNow.getTime() + 8 * 24 * 60 * 60 * 1_000),
    )).resolves.toBeNull();
  });

  it('refuses T1-invalid projected facts before publication state can advance', async () => {
    await seedProjection('finance-a');
    const invalidFact = {
      ...(await loadFinanceInsightPublicationProjectionFacts(
        'finance-a',
        projectionGenerationId('finance-a'),
      )).transaction[0]!,
      tagRefs: Array.from({ length: 51 }, (_, index) => `tag-${index}`),
    };
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_facts SET payload = ?
      WHERE connector_id = 'finance-a'
    `).run(JSON.stringify(invalidFact));
    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toEqual({ status: 'refused', code: 'invalid_projection_fact' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_publications
    `).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT last_source_sequence AS sourceSequence, last_capture_outcome AS outcome
      FROM finance_insight_publication_state WHERE connector_id = 'finance-a'
    `).get()).toEqual({ sourceSequence: 0, outcome: 'refused' });
  });

  it('isolates the exact insight history generation from operational transaction rows', async () => {
    await seedProjection('finance-a');
    sqlite.prepare(`
      INSERT INTO finance_transactions (
        id, connector_instance_id, upstream_transaction_id, date, amount,
        merchant_name, tags, tag_references, source_fingerprint,
        last_seen_generation_id, synced_at
      ) VALUES (
        'finance:finance-a:legacy-outside-window', 'finance-a',
        'legacy-outside-window', '2025-08-10', -1, 'Invented old merchant',
        '["Reviewed"]', '[]', 'legacy-fingerprint',
        'legacy-generation', '2025-08-10T12:00:00.000Z'
      )
    `).run();
    const captured = await captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    );
    expect(captured).toMatchObject({ status: 'captured', sourceSequence: 1 });
    const publication = await loadFinanceInsightPublication('finance-a', undefined, () => baseNow);
    expect(publication?.batches
      .filter((batch) => batch.kind === 'transaction')
      .flatMap((batch) => batch.kind === 'transaction' ? batch.facts : [])
      .map((fact) => fact.sourceRef)).toEqual([
        expect.stringMatching(/^transaction-v1:[A-Za-z0-9_-]{43}$/),
      ]);
  });

  it('partitions valid fact batches by both item count and T1 request bytes', async () => {
    await seedProjection('finance-a');
    const tagRefs = ['tag-one'];
    const insertTag = sqlite.prepare(`
      INSERT INTO finance_tags (
        id, connector_id, upstream_tag_id, name, is_active, source_is_active,
        last_seen_generation_id, first_seen_at, last_seen_at
      ) VALUES (?, 'finance-a', ?, ?, 1, 1, 'tags-generation-one',
        '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z')
    `);
    for (let index = 1; index < 50; index++) {
      const sourceRef = `tag-${index}-${'x'.repeat(145)}`;
      tagRefs.push(sourceRef);
      insertTag.run(`finance:tag:finance-a:${index}`, sourceRef, `Invented tag ${index}`);
    }
    for (let index = 2; index <= 120; index++) {
      insertHistoryFact('finance-a', {
        sourceRef: `large-transaction-${index}`,
        occurredOn: '2026-08-09',
        amountMinor: -100,
        merchantName: `Invented merchant ${'m'.repeat(140)}`,
        categoryRef: 'category-one',
        accountRef: 'account-one',
        isPending: false,
        recurringRef: null,
        tagRefs,
      });
    }
    await refreshProjectionProof('finance-a');

    await expect(captureFinanceInsightPublication(
      connector('finance-a'),
      completeResult,
      () => baseNow,
    )).resolves.toMatchObject({ status: 'captured' });
    const publication = await loadFinanceInsightPublication('finance-a', undefined, () => baseNow);
    const transactionBatches = publication!.batches
      .filter((batch) => batch.kind === 'transaction');
    expect(transactionBatches.length).toBeGreaterThan(1);
    expect(transactionBatches.every((batch) => (
      new TextEncoder().encode(JSON.stringify(batch)).byteLength
        <= FINANCE_INSIGHT_MAX_REQUEST_BYTES
    ))).toBe(true);
    expect(publication!.createRequest.manifest.find(
      (entry) => entry.kind === 'transaction',
    )?.batchCount).toBe(transactionBatches.length);
  });
});

describe.sequential('finance insight occurrence cache foundation', () => {
  it('enforces connector identity, count, summary age, and purge age', async () => {
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a')],
      now: baseNow,
    });
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 24 * 60 * 60 * 1_000),
    )).resolves.toMatchObject({ state: 'available', alertCapable: true });
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 49 * 60 * 60 * 1_000),
    )).resolves.toMatchObject({ state: 'available', alertCapable: false });
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 8 * 24 * 60 * 60 * 1_000),
    )).resolves.toMatchObject({
      state: 'metadata-only',
      alertCapable: false,
      items: [{ occurrenceId: summary('finance-a').occurrenceId }],
    });
    const retained = sqlite.prepare(`
      SELECT summary_payload AS summaryPayload, entity_label AS entityLabel,
             headline, target_descriptors AS targets
      FROM finance_insight_occurrences WHERE connector_id = 'finance-a'
    `).get() as {
      summaryPayload: string | null;
      entityLabel: string;
      headline: string;
      targets: string;
    };
    expect(retained).toMatchObject({
      entityLabel: 'Invented market',
      headline: 'Invented large transaction',
    });
    expect(retained.summaryPayload).not.toBeNull();
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 31 * 24 * 60 * 60 * 1_000),
    )).resolves.toMatchObject({
      state: 'metadata-only',
      alertCapable: false,
    });
    expect(sqlite.prepare(`
      SELECT summary_payload AS summaryPayload, entity_label AS entityLabel,
             headline, target_descriptors AS targets
      FROM finance_insight_occurrences WHERE connector_id = 'finance-a'
    `).get()).toEqual({
      summaryPayload: null,
      entityLabel: '',
      headline: '',
      targets: '[]',
    });
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 91 * 24 * 60 * 60 * 1_000),
    )).resolves.toEqual({
      state: 'unavailable',
      alertCapable: false,
      sourceGeneration: null,
      items: [],
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a'
    `).get()).toEqual({ count: 0 });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: Array.from({ length: 501 }, () => summary('finance-a')),
      now: baseNow,
    })).rejects.toThrow('row limit');
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-b',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a')],
      now: baseNow,
    })).rejects.toThrow('identity is invalid');
  });

  it('never marks partial or stale summaries as alert-capable', async () => {
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', {
        freshness: {
          state: 'partial',
          sourceAsOf: '2026-08-10T12:00:00.000Z',
          maxAgeHours: 48,
          warningReason: 'source_partial',
        },
        provenance: {
          ...summary('finance-a').provenance,
          completeness: 'partial',
        },
      })],
      now: baseNow,
    });
    await expect(readFinanceInsightOccurrenceCache('finance-a', baseNow))
      .resolves.toMatchObject({ state: 'available', alertCapable: false });
  });

  it('preserves resolved identities as bounded metadata tombstones across generations', async () => {
    const resolved = summary('finance-a', {
      sourceLifecycle: 'resolved',
      resolutionReason: 'source_unavailable',
      resolvedAt: '2026-08-10T12:01:01.000Z',
    });
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [resolved],
      now: baseNow,
    });
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-two',
      sourceSequence: 2,
      sourceAsOf: '2026-08-11T12:00:00.000Z',
      items: [],
      now: new Date('2026-08-11T12:00:00.000Z'),
    });

    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date('2026-08-12T12:00:00.000Z'),
    )).resolves.toMatchObject({ state: 'available', items: [] });
    expect(sqlite.prepare(`
      SELECT source_generation AS sourceGeneration, source_lifecycle AS lifecycle,
             summary_payload AS summaryPayload, entity_label AS entityLabel
      FROM finance_insight_occurrences WHERE connector_id = 'finance-a'
    `).get()).toEqual({
      sourceGeneration: 'publication-one',
      lifecycle: 'resolved',
      summaryPayload: null,
      entityLabel: '',
    });
    await expect(readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date('2026-11-12T12:00:00.000Z'),
    )).resolves.toEqual({
      state: 'unavailable',
      alertCapable: false,
      sourceGeneration: null,
      items: [],
    });
  });

  it('moves omitted terminal rows out of current membership for the same generation', async () => {
    const first = resolvedSummary(
      'finance-a',
      'publication-one',
      '2026-08-10T12:00:00.000Z',
      1,
    );
    const second = resolvedSummary(
      'finance-a',
      'publication-one',
      '2026-08-10T12:00:00.000Z',
      2,
    );
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [first, second],
      now: baseNow,
    });
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [second],
      now: new Date(baseNow.getTime() + 60_000),
    });

    await expect(readFinanceInsightOccurrenceCache('finance-a', baseNow)).resolves.toMatchObject({
      state: 'available',
      items: [{ occurrenceId: second.occurrenceId }],
    });
    expect(sqlite.prepare(`
      SELECT is_tombstone AS isTombstone, COUNT(*) AS count
      FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a'
      GROUP BY is_tombstone
      ORDER BY is_tombstone
    `).all()).toEqual([
      { isTombstone: 0, count: 1 },
      { isTombstone: 1, count: 1 },
    ]);
  });

  it('renews payload retention on an identical successful refresh', async () => {
    const item = summary('finance-a');
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [item],
      now: baseNow,
    });
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [item],
      now: new Date(baseNow.getTime() + 29 * 24 * 60 * 60 * 1_000),
    });

    await readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 31 * 24 * 60 * 60 * 1_000),
    );
    expect(sqlite.prepare(`
      SELECT summary_payload AS summaryPayload
      FROM finance_insight_occurrences WHERE connector_id = 'finance-a'
    `).get()).toEqual({
      summaryPayload: JSON.stringify(item),
    });
  });

  it('evicts oldest resolved tombstones above the per-connector limit', async () => {
    for (let generation = 1; generation <= 4; generation++) {
      const sourceGeneration = `publication-${generation}`;
      const sourceAsOf = new Date(
        baseNow.getTime() + (generation - 1) * 24 * 60 * 60 * 1_000,
      ).toISOString();
      await replaceFinanceInsightOccurrenceCache({
        connectorId: 'finance-a',
        sourceGeneration,
        sourceSequence: generation,
        sourceAsOf,
        items: Array.from(
          { length: 500 },
          (_, index) => resolvedSummary(
            'finance-a',
            sourceGeneration,
            sourceAsOf,
            (generation - 1) * 500 + index,
          ),
        ),
        now: new Date(Date.parse(sourceAsOf) + 3 * 60_000),
      });
    }

    expect(sqlite.prepare(`
      SELECT source_generation AS sourceGeneration, COUNT(*) AS count
      FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a'
      GROUP BY source_generation
      ORDER BY source_generation
    `).all()).toEqual([
      { sourceGeneration: 'publication-2', count: 500 },
      { sourceGeneration: 'publication-3', count: 500 },
      { sourceGeneration: 'publication-4', count: 500 },
    ]);
  });

  it('rejects stale/conflicting generations and delivery revision regressions', async () => {
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 2,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', { deliveryRevision: 2 })],
      now: baseNow,
    });
    const reaged = summary('finance-a', {
      deliveryRevision: 2,
      provenance: {
        ...summary('finance-a').provenance,
        sourceAsOf: '2026-08-10T12:00:30.000Z',
      },
      freshness: {
        ...summary('finance-a').freshness,
        sourceAsOf: '2026-08-10T12:00:30.000Z',
      },
    });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 2,
      sourceAsOf: '2026-08-10T12:00:30.000Z',
      items: [reaged],
      now: new Date('2026-08-10T12:00:30.000Z'),
    })).rejects.toThrow('identity is immutable');
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 3,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', { deliveryRevision: 2 })],
      now: baseNow,
    })).rejects.toThrow('identity is immutable');
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-conflict',
      sourceSequence: 2,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', {
        deliveryRevision: 2,
        provenance: {
          ...summary('finance-a').provenance,
          sourceGeneration: 'publication-conflict',
        },
      })],
      now: baseNow,
    })).rejects.toThrow('generation conflicts');

    const older = summary('finance-a', {
      provenance: {
        ...summary('finance-a').provenance,
        sourceGeneration: 'publication-older',
        sourceAsOf: '2026-08-09T12:00:00.000Z',
      },
      freshness: {
        ...summary('finance-a').freshness,
        sourceAsOf: '2026-08-09T12:00:00.000Z',
      },
    });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-older',
      sourceSequence: 1,
      sourceAsOf: '2026-08-09T12:00:00.000Z',
      items: [older],
      now: baseNow,
    })).rejects.toThrow('generation is stale');
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 2,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', { deliveryRevision: 1 })],
      now: baseNow,
    })).rejects.toThrow('revision is stale');
  });

  it('preserves immutable material revisions and bounds resolved tombstones', async () => {
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a')],
      now: baseNow,
    });
    sqlite.prepare(`
      UPDATE finance_insight_occurrences
      SET revision_digest = '', source_generation = '', source_sequence = 0
      WHERE connector_id = 'finance-a'
    `).run();
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', {
        headline: 'Invented conflicting migration replay',
      })],
      now: baseNow,
    })).rejects.toThrow('revision conflicts');
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a')],
      now: baseNow,
    });
    expect(sqlite.prepare(`
      SELECT source_generation AS generation, source_sequence AS sequence
      FROM finance_insight_occurrences WHERE connector_id = 'finance-a'
    `).get()).toEqual({ generation: 'publication-one', sequence: 1 });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', {
        observedValue: { currency: 'USD', amountMinor: -9999 },
      })],
      now: baseNow,
    })).rejects.toThrow('revision conflicts');
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a', {
        headline: 'Invented revised material headline',
      })],
      now: baseNow,
    })).rejects.toThrow('revision conflicts');

    const resolved = summary('finance-a', {
      sourceLifecycle: 'resolved',
      resolutionReason: 'correction_resolved',
      updatedAt: '2026-08-10T12:02:00.000Z',
      resolvedAt: '2026-08-10T12:02:00.000Z',
    });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [resolved],
      now: new Date('2026-08-10T12:02:00.000Z'),
    })).resolves.not.toThrow();
    expect(sqlite.prepare(`
      SELECT source_lifecycle AS lifecycle, delivery_revision AS revision,
             is_tombstone AS isTombstone
      FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a'
    `).get()).toEqual({ lifecycle: 'resolved', revision: 1, isTombstone: 0 });
    await expect(replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-one',
      sourceSequence: 1,
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      items: [summary('finance-a')],
      now: new Date('2026-08-10T12:03:00.000Z'),
    })).rejects.toThrow('revision is stale');

    const insertTombstone = sqlite.prepare(`
      INSERT INTO finance_insight_occurrences (
        connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
        insight_id, delivery_revision, revision_digest, kind, entity_kind,
        entity_source_ref, entity_label, analysis_state, source_lifecycle, severity,
        confidence, baseline_sufficiency, headline, freshness_state, source_as_of,
        target_descriptors, summary_payload, source_updated_at, cached_at
      )
      SELECT connector_id, ?, source_generation, source_sequence, 1, ?,
        delivery_revision, ?, kind, entity_kind, entity_source_ref, entity_label,
        analysis_state, source_lifecycle, severity, confidence, baseline_sufficiency,
        headline, freshness_state, source_as_of, target_descriptors, NULL, ?, ?
      FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a' AND occurrence_id = ?
      ON CONFLICT(connector_id, occurrence_id) DO NOTHING
    `);
    for (let index = 0; index < 1_005; index++) {
      const timestamp = new Date(baseNow.getTime() + index * 1_000).toISOString();
      insertTombstone.run(
        `occurrence-extra-${index}`,
        `insight-extra-${index}`,
        `digest-${index}`,
        timestamp,
        timestamp,
        resolved.occurrenceId,
      );
    }
    await replaceFinanceInsightOccurrenceCache({
      connectorId: 'finance-a',
      sourceGeneration: 'publication-two',
      sourceSequence: 2,
      sourceAsOf: '2026-08-10T12:00:01.000Z',
      items: [],
      now: new Date('2026-08-10T12:03:00.000Z'),
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a' AND is_tombstone = 1
    `).get()).toEqual({ count: 1_000 });
    expect(sqlite.prepare(`
      SELECT 1 AS present FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a' AND is_tombstone = 1
        AND occurrence_id = 'occurrence-extra-0'
    `).get()).toBeUndefined();

    await readFinanceInsightOccurrenceCache(
      'finance-a',
      new Date(baseNow.getTime() + 91 * 24 * 60 * 60 * 1_000),
    );
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences
      WHERE connector_id = 'finance-a' AND is_tombstone = 1
    `).get()).toEqual({ count: 0 });
  });
});
