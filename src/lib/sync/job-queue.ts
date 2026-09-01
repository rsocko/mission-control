import { resolveDatabaseBackend } from '@/db/runtime-backend';
import {
  enqueueSyncJobInCurrentTransaction as sqliteEnqueueSyncJobInCurrentTransaction,
} from './sqlite-job-repository';

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

export {
  claimNextSyncJob,
  completeSyncJob,
  countQueuedSyncJobs,
  countRemainingSyncJobs,
  enqueueDueSyncSchedules,
  enqueueSyncJob,
  failSyncJob,
  finalizeSuccessfulSyncJob,
  getActiveSyncJobConnectorIds,
  getLatestDurableSyncResult,
  getLatestSyncJobEventId,
  getSyncJob,
  getSyncJobEventsAfter,
  getSyncQueueMetrics,
  getSyncScheduleHealth,
  getSyncSchedules,
  isSyncJobCancellationRequested,
  linkSyncLogToJob,
  markSyncScheduleEnqueued,
  persistSyncJobEvent,
  pruneSyncJobs,
  registerSyncSchedule,
  releaseSyncJob,
  renewSyncJobLease,
  requestSyncJobCancellation,
  sqliteSyncJobRepository,
  unregisterSyncSchedule,
} from './sqlite-job-repository';

export {
  getSyncDurationBudgetMs,
  getSyncJobRepository,
  getSyncLeaseMs,
  isDurableSyncMode,
  waitForSyncJob,
} from './job-runtime';

export function enqueueSyncJobInCurrentTransaction(
  ...args: Parameters<typeof sqliteEnqueueSyncJobInCurrentTransaction>
): ReturnType<typeof sqliteEnqueueSyncJobInCurrentTransaction> {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'enqueueSyncJobInCurrentTransaction is SQLite-only: PostgreSQL has no portable contract '
      + 'for enqueueing a sync job inside an ambient transaction. Use '
      + 'getSyncJobRepository().enqueue(...) instead.',
    );
  }
  return sqliteEnqueueSyncJobInCurrentTransaction(...args);
}
