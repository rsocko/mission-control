import { describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const controls = vi.hoisted(() => {
  let release: (() => void) | undefined;
  return {
    shouldWait: false,
    transactionFailure: false,
    datasetCalls: 0,
    captureCalls: [] as Array<{ connectorId: string; status?: string }>,
    publicationReady: false,
    ingestionFailure: false,
    ingestionResult: { status: 'disabled' } as
      | { status: 'disabled' }
      | { status: 'pending'; evaluationState: 'queued' | 'evaluating' }
      | { status: 'failed'; code: string; retryable: boolean }
      | {
          status: 'completed';
          itemCount: number;
          notificationsProcessed: number;
          notificationsAdded: number;
        },
    continuationPublicationId: null as string | null,
    ingestionPublicationIds: [] as string[],
    ingestionCalls: 0,
    continuationCalls: [] as Array<{ connectorId: string; jobId: string }>,
    pruneCalls: 0,
    attentionCalls: [] as string[],
    attentionFailure: false,
    attentionNotificationsCreated: 0,
    wait: () => new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release?.(),
  };
});

vi.mock('@/db', () => ({ default: {} }));
vi.mock('@/lib/connectors/monarch-money/snapshot-synchronizer', () => ({
  FinanceSnapshotSynchronizer: class {
    async sync() {
      if (controls.transactionFailure) throw new Error('Invented transaction failure');
      if (controls.shouldWait) await controls.wait();
      return { itemsAdded: 0, itemsUpdated: 0, itemsRemoved: 0 };
    }
  },
  updateFinanceCategory: vi.fn(),
}));
vi.mock('@/lib/connectors/monarch-money/dataset-synchronizer', () => ({
  FinanceDatasetSynchronizer: class {
    async sync() {
      controls.datasetCalls++;
      return {
        itemsAdded: 0,
        itemsUpdated: 0,
        itemsRemoved: 0,
        status: 'fresh',
        datasetErrors: {},
      };
    }
  },
}));
vi.mock('@/lib/connectors/monarch-money/finance-insight-history-sync', () => ({
  FinanceInsightHistorySynchronizer: class {
    async sync() {
      return {
        generationId: 'insight-history-generation',
        sourceAsOf: '2026-08-10T12:00:00.000Z',
        itemCount: 0,
        coverageStart: '2023-08-01',
        coverageEnd: '2026-08-10',
      };
    }
  },
}));
vi.mock('@/lib/finance-insights/publication', () => ({
  captureFinanceInsightPublication: vi.fn((connector: ConnectorConfig, result: { status?: string }) => {
    controls.captureCalls.push({ connectorId: connector.id, status: result.status });
    if (controls.publicationReady) {
      return { publicationId: 'finance-publication-v1-invented' };
    }
    return { status: 'refused', code: 'test_projection' };
  }),
}));
vi.mock('@/lib/finance-insights/orchestrator', () => ({
  findFinanceInsightContinuationPublicationId: vi.fn(
    () => controls.continuationPublicationId,
  ),
  runFinanceInsightIngestion: vi.fn(async (input: { publicationId: string }) => {
    controls.ingestionCalls++;
    controls.ingestionPublicationIds.push(input.publicationId);
    if (controls.ingestionFailure) throw new Error('Invented private transport detail');
    return controls.ingestionResult;
  }),
}));
vi.mock('@/lib/finance-insights/continuation', () => ({
  enqueueFinanceInsightContinuation: vi.fn((input: { connectorId: string; jobId: string }) => {
    controls.continuationCalls.push(input);
  }),
}));
vi.mock('@/lib/finance-insights/occurrence-cache', () => ({
  pruneFinanceInsightOccurrenceCache: vi.fn(() => {
    controls.pruneCalls++;
  }),
}));
vi.mock('@/lib/finance/attention-routing', () => ({
  reconcileFinanceAttention: vi.fn(async ({ connectorId }: { connectorId: string }) => {
    controls.attentionCalls.push(connectorId);
    if (controls.attentionFailure) {
      throw new Error('Finance attention routing failed (finance_attention_routing_failed)');
    }
    return {
      evaluated: 0,
      notificationsCreated: controls.attentionNotificationsCreated,
      notificationsUpdated: 0,
      tasksCreated: 0,
      tasksUpdated: 0,
      tasksSettled: 0,
      stalePreserved: 0,
      statusOnly: 0,
    };
  }),
}));

const config: ConnectorConfig = {
  id: 'concurrency-finance',
  type: 'finance-manager',
  name: 'Concurrency finance',
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

describe.sequential('finance projection concurrency fence', () => {
  it('rejects a concurrent run for the same connector and releases the fence', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(config);

    controls.shouldWait = true;
    controls.captureCalls = [];
    controls.pruneCalls = 0;
    controls.attentionCalls = [];
    const first = connector.syncDomainData({ full: true });
    await expect(connector.syncDomainData({ full: true })).rejects.toMatchObject({
      code: 'sync_in_progress',
      status: 409,
    });
    controls.release();
    await expect(first).resolves.toMatchObject({ status: 'fresh' });
    expect(controls.captureCalls).toEqual([{
      connectorId: 'concurrency-finance',
      status: 'fresh',
    }]);
    expect(controls.pruneCalls).toBe(1);
    expect(controls.attentionCalls).toEqual(['concurrency-finance']);
    controls.shouldWait = false;
  });

  it('continues independent datasets after a transaction projection failure', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'transaction-failure-finance' });
    controls.transactionFailure = true;
    controls.datasetCalls = 0;
    controls.captureCalls = [];
    controls.pruneCalls = 0;
    controls.attentionCalls = [];

    await expect(connector.syncDomainData({ full: true })).resolves.toMatchObject({
      status: 'partial',
      datasetErrors: { transactions: 'transaction_sync_failed' },
    });
    expect(controls.datasetCalls).toBe(1);
    expect(controls.captureCalls).toEqual([{
      connectorId: 'transaction-failure-finance',
      status: 'partial',
    }]);
    expect(controls.pruneCalls).toBe(1);
    expect(controls.attentionCalls).toEqual(['transaction-failure-finance']);
    controls.transactionFailure = false;
  });

  it('isolates an unexpected shadow-ingestion failure from base sync', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'shadow-isolation-finance' });
    controls.publicationReady = true;
    controls.ingestionFailure = true;
    controls.ingestionCalls = 0;
    controls.pruneCalls = 0;
    controls.attentionCalls = [];

    await expect(connector.syncDomainData({ full: true })).resolves.toMatchObject({
      status: 'fresh',
    });
    expect(controls.ingestionCalls).toBe(1);
    expect(controls.pruneCalls).toBe(1);
    expect(controls.attentionCalls).toEqual(['shadow-isolation-finance']);
    controls.publicationReady = false;
    controls.ingestionFailure = false;
  });

  it.each([
    { status: 'pending', evaluationState: 'queued' },
    { status: 'failed', code: 'evaluation_unavailable', retryable: true },
  ] as const)('queues one durable continuation for $status insight ingestion', async (ingestionResult) => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'continuation-finance' });
    controls.publicationReady = true;
    controls.ingestionResult = ingestionResult;
    controls.continuationCalls = [];

    await expect(connector.syncDomainData({
      full: false,
      jobId: 'durable-job-one',
    })).resolves.toMatchObject({ status: 'fresh' });

    expect(controls.continuationCalls).toEqual([{
      connectorId: 'continuation-finance',
      jobId: 'durable-job-one',
    }]);
    controls.publicationReady = false;
    controls.ingestionResult = { status: 'disabled' };
  });

  it('resumes persisted evaluation when a continuation projection is partial', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'partial-continuation-finance' });
    controls.publicationReady = false;
    controls.continuationPublicationId = 'persisted-pending-publication';
    controls.ingestionResult = { status: 'pending', evaluationState: 'evaluating' };
    controls.ingestionPublicationIds = [];
    controls.continuationCalls = [];

    await expect(connector.syncDomainData({
      full: false,
      jobId: 'durable-job-two',
    })).resolves.toMatchObject({ status: 'fresh' });

    expect(controls.ingestionPublicationIds).toEqual(['persisted-pending-publication']);
    expect(controls.continuationCalls).toEqual([{
      connectorId: 'partial-continuation-finance',
      jobId: 'durable-job-two',
    }]);
    controls.continuationPublicationId = null;
    controls.ingestionResult = { status: 'disabled' };
  });

  it('fails the durable sync when attention routing needs a retry', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'attention-retry-finance' });
    controls.attentionFailure = true;
    controls.attentionCalls = [];

    await expect(connector.syncDomainData({ full: true })).rejects.toThrow(
      'Finance attention routing failed (finance_attention_routing_failed)',
    );
    expect(controls.attentionCalls).toEqual(['attention-retry-finance']);
    controls.attentionFailure = false;
  });

  it('reports only newly created finance notifications in the domain result', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize({ ...config, id: 'notification-count-finance' });
    controls.publicationReady = true;
    controls.ingestionResult = {
      status: 'completed',
      itemCount: 4,
      notificationsProcessed: 3,
      notificationsAdded: 2,
    };
    controls.attentionNotificationsCreated = 1;

    await expect(connector.syncDomainData({ full: true })).resolves.toMatchObject({
      status: 'fresh',
      notificationsAdded: 3,
    });

    controls.publicationReady = false;
    controls.ingestionResult = { status: 'disabled' };
    controls.attentionNotificationsCreated = 0;
  });
});
