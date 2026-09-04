import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import db, { runTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  appSettings,
  connectorConfigs,
  focusItems,
  hubProjects,
  myDayExclusions,
  myDayItems,
  notifications,
  priorityEntities,
  prioritySyncLog,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  projectPhases,
  quickSortLog,
  quickSortOperations,
  scoutReconciliationEvaluations,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
  sourceLists,
  sourceRankings,
  syncDeletionCandidates,
  syncDeletionSnapshots,
  tags,
  taskAttachments,
  taskDependencies,
  taskFieldStates,
  taskHistoryEvents,
  taskIngestSuppressions,
  taskLinkedSources,
  taskProjects,
  taskSchedules,
  taskTags,
  tasks,
  weeklyOneThing,
} from '@/db/schema';
import { detachTaskDescendants } from '@/lib/tasks/task-hierarchy-deletion';
import { repointTaskReferences } from '@/lib/tasks/task-reference-repoint';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import { decodeLenientJsonArray, decodeLenientJsonObject } from './value-codecs';
import {
  reconcileSqliteTaskTransferIdentityRefreshForRepository,
  resolveSqliteTaskTransferIdentityTargetsForRepository,
} from './sqlite-task-transfer-identity';
import {
  compileCanonicalTaskFilter,
  compileQuickFilterCondition,
  enabledGitHubConnectorCondition,
  withCondition,
  type CanonicalTaskFilterInputs,
} from './sqlite-task-filter';
import {
  CLOSED_TASK_STATUSES,
  type AvailableTaskTag,
  type InboxListEntry,
  type LocalTaskDeletionRequest,
  type LocalTaskLifecycleRepository,
  type PendingSyncTaskMoveOutcome,
  type PendingSyncTaskMoveRequest,
  type PriorityEntityRepository,
  type PriorityEntityRow,
  type PriorityProjectReference,
  type PrioritySourceListReference,
  type PriorityTagReference,
  type RetentionTaskIdentity,
  type RetentionTaskRow,
  type ScoutHardDeleteOutcome,
  type ScoutTaskHardDeleteRepository,
  type SourceListDisplayNameRow,
  type SourceListNameRepository,
  type TaskAttachmentContentRow,
  type TaskAttachmentInsert,
  type TaskAttachmentMetadataRow,
  type TaskAttachmentRow,
  type TaskCorePersistence,
  type TaskDependencyEndpoints,
  type TaskDuplicateDetectionRow,
  type TaskFilterInputRepository,
  type TaskFilterSpec,
  type TaskGroupMode,
  type TaskListPage,
  type TaskMoveClaimReleaseRequest,
  type TaskMoveClaimRequest,
  type TaskMoveDestinationMaterialization,
  type TaskMoveFinalizationOutcome,
  type TaskMoveFinalizationRequest,
  type TaskMoveListRow,
  type TaskMoveRepository,
  type TaskMoveSourceCopyProvenance,
  type TaskMoveSourceRow,
  type TaskMoveSourceSyncIntent,
  type TaskMoveTagRef,
  type TaskMoveTargetList,
  type TaskMoveTaskInsert,
  type TaskMoveTaskRow,
  type TaskPolicyIdentityRepository,
  type TaskQueryRepository,
  type TaskQueryScope,
  type TaskQuickSortOrder,
  type TaskQuickSortQueueMode,
  type TaskQuickSortQueueRow,
  type TaskQuickSortScope,
  type TaskQuickSortSuggestionInputs,
  type TaskReadRepository,
  type TaskRelationshipCandidateRow,
  type TaskScheduleRow,
  type TaskSourceIdentityRow,
  type TaskSourceCounts,
  type TaskStatsResult,
  type TaskTransferIdentityRepository,
  type WriteThroughTaskMoveRepository,
} from '@/lib/tasks/core/contracts';

/**
 * SQLite implementation of the L04 task-core contracts.
 *
 * Every method here is `async` to satisfy the portable contract, but the
 * SQLite work itself is synchronous: `runTransaction` uses better-sqlite3's
 * synchronous transaction, and no `await` ever happens inside a transaction
 * body. That is the honest shape for this driver — the contract does not
 * pretend SQLite can suspend mid-transaction.
 */

type SqliteTransaction = BetterSQLite3Database<typeof schema>;
type Drizzle = BetterSQLite3Database<typeof schema>;

/**
 * The synchronous transaction runner this composition writes through. It is
 * injected alongside the database handle so a repository can never write to a
 * different database than the one it reads from: `createSqliteTaskCorePersistence`
 * requires both, and no repository falls back to a module-level handle.
 *
 * The shape deliberately matches `runTransaction` from `@/db` exactly — a
 * synchronous callback, not a `Promise`-returning one — because better-sqlite3
 * cannot hold a transaction open across an `await`. Production passes that
 * exact function so transaction behavior (`immediate`/`deferred`) and database
 * telemetry are preserved.
 */
export type SqliteTaskCoreTransactionRunner = <T>(
  fn: (tx: SqliteTransaction) => T,
  options?: { readOnly?: boolean },
) => T;

class PendingTaskMoveSourceChangedError extends Error {
  constructor() {
    super('Task changed before the move could be committed');
    this.name = 'PendingTaskMoveSourceChangedError';
  }
}

const TASK_HISTORY_DELETE_TRIGGER = `
  CREATE TRIGGER task_history_immutable_delete
  BEFORE DELETE ON task_history_events
  BEGIN
    SELECT RAISE(ABORT, 'task_history_events is append-only');
  END
`;

function parseMetadata(metadata: unknown): Record<string, unknown> {
  return decodeLenientJsonObject(metadata);
}

/* ------------------------------------------------------------------ *
 * Filter inputs
 * ------------------------------------------------------------------ */

class SqliteTaskFilterInputRepository implements TaskFilterInputRepository {
  constructor(private readonly database: Drizzle) {}

  async listMyDayTaskIds(date: string): Promise<string[]> {
    const rows = await this.database
      .select({ taskId: myDayItems.taskId })
      .from(myDayItems)
      .where(eq(myDayItems.date, date));
    return rows.map((row) => row.taskId);
  }

  async listAssignedGitHubUsernames(): Promise<string[]> {
    const rows = await this.database
      .select({ settings: connectorConfigs.settings })
      .from(connectorConfigs)
      .where(enabledGitHubConnectorCondition());

    const usernames: string[] = [];
    for (const row of rows) {
      const authenticatedUser = decodeLenientJsonObject(row.settings).authenticatedUser;
      if (typeof authenticatedUser === 'string' && authenticatedUser) {
        usernames.push(authenticatedUser);
      }
    }
    return usernames;
  }

  async listInboxListEntries(): Promise<InboxListEntry[]> {
    const [row] = await this.database
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'inbox.lists'))
      .limit(1);
    if (!row?.value) return [];

    return decodeLenientJsonArray(row.value).flatMap((entry): InboxListEntry[] => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.connectorType !== 'string') return [];
      return [{
        connectorType: record.connectorType,
        sourceListId: typeof record.sourceListId === 'string' ? record.sourceListId : undefined,
        sourceListName: typeof record.sourceListName === 'string' ? record.sourceListName : undefined,
      }];
    });
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const PRIORITY_ORDER_EXPRESSION = sql`CASE ${tasks.priority}
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  WHEN 'low' THEN 3
  ELSE 4 END`;

const EFFORT_ORDER_EXPRESSION = sql`COALESCE(${tasks.effort}, 0)`;

/**
 * Explicit NULL placement for the nullable sort columns (`dueDate`,
 * `sourceListName`). SQLite treats NULL as the lowest value (NULLs first
 * ascending, last descending) while PostgreSQL defaults to the opposite
 * (NULLS LAST ascending, FIRST descending). The observable ordering of the
 * legacy `/api/tasks` route is the SQLite one, so both adapters state it
 * explicitly instead of inheriting a dialect default. `effort` needs no rank:
 * `EFFORT_ORDER_EXPRESSION` coalesces NULL away on both backends.
 */
type NullableSortColumn = typeof tasks.dueDate | typeof tasks.sourceListName;

function nullsLowestRank(column: NullableSortColumn): SQL {
  return sql`CASE WHEN ${column} IS NULL THEN 0 ELSE 1 END`;
}

function nullableSortColumn(field: TaskListPage['order']['field']): NullableSortColumn | null {
  if (field === 'dueDate') return tasks.dueDate;
  if (field === 'sourceList') return tasks.sourceListName;
  return null;
}

class SqliteTaskQueryRepository implements TaskQueryRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly filterInputs: TaskFilterInputRepository,
  ) {}

  private async resolveInputs(spec: TaskFilterSpec): Promise<CanonicalTaskFilterInputs> {
    const [myDayTaskIds, assignedGitHubUsernames, inboxListEntries] = await Promise.all([
      this.filterInputs.listMyDayTaskIds(spec.myDayDate),
      this.filterInputs.listAssignedGitHubUsernames(),
      this.filterInputs.listInboxListEntries(),
    ]);
    return { myDayTaskIds, assignedGitHubUsernames, inboxListEntries };
  }

  private async countWhere(where: SQL | undefined): Promise<number> {
    const [row] = await this.database
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(where);
    return Number(row?.count ?? 0);
  }

  async countTasks(spec: TaskFilterSpec, scope: TaskQueryScope = {}): Promise<number> {
    const inputs = await this.resolveInputs(spec);
    const compiled = compileCanonicalTaskFilter(spec, inputs);
    return this.countWhere(scope.includeQuickFilter ? compiled.taskWhere : compiled.baseWhere);
  }

  async listTaskIds(spec: TaskFilterSpec, page: TaskListPage): Promise<string[]> {
    const inputs = await this.resolveInputs(spec);
    const compiled = compileCanonicalTaskFilter(spec, inputs);
    const direction = page.order.direction === 'desc' ? desc : asc;
    const column = page.order.field === 'dueDate'
      ? tasks.dueDate
      : page.order.field === 'title'
        ? tasks.title
        : page.order.field === 'createdAt'
          ? tasks.createdAt
          : page.order.field === 'updatedAt'
            ? tasks.updatedAt
            : page.order.field === 'status'
              ? tasks.status
              : page.order.field === 'sourceList'
                ? tasks.sourceListName
                : page.order.field === 'effort'
                  ? EFFORT_ORDER_EXPRESSION
                  : PRIORITY_ORDER_EXPRESSION;
    const nullable = nullableSortColumn(page.order.field);
    const orderedColumn = (
      page.order.field === 'title'
      || page.order.field === 'status'
      || page.order.field === 'sourceList'
    )
      ? sql`${column} COLLATE BINARY`
      : column;

    const rows = await this.database
      .select({ id: tasks.id })
      .from(tasks)
      .where(compiled.taskWhere)
      // `id` is the deterministic tie-break so two backends can never
      // disagree about the page boundary for equal sort keys.
      .orderBy(
        ...(nullable ? [direction(nullsLowestRank(nullable))] : []),
        direction(orderedColumn),
        asc(sql`${tasks.id} COLLATE BINARY`),
      )
      .limit(page.limit)
      .offset(page.offset);
    return rows.map((row) => row.id);
  }

  async getStats(spec: TaskFilterSpec): Promise<TaskStatsResult> {
    const inputs = await this.resolveInputs(spec);
    const compiled = compileCanonicalTaskFilter(spec, inputs);
    const openWhere = spec.openOnly
      ? compiled.baseWhere
      : withCondition(compiled.baseWhere, notInArray(tasks.status, [...CLOSED_TASK_STATUSES]));

    const quick = (name: Parameters<typeof compileQuickFilterCondition>[0]) =>
      compileQuickFilterCondition(name, spec, inputs);

    const [
      totalOpen,
      overdue,
      dueToday,
      dueThisWeek,
      noDate,
      highPriority,
      assignedToMe,
      myDay,
      recentlyCreated,
      recentlyClosed,
      waiting,
      inbox,
    ] = await Promise.all([
      this.countWhere(openWhere),
      this.countWhere(withCondition(openWhere, quick('overdue'))),
      this.countWhere(withCondition(openWhere, quick('today'))),
      this.countWhere(withCondition(openWhere, quick('week'))),
      this.countWhere(withCondition(openWhere, quick('noDate'))),
      this.countWhere(withCondition(openWhere, quick('high'))),
      this.countWhere(withCondition(openWhere, quick('assigned'))),
      this.countWhere(withCondition(openWhere, quick('myDay'))),
      this.countWhere(withCondition(openWhere, quick('recentlyCreated'))),
      this.countWhere(withCondition(compiled.baseWhere, quick('recentlyClosed'))),
      this.countWhere(withCondition(openWhere, quick('waiting'))),
      this.countWhere(withCondition(openWhere, quick('inbox'))),
    ]);

    return {
      totalOpen,
      overdue,
      dueToday,
      dueThisWeek,
      noDate,
      highPriority,
      assignedToMe,
      myDay,
      recentlyCreated,
      recentlyClosed,
      waiting,
      inbox,
    };
  }

  async getSourceCounts(spec: TaskFilterSpec): Promise<TaskSourceCounts> {
    const inputs = await this.resolveInputs(spec);
    const compiled = compileCanonicalTaskFilter(spec, inputs);
    const rows = await this.database
      .select({ connectorType: tasks.connectorType, count: sql<number>`count(*)` })
      .from(tasks)
      .where(compiled.baseWhere)
      .groupBy(tasks.connectorType);

    return rows.reduce<TaskSourceCounts>((accumulator, row) => {
      accumulator[row.connectorType] = Number(row.count ?? 0);
      return accumulator;
    }, {});
  }

  async getAvailableTags(spec: TaskFilterSpec): Promise<AvailableTaskTag[]> {
    const inputs = await this.resolveInputs(spec);
    const compiled = compileCanonicalTaskFilter(spec, inputs);
    const rows = await this.database
      .select({
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        type: tags.type,
        source: tags.source,
        color: tags.color,
        confirmed: tags.confirmed,
        count: sql<number>`count(*)`,
      })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
      .where(compiled.baseWhere)
      .groupBy(tags.id, tags.name, tags.slug, tags.type, tags.source, tags.color, tags.confirmed)
      .orderBy(
        asc(sql`${tags.name} COLLATE BINARY`),
        asc(sql`${tags.id} COLLATE BINARY`),
      );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      type: row.type,
      source: row.source ?? null,
      color: row.color ?? null,
      confirmed: Boolean(row.confirmed),
      count: Number(row.count ?? 0),
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Endpoint-oriented task reads
 * ------------------------------------------------------------------ */

function sqliteListGroupExpression(): SQL<string> {
  return sql<string>`COALESCE(
    NULLIF((
      SELECT COALESCE(NULLIF(${sourceLists.userDisplayName}, ''), NULLIF(${sourceLists.name}, ''))
      FROM ${sourceLists}
      WHERE ${sourceLists.connectorInstanceId} = ${tasks.connectorInstanceId}
        AND ${sourceLists.sourceId} = ${tasks.sourceListId}
      LIMIT 1
    ), ''),
    NULLIF(${tasks.sourceListName}, ''),
    'No List'
  )`;
}

function sqliteScalarGroupExpression(
  groupBy: Exclude<TaskGroupMode, 'tag' | 'project' | 'dueDate'>,
): SQL<string> {
  if (groupBy === 'status') {
    return sql<string>`CASE
      WHEN ${tasks.status} = 'done' THEN 'Completed'
      WHEN ${tasks.status} = 'cancelled' THEN 'Cancelled'
      WHEN ${tasks.status} = 'in_progress' THEN 'In Progress'
      ELSE 'To Do'
    END`;
  }
  if (groupBy === 'priority') {
    return sql<string>`COALESCE(NULLIF(${tasks.priority}, ''), 'none')`;
  }
  if (groupBy === 'planningHorizon') {
    return sql<string>`CASE ${tasks.planningHorizon}
      WHEN 'next' THEN 'Next'
      WHEN 'soon' THEN 'Soon'
      WHEN 'later' THEN 'Later'
      WHEN 'someday' THEN 'Someday'
      ELSE 'Not set'
    END`;
  }
  if (groupBy === 'source') {
    return sql<string>`COALESCE(NULLIF(${tasks.connectorType}, ''), 'local')`;
  }
  if (groupBy === 'list') return sqliteListGroupExpression();
  if (groupBy === 'effort') {
    return sql<string>`CASE
      WHEN ${tasks.effort} IS NULL THEN ${NO_EFFORT_GROUP_LABEL}
      ELSE CAST(${tasks.effort} AS TEXT)
    END`;
  }
  const exhaustive: never = groupBy;
  throw new Error(`Unsupported task group: ${exhaustive}`);
}

class SqliteTaskReadRepository implements TaskReadRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly filterInputs: TaskFilterInputRepository,
  ) {}

  private async resolveInputs(spec: TaskFilterSpec): Promise<CanonicalTaskFilterInputs> {
    const [myDayTaskIds, assignedGitHubUsernames, inboxListEntries] = await Promise.all([
      this.filterInputs.listMyDayTaskIds(spec.myDayDate),
      this.filterInputs.listAssignedGitHubUsernames(),
      this.filterInputs.listInboxListEntries(),
    ]);
    return { myDayTaskIds, assignedGitHubUsernames, inboxListEntries };
  }

  async getAttachmentReadContext(taskId: string, attachmentId: string) {
    const [row] = await this.database.select({
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      attachmentId: taskAttachments.id,
      attachmentName: taskAttachments.name,
      attachmentContentType: taskAttachments.contentType,
      attachmentContentBase64: taskAttachments.contentBase64,
      sourceAttachmentId: taskAttachments.sourceAttachmentId,
    }).from(tasks).leftJoin(
      taskAttachments,
      and(
        eq(taskAttachments.taskId, tasks.id),
        eq(taskAttachments.id, attachmentId),
      ),
    ).where(eq(tasks.id, taskId)).limit(1);

    if (!row) return { task: null, attachment: null };
    return {
      task: {
        sourceId: row.sourceId,
        connectorType: row.connectorType,
        connectorInstanceId: row.connectorInstanceId,
      },
      attachment: row.attachmentId === null
        ? null
        : {
            name: row.attachmentName!,
            contentType: row.attachmentContentType!,
            contentBase64: row.attachmentContentBase64 ?? null,
            sourceAttachmentId: row.sourceAttachmentId ?? null,
          },
    };
  }

  async getDocumentPreviewContext(taskId: string) {
    const [row] = await this.database.select({
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      metadata: tasks.metadata,
      documentConnectorId: connectorConfigs.id,
      credentials: connectorConfigs.credentials,
      settings: connectorConfigs.settings,
    }).from(tasks).leftJoin(
      connectorConfigs,
      and(
        eq(tasks.connectorType, 'document-intelligence'),
        eq(connectorConfigs.id, tasks.connectorInstanceId),
        eq(connectorConfigs.type, 'document-intelligence'),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
      ),
    ).where(eq(tasks.id, taskId)).limit(1);

    if (!row) return { task: null, connector: null };
    return {
      task: {
        connectorType: row.connectorType,
        connectorInstanceId: row.connectorInstanceId,
        metadata: decodeLenientJsonObject(row.metadata),
      },
      connector: row.documentConnectorId === null
        ? null
        : {
            credentials: decodeLenientJsonObject(row.credentials),
            settings: decodeLenientJsonObject(row.settings),
          },
    };
  }

  async listLinkedSources(taskId: string) {
    const rows = await this.database.select({
      id: taskLinkedSources.id,
      taskId: taskLinkedSources.taskId,
      connectorType: taskLinkedSources.connectorType,
      connectorInstanceId: taskLinkedSources.connectorInstanceId,
      sourceId: taskLinkedSources.sourceId,
      title: taskLinkedSources.title,
      linkedAt: taskLinkedSources.linkedAt,
      matchConfidence: taskLinkedSources.matchConfidence,
      metadata: taskLinkedSources.metadata,
    }).from(taskLinkedSources).where(eq(taskLinkedSources.taskId, taskId));

    return rows.map((row) => ({
      ...row,
      matchConfidence: row.matchConfidence ?? null,
      metadata: decodeLenientJsonObject(row.metadata),
    }));
  }

  async searchRelationshipCandidates(input: {
    readonly taskId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<TaskRelationshipCandidateRow[] | null> {
    const [sourceTask] = await this.database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (!sourceTask) return null;

    const boundedLimit = Math.max(1, Math.min(input.limit, 50));
    const normalizedQuery = input.query.trim();
    const candidateRows = await this.database.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      connectorType: tasks.connectorType,
      sourceListName: tasks.sourceListName,
    }).from(tasks).where(and(
      ne(tasks.id, input.taskId),
      normalizedQuery ? like(tasks.title, `%${normalizedQuery}%`) : undefined,
    )).orderBy(
      asc(sql`${tasks.title} COLLATE BINARY`),
      asc(sql`${tasks.id} COLLATE BINARY`),
    ).limit(boundedLimit);

    const candidateIds = candidateRows.map((candidate) => candidate.id);
    if (candidateIds.length === 0) return [];
    const membershipRows = await this.database.select({
      taskId: taskProjects.taskId,
      projectId: taskProjects.projectId,
    }).from(taskProjects).where(inArray(taskProjects.taskId, candidateIds));
    const projectIds = [...new Set(membershipRows.map((row) => row.projectId))];
    const projectRows = projectIds.length > 0
      ? await this.database.select({
          id: hubProjects.id,
          name: hubProjects.name,
        }).from(hubProjects).where(inArray(hubProjects.id, projectIds))
      : [];
    const projectNameById = new Map(projectRows.map((project) => [project.id, project.name]));
    const membershipsByTask = new Map<string, string[]>();
    for (const membership of membershipRows) {
      const ids = membershipsByTask.get(membership.taskId) ?? [];
      ids.push(membership.projectId);
      membershipsByTask.set(membership.taskId, ids);
    }

    return candidateRows.map((candidate) => {
      const candidateProjectIds = membershipsByTask.get(candidate.id) ?? [];
      return {
        ...candidate,
        sourceListName: candidate.sourceListName ?? null,
        projectIds: candidateProjectIds,
        projectNames: candidateProjectIds
          .map((projectId) => projectNameById.get(projectId))
          .filter((name): name is string => Boolean(name)),
      };
    });
  }

  async listDuplicateDetectionTasks(input: {
    readonly includeClosedTasks: boolean;
  }): Promise<TaskDuplicateDetectionRow[]> {
    return this.database.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      createdAt: tasks.createdAt,
    }).from(tasks).where(
      input.includeClosedTasks
        ? undefined
        : inArray(tasks.status, ['todo', 'in_progress']),
    );
  }

  async listDistinctTaskAssignees(): Promise<string[]> {
    const rows = await this.database
      .select({ assignee: tasks.assignee })
      .from(tasks)
      .where(isNotNull(tasks.assignee))
      .groupBy(tasks.assignee)
      .orderBy(asc(sql`${tasks.assignee} COLLATE BINARY`));
    return rows.map((row) => row.assignee!);
  }

  async getGroupCounts(input: {
    readonly spec: TaskFilterSpec;
    readonly groupBy: TaskGroupMode;
  }): Promise<Record<string, number>> {
    const compiled = compileCanonicalTaskFilter(
      input.spec,
      await this.resolveInputs(input.spec),
    );
    const taskWhere = compiled.taskWhere;

    if (input.groupBy === 'tag') {
      const [taggedRows, untaggedRows] = await Promise.all([
        this.database.select({
          group: tags.name,
          count: sql<number>`count(DISTINCT ${tasks.id})`,
        }).from(tasks)
          .innerJoin(taskTags, eq(taskTags.taskId, tasks.id))
          .innerJoin(tags, eq(tags.id, taskTags.tagId))
          .where(taskWhere)
          .groupBy(tags.name),
        this.database.select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(and(
            taskWhere,
            sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`,
          )),
      ]);
      const counts: Record<string, number> = {};
      for (const row of taggedRows) counts[row.group] = Number(row.count);
      const untaggedCount = Number(untaggedRows[0]?.count ?? 0);
      if (untaggedCount > 0) counts.Untagged = untaggedCount;
      return counts;
    }

    if (input.groupBy === 'project') {
      const projectRows = await this.database.select({
        taskId: taskProjects.taskId,
        projectId: taskProjects.projectId,
        projectName: hubProjects.name,
      }).from(tasks)
        .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
        .innerJoin(hubProjects, eq(hubProjects.id, taskProjects.projectId))
        .where(taskWhere);
      const taskIds = [...new Set(projectRows.map((row) => row.taskId))];
      const phaseRows = taskIds.length > 0
        ? await this.database.select({
            taskId: projectPhaseItems.taskId,
            phaseName: projectPhases.name,
            projectId: projectPhases.projectId,
          }).from(projectPhaseItems)
            .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
            .where(inArray(projectPhaseItems.taskId, taskIds))
        : [];
      const phasesByMembership = new Map<string, string[]>();
      for (const phase of phaseRows) {
        if (!phase.projectId) continue;
        const key = `${phase.taskId}:${phase.projectId}`;
        const names = phasesByMembership.get(key) ?? [];
        names.push(phase.phaseName);
        phasesByMembership.set(key, names);
      }
      const taskIdsByGroup = new Map<string, Set<string>>();
      for (const project of projectRows) {
        const phaseNames = phasesByMembership.get(`${project.taskId}:${project.projectId}`);
        for (const group of phaseNames?.length
          ? phaseNames.map((phaseName) => `${project.projectName} › ${phaseName}`)
          : [`${project.projectName} › Unphased`]) {
          const ids = taskIdsByGroup.get(group) ?? new Set<string>();
          ids.add(project.taskId);
          taskIdsByGroup.set(group, ids);
        }
      }
      const counts = Object.fromEntries(
        [...taskIdsByGroup].map(([group, ids]) => [group, ids.size]),
      );
      const [unprojected] = await this.database.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          taskWhere,
          sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`,
        ));
      const unprojectedCount = Number(unprojected?.count ?? 0);
      if (unprojectedCount > 0) counts['No Project'] = unprojectedCount;
      return counts;
    }

    const expression = input.groupBy === 'dueDate'
      ? sql<string>`CASE
          WHEN ${tasks.dueDate} IS NULL OR ${tasks.dueDate} = '' THEN 'No Due Date'
          WHEN ${tasks.dueDate} < ${input.spec.today} THEN 'Overdue'
          WHEN ${tasks.dueDate} = ${input.spec.today} THEN 'Today'
          ELSE ${tasks.dueDate}
        END`
      : sqliteScalarGroupExpression(input.groupBy);
    const rows = await this.database.select({
      group: expression.as('group_key'),
      count: sql<number>`count(*)`,
    }).from(tasks).where(taskWhere).groupBy(sql`group_key`);
    return Object.fromEntries(rows.map((row) => [row.group, Number(row.count)]));
  }

  private quickSortScopeConditions(input: TaskQuickSortScope): SQL[] {
    const conditions: SQL[] = [
      sql`${tasks.connectorInstanceId} NOT IN (
        SELECT ${connectorConfigs.id} FROM ${connectorConfigs}
        WHERE ${connectorConfigs.deletedAt} IS NOT NULL
      )`,
      notInArray(tasks.status, ['done', 'cancelled']),
      isNull(tasks.parentId),
      or(isNull(tasks.snoozedUntil), lte(tasks.snoozedUntil, input.now))!,
      sql`NOT EXISTS (
        SELECT 1 FROM ${quickSortLog}
        WHERE ${quickSortLog.taskId} = ${tasks.id}
          AND ${quickSortLog.action} = 'skipped'
          AND ${quickSortLog.reversedAt} IS NULL
          AND ${quickSortLog.triagedAt} > ${input.skipCutoff}
      )`,
    ];
    if (input.sourceTypes.length === 1) {
      conditions.push(eq(tasks.connectorType, input.sourceTypes[0]));
    } else if (input.sourceTypes.length > 1) {
      conditions.push(inArray(tasks.connectorType, [...input.sourceTypes]));
    }
    if (input.sourceListId) {
      conditions.push(eq(tasks.sourceListId, input.sourceListId));
    } else if (input.sourceListName) {
      conditions.push(eq(tasks.sourceListName, input.sourceListName));
    }
    if (input.connectorInstanceId) {
      conditions.push(eq(tasks.connectorInstanceId, input.connectorInstanceId));
    }
    return conditions;
  }

  async listQuickSortSources(input: { readonly now: string; readonly skipCutoff: string }) {
    const scope: TaskQuickSortScope = {
      ...input,
      sourceTypes: [],
      sourceListId: null,
      sourceListName: null,
      connectorInstanceId: null,
    };
    const rows = await this.database.select({
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
      count: sql<number>`count(*)`,
    }).from(tasks)
      .where(and(...this.quickSortScopeConditions(scope)))
      .groupBy(
        tasks.connectorType,
        tasks.connectorInstanceId,
        tasks.sourceListId,
        tasks.sourceListName,
      )
      .orderBy(desc(sql`count(*)`));
    const definitions = await this.database.select({
      connectorInstanceId: sourceLists.connectorInstanceId,
      sourceId: sourceLists.sourceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
      type: sourceLists.type,
      icon: sourceLists.icon,
      iconColor: sourceLists.iconColor,
      hidden: sourceLists.hidden,
    }).from(sourceLists);
    return {
      rows: rows.map((row) => ({ ...row, count: Number(row.count) })),
      definitions: definitions.map((definition) => ({
        ...definition,
        userDisplayName: definition.userDisplayName ?? null,
        icon: definition.icon ?? null,
        iconColor: definition.iconColor ?? null,
        hidden: Boolean(definition.hidden),
      })),
    };
  }

  async getQuickSortCounts(input: TaskQuickSortScope) {
    const scope = this.quickSortScopeConditions(input);
    const countWhere = async (condition: SQL): Promise<number> => {
      const [row] = await this.database.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(...scope, condition));
      return Number(row?.count ?? 0);
    };
    const [noPriority, noEffort, noTags, noPlanningHorizon] = await Promise.all([
      countWhere(eq(tasks.priority, 'none')),
      countWhere(isNull(tasks.effort)),
      countWhere(sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`),
      countWhere(isNull(tasks.planningHorizon)),
    ]);
    return {
      no_priority: noPriority,
      quadrant: noPriority,
      no_effort: noEffort,
      no_tags: noTags,
      no_planning_horizon: noPlanningHorizon,
    };
  }

  async listQuickSortTasks(
    input: TaskQuickSortScope & {
      readonly mode: TaskQuickSortQueueMode;
      readonly order: TaskQuickSortOrder;
      readonly limit: number;
    },
  ): Promise<TaskQuickSortQueueRow[]> {
    const conditions = this.quickSortScopeConditions(input);
    if (input.mode === 'no_priority' || input.mode === 'quadrant') {
      conditions.push(eq(tasks.priority, 'none'));
    } else if (input.mode === 'no_effort') {
      conditions.push(isNull(tasks.effort));
    } else if (input.mode === 'no_tags') {
      conditions.push(sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`);
    } else {
      conditions.push(isNull(tasks.planningHorizon));
    }

    const priorityOrder = sql`CASE ${tasks.priority}
      WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
      WHEN 'low' THEN 4 ELSE 5 END`;
    let orderClauses: SQL[];
    if (input.order === 'priority') {
      orderClauses = [
        asc(priorityOrder),
        desc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE BINARY`),
      ];
    } else if (input.order === 'oldest') {
      orderClauses = [asc(tasks.createdAt), asc(sql`${tasks.id} COLLATE BINARY`)];
    } else if (input.order === 'newest') {
      orderClauses = [desc(tasks.createdAt), asc(sql`${tasks.id} COLLATE BINARY`)];
    } else if (input.order === 'random') {
      orderClauses = [sql`RANDOM()`];
    } else if (input.mode === 'no_priority' || input.mode === 'quadrant') {
      orderClauses = [desc(tasks.createdAt), asc(sql`${tasks.id} COLLATE BINARY`)];
    } else if (input.mode === 'no_effort' || input.mode === 'no_planning_horizon') {
      orderClauses = [
        asc(priorityOrder),
        desc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE BINARY`),
      ];
    } else {
      orderClauses = [
        asc(sql`CASE WHEN ${tasks.sourceListName} IS NULL THEN 0 ELSE 1 END`),
        asc(sql`${tasks.sourceListName} COLLATE BINARY`),
        desc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE BINARY`),
      ];
    }

    const rows = await this.database.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      effort: tasks.effort,
      status: tasks.status,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
      dueDate: tasks.dueDate,
      planningHorizon: tasks.planningHorizon,
      createdAt: tasks.createdAt,
      localDisposition: tasks.localDisposition,
    }).from(tasks)
      .where(and(...conditions))
      .orderBy(...orderClauses)
      .limit(input.limit);
    const taskIds = rows.map((row) => row.id);
    if (taskIds.length === 0) return [];

    const [tagRows, projectRows, phaseRows] = await Promise.all([
      this.database.select({
        taskId: taskTags.taskId,
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        color: tags.color,
      }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, taskIds)),
      this.database.select({
        taskId: taskProjects.taskId,
        id: hubProjects.id,
        name: hubProjects.name,
        color: hubProjects.color,
      }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(inArray(taskProjects.taskId, taskIds)),
      this.database.select({
        taskId: projectPhaseItems.taskId,
        id: projectPhases.id,
        name: projectPhases.name,
        projectId: projectPhases.projectId,
      }).from(projectPhaseItems)
        .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
        .where(and(
          inArray(projectPhaseItems.taskId, taskIds),
          eq(projectPhaseItems.isProposed, false),
        )),
    ]);

    const tagsByTask = new Map<string, TaskQuickSortQueueRow['tags']>();
    for (const { taskId, ...tag } of tagRows) {
      const entries = tagsByTask.get(taskId) ?? [];
      entries.push({ ...tag, color: tag.color ?? null });
      tagsByTask.set(taskId, entries);
    }
    const projectsByTask = new Map<string, TaskQuickSortQueueRow['projects']>();
    for (const { taskId, ...project } of projectRows) {
      const entries = projectsByTask.get(taskId) ?? [];
      entries.push(project);
      projectsByTask.set(taskId, entries);
    }
    const phasesByTask = new Map<string, TaskQuickSortQueueRow['phases']>();
    for (const { taskId, ...phase } of phaseRows) {
      const entries = phasesByTask.get(taskId) ?? [];
      entries.push({ ...phase, projectId: phase.projectId ?? null });
      phasesByTask.set(taskId, entries);
    }

    return rows.map((row) => ({
      ...row,
      description: row.description ?? null,
      effort: row.effort ?? null,
      sourceListId: row.sourceListId ?? null,
      sourceListName: row.sourceListName ?? null,
      dueDate: row.dueDate ?? null,
      planningHorizon: row.planningHorizon ?? null,
      tags: tagsByTask.get(row.id) ?? [],
      projects: projectsByTask.get(row.id) ?? [],
      phases: phasesByTask.get(row.id) ?? [],
    }));
  }

  async getQuickSortSuggestionInputs(
    taskIds: readonly string[],
  ): Promise<TaskQuickSortSuggestionInputs> {
    if (taskIds.length === 0) {
      return { tasks: [], sourceRankings: [], tags: [], taskTags: [] };
    }
    const taskRows = await this.database.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListName: tasks.sourceListName,
      assignee: tasks.assignee,
      snoozedUntil: tasks.snoozedUntil,
      effort: tasks.effort,
    }).from(tasks).where(inArray(tasks.id, [...taskIds]));
    if (taskRows.length === 0) {
      return { tasks: [], sourceRankings: [], tags: [], taskTags: [] };
    }

    const [rankingRows, tagRows, assignmentRows] = await Promise.all([
      this.database.select({
        id: sourceRankings.id,
        connectorType: sourceRankings.connectorType,
        name: sourceRankings.name,
        rank: sourceRankings.rank,
        updatedAt: sourceRankings.updatedAt,
      }).from(sourceRankings),
      this.database.select({
        id: tags.id,
        name: tags.name,
      }).from(tags).orderBy(asc(sql`${tags.id} COLLATE BINARY`)),
      this.database.select({
        taskId: taskTags.taskId,
        tagId: taskTags.tagId,
      }).from(taskTags),
    ]);
    return {
      tasks: taskRows.map((row) => ({
        ...row,
        description: row.description ?? null,
        priority: row.priority as TaskQuickSortSuggestionInputs['tasks'][number]['priority'],
        dueDate: row.dueDate ?? null,
        sourceListName: row.sourceListName ?? null,
        assignee: row.assignee ?? null,
        snoozedUntil: row.snoozedUntil ?? null,
        effort: row.effort ?? null,
      })),
      sourceRankings: rankingRows,
      tags: tagRows,
      taskTags: assignmentRows,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Policy identities
 * ------------------------------------------------------------------ */

class SqliteTaskPolicyIdentityRepository implements TaskPolicyIdentityRepository {
  constructor(private readonly database: Drizzle) {}

  async listTaskSourceIdentities(
    taskIds: readonly string[],
  ): Promise<TaskSourceIdentityRow[]> {
    const uniqueIds = [...new Set(taskIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    return this.database.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(inArray(tasks.id, uniqueIds));
  }

  async getTaskSourceIdentity(taskId: string): Promise<TaskSourceIdentityRow | null> {
    const [row] = await this.database.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ?? null;
  }

  async getDependencyEndpoints(
    dependencyId: string,
  ): Promise<TaskDependencyEndpoints | null> {
    const [row] = await this.database.select({
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
    }).from(taskDependencies).where(eq(taskDependencies.id, dependencyId)).limit(1);
    return row ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Local task lifecycle
 * ------------------------------------------------------------------ */

function deleteTaskWithinTransaction(
  tx: SqliteTransaction,
  taskId: string,
  recursive: boolean,
): void {
  const childTasks = tx.select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentId, taskId))
    .all();
  if (recursive) {
    for (const childTask of childTasks) {
      deleteTaskWithinTransaction(tx, childTask.id, recursive);
    }
  } else {
    detachTaskDescendants(tx, taskId);
  }

  tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
  tx.delete(projectAutoIncludeExclusions)
    .where(eq(projectAutoIncludeExclusions.taskId, taskId))
    .run();
  tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId)).run();
  tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
  tx.delete(myDayItems).where(eq(myDayItems.taskId, taskId)).run();
  tx.delete(myDayExclusions).where(eq(myDayExclusions.taskId, taskId)).run();
  tx.delete(focusItems).where(eq(focusItems.taskId, taskId)).run();
  tx.delete(weeklyOneThing).where(eq(weeklyOneThing.taskId, taskId)).run();
  tx.delete(prioritySyncLog).where(eq(prioritySyncLog.taskId, taskId)).run();
  tx.delete(quickSortLog).where(eq(quickSortLog.taskId, taskId)).run();
  tx.delete(quickSortOperations).where(eq(quickSortOperations.taskId, taskId)).run();
  tx.delete(taskLinkedSources).where(eq(taskLinkedSources.taskId, taskId)).run();
  tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
  tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, taskId)).run();
  tx.update(notifications)
    .set({ relatedTaskId: null })
    .where(eq(notifications.relatedTaskId, taskId))
    .run();
  tx.delete(taskDependencies).where(or(
    eq(taskDependencies.taskId, taskId),
    eq(taskDependencies.dependsOnTaskId, taskId),
  )).run();
  tx.delete(tasks).where(eq(tasks.id, taskId)).run();
}

class SqliteLocalTaskLifecycleRepository implements LocalTaskLifecycleRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly runTransaction: SqliteTaskCoreTransactionRunner,
  ) {}

  async deleteTaskLocally(request: LocalTaskDeletionRequest): Promise<void> {
    this.runTransaction((tx) => {
      deleteTaskWithinTransaction(tx, request.taskId, request.recursive);
    });
  }

  async convertTaskTreeToLocal(
    taskId: string,
    resolution: 'keep_local' | 'archive_local',
    now: string,
  ): Promise<void> {
    this.runTransaction((tx) => {
      const convertTree = (id: string): void => {
        const [task] = tx.select({
          id: tasks.id,
          sourceId: tasks.sourceId,
          connectorType: tasks.connectorType,
          connectorInstanceId: tasks.connectorInstanceId,
          metadata: tasks.metadata,
        }).from(tasks).where(eq(tasks.id, id)).all();
        if (!task) return;

        const children = tx.select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.parentId, id))
          .all();

        tx.update(tasks).set({
          sourceId: `local:${task.id}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          sourceListId: null,
          sourceListName: null,
          syncStatus: 'synced',
          pushRetryCount: 0,
          updatedAt: now,
          lastSyncedAt: now,
          metadata: JSON.stringify({
            ...parseMetadata(task.metadata),
            retentionResolution: {
              action: resolution,
              resolvedAt: now,
              previousConnectorType: task.connectorType,
              previousConnectorInstanceId: task.connectorInstanceId,
              previousSourceId: task.sourceId,
            },
          }),
        }).where(eq(tasks.id, id)).run();

        for (const child of children) convertTree(child.id);
      };

      convertTree(taskId);
    });
  }

  async findTaskByRetentionIdentity(
    identity: RetentionTaskIdentity,
  ): Promise<RetentionTaskRow | null> {
    const columns = {
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      title: tasks.title,
      status: tasks.status,
      updatedAt: tasks.updatedAt,
      metadata: tasks.metadata,
    };

    if (identity.taskId) {
      const [row] = await this.database.select(columns)
        .from(tasks)
        .where(eq(tasks.id, identity.taskId));
      if (
        row
        && row.connectorInstanceId === identity.connectorId
        && row.sourceId === identity.taskSourceId
      ) {
        return { ...row, metadata: parseMetadata(row.metadata) };
      }
    }

    const candidates = await this.database.select(columns)
      .from(tasks)
      .where(eq(tasks.sourceId, identity.taskSourceId));
    const match = candidates.find(
      (candidate) => candidate.connectorInstanceId === identity.connectorId,
    );
    return match ? { ...match, metadata: parseMetadata(match.metadata) } : null;
  }
}

/* ------------------------------------------------------------------ *
 * Scout hard delete
 * ------------------------------------------------------------------ */

function collectTaskGraphIds(tx: SqliteTransaction, rootTaskId: string): string[] {
  const taskIds = new Set([rootTaskId]);
  let frontier = [rootTaskId];

  while (frontier.length > 0) {
    const children = tx.select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.parentId, frontier))
      .all();
    frontier = children
      .map((child) => child.id)
      .filter((childId) => {
        if (taskIds.has(childId)) return false;
        taskIds.add(childId);
        return true;
      });
  }

  return [...taskIds];
}

class SqliteScoutTaskHardDeleteRepository implements ScoutTaskHardDeleteRepository {
  constructor(private readonly runTransaction: SqliteTaskCoreTransactionRunner) {}

  async hardDeleteScoutTask(taskId: string): Promise<ScoutHardDeleteOutcome> {
    return this.runTransaction((tx): ScoutHardDeleteOutcome => {
      const task = tx.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
      }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return { kind: 'not-found' };
      if (task.connectorType !== 'scout') return { kind: 'not-scout' };

      const now = new Date().toISOString();
      const taskIds = collectTaskGraphIds(tx, task.id);
      const suppressions = tx.select({
        id: tasks.id,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceId: tasks.sourceId,
      }).from(tasks).where(inArray(tasks.id, taskIds)).all()
        .filter((candidate) => (
          candidate.connectorType === 'scout'
          && (candidate.id === task.id || !candidate.sourceId.startsWith('local:'))
        ))
        .map((candidate) => ({
          connectorInstanceId: candidate.connectorInstanceId,
          sourceId: candidate.sourceId,
          reason: 'hard-deleted' as const,
          createdAt: now,
        }));

      tx.insert(taskIngestSuppressions).values(suppressions).onConflictDoNothing().run();

      tx.delete(taskDependencies).where(or(
        inArray(taskDependencies.taskId, taskIds),
        inArray(taskDependencies.dependsOnTaskId, taskIds),
      )).run();
      tx.delete(taskTags).where(inArray(taskTags.taskId, taskIds)).run();
      tx.delete(projectAutoIncludeExclusions)
        .where(inArray(projectAutoIncludeExclusions.taskId, taskIds))
        .run();
      tx.delete(taskProjects).where(inArray(taskProjects.taskId, taskIds)).run();
      tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.taskId, taskIds)).run();
      tx.delete(taskSchedules).where(inArray(taskSchedules.taskId, taskIds)).run();
      tx.delete(taskFieldStates).where(inArray(taskFieldStates.taskId, taskIds)).run();
      tx.run(sql.raw('DROP TRIGGER IF EXISTS task_history_immutable_delete'));
      tx.delete(taskHistoryEvents).where(inArray(taskHistoryEvents.taskId, taskIds)).run();
      tx.delete(myDayItems).where(inArray(myDayItems.taskId, taskIds)).run();
      tx.delete(myDayExclusions).where(inArray(myDayExclusions.taskId, taskIds)).run();
      tx.delete(focusItems).where(inArray(focusItems.taskId, taskIds)).run();
      tx.delete(weeklyOneThing).where(inArray(weeklyOneThing.taskId, taskIds)).run();
      tx.delete(prioritySyncLog).where(inArray(prioritySyncLog.taskId, taskIds)).run();
      tx.delete(quickSortLog).where(inArray(quickSortLog.taskId, taskIds)).run();
      tx.delete(quickSortOperations).where(inArray(quickSortOperations.taskId, taskIds)).run();
      tx.delete(scoutReconciliationSuggestions)
        .where(inArray(scoutReconciliationSuggestions.taskId, taskIds))
        .run();
      tx.delete(scoutReconciliationEvaluations)
        .where(inArray(scoutReconciliationEvaluations.taskId, taskIds))
        .run();
      tx.delete(scoutReconciliationTaskState)
        .where(inArray(scoutReconciliationTaskState.taskId, taskIds))
        .run();
      tx.delete(taskAttachments).where(inArray(taskAttachments.taskId, taskIds)).run();
      tx.delete(taskLinkedSources).where(inArray(taskLinkedSources.taskId, taskIds)).run();
      tx.delete(syncDeletionCandidates).where(inArray(syncDeletionCandidates.taskId, taskIds)).run();
      tx.delete(syncDeletionSnapshots)
        .where(or(
          inArray(syncDeletionSnapshots.originalTaskId, taskIds),
          inArray(syncDeletionSnapshots.restoredTaskId, taskIds),
        ))
        .run();
      tx.update(notifications)
        .set({ relatedTaskId: null })
        .where(inArray(notifications.relatedTaskId, taskIds))
        .run();
      tx.delete(tasks).where(inArray(tasks.id, taskIds)).run();
      tx.run(sql.raw(TASK_HISTORY_DELETE_TRIGGER));

      return {
        kind: 'deleted',
        taskId: task.id,
        sourceId: task.sourceId,
        deletedTaskIds: taskIds,
      };
    });
  }
}

/* ------------------------------------------------------------------ *
 * Task moves
 * ------------------------------------------------------------------ */

function attachmentSnapshotPredicates(
  taskId: string,
  attachments: readonly { id: string; size: number; sourceAttachmentId: string | null }[],
): SQL[] {
  return [
    sql`(
      SELECT COUNT(*)
      FROM task_attachments
      WHERE task_id = ${taskId}
    ) = ${attachments.length}`,
    ...attachments.map((attachment) => sql`EXISTS (
      SELECT 1
      FROM task_attachments
      WHERE task_id = ${taskId}
        AND id = ${attachment.id}
        AND size = ${attachment.size}
        AND source_attachment_id IS ${attachment.sourceAttachmentId}
    )`),
  ];
}

class SqliteTaskMoveRepository implements TaskMoveRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly runTransaction: SqliteTaskCoreTransactionRunner,
  ) {}

  async getMoveSource(taskId: string): Promise<TaskMoveSourceRow | null> {
    const [row] = await this.database.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      completedAt: tasks.completedAt,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ?? null;
  }

  async listTaskAttachments(taskId: string): Promise<TaskAttachmentRow[]> {
    const rows = await this.database.select().from(taskAttachments)
      .where(eq(taskAttachments.taskId, taskId));
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      contentBase64: row.contentBase64 ?? null,
      sourceAttachmentId: row.sourceAttachmentId ?? null,
      createdAt: row.createdAt,
    }));
  }

  async taskExists(taskId: string): Promise<boolean> {
    const [row] = await this.database.select({ id: tasks.id })
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return Boolean(row);
  }

  async findTargetList(
    connectorInstanceId: string,
    listIdOrSourceId: string,
  ): Promise<TaskMoveTargetList | null> {
    const [row] = await this.database
      .select({ id: sourceLists.id, sourceId: sourceLists.sourceId })
      .from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        or(
          eq(sourceLists.id, listIdOrSourceId),
          eq(sourceLists.sourceId, listIdOrSourceId),
        ),
      ))
      .limit(1);
    return row ?? null;
  }

  async executePendingSyncMove(
    request: PendingSyncTaskMoveRequest,
  ): Promise<PendingSyncTaskMoveOutcome> {
    const source = await this.getMoveSource(request.sourceTaskId);
    if (!source) return { kind: 'not-found' };
    const attachments = await this.listTaskAttachments(request.sourceTaskId);

    try {
      this.runTransaction((tx) => {
        const claim = tx.update(tasks).set({
          updatedAt: sql`${tasks.updatedAt}`,
        }).where(and(
          eq(tasks.id, request.sourceTaskId),
          eq(tasks.sourceId, request.expectedSourceId),
          eq(tasks.updatedAt, request.expectedUpdatedAt),
          ...attachmentSnapshotPredicates(
            request.sourceTaskId,
            request.attachmentSnapshot,
          ),
        )).run();
        if (claim.changes !== 1) {
          throw new PendingTaskMoveSourceChangedError();
        }

        tx.insert(tasks).values({
          id: request.newTaskId,
          sourceId: `local:${request.newTaskId}`,
          connectorType: request.targetConnectorType,
          connectorInstanceId: request.targetConnectorInstanceId,
          title: source.title,
          description: source.description,
          status: source.status,
          priority: source.priority,
          dueDate: source.dueDate,
          createdAt: source.createdAt,
          updatedAt: request.now,
          completedAt: source.completedAt,
          depth: 0,
          isChecklistItem: false,
          sourceListId: request.targetSourceListId ?? undefined,
          metadata: '{}',
          syncStatus: 'pending_push',
          lastSyncedAt: request.now,
        }).run();

        if (request.keepTags) {
          const sourceTags = tx.select().from(taskTags)
            .where(eq(taskTags.taskId, request.sourceTaskId)).all();
          if (sourceTags.length > 0) {
            tx.insert(taskTags).values(
              sourceTags.map((tag) => ({ taskId: request.newTaskId, tagId: tag.tagId })),
            ).run();
          }
        }

        const sourceSchedules = tx.select().from(taskSchedules)
          .where(eq(taskSchedules.taskId, request.sourceTaskId)).all();
        if (sourceSchedules.length > 0) {
          tx.delete(taskSchedules)
            .where(eq(taskSchedules.taskId, request.sourceTaskId)).run();
          tx.insert(taskSchedules).values(
            sourceSchedules.map((schedule) => ({ ...schedule, taskId: request.newTaskId })),
          ).run();
        }

        if (attachments.length > 0) {
          tx.insert(taskAttachments).values(
            attachments.map((attachment) => ({
              ...attachment,
              id: crypto.randomUUID(),
              taskId: request.newTaskId,
              sourceAttachmentId: null,
            })),
          ).run();
        }

        repointTaskReferences(tx, request.sourceTaskId, request.newTaskId);

        tx.delete(taskAttachments)
          .where(eq(taskAttachments.taskId, request.sourceTaskId)).run();
        tx.delete(taskTags).where(eq(taskTags.taskId, request.sourceTaskId)).run();
        tx.delete(tasks).where(eq(tasks.id, request.sourceTaskId)).run();
      });
    } catch (error) {
      if (error instanceof PendingTaskMoveSourceChangedError) {
        return await this.taskExists(request.sourceTaskId)
          ? { kind: 'source-changed' }
          : { kind: 'not-found' };
      }
      throw error;
    }

    return { kind: 'moved' };
  }
}

/* ------------------------------------------------------------------ *
 * Write-through task move
 * ------------------------------------------------------------------ */

class WriteThroughMoveSourceChangedError extends Error {
  constructor() {
    super('Task changed before the move could be finalized');
    this.name = 'WriteThroughMoveSourceChangedError';
  }
}

const MOVE_TASK_COLUMNS = {
  id: tasks.id,
  sourceId: tasks.sourceId,
  connectorType: tasks.connectorType,
  connectorInstanceId: tasks.connectorInstanceId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  localDisposition: tasks.localDisposition,
  priority: tasks.priority,
  planningHorizon: tasks.planningHorizon,
  dueDate: tasks.dueDate,
  pushCount: tasks.pushCount,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  completedAt: tasks.completedAt,
  recurrenceGeneratedFromTaskId: tasks.recurrenceGeneratedFromTaskId,
  parentId: tasks.parentId,
  depth: tasks.depth,
  isChecklistItem: tasks.isChecklistItem,
  sourceListId: tasks.sourceListId,
  sourceListName: tasks.sourceListName,
  assignee: tasks.assignee,
  microStatus: tasks.microStatus,
  statusReason: tasks.statusReason,
  metadata: tasks.metadata,
  syncStatus: tasks.syncStatus,
  lastSyncedAt: tasks.lastSyncedAt,
  pushRetryCount: tasks.pushRetryCount,
  kanbanColumn: tasks.kanbanColumn,
  kanbanOrder: tasks.kanbanOrder,
  snoozedUntil: tasks.snoozedUntil,
  reminderAt: tasks.reminderAt,
  reminderRelative: tasks.reminderRelative,
  reminderDueTime: tasks.reminderDueTime,
  effort: tasks.effort,
  isBulkImport: tasks.isBulkImport,
};

type RawMoveTaskRow = {
  [K in keyof typeof MOVE_TASK_COLUMNS]: unknown;
};

function toMoveTaskRow(row: RawMoveTaskRow): TaskMoveTaskRow {
  return {
    ...(row as unknown as TaskMoveTaskRow),
    metadata: parseMetadata(row.metadata),
  };
}

/** The insert payload every task write in this repository shares. */
function moveTaskInsertValues(task: TaskMoveTaskInsert) {
  return {
    ...task,
    planningHorizon: task.planningHorizon ?? null,
    localDisposition: task.localDisposition,
    metadata: JSON.stringify(task.metadata),
  };
}

class SqliteWriteThroughTaskMoveRepository implements WriteThroughTaskMoveRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly runTransaction: SqliteTaskCoreTransactionRunner,
  ) {}

  async getTask(taskId: string): Promise<TaskMoveTaskRow | null> {
    const [row] = await this.database.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ? toMoveTaskRow(row) : null;
  }

  async listChildTasks(parentTaskId: string, limit: number): Promise<TaskMoveTaskRow[]> {
    const rows = await this.database.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.parentId, parentTaskId)).limit(limit);
    return rows.map(toMoveTaskRow);
  }

  async listTaskTagRefs(taskId: string): Promise<TaskMoveTagRef[]> {
    const rows = await this.database.select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      color: tags.color,
    })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(eq(taskTags.taskId, taskId));
    return rows.map((row) => ({ ...row, color: row.color ?? null }));
  }

  async listAttachmentMetadata(
    taskIds: readonly string[],
    limit: number,
  ): Promise<TaskAttachmentMetadataRow[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.database.select({
      id: taskAttachments.id,
      taskId: taskAttachments.taskId,
      name: taskAttachments.name,
      contentType: taskAttachments.contentType,
      size: taskAttachments.size,
      sourceAttachmentId: taskAttachments.sourceAttachmentId,
      createdAt: taskAttachments.createdAt,
    })
      .from(taskAttachments)
      .where(inArray(taskAttachments.taskId, [...taskIds]))
      .limit(limit);
    return rows.map((row) => ({ ...row, sourceAttachmentId: row.sourceAttachmentId ?? null }));
  }

  async listAttachmentContents(
    attachmentIds: readonly string[],
  ): Promise<TaskAttachmentContentRow[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await this.database.select({
      id: taskAttachments.id,
      contentBase64: taskAttachments.contentBase64,
    })
      .from(taskAttachments)
      .where(inArray(taskAttachments.id, [...attachmentIds]));
    return rows.map((row) => ({ id: row.id, contentBase64: row.contentBase64 ?? null }));
  }

  async getTaskSchedule(taskId: string): Promise<TaskScheduleRow | null> {
    const [row] = await this.database.select().from(taskSchedules)
      .where(eq(taskSchedules.taskId, taskId)).limit(1);
    return row ?? null;
  }

  async findTargetListBySourceId(
    connectorInstanceId: string,
    sourceListId: string,
  ): Promise<TaskMoveListRow | null> {
    const [row] = await this.database
      .select({ id: sourceLists.id, name: sourceLists.name, sourceId: sourceLists.sourceId })
      .from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        eq(sourceLists.sourceId, sourceListId),
      ))
      .limit(1);
    return row ?? null;
  }

  async claimTaskMove(request: TaskMoveClaimRequest): Promise<boolean> {
    return this.runTransaction((tx) => {
      const result = tx.update(tasks).set({
        syncStatus: request.claimSyncStatus,
        metadata: request.metadata,
      }).where(and(
        eq(tasks.id, request.taskId),
        eq(tasks.sourceId, request.expectedSourceId),
        eq(tasks.syncStatus, request.expectedSyncStatus),
      )).run();
      return result.changes === 1;
    });
  }

  async releaseTaskMoveClaim(request: TaskMoveClaimReleaseRequest): Promise<void> {
    this.runTransaction((tx) => {
      tx.update(tasks).set({
        syncStatus: request.syncStatus,
        metadata: request.metadata,
      }).where(and(
        eq(tasks.id, request.taskId),
        sql`json_extract(${tasks.metadata}, '$.taskMoveClaim.token') = ${request.claimToken}`,
      )).run();
    });
  }

  async discardMaterializedDestination(taskId: string): Promise<void> {
    this.runTransaction((tx) => {
      tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
      tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
      tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
      tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId)).run();
      tx.delete(tasks).where(eq(tasks.id, taskId)).run();
    });
  }

  async materializeDestination(
    request: TaskMoveDestinationMaterialization,
  ): Promise<void> {
    this.runTransaction((tx) => {
      tx.insert(tasks).values(moveTaskInsertValues(request.task)).run();

      if (request.tagIds.length > 0) {
        tx.insert(taskTags).values(
          request.tagIds.map((tagId) => ({ taskId: request.task.id, tagId })),
        ).run();
      }

      if (request.copyProjectsFromTaskId) {
        const sourceProjects = tx.select().from(taskProjects)
          .where(eq(taskProjects.taskId, request.copyProjectsFromTaskId)).all();
        if (sourceProjects.length > 0) {
          tx.insert(taskProjects).values(
            sourceProjects.map((row) => ({ taskId: request.task.id, projectId: row.projectId })),
          ).run();
        }
      }

      if (request.schedule) {
        tx.insert(taskSchedules)
          .values({ ...request.schedule, taskId: request.task.id }).run();
      }

      if (request.attachments.length > 0) {
        tx.insert(taskAttachments).values(request.attachments.map(toAttachmentInsert)).run();
      }

      for (const subtask of request.subtaskCopies) {
        tx.insert(tasks).values(moveTaskInsertValues(subtask.task)).run();

        const subtaskTags = tx.select().from(taskTags)
          .where(eq(taskTags.taskId, subtask.copyFromTaskId)).all();
        if (subtaskTags.length > 0) {
          tx.insert(taskTags).values(
            subtaskTags.map((tag) => ({ taskId: subtask.task.id, tagId: tag.tagId })),
          ).run();
        }

        const subtaskProjects = tx.select().from(taskProjects)
          .where(eq(taskProjects.taskId, subtask.copyFromTaskId)).all();
        if (subtaskProjects.length > 0) {
          tx.insert(taskProjects).values(
            subtaskProjects.map((project) => ({
              taskId: subtask.task.id,
              projectId: project.projectId,
            })),
          ).run();
        }

        const subtaskSchedules = tx.select().from(taskSchedules)
          .where(eq(taskSchedules.taskId, subtask.copyFromTaskId)).all();
        if (subtaskSchedules.length > 0) {
          tx.insert(taskSchedules).values(
            subtaskSchedules.map((schedule) => ({ ...schedule, taskId: subtask.task.id })),
          ).run();
        }

        if (subtask.attachments.length > 0) {
          tx.insert(taskAttachments)
            .values(subtask.attachments.map(toAttachmentInsert)).run();
        }
      }
    });
  }

  async finalizeMove(
    request: TaskMoveFinalizationRequest,
  ): Promise<TaskMoveFinalizationOutcome> {
    try {
      this.runTransaction((tx) => {
        const sourceUnchanged = tx.update(tasks).set({
          updatedAt: sql`${tasks.updatedAt}`,
        }).where(and(
          eq(tasks.id, request.sourceTaskId),
          sql`json_extract(${tasks.metadata}, '$.taskMoveClaim.token') = ${request.claimToken}`,
          ...attachmentSnapshotPredicates(
            request.sourceTaskId,
            request.attachmentSnapshot,
          ),
        )).run();
        if (sourceUnchanged.changes !== 1) {
          throw new WriteThroughMoveSourceChangedError();
        }

        repointTaskReferences(tx, request.sourceTaskId, request.successorTaskId);

        for (const repoint of request.subtaskRepoints) {
          tx.update(tasks).set({
            sourceId: repoint.sourceId,
            connectorType: repoint.connectorType,
            connectorInstanceId: repoint.connectorInstanceId,
            sourceListId: repoint.sourceListId,
            sourceListName: repoint.sourceListName,
            parentId: repoint.parentId,
            updatedAt: repoint.updatedAt,
            syncStatus: repoint.syncStatus,
            lastSyncedAt: repoint.lastSyncedAt,
          }).where(eq(tasks.id, repoint.taskId)).run();
          tx.delete(taskAttachments)
            .where(eq(taskAttachments.taskId, repoint.taskId)).run();
          if (repoint.attachments.length > 0) {
            tx.insert(taskAttachments)
              .values(repoint.attachments.map(toAttachmentInsert)).run();
          }
        }

        tx.delete(taskSchedules)
          .where(eq(taskSchedules.taskId, request.sourceTaskId)).run();
        tx.delete(taskAttachments)
          .where(eq(taskAttachments.taskId, request.sourceTaskId)).run();

        if (request.sourceDisposition.kind === 'delete') {
          tx.delete(taskTags).where(eq(taskTags.taskId, request.sourceTaskId)).run();
          tx.delete(tasks).where(eq(tasks.id, request.sourceTaskId)).run();
        } else {
          const disposition = request.sourceDisposition;
          tx.update(tasks).set({
            status: disposition.status,
            statusReason: disposition.statusReason,
            description: disposition.description,
            updatedAt: disposition.updatedAt,
            syncStatus: disposition.syncStatus,
            metadata: JSON.stringify(disposition.metadata),
          }).where(eq(tasks.id, request.sourceTaskId)).run();
        }
      });
    } catch (error) {
      if (error instanceof WriteThroughMoveSourceChangedError) {
        return { kind: 'source-changed' };
      }
      throw error;
    }
    return { kind: 'finalized' };
  }

  async recordSourceSyncIntent(request: TaskMoveSourceSyncIntent): Promise<void> {
    await this.database.update(tasks).set({
      syncStatus: request.syncStatus,
      metadata: JSON.stringify(request.metadata),
    }).where(eq(tasks.id, request.taskId));
  }

  async recordSourceCopyProvenance(
    request: TaskMoveSourceCopyProvenance,
  ): Promise<void> {
    this.runTransaction((tx) => {
      const current = tx.select({ metadata: tasks.metadata })
        .from(tasks)
        .where(eq(tasks.id, request.taskId))
        .limit(1)
        .get();
      if (!current) return;
      tx.update(tasks).set({
        updatedAt: request.updatedAt,
        metadata: JSON.stringify({
          ...decodeLenientJsonObject(current.metadata),
          copiedTo: request.copiedTo,
        }),
      }).where(eq(tasks.id, request.taskId)).run();
    });
  }
}

function toAttachmentInsert(attachment: TaskAttachmentInsert) {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    contentBase64: attachment.contentBase64 ?? null,
    sourceAttachmentId: attachment.sourceAttachmentId ?? null,
    createdAt: attachment.createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * Priority entities and source-list names
 * ------------------------------------------------------------------ */

class SqlitePriorityEntityRepository implements PriorityEntityRepository {
  constructor(private readonly database: Drizzle) {}

  async listPriorityEntitiesByRank(): Promise<PriorityEntityRow[]> {
    const rows = await this.database.select()
      .from(priorityEntities)
      .orderBy(
        asc(priorityEntities.rank),
        asc(sql`${priorityEntities.id} COLLATE BINARY`),
      );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      referenceId: row.referenceId ?? null,
      description: row.description ?? null,
      tier: row.tier,
      color: row.color,
      rank: row.rank,
      activeTaskCount: row.activeTaskCount,
      lastTouchedAt: row.lastTouchedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async getProjectReference(projectId: string): Promise<PriorityProjectReference | null> {
    const [row] = await this.database.select({
      id: schema.hubProjects.id,
      name: schema.hubProjects.name,
      description: schema.hubProjects.description,
      color: schema.hubProjects.color,
    }).from(schema.hubProjects).where(eq(schema.hubProjects.id, projectId)).limit(1);
    return row
      ? { id: row.id, name: row.name, description: row.description ?? null, color: row.color ?? null }
      : null;
  }

  async getTagReference(tagId: string): Promise<PriorityTagReference | null> {
    const [row] = await this.database.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      unifiedInto: tags.unifiedInto,
    }).from(tags).where(eq(tags.id, tagId)).limit(1);
    return row
      ? { id: row.id, name: row.name, color: row.color ?? null, unifiedInto: row.unifiedInto ?? null }
      : null;
  }

  async getSourceListReference(
    connectorInstanceId: string,
    sourceId: string,
  ): Promise<PrioritySourceListReference | null> {
    const [row] = await this.database.select({
      connectorInstanceId: sourceLists.connectorInstanceId,
      sourceId: sourceLists.sourceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
      color: sourceLists.iconColor,
    }).from(sourceLists).where(and(
      eq(sourceLists.connectorInstanceId, connectorInstanceId),
      eq(sourceLists.sourceId, sourceId),
    )).limit(1);
    return row
      ? {
          connectorInstanceId: row.connectorInstanceId,
          sourceId: row.sourceId,
          name: row.name,
          userDisplayName: row.userDisplayName ?? null,
          color: row.color ?? null,
        }
      : null;
  }

  async listProjectReferences(): Promise<PriorityProjectReference[]> {
    const rows = await this.database.select({
      id: schema.hubProjects.id,
      name: schema.hubProjects.name,
      description: schema.hubProjects.description,
      color: schema.hubProjects.color,
    }).from(schema.hubProjects);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      color: row.color ?? null,
    }));
  }

  async listTagReferences(): Promise<PriorityTagReference[]> {
    const rows = await this.database.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      unifiedInto: tags.unifiedInto,
    }).from(tags);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? null,
      unifiedInto: row.unifiedInto ?? null,
    }));
  }

  async listSourceListReferences(): Promise<PrioritySourceListReference[]> {
    const rows = await this.database.select({
      connectorInstanceId: sourceLists.connectorInstanceId,
      sourceId: sourceLists.sourceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
      color: sourceLists.iconColor,
    }).from(sourceLists);
    return rows.map((row) => ({
      connectorInstanceId: row.connectorInstanceId,
      sourceId: row.sourceId,
      name: row.name,
      userDisplayName: row.userDisplayName ?? null,
      color: row.color ?? null,
    }));
  }
}

class SqliteSourceListNameRepository implements SourceListNameRepository {
  constructor(private readonly database: Drizzle) {}

  async listSourceListDisplayNames(
    sourceListIds: readonly string[],
  ): Promise<SourceListDisplayNameRow[]> {
    const uniqueIds = [...new Set(sourceListIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const rows = await this.database.select({
      connectorInstanceId: sourceLists.connectorInstanceId,
      sourceId: sourceLists.sourceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
    }).from(sourceLists).where(inArray(sourceLists.sourceId, uniqueIds));
    return rows.map((row) => ({
      connectorInstanceId: row.connectorInstanceId,
      sourceId: row.sourceId,
      name: row.name,
      userDisplayName: row.userDisplayName ?? null,
    }));
  }
}

class SqliteTaskTransferIdentityRepository implements TaskTransferIdentityRepository {
  constructor(
    private readonly database: Drizzle,
    private readonly runTransaction: SqliteTaskCoreTransactionRunner,
  ) {}

  async resolveIdentityTargets(input: {
    taskId: string;
    connectorInstanceId: string;
    sourceListIds: readonly string[];
  }): Promise<{
    taskExists: boolean;
    taskMetadata: Record<string, unknown>;
    sourceLists: readonly { sourceId: string; localId: string }[];
  }> {
    return resolveSqliteTaskTransferIdentityTargetsForRepository(this.database, input);
  }

  async reconcileTaskRefresh(input: {
    taskId: string;
    connectorInstanceId: string;
    task: {
      sourceId: string; sourceListId: string | null; sourceListName: string | null;
      title: string; description: string | null; status: string; statusReason: string | null;
      priority: string; effort: number | null; microStatus: string | null; assignee: string | null;
      updatedAt: string; completedAt: string | null; metadata: Record<string, unknown>;
    };
    observedAt: string;
  }): Promise<boolean> {
    return reconcileSqliteTaskTransferIdentityRefreshForRepository(
      this.runTransaction,
      input,
    );
  }
}

/* ------------------------------------------------------------------ */

/**
 * Builds the SQLite task-core composition. Both the read handle and the
 * transaction runner are required, and every repository — reader and writer —
 * is constructed from exactly this pair. There is no module-level fallback, so
 * an injected database can never be read while writes land somewhere else.
 */
export function createSqliteTaskCorePersistence(
  database: Drizzle,
  transactionRunner: SqliteTaskCoreTransactionRunner,
): TaskCorePersistence {
  const filterInputs = new SqliteTaskFilterInputRepository(database);
  return {
    taskReads: new SqliteTaskReadRepository(database, filterInputs),
    filterInputs,
    queries: new SqliteTaskQueryRepository(database, filterInputs),
    policyIdentities: new SqliteTaskPolicyIdentityRepository(database),
    lifecycle: new SqliteLocalTaskLifecycleRepository(database, transactionRunner),
    scoutDeletion: new SqliteScoutTaskHardDeleteRepository(transactionRunner),
    moves: new SqliteTaskMoveRepository(database, transactionRunner),
    writeThroughMoves: new SqliteWriteThroughTaskMoveRepository(database, transactionRunner),
    priorityEntities: new SqlitePriorityEntityRepository(database),
    sourceListNames: new SqliteSourceListNameRepository(database),
    transferIdentity: new SqliteTaskTransferIdentityRepository(database, transactionRunner),
  };
}

export const sqliteTaskCorePersistence = createSqliteTaskCorePersistence(db, runTransaction);
