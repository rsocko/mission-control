import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';
import type { SyncJob } from '@/lib/sync/job-queue';

const queueMocks = vi.hoisted(() => ({
  claimNextSyncJob: vi.fn(),
  completeSyncJob: vi.fn(),
  enqueueDueSyncSchedules: vi.fn(() => []),
  failSyncJob: vi.fn(() => 'failed'),
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
  persistSyncJobEvent: vi.fn(),
  pruneSyncJobs: vi.fn(),
  releaseSyncJob: vi.fn(() => true),
  renewSyncJobLease: vi.fn(() => true),
}));

vi.mock('@/lib/sync/job-queue', () => queueMocks);
vi.mock('@/lib/sync/events', () => ({
  setSyncEventPersistence: vi.fn(),
}));
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

  it('records successful work only after the connector returns success', async () => {
    const { SyncWorker } = await import('@/lib/sync/worker');
    const execute = vi.fn().mockResolvedValue(result(true));
    const worker = new SyncWorker(execute, { ownerId: 'worker-a', pollIntervalMs: 1 });

    worker.start();
    await waitFor(() => expect(queueMocks.completeSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(execute).toHaveBeenCalledWith(
      'github-1',
      expect.objectContaining({
        full: false,
        signal: expect.any(AbortSignal),
        identityContext: {
          connectorInstanceId: 'github-1',
          effectiveMode: 'comparison',
          modeRevision: 7,
        },
      }),
    );
    expect(queueMocks.failSyncJob).not.toHaveBeenCalled();
    expect(queueMocks.linkSyncLogToJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      expect.objectContaining({ success: true }),
    );
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
      await waitFor(() => expect(queueMocks.completeSyncJob).toHaveBeenCalledOnce());
      await worker.stop();

      expect(execute).toHaveBeenCalledWith(
        'github-1',
        expect.objectContaining({
          identityContext: {
            connectorInstanceId: 'github-1',
            effectiveMode: 'legacy',
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
    await waitFor(() => expect(queueMocks.completeSyncJob).toHaveBeenCalledOnce());
    await worker.stop();

    expect(execute).toHaveBeenCalledWith(
      'github-1',
      expect.objectContaining({
        identityContext: {
          connectorInstanceId: 'github-1',
          effectiveMode: 'stable',
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
});
