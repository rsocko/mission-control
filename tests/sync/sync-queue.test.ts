import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';

const mocks = vi.hoisted(() => ({
  isDurableSyncMode: vi.fn(() => false),
  setQueuedExpensiveOperations: vi.fn(),
  assertConnectorMaintenanceUnlockedAsync: vi.fn(() => Promise.resolve()),
  assertConnectorSyncEnqueueAllowedAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/sync/job-runtime', () => ({
  isDurableSyncMode: mocks.isDurableSyncMode,
  waitForSyncJob: vi.fn(),
  getSyncJobRepository: () => Promise.resolve({
    enqueue: vi.fn(),
    getMetrics: vi.fn(() => Promise.resolve({ queued: 0, running: 0 })),
  }),
}));
vi.mock('@/lib/sync/maintenance-lock', () => ({
  assertConnectorMaintenanceUnlockedAsync: mocks.assertConnectorMaintenanceUnlockedAsync,
}));
vi.mock('@/lib/sync/control-state', () => ({
  assertConnectorSyncEnqueueAllowedAsync: mocks.assertConnectorSyncEnqueueAllowedAsync,
}));
vi.mock('@/lib/telemetry/operations', () => ({
  setQueuedExpensiveOperations: mocks.setQueuedExpensiveOperations,
}));

import { SyncQueue } from '@/lib/sync/queue';

function result(connectorId: string): SyncResult {
  return {
    connectorId,
    success: true,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [],
    syncedAt: '2026-08-15T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SyncQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDurableSyncMode.mockReturnValue(false);
  });

  it('executes queued connectors in FIFO order within the concurrency limit', async () => {
    const runs = new Map<string, ReturnType<typeof deferred<SyncResult>>>();
    const started: string[] = [];
    const queue = new SyncQueue((connectorId) => {
      started.push(connectorId);
      const run = deferred<SyncResult>();
      runs.set(connectorId, run);
      return run.promise;
    }, () => false);

    const first = queue.enqueueSync('first');
    const second = queue.enqueueSync('second');
    const third = queue.enqueueSync('third');
    expect(started).toEqual(['first']);

    runs.get('first')!.resolve(result('first'));
    await first;
    expect(started).toEqual(['first', 'second']);

    runs.get('second')!.resolve(result('second'));
    await second;
    expect(started).toEqual(['first', 'second', 'third']);

    runs.get('third')!.resolve(result('third'));
    await third;
    expect(await queue.getRemaining()).toBe(0);
  });

  it('deduplicates queued work and upgrades a follow-up to a full sync', async () => {
    const active = deferred<SyncResult>();
    const received: Array<{ connectorId: string; full?: boolean }> = [];
    const queue = new SyncQueue((connectorId, options) => {
      received.push({ connectorId, full: options?.full });
      return connectorId === 'active'
        ? active.promise
        : Promise.resolve(result(connectorId));
    }, () => false);

    const running = queue.enqueueSync('active');
    await expect(queue.enqueueSync('active')).resolves.toMatchObject({
      success: false,
      errors: ['Sync already in progress'],
    });
    const queued = queue.enqueueSync('follow-up');
    await queue.queueFollowUpSync('follow-up');
    await expect(queue.enqueueSync('follow-up')).resolves.toMatchObject({
      success: false,
      errors: ['Sync already queued'],
    });

    active.resolve(result('active'));
    await running;
    await queued;
    expect(received).toEqual([
      { connectorId: 'active', full: undefined },
      { connectorId: 'follow-up', full: true },
    ]);
  });

  it('returns maintenance lock failures as rejected promises', async () => {
    const failure = new Error('connector is under maintenance');
    mocks.assertConnectorMaintenanceUnlockedAsync.mockImplementationOnce(() => {
      throw failure;
    });
    const queue = new SyncQueue(
      async (connectorId) => result(connectorId),
      () => false,
    );

    const request = queue.requestSync('locked');
    await expect(request).rejects.toBe(failure);
  });

  it('rejects queued callers when local execution rejects', async () => {
    const active = deferred<SyncResult>();
    const failure = new Error('event outbox unavailable');
    const queue = new SyncQueue((connectorId) => {
      if (connectorId === 'active') return active.promise;
      return Promise.reject(failure);
    }, () => false);

    const running = queue.enqueueSync('active');
    const queued = queue.enqueueSync('queued');
    active.resolve(result('active'));

    await running;
    await expect(queued).rejects.toBe(failure);
  });

  it('rejects direct sync requests while connector quarantine is active', async () => {
    const failure = new Error('connector_sync_quarantined');
    mocks.assertConnectorSyncEnqueueAllowedAsync.mockImplementationOnce(() => {
      throw failure;
    });
    const queue = new SyncQueue(
      async (connectorId) => result(connectorId),
      () => false,
    );

    await expect(queue.requestSync('quarantined', { source: 'api' })).rejects.toBe(failure);
    expect(mocks.assertConnectorSyncEnqueueAllowedAsync)
      .toHaveBeenCalledWith('quarantined', 'api');
  });
});
