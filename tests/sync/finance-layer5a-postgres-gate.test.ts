import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqliteTouch: vi.fn(),
  snapshotSync: vi.fn(async () => ({
    itemsAdded: 2,
    itemsUpdated: 1,
    itemsRemoved: 0,
  })),
  datasetSync: vi.fn(async () => ({
    itemsAdded: 3,
    itemsUpdated: 0,
    itemsRemoved: 1,
    status: 'fresh',
    datasetErrors: {},
  })),
  historySync: vi.fn(async () => {
    throw new Error('Layer 5B history must remain gated');
  }),
  publication: vi.fn(() => {
    throw new Error('Layer 5B publication must remain gated');
  }),
  prune: vi.fn(() => {
    throw new Error('Layer 5B occurrence cache must remain gated');
  }),
}));

vi.mock('@/db/runtime-backend', () => ({
  resolveDatabaseBackend: () => 'postgres',
}));

vi.mock('@/db', () => {
  const forbidden = new Proxy({}, {
    get() {
      mocks.sqliteTouch();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { default: forbidden, db: forbidden, sqlite: forbidden };
});

vi.mock('@/lib/connectors/monarch-money/snapshot-sync', () => ({
  FinanceSnapshotSynchronizer: class {
    sync = mocks.snapshotSync;
  },
  updateFinanceCategory: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/dataset-sync', () => ({
  FinanceDatasetSynchronizer: class {
    sync = mocks.datasetSync;
  },
}));

vi.mock('@/lib/connectors/monarch-money/finance-insight-history-sync', () => ({
  FinanceInsightHistorySynchronizer: class {
    sync = mocks.historySync;
  },
}));

vi.mock('@/lib/connectors/monarch-money/attribution-service', () => ({
  applyManualAttributionDecision: vi.fn(),
}));

vi.mock('@/lib/finance-insights/publication', () => ({
  captureFinanceInsightPublication: mocks.publication,
}));

vi.mock('@/lib/finance-insights/occurrence-cache', () => ({
  pruneFinanceInsightOccurrenceCache: mocks.prune,
}));

describe('Layer 5A PostgreSQL finance gate', () => {
  it('returns after the portable core projection without entering Layer 5B', async () => {
    const { FinanceManagerConnector } = await import(
      '@/lib/connectors/monarch-money'
    );
    const connector = new FinanceManagerConnector();
    await connector.initialize({
      id: 'postgres-finance-gate',
      type: 'finance-manager',
      name: 'PostgreSQL finance gate',
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
    });

    await expect(connector.syncDomainData({ full: true })).resolves.toEqual({
      itemsAdded: 5,
      itemsUpdated: 1,
      itemsRemoved: 1,
      status: 'fresh',
      datasetErrors: {},
    });
    expect(mocks.snapshotSync).toHaveBeenCalledOnce();
    expect(mocks.datasetSync).toHaveBeenCalledOnce();
    expect(mocks.historySync).not.toHaveBeenCalled();
    expect(mocks.publication).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });
});
