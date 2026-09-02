import type { SyncResult } from '@/types';
import type { SyncJob, SyncTerminalEvent } from './job-repository';

/**
 * Stable keys are derived from durable sync identity — the job id plus the
 * durable sync-run id for a success, the job id for a terminal failure. The
 * outbox enforces uniqueness on this key, so a finalizer that runs twice (crash
 * between commit and acknowledgement, or an attempt retry that later fails
 * terminally) can never enqueue a second delivery for the same transition.
 */
export function syncCompletedStableKey(jobId: string, syncRunId: string): string {
  return `sync.completed:job:${jobId}:run:${syncRunId}`;
}

export function syncFailedStableKey(jobId: string): string {
  return `sync.failed:job:${jobId}`;
}

export function buildSyncCompletedEvent(job: SyncJob, result: SyncResult): SyncTerminalEvent {
  return {
    stableKey: syncCompletedStableKey(job.id, result.syncRunId ?? job.id),
    eventType: 'sync.completed',
    occurredAt: result.syncedAt,
    payload: {
      connectorId: result.connectorId,
      success: result.success,
      tasksAdded: result.tasksAdded,
      tasksUpdated: result.tasksUpdated,
      tasksRemoved: result.tasksRemoved,
      notificationsAdded: result.notificationsAdded,
      errors: result.errors,
    },
  };
}

export function buildSyncFailedEvent(
  job: SyncJob,
  input: { errors: string[]; occurredAt?: string },
): SyncTerminalEvent {
  return {
    stableKey: syncFailedStableKey(job.id),
    eventType: 'sync.failed',
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    payload: {
      connectorId: job.connectorId,
      errors: input.errors,
    },
  };
}

/**
 * Terminal statuses are the only ones that justify emitting an outbound sync
 * event: a `queued` result means the job will be retried and has not reached an
 * authoritative outcome yet.
 */
export function isTerminalSyncJobStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
