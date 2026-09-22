import type { SyncResult } from '@/types';
import type { SyncStreamEvent } from './events';

export type SyncJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type SyncJobSource =
  | 'api'
  | 'schedule'
  | 'nightly'
  | 'watchdog'
  | 'recovery'
  | 'operator-canary';

export interface SyncJob {
  id: string;
  connectorId: string;
  full: boolean;
  source: SyncJobSource;
  status: SyncJobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  scheduledFor: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: SyncResult | null;
  error: string | null;
  durationBudgetMs: number;
  identityMode: string | null;
  identityModeRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSyncJobOptions {
  full?: boolean;
  source?: SyncJobSource;
  availableAt?: Date;
  scheduledFor?: Date;
  maxAttempts?: number;
  durationBudgetMs?: number;
  operatorCanaryRunId?: string;
}

export interface SyncJobFailureOptions {
  retry?: boolean;
  cancelled?: boolean;
  terminal?: boolean;
  /**
   * Durable events enqueued inside the same transaction as the terminal
   * transition. Ignored when the computed status is not terminal (a retry is
   * still in flight), which is what keeps retries from duplicating events.
   */
  events?: readonly SyncTerminalEvent[];
}

/**
 * An outbound event whose durability is coupled to a sync job's authoritative
 * terminal transition. `stableKey` is derived from durable sync job/run
 * identity, so re-running a finalizer can never produce a second delivery.
 */
export interface SyncTerminalEvent {
  stableKey: string;
  eventType: 'sync.completed' | 'sync.failed';
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SyncJobFinalizationOptions {
  events?: readonly SyncTerminalEvent[];
}

export interface SyncJobEnqueueRequest {
  full?: boolean;
  source?: SyncJobSource;
  availableAt?: string;
  scheduledFor?: string;
  maxAttempts?: number;
  durationBudgetMs?: number;
  operatorCanaryRunId?: string;
}

export interface SyncQueueMetrics {
  queued: number;
  running: number;
  retrying: number;
  cancelled: number;
  oldestQueuedAgeMs: number;
  missedSchedules: number;
  oldestScheduleOverdueMs: number;
  overBudget: number;
  expiredLeases: number;
}

export interface SyncSchedule {
  connectorId: string;
  intervalMinutes: number;
}

export interface SyncScheduleHealth extends SyncSchedule {
  nextDueAt: string;
  lastEnqueuedAt: string | null;
  overdueMs: number;
  overdue: boolean;
}

export interface PersistedSyncEvent {
  id: number;
  jobId: string | null;
  connectorId: string;
  event: SyncStreamEvent;
  createdAt: string;
}

export interface SyncCancellationResult {
  cancelled: number;
  cancellationRequested: number;
}

export interface SyncJobRepository {
  enqueue(connectorId: string, request?: SyncJobEnqueueRequest): Promise<SyncJob>;
  claimNext(
    owner: string,
    leaseMs?: number,
    excludedConnectorIds?: ReadonlySet<string>,
  ): Promise<SyncJob | null>;
  renewLease(jobId: string, owner: string, attempt: number, leaseMs?: number): Promise<boolean>;
  isCancellationRequested(jobId: string, owner: string, attempt: number): Promise<boolean>;
  complete(jobId: string, owner: string, attempt: number, result: SyncResult): Promise<void>;
  finalizeSuccess(
    job: SyncJob,
    owner: string,
    result: SyncResult,
    options?: SyncJobFinalizationOptions,
  ): Promise<void>;
  linkSyncLog(job: SyncJob, result: SyncResult): Promise<void>;
  fail(
    job: SyncJob,
    owner: string,
    error: string,
    options?: SyncJobFailureOptions,
  ): Promise<SyncJobStatus>;
  release(jobId: string, owner: string, attempt: number, reason: string): Promise<boolean>;
  requestCancellation(params: {
    jobId?: string;
    connectorId?: string;
  }): Promise<SyncCancellationResult>;
  get(jobId: string): Promise<SyncJob | null>;
  persistEvent(jobId: string, event: SyncStreamEvent): Promise<void>;
  getEventsAfter(cursor: number, limit?: number): Promise<PersistedSyncEvent[]>;
  getLatestEventId(): Promise<number>;
  countQueued(): Promise<number>;
  getMetrics(at?: string): Promise<SyncQueueMetrics>;
  registerSchedule(connectorId: string, intervalMinutes: number): Promise<void>;
  markScheduleEnqueued(connectorId: string): Promise<void>;
  unregisterSchedule(connectorId: string): Promise<void>;
  getSchedules(): Promise<SyncSchedule[]>;
  getScheduleHealth(at?: string): Promise<SyncScheduleHealth[]>;
  enqueueDueSchedules(at?: string): Promise<SyncJob[]>;
  getLatestResult(connectorId: string): Promise<SyncResult | undefined>;
  getActiveConnectorIds(): Promise<string[]>;
  prune(retentionDays?: number): Promise<void>;
}
