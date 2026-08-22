import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';

const mocks = vi.hoisted(() => ({
  isDurableSyncMode: vi.fn(() => false),
  setQueuedExpensiveOperations: vi.fn(),
  assertConnectorMaintenanceUnlocked: vi.fn(),
  assertConnectorSyncEnqueueAllowed: vi.fn(),
}));

vi.mock('@/lib/sync/job-queue', () => ({
  countRemainingSyncJobs: vi.fn(() => 0),
  enqueueSyncJob: vi.fn(),
  getSyncQueueMetrics: vi.fn(() => ({ queued: 0, running: 0 })),
  isDurableSyncMode: mocks.isDurableSyncMode,
  waitForSyncJob: vi.fn(),
}));
vi.mock('@/lib/sync/maintenance-lock', () => ({
  assertConnectorMaintenanceUnlocked: mocks.assertConnectorMaintenanceUnlocked,
}));
vi.mock('@/lib/sync/control-state', () => ({
  assertConnectorSyncEnqueueAllowed: mocks.assertConnectorSyncEnqueueAllowed,
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
    expect(queue.getRemaining()).toBe(0);
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
    queue.queueFollowUpSync('follow-up');
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
    mocks.assertConnectorMaintenanceUnlocked.mockImplementationOnce(() => {
      throw failure;
    });
    const queue = new SyncQueue(
      async (connectorId) => result(connectorId),
      () => false,
    );

    const request = queue.requestSync('locked');
    await expect(request).rejects.toBe(failure);
  });

  it('rejects direct sync requests while connector quarantine is active', async () => {
    const failure = new Error('connector_sync_quarantined');
    mocks.assertConnectorSyncEnqueueAllowed.mockImplementationOnce(() => {
      throw failure;
    });
    const queue = new SyncQueue(
      async (connectorId) => result(connectorId),
      () => false,
    );

    await expect(queue.requestSync('quarantined', { source: 'api' })).rejects.toBe(failure);
    expect(mocks.assertConnectorSyncEnqueueAllowed)
      .toHaveBeenCalledWith('quarantined', 'api');
  });
});
