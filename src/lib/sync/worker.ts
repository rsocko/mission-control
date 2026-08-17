import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncLogger } from '@/lib/logger';
import type { SyncResult } from '@/types';
import {
  claimNextSyncJob,
  completeSyncJob,
  failSyncJob,
  enqueueDueSyncSchedules,
  getSyncLeaseMs,
  getSyncQueueMetrics,
  isSyncJobCancellationRequested,
  linkSyncLogToJob,
  persistSyncJobEvent,
  pruneSyncJobs,
  renewSyncJobLease,
  type SyncJob,
} from './job-queue';
import { setSyncEventPersistence } from './events';
import { setQueuedExpensiveOperations } from '@/lib/telemetry/operations';
import type { GitHubIdentityRunContext } from '@/lib/external-identities';
import { StaleGitHubIdentityContextError } from './github-identity-context';

export type SyncJobExecutor = (
  connectorId: string,
  options: {
    full?: boolean;
    signal?: AbortSignal;
    jobId?: string;
    identityContext?: GitHubIdentityRunContext;
  },
) => Promise<SyncResult>;

class WorkerShutdownError extends Error {}
class SyncExecutionTimeoutError extends Error {}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function assertSupportedWorkerReplicaCount(
  value = process.env.MC_SYNC_WORKER_REPLICA_COUNT ?? '1',
): void {
  if (value !== '1') {
    throw new Error(
      'MC_SYNC_WORKER_REPLICA_COUNT must be 1; horizontal sync-worker scaling is unsupported',
    );
  }
}

export class SyncWorker {
  readonly ownerId: string;
  private readonly execute: SyncJobExecutor;
  private readonly pollIntervalMs: number;
  private readonly abortGraceMs: number;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private active:
    | {
        job: SyncJob;
        controller: AbortController;
        promise: Promise<void>;
      }
    | null = null;
  private readonly abandoned = new Map<string, {
    job: SyncJob;
    promise: Promise<void>;
  }>();

  constructor(
    execute: SyncJobExecutor,
    options: { ownerId?: string; pollIntervalMs?: number; abortGraceMs?: number } = {},
  ) {
    this.execute = execute;
    this.ownerId = options.ownerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs
      ?? positiveInteger(process.env.MC_SYNC_WORKER_POLL_MS, 500);
    this.abortGraceMs = options.abortGraceMs
      ?? positiveInteger(process.env.MC_SYNC_WORKER_ABORT_GRACE_MS, 30_000);
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    setSyncEventPersistence((event) => {
      const activeJob = this.active?.job.connectorId === event.connectorId
        ? this.active.job
        : this.abandoned.get(event.connectorId)?.job;
      if (activeJob) persistSyncJobEvent(activeJob.id, event);
    });
    const retentionDays = positiveInteger(process.env.MC_SYNC_JOB_RETENTION_DAYS, 14);
    pruneSyncJobs(retentionDays);
    this.pruneTimer = setInterval(
      () => pruneSyncJobs(retentionDays),
      positiveInteger(process.env.MC_SYNC_JOB_PRUNE_INTERVAL_MS, 6 * 60 * 60_000),
    );
    this.pruneTimer.unref();
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
      setSyncEventPersistence(null);
    });
    syncLogger.info({ ownerId: this.ownerId }, 'Sync worker started');
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const recoveredSchedules = enqueueDueSyncSchedules();
      setQueuedExpensiveOperations(getSyncQueueMetrics().queued);
      if (recoveredSchedules.length > 0) {
        syncLogger.warn(
          {
            count: recoveredSchedules.length,
            connectorIds: recoveredSchedules.map((job) => job.connectorId),
          },
          'Recovered overdue sync schedules',
        );
      }
      const job = claimNextSyncJob(
        this.ownerId,
        getSyncLeaseMs(),
        new Set(this.abandoned.keys()),
      );
      if (!job) {
        await this.delay(this.pollIntervalMs);
        continue;
      }
      const controller = new AbortController();
      const promise = this.executeJob(job, controller);
      this.active = { job, controller, promise };
      await this.waitForJob(job, controller, promise);
      if (this.active?.job.id === job.id) this.active = null;
      setQueuedExpensiveOperations(getSyncQueueMetrics().queued);
    }
  }

  private async executeJob(job: SyncJob, controller: AbortController): Promise<void> {
    const leaseMs = getSyncLeaseMs();
    const heartbeatMs = Math.max(1, Math.floor(leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        if (isSyncJobCancellationRequested(job.id, this.ownerId)) {
          controller.abort(new Error('Sync cancellation requested'));
          return;
        }
        if (!renewSyncJobLease(job.id, this.ownerId, leaseMs)) {
          controller.abort(new Error('Sync job lease ownership lost'));
        }
      } catch (error) {
        controller.abort(error instanceof Error ? error : new Error(String(error)));
      }
    }, heartbeatMs);
    heartbeat.unref();
    const executionTimeout = setTimeout(() => {
      controller.abort(new SyncExecutionTimeoutError(
        `Sync execution exceeded its ${job.durationBudgetMs}ms duration budget`,
      ));
    }, job.durationBudgetMs);
    executionTimeout.unref();
    const stopTimers = () => {
      clearInterval(heartbeat);
      clearTimeout(executionTimeout);
    };
    controller.signal.addEventListener('abort', stopTimers, { once: true });

    syncLogger.info(
      {
        jobId: job.id,
        connectorId: job.connectorId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        full: job.full,
        source: job.source,
      },
      'Sync worker claimed job',
    );

    try {
      const result = await this.execute(job.connectorId, {
        full: job.full,
        signal: controller.signal,
        jobId: job.id,
        identityContext: job.identityMode === null || job.identityModeRevision === null
          ? undefined
          : Object.freeze({
              connectorInstanceId: job.connectorId,
              modeRevision: job.identityModeRevision,
            }),
      });
      if (controller.signal.aborted) {
        const cancelled = isSyncJobCancellationRequested(job.id, this.ownerId);
        failSyncJob(
          job,
          this.ownerId,
          controller.signal.reason instanceof Error
            ? controller.signal.reason.message
            : 'Sync cancelled',
          { retry: !cancelled, cancelled },
        );
      } else if (!result.success) {
        linkSyncLogToJob(job, result);
        const status = failSyncJob(
          job,
          this.ownerId,
          result.errors.join('; ') || 'Connector sync failed',
        );
        syncLogger.warn(
          { jobId: job.id, connectorId: job.connectorId, status, attempt: job.attempt },
          'Sync worker job failed',
        );
      } else {
        linkSyncLogToJob(job, result);
        completeSyncJob(job.id, this.ownerId, result);
        syncLogger.info(
          { jobId: job.id, connectorId: job.connectorId, attempt: job.attempt },
          'Sync worker job completed',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const staleIdentityContext = error instanceof StaleGitHubIdentityContextError;
        const cancelled = !staleIdentityContext
          && isSyncJobCancellationRequested(job.id, this.ownerId);
        failSyncJob(job, this.ownerId, message, {
          retry: !staleIdentityContext && !cancelled,
          cancelled,
          terminal: staleIdentityContext,
        });
      } catch (recordError) {
        syncLogger.error(
          { err: recordError, jobId: job.id, connectorId: job.connectorId },
          'Sync worker could not record job failure',
        );
      }
      syncLogger.error(
        { err: error, jobId: job.id, connectorId: job.connectorId },
        'Sync worker execution failed',
      );
    } finally {
      controller.signal.removeEventListener('abort', stopTimers);
      stopTimers();
    }
  }

  private async waitForJob(
    job: SyncJob,
    controller: AbortController,
    promise: Promise<void>,
  ): Promise<void> {
    if (!controller.signal.aborted) {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        onAbort = () => resolve();
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([
        promise,
        aborted,
      ]);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
    if (!controller.signal.aborted) return;

    const completed = await Promise.race([
      promise.then(() => true),
      this.delay(this.abortGraceMs).then(() => false),
    ]);
    if (completed) return;

    this.abandoned.set(job.connectorId, { job, promise });
    void promise.finally(() => {
      if (this.abandoned.get(job.connectorId)?.promise === promise) {
        this.abandoned.delete(job.connectorId);
      }
    });
    syncLogger.error(
      {
        jobId: job.id,
        connectorId: job.connectorId,
        abortGraceMs: this.abortGraceMs,
        reason: controller.signal.reason,
      },
      'Sync execution did not stop after abort grace; connector fenced while worker continues',
    );
  }

  async stop(graceMs = positiveInteger(process.env.MC_SYNC_WORKER_SHUTDOWN_GRACE_MS, 30_000)): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    const active = this.active;
    let timedOut = false;
    if (active) {
      const completed = await Promise.race([
        active.promise.then(() => true),
        this.delay(graceMs).then(() => false),
      ]);
      if (!completed) {
        timedOut = true;
        active.controller.abort(new WorkerShutdownError('Worker shutdown grace period expired'));
      }
    }
    if (this.loopPromise && !timedOut) await this.loopPromise;
    if (timedOut) setSyncEventPersistence(null);
    setQueuedExpensiveOperations(0);
    syncLogger.info({ ownerId: this.ownerId }, 'Sync worker stopped');
  }

  getActiveJob(): SyncJob | null {
    return this.active?.job ?? null;
  }

  hasPendingWork(): boolean {
    return this.active !== null || getSyncQueueMetrics().queued > 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
