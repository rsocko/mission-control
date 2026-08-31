import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const mocks = vi.hoisted(() => {
  const sqliteTouch = vi.fn();
  const snapshots = {
    readBasis: vi.fn(async () => ({
      lastSuccessfulWindowEnd: null,
      needsStableTagBackfill: false,
    })),
    start: vi.fn(async () => undefined),
    upsertPage: vi.fn(async () => ({ added: 1, updated: 0 })),
    complete: vi.fn(async () => ({ removed: 2 })),
    fail: vi.fn(async () => ({ recorded: true })),
  };
  const datasetState = [
    'accounts',
    'category-groups',
    'categories',
    'tags',
    'recurring',
    'budgets',
  ].map((dataset) => ({
    dataset,
    lastAttemptAt: '2026-08-30T12:00:00.000Z',
    lastAttemptOutcome: 'succeeded',
    lastSuccessfulAt: '2026-08-30T12:00:00.000Z',
    sourceAsOf: '2026-08-30T12:00:00.000Z',
    freshUntil: '2099-08-31T12:00:00.000Z',
    coverageStart: null,
    coverageEnd: null,
    currentGenerationId: `${dataset}-generation`,
    previousGenerationId: null,
    schemaVersion: '1.0',
    configVersion: 1,
    publishedItemCount: 1,
    sourceLimit: 1_000,
    lastErrorCode: null,
  }));
  const datasets = {
    listState: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(datasetState),
    recordAttempt: vi.fn(async () => undefined),
    publishReference: vi.fn(async () => ({
      added: 1,
      updated: 0,
      removed: 0,
      count: 1,
    })),
    publishRecurring: vi.fn(async () => ({
      added: 1,
      updated: 0,
      removed: 0,
      count: 1,
    })),
    publishBudgets: vi.fn(async () => ({
      added: 1,
      updated: 0,
      removed: 0,
      count: 1,
    })),
    recordFailure: vi.fn(async () => ({ recorded: true })),
  };
  return {
    sqliteTouch,
    snapshots,
    datasets,
    datasetState,
    attributePage: vi.fn(async () => undefined),
    finishAttribution: vi.fn(async () => undefined),
  };
});

vi.mock('@/db', () => {
  const forbidden = new Proxy({}, {
    get() {
      mocks.sqliteTouch();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { sqlite: forbidden, db: forbidden, default: forbidden };
});

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    finance: {
      identity: {},
      snapshots: mocks.snapshots,
      datasets: mocks.datasets,
      attribution: {},
    },
  }),
}));

vi.mock('@/lib/connectors/monarch-money/attribution-service', () => ({
  FinanceAttributionCoordinator: class {
    attributePage = mocks.attributePage;
    finish = mocks.finishAttribution;
  },
}));

vi.mock('@/lib/finance-insights/publication', () => ({
  loadFinanceInsightProjectionFacts: vi.fn(() => {
    throw new Error('Layer 5B proof loader must not run');
  }),
}));

vi.mock('@/lib/finance-insights/canonical', () => ({
  financeInsightDigestV1: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/client', () => {
  class MonarchBridgeError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly retryable = false,
      readonly status = 500,
    ) {
      super(message);
    }
  }
  class MonarchBridgeClient {
    async getTransactionsPage() {
      return {
        provenance: { provider: 'live', fetchedAt: '2026-08-30T12:00:00.000Z' },
        transactions: [{
          id: 'transaction-one',
          date: '2026-08-30',
          amount: -1,
          merchant: { name: 'Merchant', logoUrl: null },
          category: null,
          account: { id: 'account-one', displayName: 'Checking', mask: null },
          isPending: false,
          isRecurring: false,
          notes: null,
          tags: [],
          tagReferences: [],
        }],
        page: { nextCursor: null },
      };
    }
    async getAccounts() {
      return {
        accounts: [{
          id: 'account-one',
          displayName: 'Checking',
          type: 'checking',
          institution: null,
          mask: null,
          currentBalance: null,
          isActive: true,
        }],
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
    async getCategoryGroups() {
      return {
        categoryGroups: [{ id: 'group-one', name: 'Living', isActive: true }],
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
    async getCategories() {
      return {
        categories: [{
          id: 'category-one',
          name: 'Food',
          groupId: 'group-one',
          group: 'Living',
          icon: null,
          isActive: true,
        }],
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
    async getTags() {
      return {
        tags: [{ id: 'tag-one', name: 'Household', isActive: true }],
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
    async getRecurring() {
      return {
        recurring: [{
          id: 'recurring-one',
          merchant: 'Utility',
          amount: -10,
          frequency: 'monthly',
          nextExpectedDate: null,
          account: null,
          category: null,
        }],
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
    async getBudgets() {
      return {
        budgets: [{
          category: { id: 'category-one', name: 'Food' },
          budgeted: 100,
          spent: 25,
          remaining: 75,
          percentUsed: 25,
        }],
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        provenance: { fetchedAt: '2026-08-30T12:00:00.000Z' },
      };
    }
  }
  return {
    MonarchBridgeClient,
    MonarchBridgeError,
    MONARCH_DATASET_LIMITS: {
      accounts: 1_000,
      'category-groups': 1_000,
      categories: 5_000,
      tags: 5_000,
      recurring: 10_000,
      budgets: 5_000,
    },
  };
});

const config: ConnectorConfig = {
  id: 'finance-layer5a',
  type: 'finance-manager',
  name: 'Finance Layer 5A',
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
  credentials: {},
  settings: {},
  syncedLists: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.datasets.listState
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValue(mocks.datasetState);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Layer 5A finance orchestration selection', () => {
  it('persists transaction generations only through the finance composition', async () => {
    const { FinanceSnapshotSynchronizer } = await import(
      '@/lib/connectors/monarch-money/snapshot-sync'
    );
    const result = await new FinanceSnapshotSynchronizer(config).sync({ full: true });

    expect(result).toEqual({ itemsAdded: 1, itemsUpdated: 0, itemsRemoved: 2 });
    expect(mocks.snapshots.start).toHaveBeenCalledOnce();
    expect(mocks.snapshots.upsertPage).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: config.id,
      transactions: expect.arrayContaining([
        expect.objectContaining({ id: 'transaction-one' }),
      ]),
    }));
    expect(mocks.snapshots.complete).toHaveBeenCalledOnce();
    expect(mocks.attributePage).toHaveBeenCalledOnce();
    expect(mocks.finishAttribution).toHaveBeenCalledOnce();
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });

  it('publishes every core reference dataset through adapter-owned commands', async () => {
    const { FinanceDatasetSynchronizer } = await import(
      '@/lib/connectors/monarch-money/dataset-sync'
    );
    const result = await new FinanceDatasetSynchronizer(
      config,
      () => new Date('2026-08-30T12:00:00.000Z'),
    ).sync({ full: true });

    expect(result).toMatchObject({
      itemsAdded: 6,
      itemsUpdated: 0,
      itemsRemoved: 0,
      status: 'fresh',
    });
    expect(mocks.datasets.recordAttempt).toHaveBeenCalledTimes(6);
    expect(mocks.datasets.publishReference).toHaveBeenCalledTimes(4);
    expect(mocks.datasets.publishRecurring).toHaveBeenCalledOnce();
    expect(mocks.datasets.publishBudgets).toHaveBeenCalledOnce();
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });
});
