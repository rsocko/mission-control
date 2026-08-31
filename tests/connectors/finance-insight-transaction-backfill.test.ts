import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const attributionCoordinatorConstructor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/connectors/monarch-money/attribution-service', () => ({
  FinanceAttributionCoordinator: class {
    constructor(...args: unknown[]) {
      attributionCoordinatorConstructor(...args);
    }

    async attributePage(): Promise<void> {}
    finish(): void {}
  },
}));

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-backfill-'));
const databasePath = join(tempDirectory, 'backfill.db');
let sqlite: Database.Database;
let planFinanceInsightBackfillWindows:
  typeof import('@/lib/connectors/monarch-money/transaction-backfill')['planFinanceInsightBackfillWindows'];
let runFinanceInsightTransactionBackfill:
  typeof import('@/lib/connectors/monarch-money/transaction-backfill')['runFinanceInsightTransactionBackfill'];

const config: ConnectorConfig = {
  id: 'finance-backfill-test',
  type: 'finance-manager',
  name: 'Finance backfill test',
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
  credentials: { serviceToken: 'invented-service-token' },
  settings: {
    bridgeUrl: 'http://localhost:8100',
    householdCurrency: 'USD',
    maxRetries: 0,
  },
  syncedLists: [],
};

function transaction(id: string, date: string) {
  return {
    id,
    date,
    amount: -10,
    merchant: { name: `Invented merchant ${id}`, logoUrl: null },
    category: null,
    account: { id: 'account-one', displayName: 'Invented account', mask: '1234' },
    isPending: false,
    isRecurring: false,
    notes: null,
    tags: [],
    tagReferences: [],
  };
}

function page(
  items: ReturnType<typeof transaction>[],
  nextCursor: string | null = null,
  total = items.length,
  fetchedAt = '2024-02-29T12:00:00.000Z',
) {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    provenance: { provider: 'live', fetchedAt },
    transactions: items,
    total,
    page: { limit: 500, nextCursor },
  }), {
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  sqlite = (await import('@/db')).sqlite;
  ({
    planFinanceInsightBackfillWindows,
    runFinanceInsightTransactionBackfill,
  } = await import('@/lib/connectors/monarch-money/transaction-backfill'));
});

beforeEach(() => {
  attributionCoordinatorConstructor.mockClear();
  for (const table of [
    'finance_insight_transaction_window_proofs',
    'finance_insight_transaction_backfill_plans',
    'finance_insight_transaction_projection_facts',
    'finance_insight_transaction_projection_windows',
    'finance_insight_transaction_projection_state',
    'finance_insight_cutovers',
    'finance_transactions',
    'connector_configs',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'poll', ?, ?, ?, '[]', ?, ?)
  `).run(
    config.id,
    config.type,
    config.name,
    JSON.stringify(config.capabilities),
    JSON.stringify(config.credentials),
    JSON.stringify(config.settings),
    '2024-02-29T12:00:00.000Z',
    '2024-02-29T12:00:00.000Z',
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('Finance insight transaction backfill', () => {
  it('plans contiguous inclusive windows across leap dates without weakening the 365-day bound', () => {
    const windows = planFinanceInsightBackfillWindows('2024-02-29', 37);
    expect(windows).toEqual([
      { ordinal: 0, start: '2021-02-01', end: '2022-01-31' },
      { ordinal: 1, start: '2022-02-01', end: '2023-01-31' },
      { ordinal: 2, start: '2023-02-01', end: '2024-01-31' },
      { ordinal: 3, start: '2024-02-01', end: '2024-02-29' },
    ]);
  });

  it('resumes a 37-month plan at immutable window boundaries and replays with no fetches', async () => {
    const fetchedWindows: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      const end = url.searchParams.get('end_date')!;
      fetchedWindows.push(`${start}:${end}`);
      const fetchedAt = {
        '2021-02-01': '2024-02-20T12:00:00.000Z',
        '2022-02-01': '2024-02-23T12:00:00.000Z',
        '2023-02-01': '2024-02-26T12:00:00.000Z',
        '2024-02-01': '2024-02-29T12:00:00.000Z',
      }[start]!;
      return page([transaction(`transaction-${start}`, start)], null, 1, fetchedAt);
    }));
    const clock = () => new Date('2024-02-29T12:05:00.000Z');

    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-backfill-key',
      horizonMonths: 37,
      maxWindows: 1,
      clock,
    })).resolves.toMatchObject({
      status: 'running',
      completedWindows: 1,
      totalWindows: 4,
      coverageStart: '2021-02-01',
      coverageEnd: '2024-02-29',
    });
    expect(attributionCoordinatorConstructor).toHaveBeenCalledWith(
      config.id,
      expect.objectContaining({
        financeConfig: config,
        persistence: expect.objectContaining({
          attribution: expect.any(Object),
          identity: expect.any(Object),
        }),
        fenceMode: 'row-generation',
        generationId: expect.any(String),
      }),
    );
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-backfill-key',
      horizonMonths: 37,
      maxWindows: 4,
      clock,
    })).resolves.toMatchObject({
      status: 'completed',
      completedWindows: 4,
      totalWindows: 4,
      itemCount: 4,
    });
    expect(fetchedWindows).toHaveLength(4);
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-backfill-key',
      horizonMonths: 37,
      maxWindows: 4,
      clock: () => new Date('2024-02-29T13:05:00.000Z'),
    })).resolves.toMatchObject({ status: 'completed', itemCount: 4 });
    expect(fetchedWindows).toHaveLength(4);
    expect(sqlite.prepare(`
      SELECT window_ordinal AS ordinal, window_start AS start, window_end AS end,
             item_count AS itemCount
      FROM finance_insight_transaction_window_proofs
      ORDER BY window_ordinal
    `).all()).toEqual([
      { ordinal: 0, start: '2021-02-01', end: '2022-01-31', itemCount: 1 },
      { ordinal: 1, start: '2022-02-01', end: '2023-01-31', itemCount: 1 },
      { ordinal: 2, start: '2023-02-01', end: '2024-01-31', itemCount: 1 },
      { ordinal: 3, start: '2024-02-01', end: '2024-02-29', itemCount: 1 },
    ]);
    expect(sqlite.prepare(`
      SELECT status, source_as_of AS sourceAsOf, item_count AS itemCount,
             coverage_start AS coverageStart,
             coverage_end AS coverageEnd, window_count AS windowCount
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ?
    `).get(config.id)).toEqual({
      status: 'succeeded',
      sourceAsOf: '2024-02-20T12:00:00.000Z',
      itemCount: 4,
      coverageStart: '2021-02-01',
      coverageEnd: '2024-02-29',
      windowCount: 37,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ?
    `).get(config.id)).toEqual({ count: 37 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_facts
      WHERE connector_id = ?
    `).get(config.id)).toEqual({ count: 4 });
    expect(sqlite.prepare(`
      SELECT last_successful_at AS lastSuccessfulAt
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ?
    `).get(config.id)).toEqual({
      lastSuccessfulAt: '2024-02-29T12:05:00.000Z',
    });
    const stored = sqlite.prepare(`
      SELECT source_ref AS sourceRef, payload
      FROM finance_insight_transaction_projection_facts
      WHERE connector_id = ?
      ORDER BY source_ref
      LIMIT 1
    `).get(config.id) as { sourceRef: string; payload: string };
    sqlite.prepare(`
      UPDATE finance_insight_transaction_projection_facts
      SET payload = ?
      WHERE connector_id = ? AND source_ref = ?
    `).run(
      JSON.stringify({ ...JSON.parse(stored.payload), amountMinor: -1001 }),
      config.id,
      stored.sourceRef,
    );
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-backfill-key',
      horizonMonths: 37,
      maxWindows: 4,
      clock: () => new Date('2024-02-29T13:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'finance_insight_backfill_projection_changed',
      status: 409,
    });
    expect(fetchedWindows).toHaveLength(4);
  });

  it('restarts an interrupted window from page one without committing a partial proof', async () => {
    let failSecondPage = true;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      if (!url.searchParams.has('cursor')) {
        return page([transaction('transaction-one', start)], 'page-two', 2);
      }
      if (failSecondPage) throw new Error('invented transport interruption');
      return page([transaction('transaction-two', start)], null, 2);
    }));
    const request = {
      config,
      idempotencyKey: 'invented-restart-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock: () => new Date('2024-02-29T12:05:00.000Z'),
    };
    await expect(runFinanceInsightTransactionBackfill(request))
      .rejects.toMatchObject({ code: 'bridge_unavailable' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_transaction_window_proofs
    `).get()).toEqual({ count: 0 });

    failSecondPage = false;
    await expect(runFinanceInsightTransactionBackfill(request)).resolves.toMatchObject({
      status: 'completed',
      itemCount: 2,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_transactions
      WHERE connector_instance_id = ?
    `).get(config.id)).toEqual({ count: 2 });
  });

  it('records completion after live provenance captured during the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      return page(
        [transaction('transaction-live-provenance', start)],
        null,
        1,
        '2024-02-29T12:00:01.000Z',
      );
    }));
    const clock = vi.fn()
      .mockReturnValueOnce(new Date('2024-02-29T12:00:00.000Z'))
      .mockReturnValueOnce(new Date('2024-02-29T12:00:02.000Z'));

    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-live-provenance-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).resolves.toMatchObject({ status: 'completed', itemCount: 1 });
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it('rejects a truncated final page without tombstoning unseen transactions', async () => {
    let truncated = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      const transactions = [
        transaction('transaction-one', start),
        transaction('transaction-two', start),
      ];
      return page(truncated ? transactions.slice(0, 1) : transactions, null, 2);
    }));
    const clock = () => new Date('2024-02-29T12:05:00.000Z');

    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-complete-window-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).resolves.toMatchObject({ status: 'completed', itemCount: 2 });

    truncated = true;
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-truncated-window-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).rejects.toMatchObject({
      code: 'finance_insight_backfill_window_incomplete',
      status: 409,
    });
    expect(sqlite.prepare(`
      SELECT lifecycle_status AS lifecycleStatus
      FROM finance_transactions
      WHERE connector_instance_id = ? AND upstream_transaction_id = ?
    `).get(config.id, 'transaction-two')).toEqual({ lifecycleStatus: 'active' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_window_proofs
      WHERE plan_id = (
        SELECT id FROM finance_insight_transaction_backfill_plans
        WHERE idempotency_key = ?
      )
    `).get('invented-truncated-window-key')).toEqual({ count: 0 });
  });

  it('refuses delivery-enabled, changed, conflicting, and oversized plans', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('start_date')!;
      return page([transaction('transaction-one', start)]);
    }));
    const clock = () => new Date('2024-02-29T12:05:00.000Z');
    await runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-refusal-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    });
    sqlite.prepare(`
      UPDATE finance_transactions SET amount = -11
      WHERE connector_instance_id = ?
    `).run(config.id);
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-refusal-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).rejects.toMatchObject({ code: 'finance_insight_backfill_window_changed' });
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-refusal-key',
      horizonMonths: 2,
      maxWindows: 1,
      clock,
    })).rejects.toMatchObject({ code: 'finance_insight_backfill_idempotency_conflict' });

    sqlite.prepare(`
      INSERT INTO finance_insight_cutovers (
        connector_id, cutover_at, source_generation, source_sequence,
        legacy_disabled, delivery_enabled, result, created_at, updated_at
      ) VALUES (?, ?, 'generation-one', 1, 1, 1, '{}', ?, ?)
    `).run(
      config.id,
      '2024-02-29T12:00:00.000Z',
      '2024-02-29T12:00:00.000Z',
      '2024-02-29T12:00:00.000Z',
    );
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-delivery-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).rejects.toMatchObject({ code: 'finance_insight_backfill_delivery_enabled' });

    sqlite.prepare(`DELETE FROM finance_insight_cutovers`).run();
    vi.stubGlobal('fetch', vi.fn(async () => page([], null, 50_001)));
    await expect(runFinanceInsightTransactionBackfill({
      config,
      idempotencyKey: 'invented-oversized-key',
      horizonMonths: 1,
      maxWindows: 1,
      clock,
    })).rejects.toMatchObject({ code: 'finance_insight_backfill_page_limit' });
  });
});
