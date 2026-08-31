import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SyncJobRepository } from './job-repository';
import type { SyncResult } from '@/types';

export type {
  EnqueueSyncJobOptions,
  PersistedSyncEvent,
  SyncCancellationResult,
  SyncJob,
  SyncJobFailureOptions,
  SyncJobEnqueueRequest,
  SyncJobRepository,
  SyncJobSource,
  SyncJobStatus,
  SyncQueueMetrics,
  SyncSchedule,
  SyncScheduleHealth,
} from './job-repository';

/**
 * Resolves the sync-job-queue adapter for the currently selected database
 * backend. SQLite keeps using its long-standing `sync_jobs`-backed
 * singleton unchanged; PostgreSQL resolves to the adapter registered by
 * `initializeRuntimeDatabase` (see `@/db/runtime`) once the backend has
 * finished initializing. Prefer this over the raw `sqlite*` named exports
 * above (which remain SQLite-only) for any code that must work under either
 * backend.
 *
 * The PostgreSQL side is imported dynamically (only once actually needed)
 * so that merely importing this module — as most of the existing SQLite
 * call sites already do — never pulls in the PostgreSQL schema/driver graph.
 */
export async function getSyncJobRepository(): Promise<SyncJobRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresSyncJobRepository } = await import('@/db/runtime');
    return getPostgresSyncJobRepository();
  }
  const { sqliteSyncJobRepository } = await import('./sqlite-job-repository');
  return sqliteSyncJobRepository;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isDurableSyncMode(): boolean {
  return process.env.MC_SYNC_EXECUTION_MODE === 'worker';
}

export function getSyncLeaseMs(): number {
  return positiveInteger(process.env.MC_SYNC_JOB_LEASE_MS, 120_000);
}

export function getSyncDurationBudgetMs(): number {
  return positiveInteger(process.env.MC_SYNC_DURATION_BUDGET_MS, 300_000);
}

function waitFailedResult(connectorId: string, error: string): SyncResult {
  return {
    connectorId,
    success: false,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [error],
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Waits for an enqueued sync job to reach a terminal state. Backend-selected:
 * SQLite keeps its original polling implementation unchanged; PostgreSQL
 * polls the same way but through the selected `SyncJobRepository.get(...)`
 * instead of the raw SQLite query, so an API request waiting on a job
 * enqueued under PostgreSQL never touches SQLite.
 */
export async function waitForSyncJob(
  job: import('./job-repository').SyncJob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  if (resolveDatabaseBackend() === 'sqlite') {
    const { waitForSyncJob: sqliteWaitForSyncJob } = await import('./sqlite-job-repository');
    return sqliteWaitForSyncJob(job, options);
  }

  const timeoutMs = options.timeoutMs
    ?? positiveInteger(process.env.MC_SYNC_API_WAIT_TIMEOUT_MS, 15 * 60_000);
  const deadline = Date.now() + timeoutMs;
  const repository = await getSyncJobRepository();

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      return waitFailedResult(job.connectorId, 'Request ended while sync continues in the worker');
    }
    const current = await repository.get(job.id);
    if (!current) return waitFailedResult(job.connectorId, 'Sync job disappeared before completion');
    if (current.status === 'succeeded') {
      if (!current.result?.success) {
        return waitFailedResult(job.connectorId, 'Worker stored an invalid success result');
      }
      return current.result;
    }
    if (current.status === 'failed' || current.status === 'cancelled') {
      return waitFailedResult(
        job.connectorId,
        current.error ?? `Sync job ${current.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return waitFailedResult(
    job.connectorId,
    `Timed out waiting ${timeoutMs}ms for sync worker job ${job.id}`,
  );
}
