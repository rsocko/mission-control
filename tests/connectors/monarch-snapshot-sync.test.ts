import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { ConnectorConfig } from '@/types';

type SnapshotSynchronizer = InstanceType<
  typeof import('@/lib/connectors/monarch-money/snapshot-sync')['FinanceSnapshotSynchronizer']
>;

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-snapshot-'));
const databasePath = join(tempDirectory, 'finance.db');
let sqlite: Database.Database;
let synchronizer: SnapshotSynchronizer;
let updateFinanceCategory:
  typeof import('@/lib/connectors/monarch-money/snapshot-sync')['updateFinanceCategory'];
let applyManualAttributionDecision:
  typeof import('@/lib/connectors/monarch-money/attribution-service')['applyManualAttributionDecision'];
let controller: AbortController;

const connectorConfig: ConnectorConfig = {
  id: 'finance-snapshot-test',
  type: 'finance-manager',
  name: 'Finance snapshot test',
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
    tagWriteBack: true,
  },
  credentials: { serviceToken: 'invented-test-token' },
  settings: {
    bridgeUrl: 'http://localhost:8100',
    backfillDays: 30,
    overlapDays: 7,
    pageSize: 500,
    maxRetries: 0,
  },
  syncedLists: [],
};

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    date: new Date().toISOString().slice(0, 10),
    amount: -10,
    merchant: { name: `Invented merchant ${id}`, logoUrl: null },
    category: { id: 'source-category', name: 'Source category' },
    account: { id: 'account-1', displayName: 'Invented account', mask: '1234' },
    isPending: false,
    isRecurring: false,
    notes: null,
    tags: [],
    tagReferences: [],
    ...overrides,
  };
}

function page(
  transactions: unknown[],
  nextCursor: string | null,
  fetchedAt = new Date().toISOString(),
) {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    provenance: { provider: 'live', fetchedAt },
    transactions,
    total: transactions.length,
    page: { limit: 500, nextCursor },
  }), {
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

function mockPages(pages: unknown[][], fetchedAt: string[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get('cursor');
    const pageIndex = cursor ? Number(cursor.slice('page-'.length)) : 0;
    return page(
      pages[pageIndex] ?? [],
      pageIndex + 1 < pages.length ? `page-${pageIndex + 1}` : null,
      fetchedAt[pageIndex],
    );
  }));
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION = '7';
  vi.resetModules();
  const dbModule = await importInitializedSqliteDatabase();
  sqlite = dbModule.sqlite;
  const configuredAt = new Date().toISOString();
  sqlite.prepare(`
    INSERT OR IGNORE INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', 'Finance snapshot test', 1, 'poll',
      '{}', '{}', '{}', '[]', ?, ?)
  `).run(connectorConfig.id, configuredAt, configuredAt);
  const snapshotModule = await import('@/lib/connectors/monarch-money/snapshot-sync');
  synchronizer = new snapshotModule.FinanceSnapshotSynchronizer(connectorConfig);
  updateFinanceCategory = snapshotModule.updateFinanceCategory;
  applyManualAttributionDecision = (
    await import('@/lib/connectors/monarch-money/attribution-service')
  ).applyManualAttributionDecision;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  delete process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('FinanceSnapshotSynchronizer', () => {
  it('accepts the legacy Finance connector alias for manual attribution', () => {
    const observedAt = new Date().toISOString();
    const transactionId = `finance:${connectorConfig.id}:legacy-alias-transaction`;
    sqlite.prepare(`
      INSERT INTO finance_transactions (
        id, connector_instance_id, upstream_transaction_id, date, amount,
        merchant_name, triage_status, is_pending, is_recurring, tags,
        lifecycle_status, source_fingerprint, first_seen_at, last_seen_at, synced_at
      ) VALUES (?, ?, 'legacy-alias-transaction', ?, -10,
        'Invented alias merchant', 'pending', 0, 0, '[]',
        'active', 'legacy-alias-fingerprint', ?, ?, ?)
    `).run(
      transactionId,
      connectorConfig.id,
      observedAt.slice(0, 10),
      observedAt,
      observedAt,
      observedAt,
    );
    sqlite.prepare(`UPDATE connector_configs SET type = 'finance' WHERE id = ?`)
      .run(connectorConfig.id);

    try {
      expect(applyManualAttributionDecision({
        connectorId: connectorConfig.id,
        transactionId,
        action: 'parent-expense',
        kidId: null,
        idempotencyKey: 'legacy-alias-manual-decision',
        actorType: 'parent-admin',
      })).toMatchObject({
        status: 'resolved',
        transactionId,
        replayed: false,
      });
    } finally {
      sqlite.prepare(`UPDATE connector_configs SET type = 'finance-manager' WHERE id = ?`)
        .run(connectorConfig.id);
      sqlite.prepare(`
        DELETE FROM finance_attribution_audit
        WHERE connector_id = ? AND idempotency_key = 'legacy-alias-manual-decision'
      `).run(connectorConfig.id);
      sqlite.prepare(`DELETE FROM finance_transactions WHERE id = ?`).run(transactionId);
    }
  });

  it('pages beyond 500 and replays idempotently without replacing local fields', async () => {
    const fixtures = Array.from({ length: 501 }, (_, index) =>
      transaction(`transaction-${index}`, index === 0
        ? {
            isPending: true,
            tags: ['Reviewed'],
            tagReferences: [{ id: 'stable-tag-one', name: 'Reviewed' }],
          }
        : {}));
    const firstPageFetchedAt = '2026-08-10T07:00:00-04:00';
    const secondPageFetchedAt = '2026-08-10T11:59:00.000Z';
    mockPages(
      [fixtures.slice(0, 500), fixtures.slice(500)],
      [firstPageFetchedAt, secondPageFetchedAt],
    );

    const first = await synchronizer.sync({ full: true });
    expect(first).toEqual({ itemsAdded: 501, itemsUpdated: 0, itemsRemoved: 0 });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM finance_transactions
      WHERE connector_instance_id = ?
    `).get(connectorConfig.id)).toEqual({ count: 501 });
    expect(sqlite.prepare(`
      SELECT confirmed_category AS confirmedCategory
      FROM finance_transactions
      WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({ confirmedCategory: null });
    expect(sqlite.prepare(`
      SELECT tag_references AS tagReferences
      FROM finance_transactions
      WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({ tagReferences: '["stable-tag-one"]' });
    expect(sqlite.prepare(`
      SELECT last_successful_source_as_of AS sourceAsOf,
             last_successful_item_count AS itemCount,
             last_successful_content_digest AS contentDigest,
             last_successful_projection_start_date AS projectionStartDate,
             last_successful_projection_coverage_start AS coverageStart,
             last_successful_projection_coverage_end AS coverageEnd,
             last_successful_bridge_contract_version AS bridgeContractVersion
      FROM finance_sync_state WHERE connector_id = ?
    `).get(connectorConfig.id)).toMatchObject({
      sourceAsOf: '2026-08-10T11:00:00.000Z',
      itemCount: 501,
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      projectionStartDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      coverageStart: new Date().toISOString().slice(0, 10),
      coverageEnd: new Date().toISOString().slice(0, 10),
      bridgeContractVersion: 'bridge-v1',
    });
    expect(sqlite.prepare(`
      SELECT provenance_fetched_at AS fetchedAt
      FROM finance_transactions
      WHERE connector_instance_id = ? AND upstream_transaction_id = 'transaction-0'
    `).get(connectorConfig.id)).toEqual({ fetchedAt: '2026-08-10T11:00:00.000Z' });

    sqlite.prepare(`
      UPDATE finance_transactions
      SET assigned_kid_id = 'kid-local', kid_assignment_method = 'manual',
          triage_status = 'confirmed', confirmed_category = 'local-category'
      WHERE upstream_transaction_id = 'transaction-0'
    `).run();
    mockPages([fixtures.slice(0, 500), fixtures.slice(500)]);
    expect(await synchronizer.sync({ full: false })).toEqual({
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsRemoved: 0,
    });
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, triage_status AS triageStatus,
             confirmed_category AS confirmedCategory
      FROM finance_transactions
      WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({
      kidId: 'kid-local',
      triageStatus: 'confirmed',
      confirmedCategory: 'local-category',
    });

    const updatedFixtures = fixtures.map((item, index) =>
      index === 0 ? transaction('transaction-0', { amount: -22, isPending: false }) : item);
    mockPages([updatedFixtures.slice(0, 500), updatedFixtures.slice(500)]);
    expect(await synchronizer.sync({ full: false })).toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 1,
      itemsRemoved: 0,
    });
    expect(sqlite.prepare(`
      SELECT amount, is_pending AS isPending, assigned_kid_id AS kidId
      FROM finance_transactions WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({ amount: -22, isPending: 0, kidId: 'kid-local' });
  });

  it('does not advance the successful window or tombstone on interruption', async () => {
    const before = sqlite.prepare(`
      SELECT last_successful_sync_at AS lastSuccess
      FROM finance_sync_state WHERE connector_id = ?
    `).get(connectorConfig.id) as { lastSuccess: string };
    controller = new AbortController();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.searchParams.has('cursor')) {
        return page([transaction('partial-new')], 'page-1');
      }
      controller.abort(new Error('Invented cancellation'));
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(synchronizer.sync({
      full: false,
      signal: controller.signal,
    })).rejects.toThrow('Invented cancellation');

    expect(sqlite.prepare(`
      SELECT last_successful_sync_at AS lastSuccess, status
      FROM finance_sync_state WHERE connector_id = ?
    `).get(connectorConfig.id)).toEqual({
      lastSuccess: before.lastSuccess,
      status: 'failed',
    });
    expect(sqlite.prepare(`
      SELECT lifecycle_status AS lifecycle
      FROM finance_transactions WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({ lifecycle: 'active' });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM finance_transactions
      WHERE upstream_transaction_id = 'partial-new'
    `).get()).toEqual({ count: 1 });
  });

  it('restarts from page one and tombstones only after a complete authoritative generation', async () => {
    mockPages([[
      transaction('partial-new'),
      transaction('posted-replacement', { amount: -10, isPending: false }),
    ]]);

    const result = await synchronizer.sync({ full: false });

    expect(result.itemsAdded).toBe(1);
    expect(result.itemsRemoved).toBe(501);
    expect(sqlite.prepare(`
      SELECT lifecycle_status AS lifecycle
      FROM finance_transactions WHERE upstream_transaction_id = 'transaction-0'
    `).get()).toEqual({ lifecycle: 'deleted' });
    expect(sqlite.prepare(`
      SELECT lifecycle_status AS lifecycle
      FROM finance_transactions WHERE upstream_transaction_id = 'posted-replacement'
    `).get()).toEqual({ lifecycle: 'active' });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM finance_transactions
      WHERE upstream_transaction_id = 'partial-new'
    `).get()).toEqual({ count: 1 });
  });

  it('audits category write-back and confirms local state only after upstream success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      status: 'updated',
      transactionId: 'partial-new',
      categoryId: 'category-confirmed',
    }), {
      headers: {
        'content-type': 'application/json',
        'x-monarch-contract-version': '1.0',
      },
    })));

    await expect(updateFinanceCategory(
      connectorConfig,
      'finance:finance-snapshot-test:partial-new',
      'category-confirmed',
      'writeback-success',
    )).resolves.toEqual({
      idempotencyKey: 'writeback-success',
      status: 'updated',
    });
    expect(sqlite.prepare(`
      SELECT confirmed_category AS confirmedCategory, triage_status AS triageStatus
      FROM finance_transactions WHERE upstream_transaction_id = 'partial-new'
    `).get()).toEqual({
      confirmedCategory: 'category-confirmed',
      triageStatus: 'confirmed',
    });
    expect(sqlite.prepare(`
      SELECT status, attempt_count AS attempts
      FROM finance_mutation_audit WHERE idempotency_key = 'writeback-success'
    `).get()).toEqual({ status: 'succeeded', attempts: 1 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      error: { code: 'upstream_unavailable', message: 'invented private detail' },
    }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-monarch-contract-version': '1.0',
      },
    })));
    await expect(updateFinanceCategory(
      connectorConfig,
      'finance:finance-snapshot-test:partial-new',
      'category-failed',
      'writeback-failure',
    )).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(sqlite.prepare(`
      SELECT status, last_error_code AS errorCode
      FROM finance_mutation_audit WHERE idempotency_key = 'writeback-failure'
    `).get()).toEqual({ status: 'failed', errorCode: 'upstream_unavailable' });
    expect(sqlite.prepare(`
      SELECT confirmed_category AS confirmedCategory
      FROM finance_transactions WHERE upstream_transaction_id = 'partial-new'
    `).get()).toEqual({ confirmedCategory: 'category-confirmed' });

    await expect(updateFinanceCategory(
      connectorConfig,
      'finance:finance-snapshot-test:partial-new',
      'different-category',
      'writeback-success',
    )).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const blockedAt = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO finance_mutation_audit (
        id, idempotency_key, connector_id, transaction_id,
        upstream_transaction_id, operation, requested_value, status,
        attempt_count, created_at, updated_at
      ) VALUES (
        'concurrent-mutation', 'concurrent-key', ?, ?,
        'partial-new', 'category_update', 'other-category', 'processing',
        1, ?, ?
      )
    `).run(
      connectorConfig.id,
      'finance:finance-snapshot-test:partial-new',
      blockedAt,
      blockedAt,
    );
    await expect(updateFinanceCategory(
      connectorConfig,
      'finance:finance-snapshot-test:partial-new',
      'third-category',
      'different-key',
    )).rejects.toMatchObject({ code: 'mutation_in_progress' });
  });

  it('attributes a normalized page without sending private finance fields', async () => {
    const attributionBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== 'tyrion-operations-ui') {
        return page([transaction('attributed-transaction', {
          merchant: { name: 'Invented merchant', logoUrl: null },
        })], null);
      }
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer invented-test-token');
      const body = JSON.parse(String(init?.body)) as {
        expectedPolicyVersion: number | null;
        items: Array<Record<string, unknown> & { sourceRef: string }>;
      };
      attributionBodies.push(body);
      return new Response(JSON.stringify({
        contractVersion: '2.0',
        policyVersion: 7,
        engineVersion: '2.0.0',
        results: body.items.map((entry) => ({
          contractVersion: '2.0',
          sourceRef: entry.sourceRef,
          status: 'attributed',
          kidId: 'kid-one',
          confidence: 'definite',
          method: 'account-rule',
          explanation: 'Matched an account rule',
          reviewStatus: 'not-required',
          reasons: [],
          decisionSource: 'automated',
          policyVersion: 7,
          engineVersion: '2.0.0',
          evaluatedAt: '2026-08-08T12:00:00.000Z',
        })),
      }), { headers: { 'content-type': 'application/json' } });
    }));

    await expect(synchronizer.sync({ full: false })).resolves.toMatchObject({
      itemsAdded: 1,
    });
    const firstAttributionBody = attributionBodies[0] as {
      items: Array<Record<string, unknown>>;
    };
    expect(Object.keys(firstAttributionBody.items[0]!).sort()).toEqual([
      'accountRef',
      'existingManualDecision',
      'merchantName',
      'observedAt',
      'occurredOn',
      'sourceRef',
    ]);
    expect(firstAttributionBody.items[0]!.accountRef)
      .toMatch(/^account-v1:[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(attributionBodies[0])).not.toMatch(
      /amount|accountId|mask|notes|tags|category|attributed-transaction/,
    );
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId,
             attribution_status AS status,
             attribution_policy_version AS policyVersion,
             attribution_engine_version AS engineVersion
      FROM finance_transactions
      WHERE upstream_transaction_id = 'attributed-transaction'
    `).get()).toEqual({
      kidId: 'kid-one',
      status: 'attributed',
      policyVersion: 7,
      engineVersion: '2.0.0',
    });
  });

  it('reuses one account reference without an attribution rollout gate', async () => {
    const attributionBodies: Array<{ items: Array<Record<string, unknown> & { sourceRef: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== 'tyrion-operations-ui') {
        return page([
          transaction('attributed-transaction'),
          transaction('second-account-transaction'),
        ], null);
      }
      const body = JSON.parse(String(init?.body)) as {
        items: Array<Record<string, unknown> & { sourceRef: string }>;
      };
      attributionBodies.push(body);
      return new Response(JSON.stringify({
        contractVersion: '2.0',
        policyVersion: 7,
        engineVersion: '2.0.0',
        results: body.items.map((entry) => ({
          contractVersion: '2.0',
          sourceRef: entry.sourceRef,
          status: 'attributed',
          kidId: 'kid-one',
          confidence: 'definite',
          method: 'account-rule',
          explanation: 'Matched an account rule',
          reviewStatus: 'not-required',
          reasons: [],
          decisionSource: 'automated',
          policyVersion: 7,
          engineVersion: '2.0.0',
          evaluatedAt: '2026-08-08T12:00:00.000Z',
        })),
      }), { headers: { 'content-type': 'application/json' } });
    }));

    await expect(synchronizer.sync({ full: false })).resolves.toMatchObject({
      itemsAdded: 1,
    });
    expect(attributionBodies[0]?.items[0]?.accountRef)
      .toMatch(/^account-v1:[A-Za-z0-9_-]{43}$/);
    expect(attributionBodies[0]?.items[1]?.accountRef)
      .toBe(attributionBodies[0]?.items[0]?.accountRef);
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, attribution_status AS status,
             attribution_last_error_code AS failureCode
      FROM finance_transactions
      WHERE upstream_transaction_id = 'second-account-transaction'
    `).get()).toEqual({
      kidId: 'kid-one',
      status: 'attributed',
      failureCode: null,
    });
    sqlite.prepare(`
      DELETE FROM finance_attribution_audit
      WHERE transaction_id = ?
    `).run(`finance:${connectorConfig.id}:attributed-transaction`);
    sqlite.prepare(`
      DELETE FROM finance_attribution_exceptions
      WHERE transaction_id = ?
    `).run(`finance:${connectorConfig.id}:attributed-transaction`);
  });

  it('never overwrites a newer validated manual decision', async () => {
    applyManualAttributionDecision({
      connectorId: connectorConfig.id,
      transactionId: `finance:${connectorConfig.id}:attributed-transaction`,
      action: 'assign-kid',
      kidId: 'kid-one',
      idempotencyKey: 'manual-decision-0001',
      actorType: 'parent-admin',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== 'tyrion-operations-ui') {
        return page([transaction('attributed-transaction')], null);
      }
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ sourceRef: string; existingManualDecision: unknown }>;
      };
      expect(body.items[0].existingManualDecision).toMatchObject({
        action: 'assign-kid',
        kidId: 'kid-one',
      });
      applyManualAttributionDecision({
        connectorId: connectorConfig.id,
        transactionId: `finance:${connectorConfig.id}:attributed-transaction`,
        action: 'parent-expense',
        kidId: null,
        idempotencyKey: 'manual-decision-0002',
        actorType: 'parent-admin',
      });
      return new Response(JSON.stringify({
        contractVersion: '2.0',
        policyVersion: 7,
        engineVersion: '2.0.0',
        results: [{
          contractVersion: '2.0',
          sourceRef: body.items[0].sourceRef,
          status: 'attributed',
          kidId: 'kid-one',
          confidence: 'definite',
          method: 'manual',
          explanation: 'Confirmed by the submitted manual decision',
          reviewStatus: 'not-required',
          reasons: [],
          decisionSource: 'manual',
          policyVersion: 7,
          engineVersion: '2.0.0',
          evaluatedAt: '2026-08-08T12:00:00.000Z',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }));

    await synchronizer.sync({ full: false });

    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, kid_assignment_method AS method,
             attribution_status AS status
      FROM finance_transactions
      WHERE upstream_transaction_id = 'attributed-transaction'
    `).get()).toEqual({
      kidId: null,
      method: 'manual',
      status: 'unassigned',
    });
    expect(sqlite.prepare(`
      SELECT status
      FROM finance_attribution_exceptions
      WHERE transaction_id = ?
    `).get(`finance:${connectorConfig.id}:attributed-transaction`))
      .toBeUndefined();
    expect(sqlite.prepare(`
      SELECT actor_type AS actorType
      FROM finance_attribution_audit
      WHERE idempotency_key = 'manual-decision-0001'
    `).get()).toEqual({ actorType: 'parent-admin' });
  });

  it('does not let an in-flight failure downgrade a newer manual decision', async () => {
    applyManualAttributionDecision({
      connectorId: connectorConfig.id,
      transactionId: `finance:${connectorConfig.id}:attributed-transaction`,
      action: 'assign-kid',
      kidId: 'kid-one',
      idempotencyKey: 'manual-decision-0003',
      actorType: 'parent-admin',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname !== 'tyrion-operations-ui') {
        return page([transaction('attributed-transaction')], null);
      }
      applyManualAttributionDecision({
        connectorId: connectorConfig.id,
        transactionId: `finance:${connectorConfig.id}:attributed-transaction`,
        action: 'parent-expense',
        kidId: null,
        idempotencyKey: 'manual-decision-0004',
        actorType: 'parent-admin',
      });
      return new Response(JSON.stringify({
        error: { code: 'policy_unavailable', message: 'Invented policy failure' },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(synchronizer.sync({ full: false })).resolves.toMatchObject({
      itemsUpdated: 0,
    });
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, kid_assignment_method AS method,
             manual_decision_action AS action, attribution_status AS status
      FROM finance_transactions
      WHERE upstream_transaction_id = 'attributed-transaction'
    `).get()).toEqual({
      kidId: null,
      method: 'manual',
      action: 'parent-expense',
      status: 'unassigned',
    });
  });

  it('commits the generation and deduplicates exceptions when policy is unavailable', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname !== 'tyrion-operations-ui') {
        return page([transaction('policy-unavailable-transaction')], null);
      }
      return new Response(JSON.stringify({
        error: { code: 'policy_unavailable', message: 'private policy path' },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(synchronizer.sync({ full: false })).resolves.toMatchObject({
      itemsAdded: 1,
    });
    await expect(synchronizer.sync({ full: false })).resolves.toMatchObject({
      itemsAdded: 0,
    });

    expect(sqlite.prepare(`
      SELECT status, attribution_status AS attributionStatus,
             attribution_last_error_code AS errorCode
      FROM finance_sync_state WHERE connector_id = ?
    `).get(connectorConfig.id)).toEqual({
      status: 'succeeded',
      attributionStatus: 'unavailable',
      errorCode: 'policy_unavailable',
    });
    expect(sqlite.prepare(`
      SELECT count(*) AS count, max(occurrence_count) AS occurrences
      FROM finance_attribution_exceptions
      WHERE connector_id = ? AND transaction_id = ?
    `).get(
      connectorConfig.id,
      `finance:${connectorConfig.id}:policy-unavailable-transaction`,
    )).toEqual({ count: 1, occurrences: 2 });

    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'dismissed', review_state = 'resolved',
          resolution = 'dismissed', resolved_at = CURRENT_TIMESTAMP
      WHERE connector_id = ? AND transaction_id = ?
    `).run(
      connectorConfig.id,
      `finance:${connectorConfig.id}:policy-unavailable-transaction`,
    );
    sqlite.prepare(`
      UPDATE finance_transactions SET attribution_review_state = 'resolved'
      WHERE connector_instance_id = ? AND upstream_transaction_id = ?
    `).run(connectorConfig.id, 'policy-unavailable-transaction');
    await synchronizer.sync({ full: false });
    expect(sqlite.prepare(`
      SELECT e.status, e.review_state AS exceptionReviewState,
             t.attribution_review_state AS transactionReviewState,
             e.occurrence_count AS occurrences
      FROM finance_attribution_exceptions e
      INNER JOIN finance_transactions t ON t.id = e.transaction_id
      WHERE e.connector_id = ? AND e.transaction_id = ?
    `).get(
      connectorConfig.id,
      `finance:${connectorConfig.id}:policy-unavailable-transaction`,
    )).toEqual({
      status: 'dismissed',
      exceptionReviewState: 'resolved',
      transactionReviewState: 'resolved',
      occurrences: 3,
    });
  });

  it('uses a 365-day backfill while legacy tagged rows lack stable references', async () => {
    sqlite.prepare(`
      UPDATE finance_transactions
      SET lifecycle_status = 'active', tags = '["Reviewed"]', tag_references = '[]'
      WHERE connector_instance_id = ?
    `).run(connectorConfig.id);
    sqlite.prepare(`
      UPDATE finance_sync_state SET last_successful_window_end = ?
      WHERE connector_id = ?
    `).run(new Date().toISOString().slice(0, 10), connectorConfig.id);
    let requestedStart: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedStart = url.searchParams.get('start_date');
      return page([], null);
    }));

    await synchronizer.sync({ full: false });

    const expectedStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expectedStart.setUTCDate(expectedStart.getUTCDate() - 364);
    expect(requestedStart).toBe(expectedStart.toISOString().slice(0, 10));
    expect(sqlite.prepare(`
      SELECT last_mode AS mode FROM finance_sync_state WHERE connector_id = ?
    `).get(connectorConfig.id)).toEqual({ mode: 'backfill' });

    const oldDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    oldDate.setUTCDate(oldDate.getUTCDate() - 365);
    sqlite.prepare(`
      INSERT INTO finance_transactions (
        id, connector_instance_id, upstream_transaction_id, date, amount,
        tags, tag_references, lifecycle_status, source_fingerprint, synced_at
      ) VALUES (?, ?, ?, ?, -1, '["Reviewed"]', '[]', 'active', ?, ?)
    `).run(
      `finance:${connectorConfig.id}:old-tagged-transaction`,
      connectorConfig.id,
      'old-tagged-transaction',
      oldDate.toISOString().slice(0, 10),
      'old-tagged-fingerprint',
      new Date().toISOString(),
    );
    requestedStart = null;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requestedStart = new URL(String(input)).searchParams.get('start_date');
      return page([], null);
    }));

    await synchronizer.sync({ full: false });

    const incrementalStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    incrementalStart.setUTCDate(incrementalStart.getUTCDate() - 7);
    expect(requestedStart).toBe(incrementalStart.toISOString().slice(0, 10));
    expect(sqlite.prepare(`
      SELECT lifecycle_status AS lifecycleStatus
      FROM finance_transactions
      WHERE connector_instance_id = ? AND upstream_transaction_id = 'old-tagged-transaction'
    `).get(connectorConfig.id)).toEqual({ lifecycleStatus: 'active' });
  });
});
