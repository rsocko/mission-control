import type { PersistenceJson } from './contracts';

/**
 * Backend-neutral daily-planning/focus web persistence boundary.
 *
 * This capability owns every database read and write behind the energy,
 * Focus 3, My Day (including its Microsoft To Do reconciliation), schedule,
 * weekly one-thing, recent-win, mobile-dashboard and navigation-count web
 * surfaces, plus the exact day-plan, focus-suggestion, and energy-tag context
 * used by AI planning. It deliberately owns nothing else: request parsing,
 * scoring, model calls, rotation, response shaping, Microsoft To Do network
 * calls, the route-level single-flight map, edit-policy resolution, and
 * source-list display-name resolution all remain route-owned and are already
 * backend-neutral.
 *
 * Every operation is promise-based and carries only opaque IDs, local
 * `YYYY-MM-DD` dates, ISO instants, booleans, numeric counts, explicit nulls
 * and JSON-safe metadata. No Drizzle table, SQL fragment, transaction handle
 * or backend selector ever crosses it, and there is no generic CRUD or query
 * escape hatch.
 */

export type FocusScope = 'today' | 'week';

/**
 * The planning-signal observation a mutation must append inside its own
 * transaction. Adapters append it only when the mutation actually changed a
 * row and the affected row belongs to the `today` focus scope (My Day
 * mutations have no scope and always append). Historical/after-the-fact
 * observations stay on `WorkerPersistenceRepositories.planningSignals`.
 */
export interface PlanningSignalCommand {
  provenance: string;
  metadata: PersistenceJson;
}

// ─── Energy ─────────────────────────────────────────────────────────────────

export interface EnergyCheckinRecord {
  id: string;
  date: string;
  level: string;
  note: string | null;
  createdAt: string;
}

export interface EnergyPlanningRepository {
  getForDate(date: string): Promise<EnergyCheckinRecord | null>;
  /** Atomic date-keyed replace: at most one check-in survives per date. */
  replaceForDate(record: EnergyCheckinRecord): Promise<void>;
}

export type EnergyDemandLevel = 'high' | 'medium' | 'low';

export interface EnergySuggestionTask {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  connectorType: string;
}

export interface EnergyTagDefinition {
  slug: `energy-${EnergyDemandLevel}`;
  name: string;
  color: string;
}

export interface EnergySuggestionPersistence {
  listTasksByIds(
    taskIds: readonly string[],
    limit: number,
  ): Promise<EnergySuggestionTask[]>;
  listOpenTopLevelTasks(limit: number): Promise<EnergySuggestionTask[]>;
  listLevels(taskIds: readonly string[]): Promise<Array<{
    taskId: string;
    energyLevel: EnergyDemandLevel;
  }>>;
  apply(input: {
    definitions: readonly EnergyTagDefinition[];
    suggestions: ReadonlyArray<{
      taskId: string;
      energyLevel: EnergyDemandLevel;
    }>;
    createdAt: string;
  }): Promise<{
    canonicalTagIds: Partial<Record<EnergyTagDefinition['slug'], string>>;
    appliedTaskIds: string[];
  }>;
}

// ─── Focus 3 ────────────────────────────────────────────────────────────────

export interface FocusItemRecord {
  id: string;
  taskId: string;
  scope: FocusScope;
  date: string;
  slot: number;
  addedAt: string;
  isAiSuggested: boolean;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
}

export interface FocusBoardProjection {
  today: FocusItemRecord[];
  week: FocusItemRecord[];
}

export interface AddFocusItemCommand {
  id: string;
  taskId: string;
  scope: FocusScope;
  date: string;
  addedAt: string;
  isAiSuggested: boolean;
  maxSlots: number;
  signal: PlanningSignalCommand;
}

export type AddFocusItemResult =
  | { outcome: 'added'; id: string; slot: number }
  | { outcome: 'duplicate' }
  | { outcome: 'full' };

export interface RemoveFocusItemByIdCommand {
  id: string;
  removedAt: string;
  signal: PlanningSignalCommand;
}

export interface RemoveFocusItemByTaskCommand {
  taskId: string;
  scope: FocusScope;
  date: string;
  removedAt: string;
  signal: PlanningSignalCommand;
}

export interface FocusPlanningRepository {
  listBoard(input: { date: string; weekMonday: string }): Promise<FocusBoardProjection>;
  /**
   * Serializes the `(scope, date)` namespace so capacity, duplicate detection,
   * slot allocation, the insert and the commitment signal are one atomic unit.
   */
  add(command: AddFocusItemCommand): Promise<AddFocusItemResult>;
  removeById(command: RemoveFocusItemByIdCommand): Promise<{ removed: boolean }>;
  removeByTask(command: RemoveFocusItemByTaskCommand): Promise<{ removed: boolean }>;
  /** Serialized slot move; an occupied target slot is swapped, never rejected. */
  moveToSlot(command: { id: string; slot: number }): Promise<{ outcome: 'moved' | 'not-found' }>;
  getSuggestionContext(input: {
    scope: FocusScope;
    date: string;
    effectiveDate: string;
    taskLimit: number;
  }): Promise<{
    focusTaskIds: string[];
    myDayTaskIds: string[];
    tasks: FocusSuggestionTask[];
  }>;
}

export interface FocusSuggestionTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  createdAt: string;
  updatedAt: string;
  depth: number;
}

// ─── Mobile dashboard ───────────────────────────────────────────────────────

export interface MobileDashboardQuery {
  /** Overdue boundary for the "today" summary (the requested date). */
  overdueBefore: string;
  /** Overdue boundary for the queue counts (always the server's local today). */
  queueOverdueBefore: string;
  completedFrom: string;
  completedTo: string;
  recentActivityLimit: number;
}

export interface MobileDashboardActivityRecord {
  id: string;
  title: string;
  completedAt: string | null;
}

export interface MobileDashboardProjection {
  totalOpen: number;
  completedToday: number;
  inProgress: number;
  overdue: number;
  queues: { triage: number; sort: number; overdue: number };
  recentActivity: MobileDashboardActivityRecord[];
}

export interface MobileDashboardRepository {
  snapshot(query: MobileDashboardQuery): Promise<MobileDashboardProjection>;
}

// ─── Navigation counts ──────────────────────────────────────────────────────

export interface NavigationNotificationCounts {
  attention: number;
  unread: number;
  urgent: number;
  actionNeeded: number;
  headsUp: number;
  fyi: number;
}

/**
 * The complete persistence projection behind `NavigationCounts`. The
 * notification, triage and Scout reconciliation members are read-only counts
 * of those domains; publishing them here preserves the existing single-request
 * payload without changing or re-exporting any excluded domain contract.
 */
export interface NavigationCountsProjection {
  myDay: number;
  triage: number;
  quickSort: number;
  reconciliation: number;
  overdue: number;
  notifications: NavigationNotificationCounts;
}

export interface NavigationCountsRepository {
  counts(query: { date: string; now: string }): Promise<NavigationCountsProjection>;
}

// ─── My Day ─────────────────────────────────────────────────────────────────

export interface MyDayTagRecord {
  id: string;
  name: string;
  slug: string;
  type: string;
  color: string | null;
}

export interface MyDayPhaseMembershipRecord {
  projectId: string;
  phaseId: string;
  phaseName: string;
}

/** A candidate task row shared by every suggestion group. */
export interface MyDaySuggestionRecord {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  pushCount: number;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  metadata: PersistenceJson;
  localDisposition: string;
}

export interface MyDayItemRecord {
  /** The My Day row ID, not the task ID. */
  id: string;
  taskId: string;
  order: number;
  isAutoIncluded: boolean;
  addedAt: string;
  title: string;
  hasDescription: boolean;
  status: string;
  statusReason: string | null;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  pushCount: number;
  connectorType: string;
  connectorInstanceId: string;
  syncStatus: string;
  pushRetryCount: number;
  sourceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  assignee: string | null;
  createdAt: string;
  completedAt: string | null;
  metadata: PersistenceJson;
  effort: number | null;
  microStatus: string | null;
  localDisposition: string;
  tags: MyDayTagRecord[];
  subtaskTotal: number;
  subtaskDone: number;
  hubProjectIds: string[];
  projectPhases: MyDayPhaseMembershipRecord[];
  estimatedDuration: number | null;
}

export interface MyDaySignalledSuggestionRecord extends MyDaySuggestionRecord {
  planningSignalCount: number;
}

export interface MyDaySuggestionGroups {
  planningSignals: MyDaySignalledSuggestionRecord[];
  planningNext: MyDaySuggestionRecord[];
  yesterday: MyDaySuggestionRecord[];
  overdue: MyDaySuggestionRecord[];
  dueToday: MyDaySuggestionRecord[];
  dueThisWeek: MyDaySuggestionRecord[];
  highPriority: MyDaySuggestionRecord[];
  aiRecommended: MyDaySuggestionRecord[];
  recentlyAdded: MyDaySuggestionRecord[];
  carriedForward: MyDaySuggestionRecord[];
  repeatedlyRescheduled: MyDaySuggestionRecord[];
}

export interface MyDayDayViewQuery {
  date: string;
  yesterday: string;
  /** Inclusive upper bound of the "due this week" group. */
  dueThrough: string;
  /** Lower bound for the recently-updated and recently-created groups. */
  activitySince: string;
  /** Lower bound for the planning-friction observation window. */
  frictionSince: string;
  frictionEventTypes: readonly string[];
  /** Minimum number of My Day appearances for the carried-forward group. */
  carriedForwardMinimum: number;
  suggestionLimit: number;
}

export interface MyDayDayViewProjection {
  items: MyDayItemRecord[];
  suggestions: MyDaySuggestionGroups;
}

export type MyDayAutoIncludeResult =
  | { outcome: 'applied'; inserted: number }
  | { outcome: 'noop' }
  | { outcome: 'skipped-write-contention' };

export interface AddMyDayItemCommand {
  id: string;
  taskId: string;
  date: string;
  addedAt: string;
  signal: PlanningSignalCommand;
}

export type AddMyDayItemResult =
  | { outcome: 'added'; id: string; order: number }
  | { outcome: 'exists'; id: string };

export interface RemoveMyDayItemCommand {
  itemId: string | null;
  taskId: string | null;
  /** Fallback date when the removal is addressed by task rather than item ID. */
  date: string;
  removedAt: string;
  exclusionId: string;
  signal: PlanningSignalCommand;
}

export interface MyDayRemoteIdentity {
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
}

export interface MyDayPlanningRepository {
  dayView(query: MyDayDayViewQuery): Promise<MyDayDayViewProjection>;
  /**
   * Best-effort auto-inclusion of the date's completed tasks. Resolves
   * `skipped-write-contention` instead of throwing when the local database is
   * write-contended, preserving the existing fail-soft read behavior.
   */
  includeCompletedTasks(command: {
    date: string;
    dayStart: string;
    nextDayStart: string;
  }): Promise<MyDayAutoIncludeResult>;
  /**
   * Validates the complete visible ID set and rewrites the full
   * visible-plus-hidden order in one serialized transaction. A stale or
   * partial set resolves `stale` and changes nothing.
   */
  replaceOrder(command: {
    date: string;
    orderedItemIds: readonly string[];
  }): Promise<{ outcome: 'saved' | 'stale' }>;
  add(command: AddMyDayItemCommand): Promise<AddMyDayItemResult>;
  /**
   * Deletes the row, records the date exclusion idempotently and appends the
   * withdrawal signal atomically. Resolves the task ID the caller should write
   * back to Microsoft To Do, which is the requested task ID even when no row
   * was present.
   */
  remove(command: RemoveMyDayItemCommand): Promise<{ taskId: string | null }>;
  getRemoteIdentity(taskId: string): Promise<MyDayRemoteIdentity | null>;
}

// ─── My Day reconciliation (Microsoft To Do) ────────────────────────────────

export interface MyDaySyncLocalItem {
  id: string;
  taskId: string;
  sourceId: string | null;
  isAutoIncluded: boolean;
  status: string;
  completedAt: string | null;
}

export interface MyDaySyncRecurringHistoryRecord {
  title: string;
  sourceListId: string | null;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  metadata: PersistenceJson;
}

export interface MyDaySyncSnapshot {
  localItems: MyDaySyncLocalItem[];
  excludedTaskIds: string[];
  recurringHistory: MyDaySyncRecurringHistoryRecord[];
  archivedDuplicateSourceIds: string[];
}

export interface MyDaySyncLocalTask {
  id: string;
  sourceId: string;
  metadata: PersistenceJson;
  status: string;
}

export interface MyDaySyncCompletedSibling {
  sourceListId: string | null;
  title: string;
  completedAt: string | null;
  metadata: PersistenceJson;
}

export interface MyDayRowInsert {
  id: string;
  taskId: string;
  date: string;
  addedAt: string;
  isAutoIncluded: boolean;
  order: number;
}

export type MyDaySyncRowInsert = Omit<MyDayRowInsert, 'order'>;

export interface CreateMyDaySyncTaskCommand {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  title: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string;
  sourceListId: string | null;
}

export interface MyDaySyncRepository {
  /**
   * The bounded local reconciliation snapshot: today's My Day rows, the
   * user-excluded task IDs, the connector's top-level recurrence history and
   * the source IDs archived as duplicate recurrences.
   */
  snapshot(input: {
    date: string;
    connectorInstanceId: string;
    archivedDuplicateReasonPrefix: string;
  }): Promise<MyDaySyncSnapshot>;
  /** Batched source-identity lookup; the adapter owns the batch size. */
  findTasksBySourceIds(input: {
    connectorType: string | null;
    connectorInstanceId: string;
    sourceIds: readonly string[];
  }): Promise<MyDaySyncLocalTask[]>;
  listCompletedMyDaySiblings(input: {
    connectorInstanceId: string;
    date: string;
  }): Promise<MyDaySyncCompletedSibling[]>;
  /** Conflict-safe task creation; `created` is false when the row already existed. */
  createTaskFromRemote(
    command: CreateMyDaySyncTaskCommand,
  ): Promise<{ created: boolean; task: MyDaySyncLocalTask | null }>;
  /** Applies one date's row changes, order allocation, and signals atomically. */
  applyReconciliation(command: {
    date: string;
    committedRows: readonly MyDaySyncRowInsert[];
    autoIncludedRows: readonly MyDaySyncRowInsert[];
    removeItemIds: readonly string[];
    removedAt: string;
    signal: PlanningSignalCommand;
  }): Promise<{ added: number; dueTodayAdded: number; removed: number }>;
  /** Open, due-today task IDs for a connector type, used to keep local rows. */
  listOpenDueTodayTaskIds(input: { connectorType: string; date: string }): Promise<string[]>;
  listOpenDueTodayTasks(input: {
    connectorType: string;
    connectorInstanceId: string;
    date: string;
  }): Promise<Array<{ id: string; sourceId: string | null; status: string }>>;
  listMyDayTaskIds(date: string): Promise<string[]>;
  resolveTaskIdsBySourceIds(input: {
    connectorInstanceId: string;
    sourceIds: readonly string[];
  }): Promise<Array<{ id: string; sourceId: string }>>;
}

// ─── Weekly one thing ───────────────────────────────────────────────────────

export interface WeeklyOneThingRecord {
  id: string;
  taskId: string;
  weekMonday: string;
  isManualOverride: boolean;
  completedAt: string | null;
  createdAt: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
}

export interface WeeklyOneThingCandidate {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  updatedAt: string;
  depth: number;
}

export interface SelectWeeklyOneThingCommand {
  id: string;
  taskId: string;
  weekMonday: string;
  createdAt: string;
}

export interface WeeklyOneThingRepository {
  getForWeek(weekMonday: string): Promise<WeeklyOneThingRecord | null>;
  /** Idempotent completion stamp. */
  markCompleted(command: { id: string; completedAt: string }): Promise<void>;
  subtaskProgress(taskId: string): Promise<{ total: number; done: number }>;
  listCandidates(limit: number): Promise<WeeklyOneThingCandidate[]>;
  listMyDayTaskIds(date: string): Promise<string[]>;
  /**
   * Serializes the week namespace: an auto-selection never overwrites, or
   * duplicates, a selection another writer already made for the week.
   */
  selectAuto(
    command: SelectWeeklyOneThingCommand,
  ): Promise<{ outcome: 'selected' | 'existing' }>;
  /** Serialized manual override; resolves `task-not-found` for an unknown task. */
  selectManual(
    command: SelectWeeklyOneThingCommand,
  ): Promise<{ outcome: 'selected' | 'task-not-found' }>;
  clearForWeek(weekMonday: string): Promise<void>;
}

// ─── Schedule ───────────────────────────────────────────────────────────────

export interface ScheduledTaskRecord {
  taskId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  estimatedDuration: number | null;
  isTimeBlocked: boolean;
  recurrence: string | null;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
}

export interface UpsertTaskScheduleCommand {
  taskId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  estimatedDuration: number | null;
  isTimeBlocked: boolean;
  recurrence: string | null;
}

export interface TaskSchedulePlanningRepository {
  listForDate(date: string): Promise<ScheduledTaskRecord[]>;
  /** Primary-key upsert; no read-before-write transaction is required. */
  upsert(command: UpsertTaskScheduleCommand): Promise<void>;
  remove(taskId: string): Promise<void>;
}

export interface DayPlanTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
}

export interface DayPlanSchedule {
  taskId: string;
  scheduledTime: string | null;
  estimatedDuration: number | null;
}

export interface DayPlanContextRepository {
  getContext(input: {
    date: string;
    openTaskLimit: number;
  }): Promise<{
    myDayItems: DayPlanTask[];
    schedules: DayPlanSchedule[];
    openTasks: DayPlanTask[];
  }>;
}

// ─── Recent wins ────────────────────────────────────────────────────────────

export interface RecentWinRecord {
  id: string;
  title: string;
  priority: string;
  completedAt: string | null;
  connectorType: string;
  sourceListName: string | null;
  dueDate: string | null;
  recurrence: string | null;
}

export interface RecentWinsRepository {
  /**
   * Recent completions newest-first. Snooze and deprioritized-list values are
   * deliberately absent: they live on the existing core settings repository.
   */
  listRecentCompletions(input: { completedFrom: string }): Promise<RecentWinRecord[]>;
}

// ─── Capability ─────────────────────────────────────────────────────────────

export interface DailyPlanningPersistence {
  energy: EnergyPlanningRepository;
  energySuggestions: EnergySuggestionPersistence;
  focus: FocusPlanningRepository;
  dashboard: MobileDashboardRepository;
  navigation: NavigationCountsRepository;
  myDay: MyDayPlanningRepository;
  myDaySync: MyDaySyncRepository;
  oneThing: WeeklyOneThingRepository;
  schedule: TaskSchedulePlanningRepository;
  dayPlan: DayPlanContextRepository;
  recentWins: RecentWinsRepository;
}

declare module './worker-repositories' {
  interface WorkerPersistenceRepositories {
    /**
     * The complete daily-planning/focus web capability is selected atomically
     * with the rest of the worker persistence composition.
     */
    dailyPlanning?: DailyPlanningPersistence;
  }
}
