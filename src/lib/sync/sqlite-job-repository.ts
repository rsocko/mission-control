import type { SyncResult } from '@/types';
import type { SyncStreamEvent } from './events';
import type {
  EnqueueSyncJobOptions,
  PersistedSyncEvent,
  SyncCancellationResult,
  SyncJob,
  SyncJobFailureOptions,
  SyncJobFinalizationOptions,
  SyncJobRepository,
  SyncJobStatus,
  SyncQueueMetrics,
  SyncSchedule,
  SyncScheduleHealth,
} from './job-repository';

export interface SqliteSyncJobCapability {
  countRemainingSyncJobs(metrics: Pick<SyncQueueMetrics, 'queued' | 'running'>): number;
  isDurableSyncMode(): boolean;
  getSyncLeaseMs(): number;
  getSyncDurationBudgetMs(): number;
  enqueueSyncJob(connectorId: string, options?: EnqueueSyncJobOptions): SyncJob;
  enqueueSyncJobInCurrentTransaction(
    connectorId: string,
    options?: EnqueueSyncJobOptions,
  ): SyncJob;
  claimNextSyncJob(
    owner: string,
    leaseMs?: number,
    excludedConnectorIds?: ReadonlySet<string>,
  ): SyncJob | null;
  renewSyncJobLease(jobId: string, owner: string, attempt: number, leaseMs?: number): boolean;
  isSyncJobCancellationRequested(jobId: string, owner: string, attempt: number): boolean;
  completeSyncJob(jobId: string, owner: string, attempt: number, result: SyncResult): void;
  finalizeSuccessfulSyncJob(
    job: SyncJob,
    owner: string,
    result: SyncResult,
    options?: SyncJobFinalizationOptions,
  ): void;
  linkSyncLogToJob(job: SyncJob, result: SyncResult): void;
  failSyncJob(
    job: SyncJob,
    owner: string,
    error: string,
    options?: SyncJobFailureOptions,
  ): SyncJobStatus;
  releaseSyncJob(jobId: string, owner: string, attempt: number, reason: string): boolean;
  requestSyncJobCancellation(params: {
    jobId?: string;
    connectorId?: string;
  }): SyncCancellationResult;
  getSyncJob(jobId: string): SyncJob | null;
  waitForSyncJob(
    job: SyncJob,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SyncResult>;
  persistSyncJobEvent(jobId: string, event: SyncStreamEvent): void;
  getSyncJobEventsAfter(cursor: number, limit?: number): PersistedSyncEvent[];
  getLatestSyncJobEventId(): number;
  countQueuedSyncJobs(): number;
  getSyncQueueMetrics(now?: Date): SyncQueueMetrics;
  registerSyncSchedule(connectorId: string, intervalMinutes: number): void;
  markSyncScheduleEnqueued(connectorId: string): void;
  unregisterSyncSchedule(connectorId: string): void;
  getSyncSchedules(): SyncSchedule[];
  getSyncScheduleHealth(now?: Date): SyncScheduleHealth[];
  enqueueDueSyncSchedules(now?: Date): SyncJob[];
  getLatestDurableSyncResult(connectorId: string): SyncResult | undefined;
  getActiveSyncJobConnectorIds(): string[];
  pruneSyncJobs(retentionDays?: number): void;
  sqliteSyncJobRepository: SyncJobRepository;
}

let capability: SqliteSyncJobCapability | null = null;

export function registerSqliteSyncJobCapability(next: SqliteSyncJobCapability): void {
  capability = next;
}

export function clearSqliteSyncJobCapability(): void {
  capability = null;
}

function requireCapability(): SqliteSyncJobCapability {
  if (!capability) {
    throw new Error('SQLite sync job capability has not been registered');
  }
  return capability;
}

export const countRemainingSyncJobs = (
  ...args: Parameters<SqliteSyncJobCapability['countRemainingSyncJobs']>
) => requireCapability().countRemainingSyncJobs(...args);
export const isDurableSyncMode = (
  ...args: Parameters<SqliteSyncJobCapability['isDurableSyncMode']>
) => requireCapability().isDurableSyncMode(...args);
export const getSyncLeaseMs = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncLeaseMs']>
) => requireCapability().getSyncLeaseMs(...args);
export const getSyncDurationBudgetMs = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncDurationBudgetMs']>
) => requireCapability().getSyncDurationBudgetMs(...args);
export const enqueueSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['enqueueSyncJob']>
) => requireCapability().enqueueSyncJob(...args);
export const enqueueSyncJobInCurrentTransaction = (
  ...args: Parameters<SqliteSyncJobCapability['enqueueSyncJobInCurrentTransaction']>
) => requireCapability().enqueueSyncJobInCurrentTransaction(...args);
export const claimNextSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['claimNextSyncJob']>
) => requireCapability().claimNextSyncJob(...args);
export const renewSyncJobLease = (
  ...args: Parameters<SqliteSyncJobCapability['renewSyncJobLease']>
) => requireCapability().renewSyncJobLease(...args);
export const isSyncJobCancellationRequested = (
  ...args: Parameters<SqliteSyncJobCapability['isSyncJobCancellationRequested']>
) => requireCapability().isSyncJobCancellationRequested(...args);
export const completeSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['completeSyncJob']>
) => requireCapability().completeSyncJob(...args);
export const finalizeSuccessfulSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['finalizeSuccessfulSyncJob']>
) => requireCapability().finalizeSuccessfulSyncJob(...args);
export const linkSyncLogToJob = (
  ...args: Parameters<SqliteSyncJobCapability['linkSyncLogToJob']>
) => requireCapability().linkSyncLogToJob(...args);
export const failSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['failSyncJob']>
) => requireCapability().failSyncJob(...args);
export const releaseSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['releaseSyncJob']>
) => requireCapability().releaseSyncJob(...args);
export const requestSyncJobCancellation = (
  ...args: Parameters<SqliteSyncJobCapability['requestSyncJobCancellation']>
) => requireCapability().requestSyncJobCancellation(...args);
export const getSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncJob']>
) => requireCapability().getSyncJob(...args);
export const waitForSyncJob = (
  ...args: Parameters<SqliteSyncJobCapability['waitForSyncJob']>
) => requireCapability().waitForSyncJob(...args);
export const persistSyncJobEvent = (
  ...args: Parameters<SqliteSyncJobCapability['persistSyncJobEvent']>
) => requireCapability().persistSyncJobEvent(...args);
export const getSyncJobEventsAfter = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncJobEventsAfter']>
) => requireCapability().getSyncJobEventsAfter(...args);
export const getLatestSyncJobEventId = (
  ...args: Parameters<SqliteSyncJobCapability['getLatestSyncJobEventId']>
) => requireCapability().getLatestSyncJobEventId(...args);
export const countQueuedSyncJobs = (
  ...args: Parameters<SqliteSyncJobCapability['countQueuedSyncJobs']>
) => requireCapability().countQueuedSyncJobs(...args);
export const getSyncQueueMetrics = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncQueueMetrics']>
) => requireCapability().getSyncQueueMetrics(...args);
export const registerSyncSchedule = (
  ...args: Parameters<SqliteSyncJobCapability['registerSyncSchedule']>
) => requireCapability().registerSyncSchedule(...args);
export const markSyncScheduleEnqueued = (
  ...args: Parameters<SqliteSyncJobCapability['markSyncScheduleEnqueued']>
) => requireCapability().markSyncScheduleEnqueued(...args);
export const unregisterSyncSchedule = (
  ...args: Parameters<SqliteSyncJobCapability['unregisterSyncSchedule']>
) => requireCapability().unregisterSyncSchedule(...args);
export const getSyncSchedules = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncSchedules']>
) => requireCapability().getSyncSchedules(...args);
export const getSyncScheduleHealth = (
  ...args: Parameters<SqliteSyncJobCapability['getSyncScheduleHealth']>
) => requireCapability().getSyncScheduleHealth(...args);
export const enqueueDueSyncSchedules = (
  ...args: Parameters<SqliteSyncJobCapability['enqueueDueSyncSchedules']>
) => requireCapability().enqueueDueSyncSchedules(...args);
export const getLatestDurableSyncResult = (
  ...args: Parameters<SqliteSyncJobCapability['getLatestDurableSyncResult']>
) => requireCapability().getLatestDurableSyncResult(...args);
export const getActiveSyncJobConnectorIds = (
  ...args: Parameters<SqliteSyncJobCapability['getActiveSyncJobConnectorIds']>
) => requireCapability().getActiveSyncJobConnectorIds(...args);
export const pruneSyncJobs = (
  ...args: Parameters<SqliteSyncJobCapability['pruneSyncJobs']>
) => requireCapability().pruneSyncJobs(...args);

export const sqliteSyncJobRepository: SyncJobRepository = {
  enqueue: (...args) => requireCapability().sqliteSyncJobRepository.enqueue(...args),
  claimNext: (...args) => requireCapability().sqliteSyncJobRepository.claimNext(...args),
  renewLease: (...args) => requireCapability().sqliteSyncJobRepository.renewLease(...args),
  isCancellationRequested: (...args) =>
    requireCapability().sqliteSyncJobRepository.isCancellationRequested(...args),
  complete: (...args) => requireCapability().sqliteSyncJobRepository.complete(...args),
  finalizeSuccess: (...args) =>
    requireCapability().sqliteSyncJobRepository.finalizeSuccess(...args),
  linkSyncLog: (...args) => requireCapability().sqliteSyncJobRepository.linkSyncLog(...args),
  fail: (...args) => requireCapability().sqliteSyncJobRepository.fail(...args),
  release: (...args) => requireCapability().sqliteSyncJobRepository.release(...args),
  requestCancellation: (...args) =>
    requireCapability().sqliteSyncJobRepository.requestCancellation(...args),
  get: (...args) => requireCapability().sqliteSyncJobRepository.get(...args),
  persistEvent: (...args) => requireCapability().sqliteSyncJobRepository.persistEvent(...args),
  getEventsAfter: (...args) =>
    requireCapability().sqliteSyncJobRepository.getEventsAfter(...args),
  getLatestEventId: (...args) =>
    requireCapability().sqliteSyncJobRepository.getLatestEventId(...args),
  countQueued: (...args) => requireCapability().sqliteSyncJobRepository.countQueued(...args),
  getMetrics: (...args) => requireCapability().sqliteSyncJobRepository.getMetrics(...args),
  registerSchedule: (...args) =>
    requireCapability().sqliteSyncJobRepository.registerSchedule(...args),
  markScheduleEnqueued: (...args) =>
    requireCapability().sqliteSyncJobRepository.markScheduleEnqueued(...args),
  unregisterSchedule: (...args) =>
    requireCapability().sqliteSyncJobRepository.unregisterSchedule(...args),
  getSchedules: (...args) => requireCapability().sqliteSyncJobRepository.getSchedules(...args),
  getScheduleHealth: (...args) =>
    requireCapability().sqliteSyncJobRepository.getScheduleHealth(...args),
  enqueueDueSchedules: (...args) =>
    requireCapability().sqliteSyncJobRepository.enqueueDueSchedules(...args),
  getLatestResult: (...args) =>
    requireCapability().sqliteSyncJobRepository.getLatestResult(...args),
  getActiveConnectorIds: (...args) =>
    requireCapability().sqliteSyncJobRepository.getActiveConnectorIds(...args),
  prune: (...args) => requireCapability().sqliteSyncJobRepository.prune(...args),
};
