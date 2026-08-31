import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-monarch-datasets-'));
const databasePath = join(tempDirectory, 'datasets.db');
const sourceAsOf = '2026-08-10T12:00:00.000Z';
const now = new Date('2026-08-10T12:05:00.000Z');
let sqlite: Database.Database;
let FinanceDatasetSynchronizer:
  typeof import('@/lib/connectors/monarch-money/dataset-sync')['FinanceDatasetSynchronizer'];
let getFinanceDatasetHealth:
  typeof import('@/lib/connectors/monarch-money/dataset-sync')['getFinanceDatasetHealth'];
let financeDatasetFreshness:
  typeof import('@/lib/connectors/monarch-money/dataset-sync')['financeDatasetFreshness'];

const connector = (id: string): ConnectorConfig => {
  const config: ConnectorConfig = {
    id,
    type: 'finance-manager',
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
    },
    credentials: {
      serviceToken: 'invented-token',
      identityNamespace: createHash('sha256').update(id).digest('hex'),
    },
    settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    syncedLists: [],
  };
  sqlite.prepare(`
    INSERT OR IGNORE INTO connector_configs (
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
    now.toISOString(),
    now.toISOString(),
  );
  return config;
};

function response(path: string, overrides: Record<string, unknown> = {}) {
  const common = {
    contractVersion: '1.0',
    provenance: { provider: 'live', fetchedAt: sourceAsOf },
  };
  const bodies: Record<string, Record<string, unknown>> = {
    '/accounts': {
      ...common,
      accounts: [{
        id: 'account-1',
        displayName: 'Invented checking',
        type: 'checking',
        mask: '1234',
        institution: 'Invented bank',
        currentBalance: 999,
        isActive: true,
      }],
    },
    '/category-groups': {
      ...common,
      categoryGroups: [{ id: 'group-1', name: 'Living', isActive: true }],
    },
    '/categories': {
      ...common,
      categories: [{
        id: 'category-1',
        name: 'Groceries',
        groupId: 'group-1',
        group: 'Living',
        icon: null,
        isActive: true,
      }],
    },
    '/tags': {
      ...common,
      tags: [{ id: 'tag-1', name: 'Household', isActive: true }],
    },
    '/recurring': {
      ...common,
      recurring: [{
        id: 'recurring-1',
        merchant: 'Invented utility',
        amount: -40,
        frequency: 'monthly',
        nextExpectedDate: '2026-09-01',
        account: { id: 'account-1', displayName: 'Invented checking', mask: '1234' },
        category: { id: 'category-1', name: 'Groceries' },
      }],
    },
    '/budgets': {
      ...common,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      budgets: [{
        category: { id: 'category-1', name: 'Groceries' },
        budgeted: 500,
        spent: 200,
        remaining: 300,
        percentUsed: 40,
      }],
    },
  };
  return new Response(JSON.stringify({ ...bodies[path], ...overrides }), {
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

function mockDatasets(
  overrides: Partial<Record<string, Record<string, unknown> | Response>> = {},
) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const override = overrides[path];
    return override instanceof Response
      ? override
      : response(path, override);
  }));
  return calls;
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  sqlite = (await import('@/db')).sqlite;
  const datasetModule = await import('@/lib/connectors/monarch-money/dataset-sync');
  FinanceDatasetSynchronizer = datasetModule.FinanceDatasetSynchronizer;
  getFinanceDatasetHealth = datasetModule.getFinanceDatasetHealth;
  financeDatasetFreshness = datasetModule.financeDatasetFreshness;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('FinanceDatasetSynchronizer', () => {
  it('publishes all normalized datasets without retaining account balances', async () => {
    mockDatasets({
      '/accounts': {
        accounts: [{
          id: 'account-1',
          displayName: 'Invented checking',
          type: 'checking',
          mask: '1234',
          institution: 'Invented bank',
          currentBalance: 123,
          isActive: true,
        }],
      },
    });
    const result = await new FinanceDatasetSynchronizer(connector('dataset-a'), () => now)
      .sync({ full: true });

    expect(result.status).toBe('fresh');
    expect(sqlite.prepare(`
      SELECT display_name AS displayName, type, institution, mask, is_active AS isActive
      FROM finance_accounts WHERE connector_id = 'dataset-a'
    `).get()).toEqual({
      displayName: 'Invented checking',
      type: 'checking',
      institution: 'Invented bank',
      mask: '1234',
      isActive: 1,
    });
    expect(sqlite.prepare(`PRAGMA table_info(finance_accounts)`).all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'current_balance' }),
      ]));
    expect(sqlite.prepare(`
      SELECT dataset, published_item_count AS count, last_attempt_outcome AS outcome
      FROM finance_dataset_sync_state WHERE connector_id = 'dataset-a'
      ORDER BY dataset
    `).all()).toHaveLength(6);
    expect(sqlite.prepare(`
      SELECT dataset, insight_item_count AS itemCount,
             insight_content_digest AS contentDigest,
             insight_bridge_contract_version AS bridgeContractVersion
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a'
        AND dataset IN ('accounts', 'categories', 'tags', 'recurring')
      ORDER BY dataset
    `).all()).toEqual([
      {
        dataset: 'accounts',
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        bridgeContractVersion: 'bridge-v1',
      },
      {
        dataset: 'categories',
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        bridgeContractVersion: 'bridge-v1',
      },
      {
        dataset: 'recurring',
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        bridgeContractVersion: 'bridge-v1',
      },
      {
        dataset: 'tags',
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        bridgeContractVersion: 'bridge-v1',
      },
    ]);
    expect(getFinanceDatasetHealth('dataset-a', now)).toMatchObject({
      aggregate: 'fresh',
      datasets: expect.arrayContaining([
        expect.objectContaining({
          dataset: 'budgets',
          state: 'fresh',
          itemCount: 1,
          coverage: { start: '2026-08-01', end: '2026-08-31' },
        }),
      ]),
    });

    const generationsBeforeReplay = sqlite.prepare(`
      SELECT dataset, current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a'
      ORDER BY dataset
    `).all();
    mockDatasets();
    await expect(new FinanceDatasetSynchronizer(connector('dataset-a'), () => now)
      .sync({ full: true })).resolves.toMatchObject({
        itemsAdded: 0,
        itemsUpdated: 0,
        itemsRemoved: 0,
      });
    expect(sqlite.prepare(`
      SELECT count(DISTINCT generation_id) AS generations
      FROM finance_recurring_obligations WHERE connector_id = 'dataset-a'
    `).get()).toEqual({ generations: 1 });
    expect(sqlite.prepare(`
      SELECT dataset, current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a'
      ORDER BY dataset
    `).all()).toEqual(generationsBeforeReplay);
  });

  it('soft-deactivates complete missing references and retains current plus previous snapshots', async () => {
    mockDatasets({
      '/accounts': { accounts: [] },
      '/category-groups': { categoryGroups: [] },
      '/categories': { categories: [] },
      '/tags': { tags: [] },
      '/recurring': { recurring: [] },
      '/budgets': { budgets: [] },
    });
    await new FinanceDatasetSynchronizer(connector('dataset-a'), () => now)
      .sync({ full: true });

    expect(sqlite.prepare(`
      SELECT is_active AS isActive FROM finance_accounts
      WHERE connector_id = 'dataset-a' AND upstream_account_id = 'account-1'
    `).get()).toEqual({ isActive: 0 });
    expect(sqlite.prepare(`
      SELECT count(DISTINCT generation_id) AS generations,
             sum(CASE WHEN is_current = 1 THEN 1 ELSE 0 END) AS currentRows
      FROM finance_recurring_obligations WHERE connector_id = 'dataset-a'
    `).get()).toEqual({ generations: 1, currentRows: 0 });
    expect(getFinanceDatasetHealth('dataset-a', now).datasets)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ dataset: 'accounts', state: 'fresh', itemCount: 0 }),
        expect.objectContaining({ dataset: 'recurring', state: 'fresh', itemCount: 0 }),
      ]));

    mockDatasets();
    await new FinanceDatasetSynchronizer(connector('dataset-a'), () => now)
      .sync({ full: true });
    expect(sqlite.prepare(`
      SELECT count(DISTINCT generation_id) AS generations,
             sum(CASE WHEN is_current = 1 THEN 1 ELSE 0 END) AS currentRows
      FROM finance_budget_snapshots WHERE connector_id = 'dataset-a'
    `).get()).toEqual({ generations: 1, currentRows: 1 });
    expect(sqlite.prepare(`
      SELECT current_generation_id = previous_generation_id AS sameGeneration
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a' AND dataset = 'budgets'
    `).get()).toEqual({ sameGeneration: 0 });
  });

  it('isolates a malformed dataset and retries only that failed dataset', async () => {
    const calls = mockDatasets({
      '/tags': new Response(JSON.stringify({
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: sourceAsOf },
        tags: [{ id: '', name: 'Invalid', isActive: true }],
      }), {
        headers: {
          'content-type': 'application/json',
          'x-monarch-contract-version': '1.0',
        },
      }),
    });
    const synchronizer = new FinanceDatasetSynchronizer(connector('dataset-b'), () => now);
    const result = await synchronizer.sync({ full: true });

    expect(result).toMatchObject({
      status: 'partial',
      datasetErrors: { tags: 'invalid_contract' },
    });
    expect(getFinanceDatasetHealth('dataset-b', now)).toMatchObject({
      aggregate: 'partial',
      datasets: expect.arrayContaining([
        expect.objectContaining({ dataset: 'accounts', state: 'fresh', warning: null }),
        expect.objectContaining({ dataset: 'tags', state: 'unavailable', warning: 'invalid_contract' }),
      ]),
    });

    calls.length = 0;
    mockDatasets();
    await synchronizer.sync({ full: false });
    expect(calls).toEqual([]);
    const retryFetch = vi.mocked(fetch);
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(String(retryFetch.mock.calls[0][0])).toContain('/tags');
  });

  it('leaves the current snapshot untouched when publication is interrupted', async () => {
    const before = sqlite.prepare(`
      SELECT current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a' AND dataset = 'recurring'
    `).get() as { generationId: string };
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/recurring') {
        controller.abort(new Error('Invented cancellation'));
        throw controller.signal.reason;
      }
      return response(path);
    }));

    await expect(new FinanceDatasetSynchronizer(connector('dataset-a'), () => now).sync({
      full: true,
      signal: controller.signal,
    })).rejects.toThrow('Invented cancellation');
    expect(sqlite.prepare(`
      SELECT current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-a' AND dataset = 'recurring'
    `).get()).toEqual(before);
  });

  it('computes deterministic stale state and isolates connectors', async () => {
    mockDatasets();
    await new FinanceDatasetSynchronizer(connector('dataset-c'), () => now)
      .sync({ full: true });
    expect(getFinanceDatasetHealth(
      'dataset-c',
      new Date('2026-08-12T13:00:00.000Z'),
    ).aggregate).toBe('stale');
    expect(getFinanceDatasetHealth('not-synchronized', now).aggregate).toBe('unavailable');
    expect(financeDatasetFreshness({
      currentGenerationId: 'future-generation',
      sourceAsOf: '2026-08-10T12:06:00.000Z',
      freshUntil: '2026-08-11T12:06:00.000Z',
    }, now)).toBe('stale');
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM finance_accounts
      WHERE connector_id = 'dataset-a'
    `).get()).toEqual({ count: 1 });
  });

  it('treats reordered mixed-case snapshot identifiers as an idempotent replay', async () => {
    const tags = ['_x', '1', 'a', 'B'].map((id) => ({
      id,
      name: `Invented ${id}`,
      isActive: true,
    }));
    const recurring = ['_x', '1', 'a', 'B'].map((id) => ({
      id,
      merchant: `Invented ${id}`,
      amount: -1,
      frequency: 'monthly',
      nextExpectedDate: null,
      account: null,
      category: null,
    }));
    const budgets = ['_x', '1', 'a', 'B'].map((id) => ({
      category: { id, name: `Invented ${id}` },
      budgeted: 1,
      spent: 0,
      remaining: 1,
      percentUsed: 0,
    }));
    mockDatasets({
      '/tags': { tags },
      '/recurring': { recurring },
      '/budgets': { budgets },
    });
    const synchronizer = new FinanceDatasetSynchronizer(connector('dataset-order'), () => now);
    await synchronizer.sync({ full: true });
    const tagGeneration = sqlite.prepare(`
      SELECT current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-order' AND dataset = 'tags'
    `).get();

    mockDatasets({
      '/tags': { tags: [...tags].reverse() },
      '/recurring': { recurring: [...recurring].reverse() },
      '/budgets': { budgets: [...budgets].reverse() },
    });
    await expect(synchronizer.sync({ full: true })).resolves.toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsRemoved: 0,
    });
    expect(sqlite.prepare(`
      SELECT current_generation_id AS generationId
      FROM finance_dataset_sync_state
      WHERE connector_id = 'dataset-order' AND dataset = 'tags'
    `).get()).toEqual(tagGeneration);
  });
});
