import type { FlowHistoryEventInput, FlowTaskInput } from '@/lib/stats/flow';

/**
 * Backend-neutral derived-analytics read boundary (L17).
 *
 * Every module behind this contract is read-only: the stats engine, the
 * insights query layer, the flow query, and the tag/word insight services never
 * write, so the contract carries no command, revision, idempotency key, or
 * transaction concept at all.
 *
 * The contract is aggregate-shaped rather than row-dumping: every `count(*)`,
 * `GROUP BY`, `DISTINCT`, window function, and `LIMIT` that runs in SQL today
 * keeps running in SQL, and every reducer that runs in TypeScript today keeps
 * running in TypeScript. Only opaque string IDs, ISO-8601 timestamp strings,
 * local `YYYY-MM-DD` date strings, numbers, booleans, and the plain record
 * types declared below ever cross it. No driver, pool, transaction, SQL
 * fragment, Drizzle table, or backend selector does.
 */

/** A local calendar date, `YYYY-MM-DD`. */
export type AnalyticsLocalDate = string;
/** An absolute instant serialized as an ISO-8601 timestamp. */
export type AnalyticsInstant = string;

/**
 * A half-open instant range, `[startInclusive, endExclusive)`. Callers resolve
 * local-calendar boundaries to instants before crossing the contract, so both
 * backends receive byte-identical bounds and neither adapter owns any timezone
 * policy.
 */
export interface AnalyticsInstantRange {
  startInclusive: AnalyticsInstant;
  endExclusive: AnalyticsInstant;
}

/** An inclusive local-date range, `[from, to]`, compared as stored text. */
export interface AnalyticsLocalDateRange {
  from: AnalyticsLocalDate;
  to: AnalyticsLocalDate;
}

export interface AnalyticsRoutine {
  id: string;
  name: string;
  icon: string | null;
  cadenceType: string;
  cadenceConfig: unknown;
}

export interface AnalyticsRoutineCompletion {
  routineId: string;
  date: AnalyticsLocalDate;
}

export interface AnalyticsRoutineCompletionCount {
  date: AnalyticsLocalDate;
  count: number;
}

export interface AnalyticsFocusItemStatus {
  id: string;
  status: string;
}

export interface AnalyticsSourceCount {
  source: string;
  count: number;
}

export interface AnalyticsProject {
  id: string;
  name: string;
  color: string;
}

export interface AnalyticsFilterOptions {
  projects: Array<{ value: string; label: string }>;
  sources: string[];
}

export interface AnalyticsCompletionSpan {
  createdAt: AnalyticsInstant;
  completedAt: AnalyticsInstant | null;
}

export interface AnalyticsPlanningFrictionEvent {
  taskId: string;
  eventType: string;
  previousValue: string | null;
  newValue: string | null;
  title: string;
  dueDate: string | null;
  pushCount: number;
  sourceListName: string | null;
}

export interface AnalyticsTaskTagName {
  taskId: string;
  name: string;
}

export interface AnalyticsDeliveryRecord {
  id: string;
  title: string;
  createdAt: AnalyticsInstant;
  completedAt: AnalyticsInstant | null;
  source: string;
  statusReason: string | null;
}

export interface AnalyticsDeliveryFilter {
  projectId?: string;
  source?: string;
}

/** The flow task projection, before per-task project membership is attached. */
export type AnalyticsFlowTask = Omit<FlowTaskInput, 'projectIds'>;

export interface AnalyticsTaskProjectMembership {
  taskId: string;
  projectId: string;
}

export type AnalyticsTaskTransition = FlowHistoryEventInput;

export interface AnalyticsTag {
  id: string;
  name: string;
}

export interface AnalyticsTagUsage {
  id: string;
  name: string;
  color: string | null;
  usageCount: number;
}

export interface AnalyticsTaggedTask {
  id: string;
  title: string;
  status: string;
}

export interface AnalyticsTaskTagLink {
  taskId: string;
  tagId: string;
}

export interface AnalyticsWordInsightTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  sourceListId: string | null;
  sourceListName: string | null;
}

export interface AnalyticsRankedTaskValue {
  taskId: string;
  id: string;
  name: string;
}

/**
 * Dashboard/reset KPI reads. `countOpen*` methods all share the same base
 * predicate (`status NOT IN ('done', 'cancelled')`).
 */
export interface KpiAnalyticsRepository {
  countOpenTasks(): Promise<number>;
  countOpenTasksDueBefore(date: AnalyticsLocalDate): Promise<number>;
  countOpenTasksDueBetween(range: AnalyticsLocalDateRange): Promise<number>;
  countOpenTasksInIds(taskIds: readonly string[]): Promise<number>;
  countOpenTasksWithPriorities(priorities: readonly string[]): Promise<number>;
  countOpenTasksWithAssignee(): Promise<number>;
  countOpenTasksByConnectorType(connectorType: string): Promise<number>;
  /** Uses the shared notification "needs attention" lifecycle predicate. */
  countNotificationsNeedingAttention(): Promise<number>;
  countNotificationsNeedingAttentionInCategory(
    connectorType: string,
    category: string,
  ): Promise<number>;
  listMyDayTaskIds(date: AnalyticsLocalDate): Promise<string[]>;
  countTasksCompletedIn(range: AnalyticsInstantRange): Promise<number>;
  countNonCancelledTasksDueBetween(range: AnalyticsLocalDateRange): Promise<number>;
  listActiveRoutines(): Promise<AnalyticsRoutine[]>;
  listRoutineCompletionsBetween(
    range: AnalyticsLocalDateRange,
  ): Promise<AnalyticsRoutineCompletion[]>;
  listCompletedTimestampsSince(
    startInclusive: AnalyticsInstant,
  ): Promise<Array<AnalyticsInstant | null>>;
  listFocusItemStatuses(
    scope: string,
    date: AnalyticsLocalDate,
  ): Promise<AnalyticsFocusItemStatus[]>;
  countTriageItemsWithStatus(status: string): Promise<number>;
  countTriageItemsWithStatusCapturedBefore(
    status: string,
    capturedBefore: AnalyticsInstant,
  ): Promise<number>;
}

/** Period-based aggregate reads for the `/insights` surface. */
export interface InsightsAnalyticsRepository {
  countTasksCompletedIn(range: AnalyticsInstantRange): Promise<number>;
  countTopLevelTasksCreatedIn(range: AnalyticsInstantRange): Promise<number>;
  listCompletedTimestampsIn(
    range: AnalyticsInstantRange,
  ): Promise<Array<AnalyticsInstant | null>>;
  listCreatedTimestampsIn(range: AnalyticsInstantRange): Promise<AnalyticsInstant[]>;
  listCompletionSpansIn(range: AnalyticsInstantRange): Promise<AnalyticsCompletionSpan[]>;
  listCompletedTimestampsSince(
    startInclusive: AnalyticsInstant,
  ): Promise<Array<AnalyticsInstant | null>>;
  sourceBreakdownIn(range: AnalyticsInstantRange): Promise<AnalyticsSourceCount[]>;
  listOpenTaskCreatedTimestamps(): Promise<AnalyticsInstant[]>;
  listPlanningFrictionEvents(
    eventTypes: readonly string[],
    range: AnalyticsInstantRange,
  ): Promise<AnalyticsPlanningFrictionEvent[]>;
  listTaskTagNames(taskIds: readonly string[]): Promise<AnalyticsTaskTagName[]>;
  listActiveProjects(): Promise<AnalyticsProject[]>;
  countProjectTasksCompletedIn(projectId: string, range: AnalyticsInstantRange): Promise<number>;
  countProjectOpenTasks(projectId: string): Promise<number>;
  countProjectTopLevelTasksCreatedIn(
    projectId: string,
    range: AnalyticsInstantRange,
  ): Promise<number>;
  listActiveRoutines(): Promise<AnalyticsRoutine[]>;
  listRoutineCompletionsBetween(
    range: AnalyticsLocalDateRange,
  ): Promise<AnalyticsRoutineCompletion[]>;
  listRoutineCompletionsInHalfOpenRange(
    fromInclusive: AnalyticsLocalDate,
    toExclusive: AnalyticsLocalDate,
  ): Promise<AnalyticsRoutineCompletion[]>;
  countRoutineCompletionsByDate(
    range: AnalyticsLocalDateRange,
  ): Promise<AnalyticsRoutineCompletionCount[]>;
  deliveryFilterOptions(): Promise<AnalyticsFilterOptions>;
  listDeliveryRecords(
    range: AnalyticsInstantRange,
    filters: AnalyticsDeliveryFilter,
  ): Promise<AnalyticsDeliveryRecord[]>;
}

/** Cumulative-flow inputs. */
export interface FlowAnalyticsRepository {
  listFlowTasks(): Promise<AnalyticsFlowTask[]>;
  listTaskProjectMemberships(): Promise<AnalyticsTaskProjectMembership[]>;
  listVisibleProjects(): Promise<AnalyticsProject[]>;
  listTaskTransitions(
    range: AnalyticsInstantRange,
    eventTypes: readonly string[],
  ): Promise<AnalyticsTaskTransition[]>;
}

/** Tag co-occurrence inputs. */
export interface TagInsightsAnalyticsRepository {
  /**
   * Tags whose normalized name matches any synthetic-tag naming pattern. The
   * authoritative synthetic classification stays in TypeScript; this narrows
   * the candidate set only.
   */
  listSyntheticTagCandidates(): Promise<AnalyticsTag[]>;
  listBoundedTaggedTasks(
    excludedTagIds: readonly string[],
    limit: number,
  ): Promise<AnalyticsTaggedTask[]>;
  listTopTags(
    taskIds: readonly string[],
    excludedTagIds: readonly string[],
    topN: number,
  ): Promise<AnalyticsTagUsage[]>;
  listTaskTagLinks(
    taskIds: readonly string[],
    tagIds: readonly string[],
  ): Promise<AnalyticsTaskTagLink[]>;
}

/** Word-frequency inputs, bounded per source per task by a window rank. */
export interface WordInsightsAnalyticsRepository {
  listTasksWithLiveConnector(limit: number): Promise<AnalyticsWordInsightTask[]>;
  listRankedTaskTags(
    taskIds: readonly string[],
    perTaskLimit: number,
    limit: number,
  ): Promise<AnalyticsRankedTaskValue[]>;
  listRankedTaskProjects(
    taskIds: readonly string[],
    perTaskLimit: number,
    limit: number,
  ): Promise<AnalyticsRankedTaskValue[]>;
  listRankedTaskPhases(
    taskIds: readonly string[],
    perTaskLimit: number,
    limit: number,
  ): Promise<AnalyticsRankedTaskValue[]>;
}

/**
 * The composed derived-analytics slot. Published as one top-level slot on
 * `WorkerPersistenceRepositories` (rather than nested under an existing slot)
 * because these read models share no rows and no serialization namespace with
 * any other worker surface, and grouped into one slot (rather than five
 * top-level slots) because they are registered atomically: a backend supports
 * every analytics surface or none.
 */
export interface AnalyticsPersistence {
  kpis: KpiAnalyticsRepository;
  insights: InsightsAnalyticsRepository;
  flow: FlowAnalyticsRepository;
  tagInsights: TagInsightsAnalyticsRepository;
  wordInsights: WordInsightsAnalyticsRepository;
}
