import type { SyncJob, SyncJobRepository } from './job-repository';
import type { SyncResult } from '@/types';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

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

let repository: SyncJobRepository | null = null;

export function registerSyncJobRepository(next: SyncJobRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repository && repository !== next) {
    throw new Error('Sync job repository is already selected');
  }
  repository = next;
}

export function clearSyncJobRepository(expectedRepository?: SyncJobRepository): void {
  if (expectedRepository && repository !== expectedRepository) return;
  repository = null;
}

export async function getSyncJobRepository(): Promise<SyncJobRepository> {
  assertPersistenceCompositionAccessAllowed();
  if (!repository) {
    throw new Error('Sync job repository has not been registered');
  }
  return repository;
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

export async function waitForSyncJob(
  job: SyncJob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
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
