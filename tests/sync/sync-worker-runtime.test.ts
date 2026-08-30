import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';
import type { SyncJob } from '@/lib/sync/job-queue';

const queueMocks = vi.hoisted(() => ({
  claimNextSyncJob: vi.fn(),
  completeSyncJob: vi.fn(),
  finalizeSuccessfulSyncJob: vi.fn(),
  enqueueDueSyncSchedules: vi.fn(() => []),
  failSyncJob: vi.fn(() => 'failed'),
  countQueuedSyncJobs: vi.fn(() => 0),
  getSyncLeaseMs: vi.fn(() => 30_000),
  getSyncQueueMetrics: vi.fn(() => ({
    queued: 0,
    running: 0,
    retrying: 0,
    cancelled: 0,
    oldestQueuedAgeMs: 0,
    missedSchedules: 0,
    oldestScheduleOverdueMs: 0,
    overBudget: 0,
    expiredLeases: 0,
  })),
  isSyncJobCancellationRequested: vi.fn(() => false),
  linkSyncLogToJob: vi.fn(),
  persistSyncJobEvent: vi.fn(() => Promise.resolve()),
  pruneSyncJobs: vi.fn(() => Promise.resolve()),
  releaseSyncJob: vi.fn(() => true),
  renewSyncJobLease: vi.fn(() => true),
}));
const eventMocks = vi.hoisted(() => ({
  setSyncEventPersistence: vi.fn(),
}));

vi.mock('@/lib/sync/job-queue', () => ({
  getSyncLeaseMs: queueMocks.getSyncLeaseMs,
  // Backend-selected repository (see @/db/runtime): all of SyncWorker's
  // queue/lease operations go through this in the current implementation.
  // The same underlying mock functions back both the raw exports above and
  // the repository methods below, so existing assertions against
  // `queueMocks.*` keep working unchanged.
  getSyncJobRepository: () => Promise.resolve({
    claimNext: queueMocks.claimNextSyncJob,
    complete: queueMocks.completeSyncJob,
    finalizeSuccess: queueMocks.finalizeSuccessfulSyncJob,
    countQueued: queueMocks.countQueuedSyncJobs,
    enqueueDueSchedules: queueMocks.enqueueDueSyncSchedules,
    fail: queueMocks.failSyncJob,
    getMetrics: queueMocks.getSyncQueueMetrics,
    isCancellationRequested: queueMocks.isSyncJobCancellationRequested,
    linkSyncLog: queueMocks.linkSyncLogToJob,
    persistEvent: queueMocks.persistSyncJobEvent,
    prune: queueMocks.pruneSyncJobs,
    release: queueMocks.releaseSyncJob,
    renewLease: queueMocks.renewSyncJobLease,
  }),
}));
vi.mock('@/lib/sync/events', () => eventMocks);
vi.mock('@/lib/logger', () => ({
  syncLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function job(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    id: 'job-1',
    connectorId: 'github-1',
    full: false,
    source: 'api',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    availableAt: '2026-08-03T00:00:00.000Z',
    scheduledFor: '2026-08-03T00:00:00.000Z',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-08-03T00:02:00.000Z',
    cancelRequestedAt: null,
    startedAt: '2026-08-03T00:00:00.000Z',
    completedAt: null,
    result: null,
    error: null,
    durationBudgetMs: 300_000,
    identityMode: 'comparison',
    identityModeRevision: 7,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

function result(success: boolean): SyncResult {
  return {
    connectorId: 'github-1',
    success,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: success ? [] : ['connector failed'],
    syncedAt: '2026-08-03T00:00:01.000Z',
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  assertion();
}

describe('sync worker runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.countQueuedSyncJobs.mockReturnValue(0);
    queueMocks.claimNextSyncJob.mockReturnValueOnce(job()).mockReturnValue(null);
  });

  it('rejects unsupported horizontal worker scaling', async () => {
    queueMocks.claimNextSyncJob.mockReset();
    const { assertSupportedWorkerReplicaCount } = await import('@/lib/sync/worker');

    expect(() => assertSupportedWorkerReplicaCount('2')).toThrow(
      'MC_SYNC_WORKER_REPLICA_COUNT must be 1',
    );
    expect(() => assertSupportedWorkerReplicaCount('1')).not.toThrow();
  });

  it('reports pending work from either the active execution or durable queue', async () => {
    queueMocks.claimNextSyncJob.mockReset();
    queueMocks.claimNextSyncJob.mockReturnValue(null);
    queueMocks.countQueuedSyncJobs.mockReturnValue(1);
    const { SyncWorker } = await import('@/lib/sync/worker');
    const worker = new SyncWorker(vi.fn(), { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(queueMocks.countQueuedSyncJobs).toHaveBeenCalled());
    expect(worker.hasPendingWork()).toBe(true);
    queueMocks.countQueuedSyncJobs.mockReturnValue(0);
    await waitFor(() => expect(worker.hasPendingWork()).toBe(false));
    expect(worker.hasPendingWork()).toBe(false);
    await worker.stop();
    expect(queueMocks.getSyncQueueMetrics).not.toHaveBeenCalled();
  });

  it('records successful work only after the connector returns success', async () => {
    const { SyncWorker } = await import('@/lib/sync/worker');
    const execute = vi.fn().mockResolvedValue(result(true));
    const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(queueMocks.finalizeSuccessfulSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(execute).toHaveBeenCalledWith(
      'github-1',
      expect.objectContaining({
        full: false,
        signal: expect.any(AbortSignal),
        identityContext: {
          connectorInstanceId: 'github-1',
          modeRevision: 7,
        },
      }),
    );
    expect(queueMocks.failSyncJob).not.toHaveBeenCalled();
    expect(queueMocks.finalizeSuccessfulSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'worker-a',
      expect.objectContaining({ success: true }),
    );
    expect(queueMocks.linkSyncLogToJob).not.toHaveBeenCalled();
  });

  it('records a failed attempt when atomic success ownership is lost', async () => {
    queueMocks.finalizeSuccessfulSyncJob.mockRejectedValueOnce(
      new Error('Sync job job-1 ownership was lost before completion'),
    );
    const { SyncWorker } = await import('@/lib/sync/worker');
    const worker = new SyncWorker(
      vi.fn().mockResolvedValue(result(true)),
      { ownerId: 'worker-a', pollIntervalMs: 1 },
    );

    worker.start();
    await waitFor(() => expect(queueMocks.failSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(queueMocks.failSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'worker-a',
      'Sync job job-1 ownership was lost before completion',
      { retry: true, cancelled: false, terminal: false },
    );
    expect(queueMocks.completeSyncJob).not.toHaveBeenCalled();
  });

  it('forwards a frozen legacy identity context', async () => {
      queueMocks.claimNextSyncJob.mockReset();
      queueMocks.claimNextSyncJob
        .mockReturnValueOnce(job({ identityMode: 'legacy', identityModeRevision: 4 }))
        .mockReturnValue(null);
      const { SyncWorker } = await import('@/lib/sync/worker');
      const execute = vi.fn().mockResolvedValue(result(true));
      const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

      worker.start();
      await waitFor(() => expect(queueMocks.finalizeSuccessfulSyncJob).toHaveBeenCalledOnce());
      await worker.stop();

      expect(execute).toHaveBeenCalledWith(
        'github-1',
        expect.objectContaining({
          identityContext: {
            connectorInstanceId: 'github-1',
            modeRevision: 4,
          },
        }),
      );
    });

  it('forwards a frozen stable identity context after a worker restart', async () => {
    queueMocks.claimNextSyncJob.mockReset();
    queueMocks.claimNextSyncJob
      .mockReturnValueOnce(job({ identityMode: 'stable', identityModeRevision: 8 }))
      .mockReturnValue(null);
    const { SyncWorker } = await import('@/lib/sync/worker');
    const execute = vi.fn().mockResolvedValue(result(true));
    const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(queueMocks.finalizeSuccessfulSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(execute).toHaveBeenCalledWith(
      'github-1',
      expect.objectContaining({
        identityContext: {
          connectorInstanceId: 'github-1',
          modeRevision: 8,
        },
      }),
    );
  });

  it('records a connector failure as retryable rather than success-shaped', async () => {
    const { SyncWorker } = await import('@/lib/sync/worker');
    const worker = new SyncWorker(
      vi.fn().mockResolvedValue(result(false)),
      { ownerId: 'worker-a', pollIntervalMs: 1 },
    );

    worker.start();
    await waitFor(() => expect(queueMocks.failSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(queueMocks.completeSyncJob).not.toHaveBeenCalled();
    expect(queueMocks.failSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'worker-a',
      'connector failed',
    );
  });

  it('retries an abort-aware connector after its duration budget expires', async () => {
    queueMocks.claimNextSyncJob.mockReset();
    queueMocks.claimNextSyncJob
      .mockReturnValueOnce(job({ durationBudgetMs: 5 }))
      .mockReturnValue(null);
    const execute = vi.fn((
      _connectorId: string,
      options: { signal?: AbortSignal },
    ) => new Promise<SyncResult>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      });
    }));
    const { SyncWorker } = await import('@/lib/sync/worker');
    const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(queueMocks.failSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(queueMocks.failSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'worker-a',
      'Sync execution exceeded its 5ms duration budget',
      { retry: true, cancelled: false, terminal: false },
    );
  });

  it('retains active ownership until timed-out shutdown work has quiesced', async () => {
    const { SyncWorker } = await import('@/lib/sync/worker');
    let finish: ((result: SyncResult) => void) | undefined;
    const execute = vi.fn(() => new Promise<SyncResult>((resolve) => {
      finish = resolve;
    }));
    const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await worker.stop(5);

    expect(queueMocks.releaseSyncJob).not.toHaveBeenCalled();
    expect(queueMocks.completeSyncJob).not.toHaveBeenCalled();
    finish?.(result(true));
    await waitFor(() => expect(queueMocks.failSyncJob).toHaveBeenCalledOnce());
    expect(queueMocks.failSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'worker-a',
      'Worker shutdown grace period expired',
      { retry: true, cancelled: false },
    );
  });

  it('continues with another connector when aborted execution ignores its grace period', async () => {
    queueMocks.claimNextSyncJob.mockReset();
    queueMocks.claimNextSyncJob
      .mockReturnValueOnce(job({
        connectorId: 'todo-1',
        durationBudgetMs: 5,
        identityMode: null,
        identityModeRevision: null,
      }))
      .mockReturnValueOnce(job({
        id: 'job-2',
        connectorId: 'github-1',
      }))
      .mockReturnValue(null);
    let finishAbandoned: ((result: SyncResult) => void) | undefined;
    const execute = vi.fn((connectorId: string) => {
      if (connectorId === 'todo-1') {
        return new Promise<SyncResult>((resolve) => {
          finishAbandoned = resolve;
        });
      }
      return Promise.resolve(result(true));
    });
    const { SyncWorker } = await import('@/lib/sync/worker');
    const worker = new SyncWorker(execute, {
      ownerId: 'worker-a',
      pollIntervalMs: 1,
      abortGraceMs: 1,
    });

    worker.start();
    await waitFor(() => expect(execute).toHaveBeenCalledWith(
      'github-1',
      expect.objectContaining({ jobId: 'job-2' }),
    ));
    await worker.stop();

    expect(queueMocks.claimNextSyncJob).toHaveBeenNthCalledWith(
      2,
      'worker-a',
      30_000,
      new Set(['todo-1']),
    );
    expect(queueMocks.finalizeSuccessfulSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-2' }),
      'worker-a',
      expect.objectContaining({ success: true }),
    );
    const persistEvent = eventMocks.setSyncEventPersistence.mock.calls[0]?.[0];
    persistEvent?.({
      type: 'sync:start',
      connectorId: 'todo-1',
      connectorName: 'To Do',
      phase: 'tasks',
    });
    await waitFor(() => expect(queueMocks.persistSyncJobEvent).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ connectorId: 'todo-1' }),
    ));

    finishAbandoned?.(result(true));
    await waitFor(() => expect(queueMocks.failSyncJob).toHaveBeenCalled());
    expect(queueMocks.finalizeSuccessfulSyncJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
