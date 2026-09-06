/**
 * Backend-neutral persistence used by the synchronous AI workflow routes.
 *
 * The surface is intentionally use-case shaped. It exposes only bounded or
 * aggregate domain reads; no SQL, transaction, table, or database handle
 * crosses this boundary.
 */

import type { WorkerPersistenceRepositories } from './worker-repositories';

export interface AIContextTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export interface AIDigestTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
}

export interface AIDigestSnapshot {
  counts: {
    open: number;
    overdue: number;
    dueToday: number;
    inProgress: number;
    critical: number;
    unreadNotifications: number;
    urgentNotifications: number;
  };
  overdue: AIDigestTask[];
  dueToday: AIDigestTask[];
  inProgress: AIDigestTask[];
  notifications: Array<{
    id: string;
    title: string;
    level: string;
    connectorType: string;
  }>;
  sources: string[];
  rowCount: number;
}

export interface NotificationClassificationRow {
  id: string;
  title: string;
  level: string;
  category: string;
  isActionable: boolean;
  connectorType: string;
  receivedAt: string;
}

export interface AssignmentProject {
  id: string;
  name: string;
  description: string | null;
}

export interface AssignmentTask {
  id: string;
  title: string;
  connectorType: string;
  sourceListName: string | null;
}

export type TagInferenceTask = AssignmentTask;

export interface SmartPriorityTask extends AssignmentTask {
  priority: string;
  dueDate: string | null;
  updatedAt: string;
}

export interface MicroStatusTask {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  connectorType: string;
  assignee: string | null;
}

export interface TaskBreakdownContext {
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    dueDate: string | null;
    effort: number | null;
    sourceListName: string | null;
    connectorType: string;
    updatedAt: string;
  };
  tagNames: string[];
  projectNames: string[];
  subtaskTitles: string[];
}

export interface WhatsNextTask extends AssignmentTask {
  priority: string;
  dueDate: string | null;
}

export interface AIWorkflowContextPersistence {
  listTaskContext(): Promise<AIContextTask[]>;
  getTriageContext(now: string): Promise<{
    unreadCount: number;
    criticalCount: number;
    categories: string[];
  }>;
  loadDigestSnapshot(input: {
    today: string;
    now: string;
    rowsPerCategory: number;
  }): Promise<AIDigestSnapshot>;
}

/** Why a task earned a place in the suggested day plan. */
export type DayPlanSuggestionReason = 'overdue' | 'due-today' | 'priority';

export interface DayPlanSuggestion {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  reason: DayPlanSuggestionReason;
}

export interface DayPlanSuggestionSnapshot {
  /** At most `limit` rows, ordered overdue → due today → critical → high. */
  suggestions: DayPlanSuggestion[];
  /** Exact aggregates over every open task, independent of the row bound. */
  counts: {
    open: number;
    overdue: number;
    dueToday: number;
  };
}

export interface AIDayPlanPersistence {
  /**
   * Bounded day-plan read: the adapter selects only the actual
   * priority/due-date candidates (never a truncated prefix of all open tasks)
   * and returns exact aggregate counts alongside them.
   */
  listSuggestions(input: {
    today: string;
    limit: number;
  }): Promise<DayPlanSuggestionSnapshot>;
}

export interface AIWorkflowRecommendationPersistence {
  listAssignmentProjects(): Promise<AssignmentProject[]>;
  listAssignmentTasks(limit: number): Promise<AssignmentTask[]>;
  listTagInferenceTasks(limit: number): Promise<TagInferenceTask[]>;
  listTaggedTaskIds(): Promise<string[]>;
  listAvailableTagNames(): Promise<string[]>;
  listSmartPriorityTasks(limit: number): Promise<SmartPriorityTask[]>;
  listMicroStatusTasks(limit: number): Promise<MicroStatusTask[]>;
  listWhatsNextTasks(limit: number): Promise<WhatsNextTask[]>;
  listWhatsNextNotifications(now: string, limit: number): Promise<Array<{
    connectorType: string;
  }>>;
}

// ─── Task tools (Houston chat bounded task reads) ──────────────────────────

export interface TaskToolsOverdueItem {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  dueDate: string | null;
  priority: string;
  source: string;
}

export interface TaskToolsSummary {
  total: number;
  open: number;
  overdue: number;
  critical: number;
  done: number;
  bySource: Record<string, number>;
  overdueItems: TaskToolsOverdueItem[];
}

export interface TaskToolsSearchFilters {
  query?: string;
  status?: string;
  priority?: string;
  source?: string;
  limit: number;
}

export interface TaskToolsSearchResult {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  dueDate: string | null;
  source: string;
  sourceList: string | null;
  description: string | null;
}

export interface TaskToolsTag {
  id: string;
  name: string;
  type: string;
  color: string | null;
}

export interface AITaskToolsPersistence {
  getSummary(input: { today: string; overdueLimit: number }): Promise<TaskToolsSummary>;
  search(filters: TaskToolsSearchFilters): Promise<TaskToolsSearchResult[]>;
  listAllTags(): Promise<TaskToolsTag[]>;
  listTaskTags(taskId: string): Promise<TaskToolsTag[]>;
}

// ─── Dispatch (bounded custom-agent context) ───────────────────────────────

export interface DispatchContextTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
}

export interface DispatchContextNotification {
  id: string;
  title: string;
  level: string;
  connectorType: string;
}

export interface AIDispatchPersistence {
  getCustomAgentContext(input: {
    taskLimit: number;
    notificationLimit: number;
  }): Promise<{
    openTasks: DispatchContextTask[];
    unreadNotifications: DispatchContextNotification[];
  }>;
}

// ─── Maintenance agents (typed scan/claim/checkpoint/apply) ───────────────

export type MaintenanceAgentType =
  | 'dismiss-old-notifications'
  | 'bulk-prioritize'
  | 'cleanup-done'
  | 'snooze-low-priority';

export type MaintenanceAgentRunStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface MaintenanceScanCandidate {
  id: string;
  title: string;
  eligible: boolean;
  result?: string;
}

export interface MaintenanceClaimResult {
  claimed: boolean;
  /** The checkpoint the claim resumed from (resolved server-side when the caller omitted one). */
  cursor: string | null;
}

export interface MaintenanceCommitResult {
  /**
   * Rows that were still eligible when the mutation ran and were therefore
   * actually changed. Always `0` for dry runs and failure commits (which pass
   * no ids), so callers must never report the scan's candidate count as work
   * performed.
   */
  applied: number;
  /**
   * The exact ids of those rows, so callers can report per-row detail without
   * naming a candidate the mutation skipped. Always a subset of the requested
   * `ids`, and always empty when `applied` is `0`. Order is unspecified —
   * callers that need a stable order must impose their own.
   */
  appliedIds: string[];
}

export interface AIMaintenancePersistence {
  /**
   * Atomically expires stale leases, resolves a resume checkpoint (when the
   * caller did not supply one and this is not a dry run), and claims the run
   * by inserting its `running` row. Serialized per `agentType` so only one
   * live run — and one resume-checkpoint resolution — proceeds at a time.
   */
  claimRun(input: {
    runId: string;
    agentType: MaintenanceAgentType;
    dryRun: boolean;
    cursor: string | null;
    leaseExpiresAt: string;
    startedAt: string;
  }): Promise<MaintenanceClaimResult>;
  scanBatch(input: {
    agentType: MaintenanceAgentType;
    cursor: string | null;
    limit: number;
    now: string;
  }): Promise<MaintenanceScanCandidate[]>;
  /**
   * Atomically applies the batch's mutations (when `ids` is non-empty) and
   * records the run's terminal checkpoint in one transaction, so a guard
   * check that fires after the mutation but before the run is marked
   * complete rolls the mutation back too — matching the single-transaction
   * safety the prior SQLite-only implementation relied on. `guard`, when
   * given, is invoked once after mutating and before the commit; throwing
   * from it aborts the whole batch.
   *
   * The adapter re-applies the agent's eligibility predicate inside the
   * mutating statement, so rows that stopped being eligible between the scan
   * and the commit are left untouched, and records/returns both the number of
   * rows it actually changed and their exact ids.
   */
  commitBatch(input: {
    runId: string;
    agentType: MaintenanceAgentType;
    ids: readonly string[];
    /** The scan's reference instant, so date-threshold math (e.g. "due in 7 days") matches the scan exactly. */
    now: string;
    /** The instant written into `updated_at`/`read_at`/etc. columns. */
    completedAt: string;
    status: MaintenanceAgentRunStatus;
    checkpoint: string | null;
    scanned: number;
    hasMore: boolean;
    error?: string;
    guard?: () => void;
  }): Promise<MaintenanceCommitResult>;
}

// ─── Goals board (list + adapter-owned atomic promotion) ──────────────────

export interface GoalMilestoneRow {
  id: string;
  name: string;
  targetDate: string | null;
  completed: boolean;
}

export interface GoalLinkedProjectRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  totalTasks: number;
  doneTasks: number;
  milestones: GoalMilestoneRow[];
}

export interface GoalTagRow {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  type: string;
}

export interface GoalTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  connectorType: string;
  tags: GoalTagRow[];
  linkedProjects: GoalLinkedProjectRow[];
}

export interface GoalsBoardCounts {
  goal: number;
  idea: number;
  brainstorm: number;
}

export interface GoalPromotionPhaseInput {
  name: string;
  description: string | null;
  tasks: Array<{ title: string; description: string | null }>;
}

export type GoalPromotionOutcome =
  | { kind: 'not-found' }
  | {
      kind: 'promoted';
      projectId: string;
      tasksCreated: string[];
    };

export interface AIGoalsBoardPersistence {
  listGoalTasks(input: {
    tagSlugs: string[];
    projectId: string | null;
  }): Promise<GoalTaskRow[]>;
  countGoalTags(): Promise<GoalsBoardCounts>;
  /** Adapter-owned atomic command: verifies the task exists, then creates the project/phases/tasks in one transaction. */
  promoteGoal(input: {
    taskId: string;
    projectId: string;
    projectName: string;
    projectDescription: string | null;
    category: string | null;
    color: string;
    phases: GoalPromotionPhaseInput[];
    now: string;
  }): Promise<GoalPromotionOutcome>;
}

// ─── Ideation (adapter-owned atomic conversion) ────────────────────────────

export interface IdeationConvertProjectInput {
  id: string;
  name: string;
  color: string;
  metadata: Record<string, unknown>;
}

export interface IdeationConvertPhaseInput {
  id: string;
  name: string;
  description: string | null;
  color: string;
  sortOrder: number;
}

export interface IdeationConvertTaskInput {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  dueDate: string | null;
  parentId: string | null;
  depth: number;
  metadata: Record<string, unknown>;
  effort: number | null;
  tagNames: string[];
}

export interface IdeationConvertPhaseItemInput {
  phaseId: string;
  taskId: string;
  sortOrder: number;
}

export interface IdeationConvertDependencyInput {
  taskId: string;
  dependsOnTaskId: string;
  type: 'blocks' | 'related';
}

export interface AIIdeationPersistence {
  /**
   * Adapter-owned atomic command. The route validates the ideation graph
   * (hierarchy, relationships, cycles) before calling this; the adapter only
   * persists the already-validated shape in one transaction, resolving tags
   * by slug and creating any that don't yet exist.
   */
  convertDraft(input: {
    project: IdeationConvertProjectInput;
    phases: IdeationConvertPhaseInput[];
    tasks: IdeationConvertTaskInput[];
    phaseItems: IdeationConvertPhaseItemInput[];
    dependencies: IdeationConvertDependencyInput[];
    now: string;
  }): Promise<{ projectId: string }>;
}

// ─── Resets (typed get/list/upsert/patch + aggregate stats) ───────────────

export interface ResetRow {
  id: string;
  type: string;
  periodStart: string;
  periodEnd: string;
  wentWell: string | null;
  needsAdjustment: string | null;
  notes: string | null;
  stats: unknown;
  aiSummary: string | null;
  staleActions: unknown;
  carryForwardItems: unknown;
  monthlyWin: string | null;
  monthlyChange: string | null;
  intentions: unknown;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ResetPatch = Partial<Pick<ResetRow,
  | 'wentWell' | 'needsAdjustment' | 'notes' | 'stats' | 'aiSummary'
  | 'staleActions' | 'carryForwardItems' | 'monthlyWin' | 'monthlyChange'
  | 'intentions' | 'completedAt'
>>;

export interface ResetStatsStaleTask {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  priority: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
}

export interface ResetStatsAggregate {
  completedTasks: Array<{ id: string; title: string; completedAt: string | null }>;
  createdTaskCount: number;
  carriedForwardCount: number;
  activeRoutines: Array<{ id: string; cadenceType: string }>;
  periodCompletions: Array<{ routineId: string; date: string }>;
  focusItems: Array<{ taskId: string; date: string; slot: number }>;
  staleTasks: ResetStatsStaleTask[];
  energyData: Array<{ date: string; level: string }>;
  focusTaskStatuses: Array<{ id: string; title: string; status: string }>;
}

export interface AIResetsPersistence {
  get(type: string, periodStart: string): Promise<ResetRow | null>;
  list(type: string | null, limit: number): Promise<ResetRow[]>;
  /**
   * Presence-sensitive upsert: only the keys present in `fields` are written,
   * so omitted keys keep their stored value on an existing row while an
   * explicit `null` clears it. Missing keys fall back to `null` (or an empty
   * list for the list-valued columns) when the row is created.
   */
  upsert(input: {
    type: string;
    periodStart: string;
    periodEnd: string;
    now: string;
    fields: ResetPatch;
  }): Promise<ResetRow>;
  patch(id: string, updates: ResetPatch, now: string): Promise<ResetRow | null>;
  aggregateStats(input: {
    periodStart: string;
    periodEnd: string;
    periodStartIso: string;
    periodEndExclusiveIso: string;
    staleThresholdExclusiveIso: string;
    staleLimit: number;
  }): Promise<ResetStatsAggregate>;
}

export interface AIWorkflowPersistence {
  context: AIWorkflowContextPersistence;
  getTaskBreakdownContext(taskId: string): Promise<TaskBreakdownContext | null>;
  notifications: {
    listForClassification(now: string, limit: number): Promise<NotificationClassificationRow[]>;
  };
  recommendations: AIWorkflowRecommendationPersistence;
  dayPlan: AIDayPlanPersistence;
  listTaskConnectorTypes(taskIds: readonly string[]): Promise<string[]>;
  taskTools: AITaskToolsPersistence;
  dispatch: AIDispatchPersistence;
  maintenance: AIMaintenancePersistence;
  goalsBoard: AIGoalsBoardPersistence;
  ideation: AIIdeationPersistence;
  resets: AIResetsPersistence;
}

declare module './worker-repositories' {
  interface WorkerPersistenceRepositories {
    aiWorkflows?: AIWorkflowPersistence;
  }
}

export function requireAIWorkflowPersistence(
  repositories: WorkerPersistenceRepositories,
): AIWorkflowPersistence {
  if (!repositories.aiWorkflows) {
    throw new Error('AI workflow persistence is not available in the selected backend');
  }
  return repositories.aiWorkflows;
}
