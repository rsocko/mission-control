import type { WorkTodoAck, WorkTodoIngest } from '@/lib/connectors/work-todo/contracts';

/**
 * Layer 4 port for Microsoft To Do - Work ("Work To Do") connector-owned state.
 *
 * The bridge's ingest, pull-envelope, lease, acknowledgement, status, and reset
 * commands are connector-owned persistence even though they are invoked by the
 * Power Automate API/MCP surfaces rather than the sync-worker loop. Each command
 * below is a whole atomic operation: the adapter owns its transaction, no
 * Drizzle/driver handle escapes, and every remote or search side effect happens
 * in the application service *after* the adapter commits.
 */

export type WorkTodoTransport = 'power-automate-standard' | 'power-automate-graph';
export type WorkTodoCapabilityProfile = 'standard-v1' | 'extended-v1';
export type WorkTodoIngestMode = 'snapshot' | 'delta';
export type WorkTodoChangeOperation = 'update' | 'complete' | 'delete';

/** Largest change batch an adapter will lease or acknowledge in one command. */
export const WORK_TODO_MAX_CHANGE_BATCH = 100;
/** Default lease duration when a caller does not request one. */
export const WORK_TODO_DEFAULT_LEASE_SECONDS = 300;
export const WORK_TODO_MIN_LEASE_SECONDS = 30;
export const WORK_TODO_MAX_LEASE_SECONDS = 1_800;

/**
 * Expected bridge conflicts. Adapters raise this instead of leaking a driver
 * error, and routes/MCP map `code`/`status` onto the unchanged API contract.
 */
export class WorkTodoBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WorkTodoBridgeError';
  }
}

/**
 * Stable code for an ingest envelope that is strictly older than the accepted
 * checkpoint. Both adapters raise it before any mutation, so a delayed Power
 * Automate delivery can never resurrect superseded tasks, lists, tags, or
 * checklist items, nor re-apply a removal the newer envelope already settled.
 */
export const WORK_TODO_STALE_INGEST_CODE = 'STALE_INGEST_ENVELOPE';
export const WORK_TODO_STALE_INGEST_STATUS = 409;

/** Builds the identical stale-envelope rejection on either backend. */
export function staleWorkTodoIngestError(
  acceptedIngestAt: string | null,
  envelopeSyncTimestamp: string,
): WorkTodoBridgeError {
  return new WorkTodoBridgeError(
    WORK_TODO_STALE_INGEST_CODE,
    `Ingest envelope ${envelopeSyncTimestamp} is older than the accepted checkpoint ${
      acceptedIngestAt ?? 'none'
    }`,
    WORK_TODO_STALE_INGEST_STATUS,
  );
}

export interface WorkTodoIngestCommand {
  /** Already-validated Power Automate envelope. */
  payload: WorkTodoIngest;
  /** Caller-owned acceptance instant (canonical UTC ISO-8601). */
  now: string;
  /** Resolved IANA timezone used for relative-reminder recomputation. */
  timezone: string;
}

export interface WorkTodoSearchableTask {
  id: string;
  title: string;
  description: string | null;
  sourceListName: string | null;
  connectorType: string;
  status: string;
  priority: string;
  updatedAt: string;
}

export interface WorkTodoIngestResult {
  mode: WorkTodoIngestMode;
  created: number;
  updated: number;
  removed: number;
  protectedPending: number;
  /**
   * Committed searchable projections for every task the ingest touched. They
   * are read inside the same transaction that wrote them, so the service can
   * index exactly what was committed without a second read.
   */
  indexedTasks: readonly WorkTodoSearchableTask[];
  /** Committed task IDs that still need post-commit search removal. */
  removedTaskIds: readonly string[];
}

export interface WorkTodoLeaseCommand {
  connectorId: string;
  /** Bounded by {@link WORK_TODO_MAX_CHANGE_BATCH}. */
  limit?: number;
  leaseSeconds?: number;
  now: string;
}

export interface WorkTodoLeasedChange {
  idempotencyKey: string;
  sourceId: string;
  listSourceId: string;
  remoteTaskId: string;
  operation: WorkTodoChangeOperation;
  fields: Record<string, unknown> | null;
}

export interface WorkTodoLeaseResult {
  leaseId: string;
  leaseExpiresAt: string;
  changes: readonly WorkTodoLeasedChange[];
}

export interface WorkTodoTaskDeltaCheckpoint {
  listSourceId: string;
  deltaLink: string | null;
}

/**
 * Backend-neutral pull state. The opaque delta links are sensitive: they are
 * returned only for the pull envelope and never logged or surfaced by status.
 */
export interface WorkTodoPullState {
  capabilityProfile: WorkTodoCapabilityProfile;
  resetRequired: boolean;
  listDeltaLink: string | null;
  selectedListIds: readonly string[];
  taskDeltaLinks: readonly WorkTodoTaskDeltaCheckpoint[];
}

export interface WorkTodoAckCommand {
  payload: WorkTodoAck;
  now: string;
}

export interface WorkTodoAckResult {
  succeeded: number;
  failed: number;
  skipped: number;
  stale: number;
  /** Committed task IDs that still need post-commit search removal. */
  removedTaskIds: readonly string[];
}

export interface WorkTodoBridgeStatus {
  enabled: boolean;
  initialized: boolean;
  transport: WorkTodoTransport | null;
  capabilityProfile: WorkTodoCapabilityProfile | null;
  resetRequired: boolean;
  lastIngestAt: string | null;
  lastIngestMode: WorkTodoIngestMode | null;
  lastError: string | null;
  deltaCheckpointStored: boolean;
  pendingWriteBackCount: number;
}

export interface WorkTodoResetResult {
  resetRequired: true;
  updatedAt: string;
}

export interface WorkTodoBridgePersistence {
  ingest(command: WorkTodoIngestCommand): Promise<WorkTodoIngestResult>;
  lease(command: WorkTodoLeaseCommand): Promise<WorkTodoLeaseResult>;
  readPullState(connectorId: string): Promise<WorkTodoPullState>;
  acknowledge(command: WorkTodoAckCommand): Promise<WorkTodoAckResult>;
  readStatus(connectorId: string): Promise<WorkTodoBridgeStatus>;
  resetDelta(input: { connectorId: string; now: string }): Promise<WorkTodoResetResult>;
}

/**
 * Layer 4 composition for non-finance connector-owned state.
 *
 * Rymessage and OWL (`document-intelligence`) intentionally have no member
 * here: they own no worker persistence table, so their durable state is the
 * generic Layer 1 connector settings plus the Layer 2 list/task/tag/notification
 * ports. Scout is push-only and its route/MCP workflows stay unassigned.
 */
export interface NonFinanceConnectorStateRepositories {
  readonly workTodo: WorkTodoBridgePersistence;
}
