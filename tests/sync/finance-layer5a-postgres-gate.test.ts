import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqliteModuleEvaluations: 0,
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
  historySync: vi.fn(async () => ({
    generationId: 'synthetic-history-generation',
    sourceAsOf: '2026-08-30T12:00:00.000Z',
    itemCount: 1,
    coverageStart: '2026-08-01',
    coverageEnd: '2026-08-30',
  })),
  publication: vi.fn(async () => ({
    status: 'published',
    publicationId: 'synthetic-publication',
  })),
  ingestion: vi.fn(async () => ({
    status: 'completed',
    itemCount: 1,
    notificationsProcessed: 1,
    notificationsAdded: 1,
  })),
  prune: vi.fn(async () => 1),
  attention: vi.fn(async () => ({
    evaluated: 1,
    notificationsCreated: 1,
    taskPromoted: 0,
    autoIncluded: 0,
    deferred: 0,
    settled: 0,
    stalePreserved: 0,
  })),
}));

vi.mock('@/db/runtime-backend', () => ({
  resolveDatabaseBackend: () => 'postgres',
}));

vi.mock('@/db', () => {
  mocks.sqliteModuleEvaluations++;
  const forbidden = new Proxy({}, {
    get() {
      mocks.sqliteTouch();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { default: forbidden, db: forbidden, sqlite: forbidden };
});

vi.mock('@/lib/connectors/monarch-money/snapshot-synchronizer', () => ({
  FinanceSnapshotSynchronizer: class {
    sync = mocks.snapshotSync;
  },
}));

vi.mock('@/lib/connectors/monarch-money/dataset-synchronizer', () => ({
  FinanceDatasetSynchronizer: class {
    sync = mocks.datasetSync;
  },
}));

vi.mock('@/lib/connectors/monarch-money/finance-insight-history-sync', () => ({
  FinanceInsightHistorySynchronizer: class {
    sync = mocks.historySync;
  },
}));

vi.mock('@/lib/finance-insights/publication', () => ({
  captureFinanceInsightPublication: mocks.publication,
}));

vi.mock('@/lib/finance-insights/orchestrator', () => ({
  findFinanceInsightContinuationPublicationId: vi.fn(),
  runFinanceInsightIngestion: mocks.ingestion,
}));

vi.mock('@/lib/finance-insights/occurrence-cache', () => ({
  pruneFinanceInsightOccurrenceCache: mocks.prune,
}));

vi.mock('@/lib/finance/attention-routing', () => ({
  reconcileFinanceAttention: mocks.attention,
}));

describe('Layer 5C PostgreSQL finance activation', () => {
  it('runs the complete portable finance flow without evaluating SQLite', async () => {
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
      notificationsAdded: 2,
    });
    expect(mocks.snapshotSync).toHaveBeenCalledOnce();
    expect(mocks.datasetSync).toHaveBeenCalledOnce();
    expect(mocks.historySync).toHaveBeenCalledOnce();
    expect(mocks.publication).toHaveBeenCalledOnce();
    expect(mocks.ingestion).toHaveBeenCalledOnce();
    expect(mocks.prune).toHaveBeenCalledOnce();
    expect(mocks.attention).toHaveBeenCalledOnce();
    expect(mocks.sqliteModuleEvaluations).toBe(0);
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });
});
