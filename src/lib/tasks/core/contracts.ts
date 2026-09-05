/**
 * Portable task-core persistence contracts (Layer L04 of the web/API
 * PostgreSQL parity migration).
 *
 * These types are deliberately *domain* inputs and results: plain data that
 * both the SQLite and PostgreSQL adapters can interpret with their own
 * dialect. No Drizzle predicate (`SQL`), table object, or transaction handle
 * may cross this boundary — that is the whole point of the layer. The
 * SQLite and PostgreSQL adapters compile the same domain specifications on
 * their own side of this contract.
 *
 * This module is type-only plus a couple of pure constants, so importing it
 * never evaluates a database driver.
 */

import type { LocalDisposition, TaskPriority, TaskStatus } from '@/types';
import type {
  QuickSortBeforeSnapshot,
  QuickSortTaskSnapshot,
} from '@/types/quick-sort';

/* ------------------------------------------------------------------ *
 * Filter / query specification
 * ------------------------------------------------------------------ */

export const TASK_QUICK_FILTERS = [
  'overdue',
  'today',
  'week',
  'noDate',
  'high',
  'myDay',
  'recentlyCreated',
  'recentlyClosed',
  'waiting',
  'assigned',
  'inbox',
] as const;

export type TaskQuickFilter = typeof TASK_QUICK_FILTERS[number];

export function isTaskQuickFilter(value: string | null | undefined): value is TaskQuickFilter {
  return typeof value === 'string'
    && (TASK_QUICK_FILTERS as readonly string[]).includes(value);
}

/**
 * Fully-resolved, backend-neutral description of the canonical task filter.
 *
 * Every field is already normalized/validated by
 * `@/lib/tasks/core/filter-spec`, so an adapter never re-parses raw request
 * input: it only translates already-canonical values into its own dialect.
 * Date boundaries are passed explicitly (rather than recomputed per adapter)
 * so both backends observe the exact same instant for a single request.
 */
export interface TaskFilterSpec {
  /** `tasks.connector_type IN (...)` when non-empty. */
  readonly connectorTypes: readonly string[];
  readonly statuses: readonly string[];
  readonly priorities: readonly string[];
  readonly planningHorizons: readonly string[];
  /** `planningHorizon=none` — matches rows whose horizon is SQL NULL. */
  readonly planningHorizonIsNull: boolean;
  readonly localDispositions: readonly LocalDisposition[];
  /**
   * `openOnly=true` (and not the `recentlyClosed` quick filter) with no
   * explicit status filter: excludes `done`/`cancelled`.
   */
  readonly excludeClosedStatuses: boolean;
  /** The raw `openOnly` request flag, which drives the stats denominators. */
  readonly openOnly: boolean;
  readonly parentOnly: boolean;
  /** `listIds`/`listId`, each optionally `${connectorInstanceId}:${sourceListId}`. */
  readonly sourceListIds: readonly string[];
  readonly sourceListGroupId: string | null;
  /** Inclusive upper bound on `tasks.created_at` (from `ageMin`). */
  readonly createdAtMax: string | null;
  /** Inclusive lower bound on `tasks.created_at` (from `ageMax`). */
  readonly createdAtMin: string | null;
  readonly filterQuery: string | null;
  readonly tagSlug: string | null;
  readonly tagSlugs: readonly string[];
  readonly projectId: string | null;
  readonly quickFilter: TaskQuickFilter | null;
  /** Already-validated `YYYY-MM-DD`; defaults to `today`. */
  readonly myDayDate: string;
  readonly today: string;
  readonly weekFromNow: string;
  /** `today - 7d`, used by the `recentlyCreated`/`recentlyClosed` filters. */
  readonly recentCutoff: string;
  /** Literal collection-search term (not filter-query syntax). */
  readonly search?: string | null;
  /** Exact effort filter used by the collection endpoint. */
  readonly effort?: number | null;
  /** Match any of these tag ids. */
  readonly tagIds?: readonly string[];
  /** Match tasks with no project membership. */
  readonly noProject?: boolean;
  /** Optional drill-down into one visible collection group. */
  readonly group?: {
    readonly mode: TaskGroupMode;
    readonly value: string;
  } | null;
}

/** Which half of the canonical filter a query should apply. */
export interface TaskQueryScope {
  /**
   * `false` (the default) evaluates only the base conditions — the
   * denominator every stat is measured against. `true` additionally applies
   * the quick filter, matching the visible result set.
   */
  readonly includeQuickFilter?: boolean;
}

export type TaskListSortField =
  | 'dueDate'
  | 'priority'
  | 'planningHorizon'
  | 'title'
  | 'createdAt'
  | 'completedAt'
  | 'updatedAt'
  | 'updated'
  | 'status'
  | 'sourceList'
  | 'effort'
  | 'smartScore';

export interface TaskListOrder {
  readonly field: TaskListSortField;
  readonly direction: 'asc' | 'desc';
}

export interface TaskListPage {
  readonly order: TaskListOrder;
  readonly limit: number;
  readonly offset: number;
}

/* ------------------------------------------------------------------ *
 * Query results
 * ------------------------------------------------------------------ */

export interface TaskStatsResult {
  readonly totalOpen: number;
  readonly overdue: number;
  readonly dueToday: number;
  readonly dueThisWeek: number;
  readonly noDate: number;
  readonly highPriority: number;
  readonly assignedToMe: number;
  readonly myDay: number;
  readonly recentlyCreated: number;
  readonly recentlyClosed: number;
  readonly waiting: number;
  readonly inbox: number;
}

export type TaskSourceCounts = Record<string, number>;

export interface AvailableTaskTag {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: string;
  readonly source: string | null;
  readonly color: string | null;
  readonly confirmed: boolean;
  readonly count: number;
}

/** A user-configured "inbox list" entry from the `inbox.lists` app setting. */
export interface InboxListEntry {
  readonly connectorType: string;
  readonly sourceListId?: string;
  readonly sourceListName?: string;
}

/* ------------------------------------------------------------------ *
 * Endpoint-oriented task reads
 * ------------------------------------------------------------------ */

export interface TaskAttachmentReadContext {
  readonly task: {
    readonly sourceId: string;
    readonly connectorType: string;
    readonly connectorInstanceId: string;
  } | null;
  readonly attachment: {
    readonly name: string;
    readonly contentType: string;
    readonly contentBase64: string | null;
    readonly sourceAttachmentId: string | null;
  } | null;
}

export interface TaskDocumentPreviewContext {
  readonly task: {
    readonly connectorType: string;
    readonly connectorInstanceId: string;
    readonly metadata: Record<string, unknown>;
  } | null;
  /**
   * Present only when the task's connector is an enabled, non-deleted
   * document-intelligence connector with the exact stored instance id.
   */
  readonly connector: {
    readonly credentials: Record<string, unknown>;
    readonly settings: Record<string, unknown>;
  } | null;
}

export interface TaskLinkedSourceRow {
  readonly id: string;
  readonly taskId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly linkedAt: string;
  readonly matchConfidence: number | null;
  readonly metadata: Record<string, unknown>;
}

export interface TaskRelationshipCandidateRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly connectorType: string;
  readonly sourceListName: string | null;
  readonly projectIds: string[];
  readonly projectNames: string[];
}

export interface TaskDuplicateDetectionRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly createdAt: string;
}

export type TaskGroupMode =
  | 'status'
  | 'priority'
  | 'planningHorizon'
  | 'source'
  | 'list'
  | 'effort'
  | 'dueDate'
  | 'tag'
  | 'project';

export const TASK_QUICK_SORT_QUEUE_MODES = [
  'no_priority',
  'quadrant',
  'no_effort',
  'no_tags',
  'no_planning_horizon',
] as const;

export type TaskQuickSortQueueMode = typeof TASK_QUICK_SORT_QUEUE_MODES[number];

export function parseTaskQuickSortQueueMode(value: string): TaskQuickSortQueueMode {
  switch (value) {
    case 'no_priority':
    case 'quadrant':
    case 'no_effort':
    case 'no_tags':
    case 'no_planning_horizon':
      return value;
    default:
      throw new Error(`Invalid persisted Quick Sort mode: ${value}`);
  }
}

export type TaskQuickSortOrder = 'smart' | 'priority' | 'oldest' | 'newest' | 'random';

export interface TaskQuickSortScope {
  readonly now: string;
  readonly skipCutoff: string;
  readonly sourceTypes: readonly string[];
  readonly sourceListId: string | null;
  readonly sourceListName: string | null;
  readonly connectorInstanceId: string | null;
}

export interface TaskQuickSortSourceRow {
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceListId: string | null;
  readonly sourceListName: string | null;
  readonly count: number;
}

export interface TaskQuickSortSourceListDefinition {
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly userDisplayName: string | null;
  readonly type: string;
  readonly icon: string | null;
  readonly iconColor: string | null;
  readonly hidden: boolean;
}

export interface TaskQuickSortCounts {
  readonly no_priority: number;
  readonly quadrant: number;
  readonly no_effort: number;
  readonly no_tags: number;
  readonly no_planning_horizon: number;
}

export interface TaskQuickSortQueueRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: string;
  readonly effort: number | null;
  readonly status: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly sourceListId: string | null;
  readonly sourceListName: string | null;
  readonly dueDate: string | null;
  readonly planningHorizon: string | null;
  readonly createdAt: string;
  readonly localDisposition: LocalDisposition;
  readonly tags: Array<{
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: string | null;
  }>;
  readonly projects: Array<{
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }>;
  readonly phases: Array<{
    readonly id: string;
    readonly name: string;
    readonly projectId: string | null;
  }>;
}

export interface TaskQuickSortSuggestionTask {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceListName: string | null;
  readonly assignee: string | null;
  readonly snoozedUntil: string | null;
  readonly effort: number | null;
}

export interface TaskQuickSortSuggestionInputs {
  readonly tasks: TaskQuickSortSuggestionTask[];
  readonly sourceRankings: Array<{
    readonly id: string;
    readonly connectorType: string;
    readonly name: string;
    readonly rank: number;
    readonly updatedAt: string;
  }>;
  readonly tags: Array<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly taskTags: Array<{
    readonly taskId: string;
    readonly tagId: string;
  }>;
}

export type TaskQuickSortAction = 'applied' | 'suggestion_accepted' | 'skipped';
export type TaskQuickSortOperationState = 'applying' | 'applied' | 'undoing' | 'undone';

export function parseTaskQuickSortAction(value: string): TaskQuickSortAction {
  if (value === 'applied' || value === 'suggestion_accepted' || value === 'skipped') {
    return value;
  }
  throw new Error(`Invalid persisted Quick Sort action: ${value}`);
}

export function parseTaskQuickSortOperationState(value: string): TaskQuickSortOperationState {
  if (value === 'applying' || value === 'applied' || value === 'undoing' || value === 'undone') {
    return value;
  }
  throw new Error(`Invalid persisted Quick Sort operation state: ${value}`);
}

export interface TaskQuickSortOperation {
  readonly id: string;
  readonly taskId: string;
  readonly mode: TaskQuickSortQueueMode;
  readonly action: TaskQuickSortAction;
  readonly label: string;
  readonly contextKey: string;
  readonly queueIndex: number;
  readonly beforeSnapshot: QuickSortBeforeSnapshot;
  readonly afterSnapshot: QuickSortTaskSnapshot;
  readonly state: TaskQuickSortOperationState;
  readonly aiAccepted: boolean;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface TaskQuickSortOperationReservation {
  readonly id: string;
  readonly taskId: string;
  readonly mode: TaskQuickSortQueueMode;
  readonly action: TaskQuickSortAction;
  readonly label: string;
  readonly contextKey: string;
  readonly queueIndex: number;
  readonly beforeSnapshot: QuickSortBeforeSnapshot;
  readonly afterSnapshot: QuickSortTaskSnapshot;
  readonly aiAccepted: boolean;
  readonly createdAt: string;
}

export type TaskQuickSortReservationOutcome =
  | { readonly kind: 'reserved'; readonly operation: TaskQuickSortOperation }
  | { readonly kind: 'existing'; readonly operation: TaskQuickSortOperation };

export interface TaskQuickSortLogEntry {
  readonly id: string;
  readonly taskId: string;
  readonly operationId: string | null;
  readonly mode: TaskQuickSortQueueMode;
  readonly action: TaskQuickSortAction;
  readonly triagedAt: string;
}

export interface TaskQuickSortPersistenceRepository {
  captureTask(taskId: string): Promise<QuickSortTaskSnapshot | null>;
  getOperation(id: string): Promise<TaskQuickSortOperation | null>;
  reserveOperation(
    input: TaskQuickSortOperationReservation,
  ): Promise<TaskQuickSortReservationOutcome>;
  discardApplyingOperation(id: string): Promise<boolean>;
  finalizeOperation(
    id: string,
    afterSnapshot: QuickSortTaskSnapshot,
    logs: readonly TaskQuickSortLogEntry[],
  ): Promise<TaskQuickSortOperation | null>;
  claimUndo(id: string): Promise<boolean>;
  releaseUndo(id: string): Promise<boolean>;
  finalizeUndo(id: string, undoneAt: string): Promise<boolean>;
  countActivityByModeSince(
    since: string,
  ): Promise<Array<{ readonly mode: TaskQuickSortQueueMode; readonly count: number }>>;
  listActivityTimestampsSince(since: string): Promise<string[]>;
  recordActivity(entry: TaskQuickSortLogEntry): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Task collection/detail and route write operations (L07)
 * ------------------------------------------------------------------ */

/** Portable representation of every durable task column used by the two routes. */
export interface TaskCoreTaskRow {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly localDisposition: LocalDisposition;
  readonly priority: string;
  readonly planningHorizon: 'next' | 'soon' | 'later' | 'someday' | null;
  readonly dueDate: string | null;
  readonly pushCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly recurrenceGeneratedFromTaskId: string | null;
  readonly parentId: string | null;
  readonly depth: number;
  readonly isChecklistItem: boolean;
  readonly sourceListId: string | null;
  readonly sourceListName: string | null;
  readonly assignee: string | null;
  readonly microStatus: string | null;
  readonly statusReason: string | null;
  readonly metadata: Record<string, unknown>;
  readonly syncStatus: string;
  readonly lastSyncedAt: string;
  readonly pushRetryCount: number;
  readonly kanbanColumn: string | null;
  readonly kanbanOrder: number | null;
  readonly snoozedUntil: string | null;
  readonly reminderAt: string | null;
  readonly reminderRelative: string | null;
  readonly reminderDueTime: string | null;
  readonly effort: number | null;
  readonly isBulkImport: boolean;
}

export interface TaskCollectionTag {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: string;
  readonly source: string | null;
  readonly color: string | null;
  readonly confirmed: boolean;
  readonly unifiedInto: string | null;
}

export interface TaskCollectionProjectPhaseMembership {
  readonly projectId: string;
  readonly projectName: string;
  readonly phaseId: string | null;
  readonly phaseName: string | null;
}

export interface TaskCollectionRow extends TaskCoreTaskRow {
  readonly parentTitle: string | null;
  readonly authoritativeSourceListName: string | null;
  readonly estimatedDuration: number | null;
  readonly subtaskTotal: number;
  readonly subtaskDone: number;
  readonly projectIds: string[];
  readonly projectPhaseMemberships: TaskCollectionProjectPhaseMembership[];
  readonly linkedSourceCount: number;
  readonly tags: TaskCollectionTag[];
}

export interface TaskCollectionConnectorContext {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly deletedAt: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
}

export interface TaskSmartScoreInputs {
  readonly rows: TaskCollectionRow[];
  readonly sourceRankings: Array<{
    readonly id: string;
    readonly connectorType: string;
    readonly name: string;
    readonly rank: number;
    readonly updatedAt: string;
  }>;
}

export interface TaskCollectionResult {
  readonly rows: TaskCollectionRow[];
  readonly total: number;
  readonly stats: TaskStatsResult;
  readonly sourceCounts: TaskSourceCounts;
  readonly availableTags: AvailableTaskTag[];
  readonly connectorContexts: TaskCollectionConnectorContext[];
  /**
   * Present for `smartScore`: rows are the deterministic candidate set rather
   * than a page, and callers apply domain scoring before slicing.
   */
  readonly smartScore: TaskSmartScoreInputs | null;
}

export interface TaskCollectionReadRepository {
  readTaskCollection(input: {
    readonly spec: TaskFilterSpec;
    readonly page: TaskListPage;
    readonly includeTags: boolean;
    readonly includeScoreInputs: boolean;
    readonly countsOnly: boolean;
    readonly smartScoreCandidateLimit: number;
  }): Promise<TaskCollectionResult>;
}

export interface TaskDetailSubtask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly effort: number | null;
}

export interface TaskDetailResult {
  readonly task: TaskCoreTaskRow;
  readonly tagIds: string[];
  readonly projectIds: string[];
  readonly subtasks: TaskDetailSubtask[];
  readonly schedule: Pick<
    TaskScheduleRow,
    'estimatedDuration' | 'recurrence' | 'recurrenceMode'
  > | null;
  readonly isInMyDay: boolean;
}

export interface TaskDetailReadRepository {
  getTaskDetail(taskId: string, myDayDate: string): Promise<TaskDetailResult | null>;
}

export interface TaskCoreEvent {
  readonly stableKey: string;
  readonly type: 'task.created' | 'task.updated' | 'task.completed';
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

export interface TaskCreateInput {
  readonly task: TaskCoreTaskRow;
  readonly tagIds: readonly string[];
  readonly tagSlugs: readonly string[];
  readonly tagCreationMode: 'freeform' | 'predefined';
  readonly projectIds: readonly string[];
  readonly schedule: TaskScheduleRow | null;
  readonly triageItemId: string | null;
  readonly triageClaimId: string | null;
  readonly requireConnectorEnabled: boolean;
  readonly requireSelectedSourceList: boolean;
  readonly event: TaskCoreEvent;
}

export type TaskCreateTargetOutcome =
  | {
      readonly kind: 'resolved';
      readonly connectorInstanceId: string;
      readonly capabilities: Record<string, unknown>;
      readonly settings: Record<string, unknown>;
    }
  | { readonly kind: 'connector-not-found' }
  | { readonly kind: 'connector-disabled' }
  | { readonly kind: 'connector-mismatch' }
  | { readonly kind: 'connector-ambiguous' }
  | { readonly kind: 'source-list-not-found' }
  | { readonly kind: 'source-list-ambiguous' }
  | { readonly kind: 'source-list-not-selected' };

export type TaskCreateOutcome =
  | {
      readonly kind: 'committed';
      readonly task: TaskCoreTaskRow;
      readonly sourceTagNames: string[];
    }
  | { readonly kind: 'triage-not-found' }
  | { readonly kind: 'triage-pending' }
  | { readonly kind: 'triage-replay'; readonly taskId: string | null }
  | { readonly kind: 'connector-not-found' }
  | { readonly kind: 'connector-disabled' }
  | { readonly kind: 'connector-mismatch' }
  | { readonly kind: 'source-list-not-found' }
  | { readonly kind: 'source-list-ambiguous' }
  | { readonly kind: 'source-list-not-selected' }
  | { readonly kind: 'project-not-found'; readonly projectId: string }
  | { readonly kind: 'tag-not-found'; readonly tagId: string };

export interface TaskCreateRepository {
  resolveTaskCreateTarget(input: {
    readonly connectorType: string;
    readonly requestedConnectorInstanceId: string | null;
    readonly sourceListId: string | null;
  }): Promise<TaskCreateTargetOutcome>;
  createTask(input: TaskCreateInput): Promise<TaskCreateOutcome>;
}

export interface TaskFieldStateMutation {
  readonly fieldName: string;
  readonly sourceValue: string;
  readonly locallyOverridden: boolean;
  readonly sourceObservedAt: string | null;
  readonly localEditedAt: string | null;
  readonly updatedAt: string;
}

export interface TaskPriorityLogMutation {
  readonly id: string;
  readonly previousPriority: string;
  readonly newPriority: string;
  readonly writeBackTriggered: boolean;
  readonly note: string | null;
}

export interface TaskPlanningHistoryMutation {
  readonly previousValue: string | null;
  readonly newValue: string | null;
}

export interface TaskSchedulePatch {
  readonly scheduledDate: string;
  readonly estimatedDuration?: number | null;
  readonly recurrence?: string | null;
  readonly recurrenceMode?: 'schedule' | 'completion';
}

export interface TaskCoreTaskPatch {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: string;
  readonly localDisposition?: LocalDisposition;
  readonly priority?: string;
  readonly planningHorizon?: 'next' | 'soon' | 'later' | 'someday' | null;
  readonly dueDate?: string | null;
  readonly completedAt?: string | null;
  readonly kanbanColumn?: string | null;
  readonly kanbanOrder?: number | null;
  readonly microStatus?: string | null;
  readonly statusReason?: string | null;
  readonly snoozedUntil?: string | null;
  readonly reminderAt?: string | null;
  readonly reminderRelative?: string | null;
  readonly reminderDueTime?: string | null;
  readonly effort?: number | null;
  readonly metadata?: Record<string, unknown>;
  readonly syncStatus?: string;
  readonly pushRetryCount?: number;
}

export interface TaskRecurrenceSuccessorMutation {
  readonly id: string;
  readonly dueDate: string;
  readonly scheduledDate: string;
  readonly scheduledTime: string | null;
  readonly reminderAt: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface TaskWriteContext {
  readonly task: TaskCoreTaskRow;
  readonly schedule: TaskScheduleRow | null;
  readonly tagIds: string[];
  readonly tagNamesById: Record<string, string>;
  readonly fieldStates: TaskFieldStateMutation[];
  readonly wasAutoCompletedByReconciliation: boolean;
}

export interface TaskMutationRequest {
  readonly taskId: string;
  readonly expectedUpdatedAt: string;
  readonly expectedStatusForTerminalTransition: string | null;
  readonly now: string;
  readonly patch: TaskCoreTaskPatch;
  readonly schedulePatch?: TaskSchedulePatch;
  readonly replaceTagIds?: readonly string[];
  readonly fieldStates?: readonly TaskFieldStateMutation[];
  readonly priorityLog?: TaskPriorityLogMutation;
  readonly planningHistory?: TaskPlanningHistoryMutation;
  readonly suppressAutoCompletionAfterReopen?: boolean;
  readonly supersedePendingReconciliation?: boolean;
  readonly recurrenceSuccessor?: TaskRecurrenceSuccessorMutation;
  readonly events?: readonly TaskCoreEvent[];
}

export type TaskMutationOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'revision-conflict'; readonly currentUpdatedAt: string }
  | {
      readonly kind: 'committed';
      readonly task: TaskCoreTaskRow;
      readonly recurrenceNextTaskId: string | null;
    };

export interface TaskMutationRepository {
  getTaskWriteContext(
    taskId: string,
    requestedTagIds?: readonly string[],
  ): Promise<TaskWriteContext | null>;
  mutateTask(request: TaskMutationRequest): Promise<TaskMutationOutcome>;
}

export type TaskRemovalMode =
  | 'mirror-dismiss'
  | 'ingested-cancel'
  | 'local-delete'
  | 'remote-cancel-intent';

export interface TaskRemovalContext {
  readonly task: TaskCoreTaskRow;
}

export type TaskRemovalOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'revision-conflict'; readonly currentUpdatedAt: string }
  | {
      readonly kind: 'committed';
      readonly action: 'dismissed' | 'cancelled' | 'deleted' | 'pending-remote';
      readonly taskVersion: string | null;
    };

export interface TaskRemovalRepository {
  getTaskRemovalContext(taskId: string): Promise<TaskRemovalContext | null>;
  applyTaskRemoval(input: {
    readonly taskId: string;
    readonly expectedUpdatedAt: string;
    readonly mode: TaskRemovalMode;
    readonly now: string;
    readonly events?: readonly TaskCoreEvent[];
  }): Promise<TaskRemovalOutcome>;
  /**
   * Called only after external I/O has completed. Both the push lease and the
   * optimistic task version must still match before the local graph is removed.
   */
  finalizeRemoteTaskRemoval(input: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly expectedUpdatedAt: string;
  }): Promise<TaskRemovalOutcome>;
}

/**
 * Narrow read surface for the nine L05 task-read endpoints. Inputs and results
 * are plain domain data; SQL expressions and backend handles never cross it.
 */
export interface TaskReadRepository {
  getAttachmentReadContext(
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachmentReadContext>;
  getDocumentPreviewContext(taskId: string): Promise<TaskDocumentPreviewContext>;
  listLinkedSources(taskId: string): Promise<TaskLinkedSourceRow[]>;
  searchRelationshipCandidates(input: {
    readonly taskId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<TaskRelationshipCandidateRow[] | null>;
  listDuplicateDetectionTasks(input: {
    readonly includeClosedTasks: boolean;
  }): Promise<TaskDuplicateDetectionRow[]>;
  listDistinctTaskAssignees(): Promise<string[]>;
  getGroupCounts(input: {
    readonly spec: TaskFilterSpec;
    readonly groupBy: TaskGroupMode;
  }): Promise<Record<string, number>>;
  listQuickSortSources(input: {
    readonly now: string;
    readonly skipCutoff: string;
  }): Promise<{
    readonly rows: TaskQuickSortSourceRow[];
    readonly definitions: TaskQuickSortSourceListDefinition[];
  }>;
  getQuickSortCounts(input: TaskQuickSortScope): Promise<TaskQuickSortCounts>;
  listQuickSortTasks(
    input: TaskQuickSortScope & {
      readonly mode: TaskQuickSortQueueMode;
      readonly order: TaskQuickSortOrder;
      readonly limit: number;
    },
  ): Promise<TaskQuickSortQueueRow[]>;
  getQuickSortSuggestionInputs(
    taskIds: readonly string[],
  ): Promise<TaskQuickSortSuggestionInputs>;
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

/**
 * Reads the stored inputs the canonical filter needs before it can be
 * compiled: My Day membership, the identity-aware "assigned to me" evidence,
 * and the user's configured inbox lists.
 */
export interface TaskFilterInputRepository {
  listMyDayTaskIds(date: string): Promise<string[]>;
  /**
   * Authenticated GitHub usernames across every enabled, non-deleted
   * `github-issues` connector. Empty when no GitHub identity is known.
   */
  listAssignedGitHubUsernames(): Promise<string[]>;
  listInboxListEntries(): Promise<InboxListEntry[]>;
}

/**
 * Backend-neutral execution of the canonical filter. Both adapters must
 * agree on result *and* ordering for identical inputs; the shared contract
 * suite in `tests/contracts/task-core.contract.ts` proves it.
 */
export interface TaskQueryRepository {
  countTasks(spec: TaskFilterSpec, scope?: TaskQueryScope): Promise<number>;
  listTaskIds(spec: TaskFilterSpec, page: TaskListPage): Promise<string[]>;
  getStats(spec: TaskFilterSpec): Promise<TaskStatsResult>;
  getSourceCounts(spec: TaskFilterSpec): Promise<TaskSourceCounts>;
  getAvailableTags(spec: TaskFilterSpec): Promise<AvailableTaskTag[]>;
}

/** The four identity columns every task edit/mutation policy decision needs. */
export interface TaskSourceIdentityRow {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
}

export interface TaskDependencyEndpoints {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

export interface TaskPolicyIdentityRepository {
  /**
   * Returns one row per *existing* task id, in no guaranteed order. Unknown
   * ids are silently absent rather than an error: policy resolution treats a
   * missing task as "no policy", which callers already handle.
   */
  listTaskSourceIdentities(
    taskIds: readonly string[],
  ): Promise<TaskSourceIdentityRow[]>;
  getTaskSourceIdentity(taskId: string): Promise<TaskSourceIdentityRow | null>;
  getDependencyEndpoints(dependencyId: string): Promise<TaskDependencyEndpoints | null>;
}

export interface LocalTaskDeletionRequest {
  readonly taskId: string;
  /**
   * `true` deletes the whole descendant subtree. `false` detaches direct
   * children (re-basing their `depth`) and deletes only the root.
   */
  readonly recursive: boolean;
}

export interface RetentionTaskIdentity {
  readonly connectorId: string;
  readonly taskId?: string;
  readonly taskSourceId: string;
}

/**
 * The retention-resolution view of a task. Deliberately narrower than
 * `TaskItem`: retention only needs identity plus the columns its callers
 * log or compare.
 */
export interface RetentionTaskRow {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface LocalTaskLifecycleRepository {
  /** Atomically removes a task (and, when recursive, its subtree). */
  deleteTaskLocally(request: LocalTaskDeletionRequest): Promise<void>;
  /**
   * Atomically rewrites a task subtree to be Mission-Control-owned,
   * recording the retention resolution in each task's metadata.
   */
  convertTaskTreeToLocal(
    taskId: string,
    resolution: 'keep_local' | 'archive_local',
    now: string,
  ): Promise<void>;
  findTaskByRetentionIdentity(
    identity: RetentionTaskIdentity,
  ): Promise<RetentionTaskRow | null>;
}

export type ScoutHardDeleteOutcome =
  | { readonly kind: 'deleted'; readonly taskId: string; readonly sourceId: string; readonly deletedTaskIds: string[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-scout' };

export interface ScoutTaskHardDeleteRepository {
  /**
   * Deletes a Scout task graph and writes its ingest-suppression tombstones
   * in one transaction. Either both land or neither does — a partially
   * applied hard delete would silently re-ingest the task on the next sync.
   */
  hardDeleteScoutTask(taskId: string): Promise<ScoutHardDeleteOutcome>;
}

/** Optimistic-concurrency evidence captured before a move is attempted. */
export interface TaskMoveAttachmentSnapshot {
  readonly id: string;
  readonly size: number;
  readonly sourceAttachmentId: string | null;
}

export interface TaskAttachmentRow {
  readonly id: string;
  readonly taskId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly contentBase64: string | null;
  readonly sourceAttachmentId: string | null;
  readonly createdAt: string;
}

export interface PendingSyncTaskMoveRequest {
  readonly sourceTaskId: string;
  readonly newTaskId: string;
  /** Optimistic guard: the move only commits if these still match. */
  readonly expectedSourceId: string;
  readonly expectedUpdatedAt: string;
  readonly attachmentSnapshot: readonly TaskMoveAttachmentSnapshot[];
  readonly targetConnectorType: string;
  readonly targetConnectorInstanceId: string;
  readonly targetSourceListId: string | null;
  readonly keepTags: boolean;
  readonly now: string;
}

export type PendingSyncTaskMoveOutcome =
  | { readonly kind: 'moved' }
  | { readonly kind: 'source-changed' }
  | { readonly kind: 'not-found' };

/** The source-task columns a pending-sync move copies onto its successor. */
export interface TaskMoveSourceRow {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/**
 * The two identifiers a move target is matched by (`sourceLists.id` or the
 * connector-scoped `sourceLists.source_id`), which is exactly what
 * `isSourceListSelected` needs to decide whether the list is synced.
 */
export interface TaskMoveTargetList {
  readonly id: string;
  readonly sourceId: string;
}

export interface TaskMoveRepository {
  getMoveSource(taskId: string): Promise<TaskMoveSourceRow | null>;
  listTaskAttachments(taskId: string): Promise<TaskAttachmentRow[]>;
  /**
   * Resolves a move target list by either its primary key or its
   * connector-scoped source id, scoped to one connector instance.
   */
  findTargetList(
    connectorInstanceId: string,
    listIdOrSourceId: string,
  ): Promise<TaskMoveTargetList | null>;
  /**
   * Claims the source task, materializes the successor, repoints every
   * durable reference, and removes the source — all inside one transaction
   * so a failure leaves the source completely intact. Connector/network I/O
   * is the caller's responsibility and must happen outside this call.
   */
  executePendingSyncMove(
    request: PendingSyncTaskMoveRequest,
  ): Promise<PendingSyncTaskMoveOutcome>;
  taskExists(taskId: string): Promise<boolean>;
}

/* ------------------------------------------------------------------ *
 * Write-through task move
 * ------------------------------------------------------------------ */

/**
 * The complete durable shape of a task row, as the write-through move needs
 * it. It is deliberately explicit rather than an opaque record: the move
 * copies a source task onto its successor field by field, so every column it
 * carries has to be nameable on both backends.
 */
export type TaskMoveTaskRow = TaskCoreTaskRow;

/** A task row about to be written, i.e. every column the move must supply. */
export type TaskMoveTaskInsert = TaskMoveTaskRow;

export interface TaskMoveTagRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: string;
  readonly color: string | null;
}

/** Attachment identity/metadata, without the (potentially large) content. */
export interface TaskAttachmentMetadataRow {
  readonly id: string;
  readonly taskId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sourceAttachmentId: string | null;
  readonly createdAt: string;
}

export interface TaskAttachmentContentRow {
  readonly id: string;
  readonly contentBase64: string | null;
}

export interface TaskAttachmentInsert {
  readonly id: string;
  readonly taskId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly contentBase64?: string | null;
  readonly sourceAttachmentId?: string | null;
  readonly createdAt: string;
}

export interface TaskScheduleRow {
  readonly taskId: string;
  readonly scheduledDate: string;
  readonly scheduledTime: string | null;
  readonly estimatedDuration: number | null;
  readonly isTimeBlocked: boolean;
  readonly recurrence: string | null;
  readonly recurrenceMode: 'schedule' | 'completion';
}

/** `{ id, name, sourceId }` of a move destination list. */
export interface TaskMoveListRow {
  readonly id: string;
  readonly name: string;
  readonly sourceId: string;
}

/**
 * Optimistic claim on a source task. The claim token is carried separately
 * from `metadata` because releasing the claim has to *match* on it, and the
 * two dialects spell a JSON path predicate differently.
 */
export interface TaskMoveClaimRequest {
  readonly taskId: string;
  readonly expectedSourceId: string;
  readonly expectedSourceConnectorInstanceId: string;
  readonly expectedSyncStatus: string;
  readonly claimSyncStatus: string;
  readonly claimToken: string;
  readonly metadata: Record<string, unknown>;
}

export interface TaskMoveClaimReleaseRequest {
  readonly taskId: string;
  readonly claimToken: string;
  readonly syncStatus: string;
  readonly metadata: Record<string, unknown>;
}

/** One subtask copied alongside its parent during a `copy`. */
export interface TaskMoveSubtaskCopy {
  readonly task: TaskMoveTaskInsert;
  /** Tag/project/schedule rows are copied from this existing task id. */
  readonly copyFromTaskId: string;
  readonly attachments: readonly TaskAttachmentInsert[];
}

/**
 * Everything the destination side of a move/copy must write. It is one
 * atomic operation because a half-materialized destination is precisely the
 * state the caller's remote compensation cannot repair.
 */
export interface TaskMoveDestinationMaterialization {
  readonly task: TaskMoveTaskInsert;
  /** `task_tags` rows to attach to the new task. */
  readonly tagIds: readonly string[];
  /** When set, `task_projects` rows are copied from this task id. */
  readonly copyProjectsFromTaskId: string | null;
  /** Copied verbatim onto the new task id when present. */
  readonly schedule: TaskScheduleRow | null;
  readonly attachments: readonly TaskAttachmentInsert[];
  readonly subtaskCopies: readonly TaskMoveSubtaskCopy[];
}

/** How a subtask is repointed onto the successor during move finalization. */
export interface TaskMoveSubtaskRepoint {
  readonly taskId: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceListId: string | null;
  readonly sourceListName: string | null;
  readonly parentId: string;
  readonly updatedAt: string;
  readonly syncStatus: string;
  readonly lastSyncedAt: string;
  /** Replaces the subtask's attachments wholesale. */
  readonly attachments: readonly TaskAttachmentInsert[];
}

/**
 * What happens to the source row once the successor exists. `delete` is the
 * local-source case; `retain` keeps a tombstone carrying the durable
 * `pending_push`/`pendingCleanup` intent that the sync pipeline later acts on.
 */
export type TaskMoveSourceDisposition =
  | { readonly kind: 'delete' }
  | {
      readonly kind: 'retain';
      readonly status: string;
      readonly statusReason: string;
      readonly description: string;
      readonly updatedAt: string;
      readonly syncStatus: string;
      readonly metadata: Record<string, unknown>;
    };

export interface TaskMoveFinalizationRequest {
  readonly sourceTaskId: string;
  readonly successorTaskId: string;
  /** Optimistic guard: the claim token written by `claimTaskMove`. */
  readonly claimToken: string;
  /** Optimistic guard: the exact attachment set observed before the move. */
  readonly attachmentSnapshot: readonly TaskMoveAttachmentSnapshot[];
  readonly subtaskRepoints: readonly TaskMoveSubtaskRepoint[];
  readonly sourceDisposition: TaskMoveSourceDisposition;
}

export type TaskMoveFinalizationOutcome =
  | { readonly kind: 'finalized' }
  | { readonly kind: 'source-changed' };

/** Durable sync intent recorded on a retained source after remote disposal. */
export interface TaskMoveSourceSyncIntent {
  readonly taskId: string;
  readonly syncStatus: string;
  readonly metadata: Record<string, unknown>;
}

/** Provenance recorded on the source of a `copy` (the source is untouched). */
export interface TaskMoveCopyTarget {
  readonly taskId: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceListId: string;
  readonly copiedAt: string;
}

export interface TaskMoveSourceCopyProvenance {
  readonly taskId: string;
  readonly updatedAt: string;
  /**
   * Only the copy target is accepted here. The adapter merges it into the
   * current metadata atomically so stale caller snapshots cannot erase a
   * concurrent move claim or another independently-written metadata field.
   */
  readonly copiedTo: TaskMoveCopyTarget;
}

/**
 * The write-through ("create remotely, then rewrite locally") task move.
 *
 * Every method is a *narrow domain operation*: no transaction handle, no
 * callback, and no dialect ever crosses this boundary. Connector, network,
 * identity and semantic I/O all stay on the caller's side of it, which is
 * what lets each of the atomic operations below be a single transaction on
 * both backends.
 */
export interface WriteThroughTaskMoveRepository {
  /* reads */
  getTask(taskId: string): Promise<TaskMoveTaskRow | null>;
  listChildTasks(parentTaskId: string, limit: number): Promise<TaskMoveTaskRow[]>;
  listTaskTagRefs(taskId: string): Promise<TaskMoveTagRef[]>;
  listAttachmentMetadata(
    taskIds: readonly string[],
    limit: number,
  ): Promise<TaskAttachmentMetadataRow[]>;
  listAttachmentContents(
    attachmentIds: readonly string[],
  ): Promise<TaskAttachmentContentRow[]>;
  getTaskSchedule(taskId: string): Promise<TaskScheduleRow | null>;
  /**
   * Resolves a destination list by its connector-scoped source id only. The
   * write-through move deliberately does *not* accept a primary key here:
   * `targetSourceListId` is the connector's own list identifier.
   */
  findTargetListBySourceId(
    connectorInstanceId: string,
    sourceListId: string,
  ): Promise<TaskMoveListRow | null>;
  /**
   * Resolves the connector's default destination, falling back to its first
   * deterministically ordered source list for legacy callers that omit a list.
   */
  findDefaultTargetList(
    connectorInstanceId: string,
  ): Promise<TaskMoveListRow | null>;

  /* atomic operations */
  /** Optimistic claim. Resolves `false` when another writer got there first. */
  claimTaskMove(request: TaskMoveClaimRequest): Promise<boolean>;
  /** Idempotent: releasing an already-released or re-claimed task is a no-op. */
  releaseTaskMoveClaim(request: TaskMoveClaimReleaseRequest): Promise<void>;
  /** Compensating cleanup for a destination that was materialized but not finalized. */
  discardMaterializedDestination(taskId: string): Promise<void>;
  materializeDestination(
    request: TaskMoveDestinationMaterialization,
  ): Promise<void>;
  finalizeMove(
    request: TaskMoveFinalizationRequest,
  ): Promise<TaskMoveFinalizationOutcome>;
  recordSourceSyncIntent(request: TaskMoveSourceSyncIntent): Promise<void>;
  recordSourceCopyProvenance(
    request: TaskMoveSourceCopyProvenance,
  ): Promise<void>;
}

export interface PriorityEntityRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly referenceId: string | null;
  readonly description: string | null;
  readonly tier: string;
  readonly color: string;
  readonly rank: number;
  readonly activeTaskCount: number;
  readonly lastTouchedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriorityProjectReference {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string | null;
}

export interface PriorityTagReference {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly unifiedInto: string | null;
}

export interface PrioritySourceListReference {
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly userDisplayName: string | null;
  readonly color: string | null;
}

export interface PriorityEntityRepository {
  listPriorityEntitiesByRank(): Promise<PriorityEntityRow[]>;
  getProjectReference(projectId: string): Promise<PriorityProjectReference | null>;
  getTagReference(tagId: string): Promise<PriorityTagReference | null>;
  getSourceListReference(
    connectorInstanceId: string,
    sourceId: string,
  ): Promise<PrioritySourceListReference | null>;
  listProjectReferences(): Promise<PriorityProjectReference[]>;
  listTagReferences(): Promise<PriorityTagReference[]>;
  listSourceListReferences(): Promise<PrioritySourceListReference[]>;
}

export interface SourceListDisplayNameRow {
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly userDisplayName: string | null;
}

export interface SourceListNameRepository {
  listSourceListDisplayNames(
    sourceListIds: readonly string[],
  ): Promise<SourceListDisplayNameRow[]>;
}

/**
 * Narrow L04 repository backing the L06 external-identity transfer-identity
 * coordinator (`src/lib/connectors/transfer-identity.ts`). It is deliberately
 * limited to the two task-core reads/writes that coordinator needs: resolving
 * local source-list ids for a connector's source-list ids plus a task's
 * current metadata, and reconciling a task's fields after a transfer refresh.
 * External-identity persistence, evidence shaping, GitHub identity-mode
 * snapshots and all connector/network I/O stay entirely on the L06 side of
 * this boundary. This repository does **not** introduce a cross-domain
 * task+external-identity atomic bridge: the external-identity writes and the
 * `reconcileTaskRefresh` update below remain two separate operations from the
 * coordinator's point of view, exactly as they are today, and identity policy
 * continues to be owned by L06.
 */
export interface TaskTransferIdentityRepository {
  /**
   * Resolves the local source-list ids for `sourceListIds` (already scoped to
   * `connectorInstanceId`) alongside the task's current metadata. Unknown
   * source ids are silently omitted, duplicates are deduplicated, and the
   * returned order matches each id's first occurrence in `sourceListIds`.
   * When the task does not exist, `taskExists` is `false` and `taskMetadata`
   * is `{}`, but source-list resolution is unaffected and remains
   * deterministic.
   */
  resolveIdentityTargets(input: {
    taskId: string;
    connectorInstanceId: string;
    sourceListIds: readonly string[];
  }): Promise<{
    taskExists: boolean;
    taskMetadata: Record<string, unknown>;
    sourceLists: readonly { sourceId: string; localId: string }[];
  }>;
  /**
   * Merges the task's existing metadata with `task.metadata` (incoming wins
   * on key collisions) and updates exactly: `sourceId`, `sourceListId`,
   * `sourceListName`, `title`, `description`, `status`, `statusReason`,
   * `priority`, `effort`, `microStatus`, `assignee`, `updatedAt`,
   * `completedAt`, the merged `metadata`, `syncStatus` (set to `'synced'`)
   * and `lastSyncedAt` (set to `observedAt`) — guarded by `taskId` *and*
   * `connectorInstanceId` matching. Resolves `true` iff exactly one row was
   * updated; `false` when the task is absent or its `connectorInstanceId`
   * does not match (no update is made in that case).
   */
  reconcileTaskRefresh(input: {
    taskId: string;
    connectorInstanceId: string;
    task: {
      sourceId: string; sourceListId: string | null; sourceListName: string | null;
      title: string; description: string | null; status: string; statusReason: string | null;
      priority: string; effort: number | null; microStatus: string | null; assignee: string | null;
      updatedAt: string; completedAt: string | null; metadata: Record<string, unknown>;
    };
    observedAt: string;
  }): Promise<boolean>;
}

/**
 * The task-core composition (L04 core plus L05 endpoint reads). Adapters build this atomically:
 * either every member resolves for a backend or the backend registers
 * nothing, so there is never a half-migrated task-core surface.
 */
export interface TaskCorePersistence {
  readonly collections: TaskCollectionReadRepository;
  readonly details: TaskDetailReadRepository;
  readonly creates: TaskCreateRepository;
  readonly mutations: TaskMutationRepository;
  readonly removals: TaskRemovalRepository;
  readonly taskReads: TaskReadRepository;
  readonly filterInputs: TaskFilterInputRepository;
  readonly queries: TaskQueryRepository;
  readonly policyIdentities: TaskPolicyIdentityRepository;
  readonly lifecycle: LocalTaskLifecycleRepository;
  readonly scoutDeletion: ScoutTaskHardDeleteRepository;
  readonly moves: TaskMoveRepository;
  readonly writeThroughMoves: WriteThroughTaskMoveRepository;
  readonly priorityEntities: PriorityEntityRepository;
  readonly sourceListNames: SourceListNameRepository;
  readonly transferIdentity: TaskTransferIdentityRepository;
  readonly quickSort: TaskQuickSortPersistenceRepository;
}

/* ------------------------------------------------------------------ *
 * Shared validated-value helpers (pure)
 * ------------------------------------------------------------------ */

export const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'done',
  'cancelled',
];

export const TASK_PRIORITY_VALUES: readonly TaskPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
  'none',
];

export const TASK_PLANNING_HORIZON_VALUES = ['next', 'soon', 'later', 'someday'] as const;

export const TASK_LOCAL_DISPOSITION_VALUES: readonly LocalDisposition[] = [
  'active',
  'handled',
  'dismissed',
];

export const CLOSED_TASK_STATUSES: readonly string[] = ['done', 'cancelled'];

export const WAITING_MICRO_STATUSES: readonly string[] = [
  'waiting_on_someone',
  'blocked_external',
  'on_hold',
];

export const HIGH_PRIORITY_VALUES: readonly string[] = ['high', 'critical'];

/** Connector types whose tasks are always "assigned to me" by construction. */
export const SELF_ASSIGNED_CONNECTOR_TYPES: readonly string[] = [
  'microsoft-todo',
  'ms-todo',
  'local',
];
