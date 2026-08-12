import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-history-'));
const databasePath = join(tempDirectory, 'history.db');
const baseNow = new Date('2026-08-10T12:00:00.000Z');
let sqlite: Database.Database;
let FinanceInsightHistorySynchronizer:
  typeof import('@/lib/connectors/monarch-money/finance-insight-history-sync')['FinanceInsightHistorySynchronizer'];
let buildFinanceInsightHistoryWindows:
  typeof import('@/lib/connectors/monarch-money/finance-insight-history-sync')['buildFinanceInsightHistoryWindows'];

const connector: ConnectorConfig = {
  id: 'finance-history-test',
  type: 'finance-manager',
  name: 'Finance history test',
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
  credentials: { serviceToken: 'invented-test-token' },
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
    amount: -84.25,
    merchant: { name: '  Invented\u0000 market  ', logoUrl: 'https://example.invalid/logo' },
    category: { id: 'category-one', name: 'Invented category' },
    account: { id: 'account-one', displayName: 'Invented account', mask: '1234' },
    isPending: false,
    isRecurring: true,
    notes: 'must not be persisted',
    tags: ['Reviewed'],
    tagReferences: [
      { id: 'tag-two', name: 'Second' },
      { id: 'tag-one', name: 'First' },
      { id: 'tag-one', name: 'Duplicate' },
    ],
  };
}

function bridgePage(
  transactions: unknown[],
  fetchedAt = '2026-08-10T11:59:00.000Z',
  total = transactions.length,
) {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    provenance: { provider: 'live', fetchedAt },
    transactions,
    total,
    page: { limit: 500, nextCursor: null },
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
    FinanceInsightHistorySynchronizer,
    buildFinanceInsightHistoryWindows,
  } = await import('@/lib/connectors/monarch-money/finance-insight-history-sync'));
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM finance_insight_transaction_projection_facts;
    DELETE FROM finance_insight_transaction_projection_windows;
    DELETE FROM finance_insight_transaction_projection_state;
    INSERT OR IGNORE INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials, settings,
      synced_lists, created_at, updated_at
    ) VALUES (
      'finance-history-test', 'finance-manager', 'Finance history test', 1, 'poll',
      '{}', '{}', '{"householdCurrency":"USD"}', '[]',
      '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z'
    );
  `);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance insight transaction history projection', () => {
  it('captures 37 complete calendar months through bounded windows with T1-only facts', async () => {
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      const start = url.searchParams.get('start_date');
      return bridgePage(
        start === '2026-08-01' ? [transaction('transaction-one', '2026-08-09')] : [],
      );
    }));
    const synchronizer = new FinanceInsightHistorySynchronizer(connector, () => baseNow);
    const first = await synchronizer.sync({ full: false });
    const replay = await synchronizer.sync({ full: false });

    expect(first).toMatchObject({
      sourceAsOf: '2026-08-10T11:59:00.000Z',
      itemCount: 1,
      coverageStart: '2023-08-01',
      coverageEnd: '2026-08-10',
    });
    expect(replay.generationId).toBe(first.generationId);
    expect(requests).toHaveLength(74);
    expect(requests[0]!.searchParams.get('start_date')).toBe('2023-08-01');
    expect(requests[0]!.searchParams.get('end_date')).toBe('2023-08-31');
    expect(requests[36]!.searchParams.get('start_date')).toBe('2026-08-01');
    expect(requests[36]!.searchParams.get('end_date')).toBe('2026-08-10');
    expect(requests.every((url) => url.searchParams.get('limit') === '500')).toBe(true);
    expect(sqlite.prepare(`
      SELECT status, successful_generation_id AS generationId,
             coverage_start AS coverageStart, coverage_end AS coverageEnd,
             window_count AS windowCount, item_count AS itemCount
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ?
    `).get(connector.id)).toEqual({
      status: 'succeeded',
      generationId: first.generationId,
      coverageStart: '2023-08-01',
      coverageEnd: '2026-08-10',
      windowCount: 37,
      itemCount: 1,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ? AND generation_id = ?
    `).get(connector.id, first.generationId)).toEqual({ count: 37 });
    const payload = JSON.parse((
      sqlite.prepare(`
        SELECT payload FROM finance_insight_transaction_projection_facts
        WHERE connector_id = ? AND generation_id = ?
      `).get(connector.id, first.generationId) as { payload: string }
    ).payload);
    expect(payload).toEqual({
      sourceRef: 'transaction-one',
      occurredOn: '2026-08-09',
      amountMinor: -8425,
      merchantName: 'Invented market',
      categoryRef: 'category-one',
      accountRef: 'account-one',
      isPending: false,
      recurringRef: null,
      tagRefs: ['tag-one', 'tag-two'],
    });
    expect(JSON.stringify(payload)).not.toMatch(/notes|logo|mask|displayName|tags/i);
  });

  it('retains the prior immutable generation when any monthly window is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bridgePage([])));
    const synchronizer = new FinanceInsightHistorySynchronizer(connector, () => baseNow);
    const successful = await synchronizer.sync({ full: false });
    sqlite.prepare(`
      INSERT INTO finance_insight_transaction_projection_facts (
        connector_id, generation_id, source_ref, occurred_on, payload
      ) VALUES (?, 'abandoned-attempt', 'abandoned-transaction', '2026-08-01', '{}')
    `).run(connector.id);
    sqlite.prepare(`
      INSERT INTO finance_insight_transaction_projection_windows (
        connector_id, generation_id, window_index, coverage_start, coverage_end,
        source_as_of, item_count, content_digest
      ) VALUES (?, 'abandoned-attempt', 0, '2026-08-01', '2026-08-10',
        '2026-08-10T11:59:00.000Z', 0, ?)
    `).run(connector.id, `sha256:${'a'.repeat(64)}`);
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount++;
      return requestCount === 12 ? bridgePage([], undefined, 1) : bridgePage([]);
    }));

    await expect(synchronizer.sync({ full: false })).rejects.toMatchObject({
      code: 'incomplete_snapshot',
    });
    expect(sqlite.prepare(`
      SELECT status, successful_generation_id AS generationId,
             last_error_code AS errorCode
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ?
    `).get(connector.id)).toEqual({
      status: 'failed',
      generationId: successful.generationId,
      errorCode: 'insight_history_incomplete_snapshot',
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ? AND generation_id = ?
    `).get(connector.id, successful.generationId)).toEqual({ count: 37 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_facts
      WHERE connector_id = ? AND generation_id = 'abandoned-attempt'
    `).get(connector.id)).toEqual({ count: 0 });
  });

  it('cannot recreate history after permanent connector deletion during an in-flight fetch', async () => {
    let deleted = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!deleted) {
        deleted = true;
        sqlite.prepare('DELETE FROM connector_configs WHERE id = ?').run(connector.id);
      }
      return bridgePage([]);
    }));

    await expect(new FinanceInsightHistorySynchronizer(connector, () => baseNow).sync({
      full: false,
    })).rejects.toThrow();

    for (const table of [
      'finance_insight_transaction_projection_state',
      'finance_insight_transaction_projection_windows',
      'finance_insight_transaction_projection_facts',
    ]) {
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count FROM ${table} WHERE connector_id = ?
      `).get(connector.id)).toEqual({ count: 0 });
    }
  });

  it('refuses stale provenance before promotion and keeps the prior generation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bridgePage([])));
    const synchronizer = new FinanceInsightHistorySynchronizer(connector, () => baseNow);
    const successful = await synchronizer.sync({ full: false });
    vi.stubGlobal('fetch', vi.fn(async () => (
      bridgePage([], '2026-08-07T11:59:00.000Z')
    )));

    await expect(synchronizer.sync({ full: false })).rejects.toMatchObject({
      code: 'stale_snapshot',
    });
    expect(sqlite.prepare(`
      SELECT status, successful_generation_id AS generationId,
             last_error_code AS errorCode
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ?
    `).get(connector.id)).toEqual({
      status: 'failed',
      generationId: successful.generationId,
      errorCode: 'insight_history_stale_snapshot',
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ? AND generation_id = ?
    `).get(connector.id, successful.generationId)).toEqual({ count: 37 });
  });

  it('uses locale-independent source-reference ordering for immutable digests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return bridgePage(url.searchParams.get('start_date') === '2026-08-01'
        ? [
            transaction('a-transaction', '2026-08-09'),
            transaction('B-transaction', '2026-08-09'),
          ]
        : []);
    }));

    await expect(new FinanceInsightHistorySynchronizer(
      connector,
      () => baseNow,
    ).sync({ full: false })).resolves.toMatchObject({ itemCount: 2 });
  });

  it('builds contiguous non-overlapping calendar-month windows', () => {
    const windows = buildFinanceInsightHistoryWindows('2024-02-29');
    expect(windows).toHaveLength(37);
    expect(windows[0]).toEqual({ index: 0, start: '2021-02-01', end: '2021-02-28' });
    expect(windows.at(-1)).toEqual({ index: 36, start: '2024-02-01', end: '2024-02-29' });
    for (let index = 1; index < windows.length; index++) {
      const priorEnd = new Date(`${windows[index - 1]!.end}T00:00:00.000Z`);
      priorEnd.setUTCDate(priorEnd.getUTCDate() + 1);
      expect(priorEnd.toISOString().slice(0, 10)).toBe(windows[index]!.start);
    }
  });
});
