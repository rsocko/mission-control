import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  appSettings,
  connectorConfigs,
  eventOutbox,
  eventOutboxDeliveries,
  focusItems,
  hubProjects,
  myDayExclusions,
  myDayItems,
  notifications,
  outboundWebhooks,
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
  subtaskTemplates,
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
  taskReminderOccurrences,
  taskSchedules,
  taskTags,
  tasks,
  triageActionClaims,
  triageItems,
  weeklyOneThing,
} from '../schema';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import {
  compileCanonicalTaskFilter,
  compileQuickFilterCondition,
  enabledGitHubConnectorCondition,
  withCondition,
  type PostgresCanonicalTaskFilterInputs,
} from './task-core-filter';
import {
  bindPostgresTaskTransferIdentityDrizzleTransaction,
  reconcilePostgresTaskTransferIdentityRefreshInTransaction,
  resolvePostgresTaskTransferIdentityTargets,
} from './task-transfer-identity';
import { decodeLenientJsonArray, decodeLenientJsonObject } from '@/db/persistence/value-codecs';
import { eventSubscriptionMatches, parseEventTypes } from '@/db/persistence/event-outbox';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import {
  CLOSED_TASK_STATUSES,
  parseTaskQuickSortAction,
  parseTaskQuickSortOperationState,
  parseTaskQuickSortQueueMode,
  type AvailableTaskTag,
  type InboxListEntry,
  type LocalTaskDeletionRequest,
  type LocalTaskLifecycleRepository,
  type PendingSyncTaskMoveOutcome,
  type PendingSyncTaskMoveRequest,
  type PriorityEntityRepository,
  type PriorityEntityCreate,
  type PriorityEntityOptions,
  type PriorityEntityRow,
  type PriorityEntityUpdate,
  type PriorityProjectReference,
  type PrioritySourceListReference,
  type PrioritySyncLogRow,
  type PriorityTagReference,
  type RetentionTaskIdentity,
  type RetentionTaskRow,
  type ScoutHardDeleteOutcome,
  type ScoutTaskHardDeleteRepository,
  type SourceListDisplayNameRow,
  type SourceListNameRepository,
  type SubtaskTemplateApplicationPlan,
  type SubtaskTemplateDeleteOutcome,
  type SubtaskTemplateItem,
  type SubtaskTemplatePatch,
  type SubtaskTemplateRow,
  type SubtaskTemplateSeed,
  type SubtaskTemplateWorkflowTask,
  type SubtaskTemplateWrite,
  type TagConsolidationCandidates,
  type TagCreateOutcome,
  type TagDeleteOutcome,
  type TagIdentityRow,
  type TagListUsageRow,
  type TagMergeOutcome,
  type TagOverviewResult,
  type TagSourceRemovalContext,
  type TagUnifyOutcome,
  type TaskAttachmentContentRow,
  type TaskAttachmentInsert,
  type TaskAttachmentInsertOutcome,
  type TaskAttachmentListContext,
  type TaskAttachmentDeleteContext,
  type TaskAttachmentMetadataRow,
  type TaskAttachmentRow,
  type TaskAncillaryRepository,
  type TaskAncillarySubtask,
  type TaskCollectionProjectPhaseMembership,
  type TaskCollectionReadRepository,
  type TaskCollectionResult,
  type TaskCollectionRow,
  type TaskCoreEvent,
  type TaskCoreTaskRow,
  type TaskCreateInput,
  type TaskCreateOutcome,
  type TaskCreateRepository,
  type TaskCreateTargetOutcome,
  type TaskCopyOutcome,
  type TaskCorePersistence,
  type TaskDetailReadRepository,
  type TaskDetailResult,
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
  type TaskMovePreviewSnapshot,
  type TaskMoveRepository,
  type TaskMoveSourceCopyProvenance,
  type TaskMoveSourceRow,
  type TaskMoveSourceSyncIntent,
  type TaskMoveTagRef,
  type TaskMoveTargetList,
  type TaskMoveToListTaskRow,
  type TaskMutationOutcome,
  type TaskMutationRepository,
  type TaskMutationRequest,
  type TaskMoveTaskInsert,
  type TaskMoveTaskRow,
  type TaskOrganizationRepository,
  type TaskPolicyIdentityRepository,
  type TaskQueryRepository,
  type TaskQueryScope,
  type TaskRemovalOutcome,
  type TaskRemovalRepository,
  type TaskQuickSortLogEntry,
  type TaskQuickSortOperation,
  type TaskQuickSortOperationReservation,
  type TaskQuickSortOrder,
  type TaskQuickSortPersistenceRepository,
  type TaskQuickSortQueueMode,
  type TaskQuickSortQueueRow,
  type TaskQuickSortReservationOutcome,
  type TaskQuickSortScope,
  type TaskQuickSortSuggestionInputs,
  type TaskReadRepository,
  type TaskRelationshipCandidateRow,
  type TaskPromoteOutcome,
  type TaskScheduleRow,
  type TaskSmartScoreSnapshot,
  type TaskSourceCounts,
  type TaskSourceIdentityRow,
  type TaskStatsResult,
  type TaskTransferIdentityRepository,
  type TaskSubtaskCreateOutcome,
  type TaskSubtaskProposalOutcome,
  type TaskSubtaskProposalSnapshot,
  type TaskTagMutationContext,
  type TaskTagMutationResult,
  type TemplateSubtaskApplicationOutcome,
  type TemplateSubtaskInsert,
  type TemplateWorkflowTaskInsert,
  type WriteThroughTaskMoveRepository,
} from '@/lib/tasks/core/contracts';

/**
 * PostgreSQL implementation of the L04 task-core contracts.
 *
 * Unlike the SQLite sibling, every mutating operation here runs inside a real
 * asynchronous transaction (`db.transaction(async tx => ...)`), so `await` is
 * legitimate mid-transaction. The externally observable guarantees are the
 * ones the contract suite pins: a move either fully lands or leaves the source
 * untouched, and a Scout hard delete either writes both the graph deletion and
 * its ingest-suppression tombstones or neither.
 */

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Filter inputs
 * ------------------------------------------------------------------ */

class PostgresTaskFilterInputRepository implements TaskFilterInputRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async listMyDayTaskIds(date: string): Promise<string[]> {
    const rows = await this.db
      .select({ taskId: myDayItems.taskId })
      .from(myDayItems)
      .where(eq(myDayItems.date, date));
    return rows.map((row) => row.taskId);
  }

  async listAssignedGitHubUsernames(): Promise<string[]> {
    const rows = await this.db
      .select({ settings: connectorConfigs.settings })
      .from(connectorConfigs)
      .where(enabledGitHubConnectorCondition());

    const usernames: string[] = [];
    for (const row of rows) {
      const authenticatedUser = asRecord(row.settings).authenticatedUser;
      if (typeof authenticatedUser === 'string' && authenticatedUser) {
        usernames.push(authenticatedUser);
      }
    }
    return usernames;
  }

  async listInboxListEntries(): Promise<InboxListEntry[]> {
    const [row] = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'inbox.lists'))
      .limit(1);
    if (!row?.value) return [];

    return asArray(row.value).flatMap((entry): InboxListEntry[] => {
      const record = asRecord(entry);
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
const PLANNING_HORIZON_ORDER_EXPRESSION = sql`CASE ${tasks.planningHorizon}
  WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2
  WHEN 'someday' THEN 3 ELSE 4 END`;

/**
 * Explicit NULL placement for the nullable sort columns (`dueDate`,
 * `sourceListName`). PostgreSQL defaults to NULLS LAST ascending / FIRST
 * descending, which is the opposite of SQLite's "NULL is the lowest value".
 * The observable ordering of the legacy `/api/tasks` route is the SQLite one,
 * so both adapters state it explicitly instead of inheriting a dialect
 * default. `effort` needs no rank: `EFFORT_ORDER_EXPRESSION` coalesces NULL
 * away on both backends.
 */
type NullableSortColumn =
  | typeof tasks.dueDate
  | typeof tasks.completedAt
  | typeof tasks.sourceListName;

function nullsLowestRank(column: NullableSortColumn): SQL {
  return sql`CASE WHEN ${column} IS NULL THEN 0 ELSE 1 END`;
}

function nullableSortColumn(field: TaskListPage['order']['field']): NullableSortColumn | null {
  if (field === 'dueDate') return tasks.dueDate;
  if (field === 'completedAt') return tasks.completedAt;
  if (field === 'sourceList') return tasks.sourceListName;
  return null;
}

class PostgresTaskQueryRepository implements TaskQueryRepository {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly filterInputs: TaskFilterInputRepository,
  ) {}

  private async resolveInputs(
    spec: TaskFilterSpec,
  ): Promise<PostgresCanonicalTaskFilterInputs> {
    const [myDayTaskIds, assignedGitHubUsernames, inboxListEntries] = await Promise.all([
      this.filterInputs.listMyDayTaskIds(spec.myDayDate),
      this.filterInputs.listAssignedGitHubUsernames(),
      this.filterInputs.listInboxListEntries(),
    ]);
    return { myDayTaskIds, assignedGitHubUsernames, inboxListEntries };
  }

  private async countWhere(where: SQL | undefined): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(where);
    return Number(row?.count ?? 0);
  }

  async countTasks(spec: TaskFilterSpec, scope: TaskQueryScope = {}): Promise<number> {
    const compiled = compileCanonicalTaskFilter(spec, await this.resolveInputs(spec));
    const where = scope.includeQuickFilter ? compiled.taskWhere : compiled.baseWhere;
    return this.countWhere(scope.availableAt
      ? and(where, or(isNull(tasks.snoozedUntil), lte(tasks.snoozedUntil, scope.availableAt)))
      : where);
  }

  async listTaskIds(spec: TaskFilterSpec, page: TaskListPage): Promise<string[]> {
    const compiled = compileCanonicalTaskFilter(spec, await this.resolveInputs(spec));
    const direction = page.order.direction === 'desc' ? desc : asc;
    const column = page.order.field === 'dueDate'
      ? tasks.dueDate
          : page.order.field === 'planningHorizon'
            ? PLANNING_HORIZON_ORDER_EXPRESSION
          : page.order.field === 'title'
            ? tasks.title
          : page.order.field === 'createdAt'
            ? tasks.createdAt
          : page.order.field === 'completedAt'
            ? tasks.completedAt
          : page.order.field === 'updatedAt'
            || page.order.field === 'updated'
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
      ? sql`${column} COLLATE "C"`
      : column;

    const smartOrder = page.order.field === 'smartScore'
      ? [
          asc(PRIORITY_ORDER_EXPRESSION),
          asc(sql`CASE WHEN ${tasks.dueDate} IS NULL THEN 1 ELSE 0 END`),
          asc(tasks.dueDate),
          desc(tasks.updatedAt),
          asc(sql`${tasks.id} COLLATE "C"`),
        ]
      : null;
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(compiled.taskWhere)
      // `id` is the deterministic tie-break so two backends can never
      // disagree about the page boundary for equal sort keys.
      .orderBy(
        ...(smartOrder ?? [
          ...(nullable ? [direction(nullsLowestRank(nullable))] : []),
          direction(orderedColumn),
          asc(sql`${tasks.id} COLLATE "C"`),
        ]),
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
    const compiled = compileCanonicalTaskFilter(spec, await this.resolveInputs(spec));
    const rows = await this.db
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
    const compiled = compileCanonicalTaskFilter(spec, await this.resolveInputs(spec));
    const rows = await this.db
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
        asc(sql`${tags.name} COLLATE "C"`),
        asc(sql`${tags.id} COLLATE "C"`),
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

function postgresListGroupExpression(): SQL<string> {
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

function postgresScalarGroupExpression(
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
  if (groupBy === 'list') return postgresListGroupExpression();
  if (groupBy === 'effort') {
    return sql<string>`CASE
      WHEN ${tasks.effort} IS NULL THEN ${NO_EFFORT_GROUP_LABEL}
      ELSE CAST(${tasks.effort} AS TEXT)
    END`;
  }
  const exhaustive: never = groupBy;
  throw new Error(`Unsupported task group: ${exhaustive}`);
}

class PostgresTaskReadRepository implements TaskReadRepository {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly filterInputs: TaskFilterInputRepository,
  ) {}

  private async resolveInputs(spec: TaskFilterSpec): Promise<PostgresCanonicalTaskFilterInputs> {
    const [myDayTaskIds, assignedGitHubUsernames, inboxListEntries] = await Promise.all([
      this.filterInputs.listMyDayTaskIds(spec.myDayDate),
      this.filterInputs.listAssignedGitHubUsernames(),
      this.filterInputs.listInboxListEntries(),
    ]);
    return { myDayTaskIds, assignedGitHubUsernames, inboxListEntries };
  }

  async getAttachmentReadContext(taskId: string, attachmentId: string) {
    const [row] = await this.db.select({
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
    const [row] = await this.db.select({
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
    const rows = await this.db.select({
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
    const [sourceTask] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (!sourceTask) return null;

    const boundedLimit = Math.max(1, Math.min(input.limit, 50));
    const normalizedQuery = input.query.trim();
    const candidateRows = await this.db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      connectorType: tasks.connectorType,
      sourceListName: tasks.sourceListName,
    }).from(tasks).where(and(
      ne(tasks.id, input.taskId),
      normalizedQuery
        ? sql`${tasks.title} COLLATE "C" ILIKE ${`%${normalizedQuery}%`} ESCAPE ''`
        : undefined,
    )).orderBy(
      asc(sql`${tasks.title} COLLATE "C"`),
      asc(sql`${tasks.id} COLLATE "C"`),
    ).limit(boundedLimit);

    const candidateIds = candidateRows.map((candidate) => candidate.id);
    if (candidateIds.length === 0) return [];
    const membershipRows = await this.db.select({
      taskId: taskProjects.taskId,
      projectId: taskProjects.projectId,
    }).from(taskProjects).where(inArray(taskProjects.taskId, candidateIds));
    const projectIds = [...new Set(membershipRows.map((row) => row.projectId))];
    const projectRows = projectIds.length > 0
      ? await this.db.select({
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
    return this.db.select({
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
    const rows = await this.db
      .select({ assignee: tasks.assignee })
      .from(tasks)
      .where(isNotNull(tasks.assignee))
      .groupBy(tasks.assignee)
      .orderBy(asc(sql`${tasks.assignee} COLLATE "C"`));
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
        this.db.select({
          group: tags.name,
          count: sql<number>`count(DISTINCT ${tasks.id})`,
        }).from(tasks)
          .innerJoin(taskTags, eq(taskTags.taskId, tasks.id))
          .innerJoin(tags, eq(tags.id, taskTags.tagId))
          .where(taskWhere)
          .groupBy(tags.name),
        this.db.select({ count: sql<number>`count(*)` })
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
      const projectRows = await this.db.select({
        taskId: taskProjects.taskId,
        projectId: taskProjects.projectId,
        projectName: hubProjects.name,
      }).from(tasks)
        .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
        .innerJoin(hubProjects, eq(hubProjects.id, taskProjects.projectId))
        .where(taskWhere);
      const taskIds = [...new Set(projectRows.map((row) => row.taskId))];
      const phaseRows = taskIds.length > 0
        ? await this.db.select({
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
      const [unprojected] = await this.db.select({ count: sql<number>`count(*)` })
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
      : postgresScalarGroupExpression(input.groupBy);
    const rows = await this.db.select({
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
    const rows = await this.db.select({
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
    const definitions = await this.db.select({
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
      const [row] = await this.db.select({ count: sql<number>`count(*)` })
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
        asc(sql`${tasks.id} COLLATE "C"`),
      ];
    } else if (input.order === 'oldest') {
      orderClauses = [asc(tasks.createdAt), asc(sql`${tasks.id} COLLATE "C"`)];
    } else if (input.order === 'newest') {
      orderClauses = [desc(tasks.createdAt), asc(sql`${tasks.id} COLLATE "C"`)];
    } else if (input.order === 'random') {
      orderClauses = [sql`RANDOM()`];
    } else if (input.mode === 'no_priority' || input.mode === 'quadrant') {
      orderClauses = [desc(tasks.createdAt), asc(sql`${tasks.id} COLLATE "C"`)];
    } else if (input.mode === 'no_effort' || input.mode === 'no_planning_horizon') {
      orderClauses = [
        asc(priorityOrder),
        desc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE "C"`),
      ];
    } else {
      orderClauses = [
        asc(sql`CASE WHEN ${tasks.sourceListName} IS NULL THEN 0 ELSE 1 END`),
        asc(sql`${tasks.sourceListName} COLLATE "C"`),
        desc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE "C"`),
      ];
    }

    const rows = await this.db.select({
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
      this.db.select({
        taskId: taskTags.taskId,
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        color: tags.color,
      }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, taskIds)),
      this.db.select({
        taskId: taskProjects.taskId,
        id: hubProjects.id,
        name: hubProjects.name,
        color: hubProjects.color,
      }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(inArray(taskProjects.taskId, taskIds)),
      this.db.select({
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
    const taskRows = await this.db.select({
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
      this.db.select({
        id: sourceRankings.id,
        connectorType: sourceRankings.connectorType,
        name: sourceRankings.name,
        rank: sourceRankings.rank,
        updatedAt: sourceRankings.updatedAt,
      }).from(sourceRankings),
      this.db.select({
        id: tags.id,
        name: tags.name,
      }).from(tags).orderBy(asc(sql`${tags.id} COLLATE "C"`)),
      this.db.select({
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

class PostgresTaskPolicyIdentityRepository implements TaskPolicyIdentityRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async listTaskSourceIdentities(
    taskIds: readonly string[],
  ): Promise<TaskSourceIdentityRow[]> {
    const uniqueIds = [...new Set(taskIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    return this.db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(inArray(tasks.id, uniqueIds));
  }

  async getTaskSourceIdentity(taskId: string): Promise<TaskSourceIdentityRow | null> {
    const [row] = await this.db.select({
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
    const [row] = await this.db.select({
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
    }).from(taskDependencies).where(eq(taskDependencies.id, dependencyId)).limit(1);
    return row ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Local task lifecycle
 * ------------------------------------------------------------------ */

/**
 * Detaches a task's direct children and re-bases the depth of the whole
 * descendant subtree, mirroring the SQLite `detachTaskDescendants` recursive
 * CTE (the `path` array is the PostgreSQL equivalent of its `instr` cycle
 * guard).
 */
async function detachTaskDescendants(
  tx: PostgresTransaction,
  taskId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH RECURSIVE descendants(id, depth, path) AS (
      SELECT id, 0, ARRAY[id]
      FROM tasks
      WHERE parent_id = ${taskId} AND id <> ${taskId}
      UNION ALL
      SELECT child.id, descendants.depth + 1, descendants.path || child.id
      FROM tasks AS child
      INNER JOIN descendants ON child.parent_id = descendants.id
      WHERE NOT (child.id = ANY(descendants.path))
    )
    UPDATE tasks
    SET
      parent_id = CASE WHEN parent_id = ${taskId} THEN NULL ELSE parent_id END,
      depth = (
        SELECT descendants.depth
        FROM descendants
        WHERE descendants.id = tasks.id
      )
    WHERE id IN (SELECT id FROM descendants)
  `);
}

async function deleteSingleTaskWithinTransaction(
  tx: PostgresTransaction,
  taskId: string,
): Promise<void> {
  await lockTaskTagMutation(tx);
  await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
  await tx.delete(projectAutoIncludeExclusions)
    .where(eq(projectAutoIncludeExclusions.taskId, taskId));
  await tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId));
  await tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId));
  await tx.delete(myDayItems).where(eq(myDayItems.taskId, taskId));
  await tx.delete(myDayExclusions).where(eq(myDayExclusions.taskId, taskId));
  await tx.delete(focusItems).where(eq(focusItems.taskId, taskId));
  await tx.delete(weeklyOneThing).where(eq(weeklyOneThing.taskId, taskId));
  await tx.delete(prioritySyncLog).where(eq(prioritySyncLog.taskId, taskId));
  await tx.delete(quickSortLog).where(eq(quickSortLog.taskId, taskId));
  await tx.delete(quickSortOperations).where(eq(quickSortOperations.taskId, taskId));
  await tx.delete(taskLinkedSources).where(eq(taskLinkedSources.taskId, taskId));
  await tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId));
  await tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, taskId));
  await tx.update(notifications)
    .set({ relatedTaskId: null })
    .where(eq(notifications.relatedTaskId, taskId));
  await tx.delete(taskDependencies).where(or(
    eq(taskDependencies.taskId, taskId),
    eq(taskDependencies.dependsOnTaskId, taskId),
  ));
  await tx.delete(tasks).where(eq(tasks.id, taskId));
}

async function lockTaskTagMutation(tx: PostgresTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext('tag-consolidation'))`,
  );
}

async function deleteTaskWithinTransaction(
  tx: PostgresTransaction,
  taskId: string,
  recursive: boolean,
): Promise<void> {
  const [current] = await tx.select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .for('update');
  if (!current) return;

  if (recursive) {
    const children = await tx.select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.parentId, taskId));
    for (const child of children) {
      await deleteTaskWithinTransaction(tx, child.id, true);
    }
  } else {
    await detachTaskDescendants(tx, taskId);
  }
  await deleteSingleTaskWithinTransaction(tx, taskId);
}

class PostgresLocalTaskLifecycleRepository implements LocalTaskLifecycleRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async deleteTaskLocally(request: LocalTaskDeletionRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      await deleteTaskWithinTransaction(tx, request.taskId, request.recursive);
    });
  }

  async convertTaskTreeToLocal(
    taskId: string,
    resolution: 'keep_local' | 'archive_local',
    now: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const convertTree = async (id: string): Promise<void> => {
        const [task] = await tx.select({
          id: tasks.id,
          sourceId: tasks.sourceId,
          connectorType: tasks.connectorType,
          connectorInstanceId: tasks.connectorInstanceId,
          metadata: tasks.metadata,
        }).from(tasks).where(eq(tasks.id, id)).limit(1);
        if (!task) return;

        const children = await tx.select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.parentId, id));

        await tx.update(tasks).set({
          sourceId: `local:${task.id}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          sourceListId: null,
          sourceListName: null,
          syncStatus: 'synced',
          pushRetryCount: 0,
          updatedAt: now,
          lastSyncedAt: now,
          metadata: {
            ...asRecord(task.metadata),
            retentionResolution: {
              action: resolution,
              resolvedAt: now,
              previousConnectorType: task.connectorType,
              previousConnectorInstanceId: task.connectorInstanceId,
              previousSourceId: task.sourceId,
            },
          },
        }).where(eq(tasks.id, id));

        for (const child of children) await convertTree(child.id);
      };

      await convertTree(taskId);
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
      const [row] = await this.db.select(columns)
        .from(tasks)
        .where(eq(tasks.id, identity.taskId));
      if (
        row
        && row.connectorInstanceId === identity.connectorId
        && row.sourceId === identity.taskSourceId
      ) {
        return { ...row, metadata: asRecord(row.metadata) };
      }
    }

    const candidates = await this.db.select(columns)
      .from(tasks)
      .where(eq(tasks.sourceId, identity.taskSourceId));
    const match = candidates.find(
      (candidate) => candidate.connectorInstanceId === identity.connectorId,
    );
    return match ? { ...match, metadata: asRecord(match.metadata) } : null;
  }
}

/* ------------------------------------------------------------------ *
 * Scout hard delete
 * ------------------------------------------------------------------ */

async function collectTaskGraphIds(
  tx: PostgresTransaction,
  rootTaskId: string,
): Promise<string[]> {
  const taskIds = new Set([rootTaskId]);
  let frontier = [rootTaskId];

  while (frontier.length > 0) {
    const children = await tx.select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.parentId, frontier));
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

class PostgresScoutTaskHardDeleteRepository implements ScoutTaskHardDeleteRepository {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Unlike SQLite, the PostgreSQL schema has no `task_history_events`
   * append-only DELETE trigger, so this path does not need the SQLite
   * adapter's drop-trigger/recreate-trigger dance around the history purge.
   */
  async hardDeleteScoutTask(taskId: string): Promise<ScoutHardDeleteOutcome> {
    return this.db.transaction(async (tx): Promise<ScoutHardDeleteOutcome> => {
      await lockTaskTagMutation(tx);
      const [task] = await tx.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
      }).from(tasks).where(eq(tasks.id, taskId)).limit(1).for('update');
      if (!task) return { kind: 'not-found' };
      if (task.connectorType !== 'scout') return { kind: 'not-scout' };

      const now = new Date().toISOString();
      const taskIds = await collectTaskGraphIds(tx, task.id);
      const candidates = await tx.select({
        id: tasks.id,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceId: tasks.sourceId,
      }).from(tasks).where(inArray(tasks.id, taskIds));

      const suppressions = candidates
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

      if (suppressions.length > 0) {
        await tx.insert(taskIngestSuppressions).values(suppressions).onConflictDoNothing();
      }

      await tx.delete(taskDependencies).where(or(
        inArray(taskDependencies.taskId, taskIds),
        inArray(taskDependencies.dependsOnTaskId, taskIds),
      ));
      await tx.delete(taskTags).where(inArray(taskTags.taskId, taskIds));
      await tx.delete(projectAutoIncludeExclusions)
        .where(inArray(projectAutoIncludeExclusions.taskId, taskIds));
      await tx.delete(taskProjects).where(inArray(taskProjects.taskId, taskIds));
      await tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.taskId, taskIds));
      await tx.delete(taskSchedules).where(inArray(taskSchedules.taskId, taskIds));
      await tx.delete(taskFieldStates).where(inArray(taskFieldStates.taskId, taskIds));
      await tx.delete(taskHistoryEvents).where(inArray(taskHistoryEvents.taskId, taskIds));
      await tx.delete(myDayItems).where(inArray(myDayItems.taskId, taskIds));
      await tx.delete(myDayExclusions).where(inArray(myDayExclusions.taskId, taskIds));
      await tx.delete(focusItems).where(inArray(focusItems.taskId, taskIds));
      await tx.delete(weeklyOneThing).where(inArray(weeklyOneThing.taskId, taskIds));
      await tx.delete(prioritySyncLog).where(inArray(prioritySyncLog.taskId, taskIds));
      await tx.delete(quickSortLog).where(inArray(quickSortLog.taskId, taskIds));
      await tx.delete(quickSortOperations).where(inArray(quickSortOperations.taskId, taskIds));
      await tx.delete(scoutReconciliationSuggestions)
        .where(inArray(scoutReconciliationSuggestions.taskId, taskIds));
      await tx.delete(scoutReconciliationEvaluations)
        .where(inArray(scoutReconciliationEvaluations.taskId, taskIds));
      await tx.delete(scoutReconciliationTaskState)
        .where(inArray(scoutReconciliationTaskState.taskId, taskIds));
      await tx.delete(taskAttachments).where(inArray(taskAttachments.taskId, taskIds));
      await tx.delete(taskLinkedSources).where(inArray(taskLinkedSources.taskId, taskIds));
      await tx.delete(taskReminderOccurrences)
        .where(inArray(taskReminderOccurrences.taskId, taskIds));
      await tx.delete(syncDeletionCandidates)
        .where(inArray(syncDeletionCandidates.taskId, taskIds));
      await tx.delete(syncDeletionSnapshots).where(or(
        inArray(syncDeletionSnapshots.originalTaskId, taskIds),
        inArray(syncDeletionSnapshots.restoredTaskId, taskIds),
      ));
      await tx.update(notifications)
        .set({ relatedTaskId: null })
        .where(inArray(notifications.relatedTaskId, taskIds));
      await tx.delete(tasks).where(inArray(tasks.id, taskIds));

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

class PendingTaskMoveSourceChangedError extends Error {
  constructor() {
    super('Task changed before the move could be committed');
    this.name = 'PendingTaskMoveSourceChangedError';
  }
}

/**
 * PostgreSQL port of `repointTaskReferences`. `INSERT OR IGNORE` becomes
 * `ON CONFLICT DO NOTHING`; the project-placement rebuild keeps the same
 * "suspend hierarchy mutation guards, move placements, restore" shape.
 */
async function repointTaskReferences(
  tx: PostgresTransaction,
  sourceTaskId: string,
  successorTaskId: string,
): Promise<void> {
  const simpleRepoints = [
    sql`UPDATE tasks SET parent_id = ${successorTaskId} WHERE parent_id = ${sourceTaskId}`,
    sql`UPDATE my_day_items SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE my_day_exclusions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE focus_items SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE weekly_one_thing SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE priority_sync_log SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE task_triage_log SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE quick_sort_operations SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE project_auto_include_exclusions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
  ];
  for (const statement of simpleRepoints) await tx.execute(statement);

  await rebuildProjectPlacements(tx, sourceTaskId, successorTaskId);

  const remainingRepoints = [
    sql`UPDATE task_linked_sources SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE task_reminder_occurrences SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE notifications SET related_task_id = ${successorTaskId} WHERE related_task_id = ${sourceTaskId}`,
    sql`UPDATE scout_reconciliation_suggestions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE scout_reconciliation_task_state SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE task_dependencies SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`,
    sql`UPDATE task_dependencies SET depends_on_task_id = ${successorTaskId} WHERE depends_on_task_id = ${sourceTaskId}`,
  ];
  for (const statement of remainingRepoints) await tx.execute(statement);
}

async function rebuildProjectPlacements(
  tx: PostgresTransaction,
  sourceTaskId: string,
  successorTaskId: string,
): Promise<void> {
  const projects = await tx.execute(sql`
    SELECT project_id AS "projectId"
    FROM task_projects
    WHERE task_id = ${sourceTaskId}
    UNION
    SELECT project_phases.project_id AS "projectId"
    FROM project_phase_items
    INNER JOIN project_phases ON project_phases.id = project_phase_items.phase_id
    WHERE project_phase_items.task_id = ${sourceTaskId}
      AND project_phases.project_id IS NOT NULL
  `);
  const projectIds = (projects.rows as Array<{ projectId?: unknown }>)
    .map((row) => row.projectId)
    .filter((value): value is string => typeof value === 'string');
  const insertedContexts: string[] = [];

  try {
    for (const projectId of projectIds) {
      const result = await tx.execute(sql`
        INSERT INTO project_hierarchy_mutation_context (project_id)
        VALUES (${projectId})
        ON CONFLICT DO NOTHING
      `);
      if ((result.rowCount ?? 0) > 0) insertedContexts.push(projectId);
    }

    await tx.execute(sql`
      INSERT INTO task_projects (task_id, project_id)
      SELECT ${successorTaskId}, project_id
      FROM task_projects
      WHERE task_id = ${sourceTaskId}
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE project_phase_items
      SET task_id = ${successorTaskId}
      WHERE task_id = ${sourceTaskId}
    `);
    await tx.execute(sql`
      DELETE FROM task_projects
      WHERE task_id = ${sourceTaskId}
    `);
  } finally {
    for (const projectId of insertedContexts) {
      await tx.execute(sql`
        DELETE FROM project_hierarchy_mutation_context
        WHERE project_id = ${projectId}
      `);
    }
  }
}

/**
 * Null-safe attachment fingerprint. SQLite spells this `IS <value>`;
 * PostgreSQL requires `IS NOT DISTINCT FROM`, which is why the predicate
 * cannot be shared across dialects.
 */
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
        AND source_attachment_id IS NOT DISTINCT FROM ${attachment.sourceAttachmentId}
    )`),
  ];
}

const MOVE_SOURCE_COLUMNS = {
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
};

class PostgresTaskMoveRepository implements TaskMoveRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getMoveSource(taskId: string): Promise<TaskMoveSourceRow | null> {
    const [row] = await this.db.select(MOVE_SOURCE_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ?? null;
  }

  async listTaskAttachments(taskId: string): Promise<TaskAttachmentRow[]> {
    const rows = await this.db.select().from(taskAttachments)
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
    const [row] = await this.db.select({ id: tasks.id })
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return Boolean(row);
  }

  async findTargetList(
    connectorInstanceId: string,
    listIdOrSourceId: string,
  ): Promise<TaskMoveTargetList | null> {
    const [row] = await this.db
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
    try {
      await this.db.transaction(async (tx) => {
        await lockTaskTagMutation(tx);
        const [source] = await tx.select(MOVE_SOURCE_COLUMNS)
          .from(tasks).where(eq(tasks.id, request.sourceTaskId)).limit(1);
        if (!source) throw new PendingTaskMoveSourceChangedError();

        const claimed = await tx.update(tasks)
          .set({ updatedAt: sql`${tasks.updatedAt}` })
          .where(and(
            eq(tasks.id, request.sourceTaskId),
            eq(tasks.sourceId, request.expectedSourceId),
            eq(tasks.updatedAt, request.expectedUpdatedAt),
            ...attachmentSnapshotPredicates(
              request.sourceTaskId,
              request.attachmentSnapshot,
            ),
          ))
          .returning({ id: tasks.id });
        if (claimed.length !== 1) throw new PendingTaskMoveSourceChangedError();

        const attachments = await tx.select().from(taskAttachments)
          .where(eq(taskAttachments.taskId, request.sourceTaskId));

        await tx.insert(tasks).values({
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
          sourceListId: request.targetSourceListId,
          metadata: {},
          syncStatus: 'pending_push',
          lastSyncedAt: request.now,
        });

        if (request.keepTags) {
          const sourceTags = await tx.select().from(taskTags)
            .where(eq(taskTags.taskId, request.sourceTaskId));
          if (sourceTags.length > 0) {
            await tx.insert(taskTags).values(
              sourceTags.map((tag) => ({ taskId: request.newTaskId, tagId: tag.tagId })),
            );
          }
        }

        const sourceSchedules = await tx.select().from(taskSchedules)
          .where(eq(taskSchedules.taskId, request.sourceTaskId));
        if (sourceSchedules.length > 0) {
          await tx.delete(taskSchedules)
            .where(eq(taskSchedules.taskId, request.sourceTaskId));
          await tx.insert(taskSchedules).values(
            sourceSchedules.map((schedule) => ({ ...schedule, taskId: request.newTaskId })),
          );
        }

        if (attachments.length > 0) {
          await tx.insert(taskAttachments).values(
            attachments.map((attachment) => ({
              ...attachment,
              id: crypto.randomUUID(),
              taskId: request.newTaskId,
              sourceAttachmentId: null,
            })),
          );
        }

        await repointTaskReferences(tx, request.sourceTaskId, request.newTaskId);

        await tx.delete(taskAttachments)
          .where(eq(taskAttachments.taskId, request.sourceTaskId));
        await tx.delete(taskTags).where(eq(taskTags.taskId, request.sourceTaskId));
        await tx.delete(tasks).where(eq(tasks.id, request.sourceTaskId));
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
  siblingOrder: tasks.siblingOrder,
  subtaskOrderRevision: tasks.subtaskOrderRevision,
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

function toMoveTaskRow(row: Record<string, unknown>): TaskMoveTaskRow {
  return {
    ...(row as unknown as TaskMoveTaskRow),
    metadata: asRecord(row.metadata),
  };
}

function normalizedSnapshot(snapshot: TaskSubtaskProposalSnapshot): TaskSubtaskProposalSnapshot {
  return {
    parentUpdatedAt: snapshot.parentUpdatedAt,
    tagNames: [...snapshot.tagNames].sort(),
    projectNames: [...snapshot.projectNames].sort(),
    subtaskTitles: [...snapshot.subtaskTitles].sort(),
  };
}

function sameSnapshot(
  left: TaskSubtaskProposalSnapshot,
  right: TaskSubtaskProposalSnapshot,
): boolean {
  return JSON.stringify(normalizedSnapshot(left)) === JSON.stringify(normalizedSnapshot(right));
}

/**
 * `metadata` is a real `jsonb` column here, so the object is written as-is
 * rather than serialized the way the SQLite text column requires.
 */
function moveTaskInsertValues(task: TaskMoveTaskInsert) {
  return { ...task, metadata: task.metadata };
}

class PostgresTaskAncillaryRepository implements TaskAncillaryRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getTask(taskId: string): Promise<TaskCoreTaskRow | null> {
    const [row] = await this.db.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ? toMoveTaskRow(row) : null;
  }

  async getAttachmentListContext(taskId: string): Promise<TaskAttachmentListContext> {
    const [task] = await this.db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      updatedAt: tasks.updatedAt,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return { task: null, attachments: [] };
    const attachments = await this.db.select({
      id: taskAttachments.id,
      taskId: taskAttachments.taskId,
      name: taskAttachments.name,
      contentType: taskAttachments.contentType,
      size: taskAttachments.size,
      sourceAttachmentId: taskAttachments.sourceAttachmentId,
      createdAt: taskAttachments.createdAt,
      hasLocalContent: sql<boolean>`CASE WHEN ${taskAttachments.contentBase64} IS NULL THEN FALSE ELSE TRUE END`,
    }).from(taskAttachments)
      .where(eq(taskAttachments.taskId, taskId))
      .orderBy(asc(taskAttachments.createdAt), asc(taskAttachments.id));
    return { task, attachments };
  }

  async getAttachmentDeleteContext(
    taskId: string,
    attachmentId: string,
  ): Promise<TaskAttachmentDeleteContext> {
    const [[task], [attachment]] = await Promise.all([
      this.db.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        updatedAt: tasks.updatedAt,
      }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
      this.db.select({
        id: taskAttachments.id,
        taskId: taskAttachments.taskId,
        name: taskAttachments.name,
        contentType: taskAttachments.contentType,
        size: taskAttachments.size,
        sourceAttachmentId: taskAttachments.sourceAttachmentId,
        createdAt: taskAttachments.createdAt,
      }).from(taskAttachments).where(and(
        eq(taskAttachments.id, attachmentId),
        eq(taskAttachments.taskId, taskId),
      )).limit(1),
    ]);
    return { task: task ?? null, attachment: attachment ?? null };
  }

  async insertAttachment(
    attachment: TaskAttachmentInsert,
  ): Promise<TaskAttachmentInsertOutcome> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.id, attachment.taskId)).limit(1);
      if (!task) return { kind: 'task-not-found' } as const;
      const [inserted] = await tx.insert(taskAttachments).values({ ...attachment })
        .onConflictDoNothing({ target: taskAttachments.id })
        .returning({ id: taskAttachments.id });
      return inserted
        ? { kind: 'inserted' } as const
        : { kind: 'already-exists' } as const;
    });
  }

  async deleteAttachment(input: {
    readonly taskId: string;
    readonly attachmentId: string;
    readonly expectedSourceAttachmentId: string | null;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select({
        sourceAttachmentId: taskAttachments.sourceAttachmentId,
      }).from(taskAttachments).where(and(
        eq(taskAttachments.id, input.attachmentId),
        eq(taskAttachments.taskId, input.taskId),
      )).limit(1);
      if (!current || current.sourceAttachmentId !== input.expectedSourceAttachmentId) {
        return false;
      }
      const removed = await tx.delete(taskAttachments).where(and(
        eq(taskAttachments.id, input.attachmentId),
        eq(taskAttachments.taskId, input.taskId),
      )).returning({ id: taskAttachments.id });
      return removed.length === 1;
    });
  }

  async copyTask(input: {
    readonly sourceTaskId: string;
    readonly newTaskId: string;
    readonly targetConnectorInstanceId: string;
    readonly targetListId: string | null;
    readonly keepTags: boolean;
    readonly now: string;
  }): Promise<TaskCopyOutcome> {
    return this.db.transaction(async (tx) => {
      if (input.keepTags) await lockTaskTagMutation(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-copy:${input.newTaskId}`}))`);
      const [replay] = await tx.select({
        connectorType: tasks.connectorType,
        sourceId: tasks.sourceId,
      }).from(tasks).where(eq(tasks.id, input.newTaskId)).limit(1);
      if (replay) {
        return replay.sourceId === `local:${input.newTaskId}`
          ? { kind: 'already-committed', connectorType: replay.connectorType } as const
          : { kind: 'task-not-found' } as const;
      }
      const [connector] = await tx.select().from(connectorConfigs)
        .where(eq(connectorConfigs.id, input.targetConnectorInstanceId)).limit(1);
      if (!connector) return { kind: 'connector-not-found' } as const;

      let targetSourceListId: string | null = null;
      if (input.targetListId) {
        const [targetList] = await tx.select().from(sourceLists).where(and(
          eq(sourceLists.connectorInstanceId, input.targetConnectorInstanceId),
          or(eq(sourceLists.id, input.targetListId), eq(sourceLists.sourceId, input.targetListId)),
        )).limit(1);
        if (!targetList) return { kind: 'source-list-not-found' } as const;
        if (!isSourceListSelected(connector, targetList)) {
          return { kind: 'source-list-not-selected' } as const;
        }
        targetSourceListId = targetList.sourceId;
      }

      const [source] = await tx.select({
        title: tasks.title,
        description: tasks.description,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
      }).from(tasks).where(eq(tasks.id, input.sourceTaskId)).limit(1);
      if (!source) return { kind: 'task-not-found' } as const;

      await tx.insert(tasks).values({
        id: input.newTaskId,
        sourceId: `local:${input.newTaskId}`,
        connectorType: connector.type,
        connectorInstanceId: input.targetConnectorInstanceId,
        title: source.title,
        description: source.description,
        status: 'todo',
        priority: source.priority,
        dueDate: source.dueDate,
        createdAt: input.now,
        updatedAt: input.now,
        depth: 0,
        isChecklistItem: false,
        sourceListId: targetSourceListId,
        metadata: {},
        syncStatus: 'pending_push',
        lastSyncedAt: input.now,
      });
      if (input.keepTags) {
        const tagRows = await tx.select({ tagId: taskTags.tagId }).from(taskTags)
          .where(eq(taskTags.taskId, input.sourceTaskId));
        if (tagRows.length) {
          await tx.insert(taskTags).values(tagRows.map(({ tagId }) => ({
            taskId: input.newTaskId,
            tagId,
          })));
        }
      }
      const projectRows = await tx.select({ projectId: taskProjects.projectId }).from(taskProjects)
        .where(eq(taskProjects.taskId, input.sourceTaskId));
      if (projectRows.length) {
        await tx.insert(taskProjects).values(projectRows.map(({ projectId }) => ({
          taskId: input.newTaskId,
          projectId,
        })));
      }
      return { kind: 'committed', connectorType: connector.type } as const;
    });
  }

  async promoteSubtask(input: {
    readonly taskId: string;
    readonly expectedUpdatedAt: string;
    readonly now: string;
  }): Promise<TaskPromoteOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select({
        parentId: tasks.parentId,
        isChecklistItem: tasks.isChecklistItem,
        updatedAt: tasks.updatedAt,
      }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
      if (!current) return { kind: 'not-found' } as const;
      if (current.updatedAt !== input.expectedUpdatedAt) {
        return { kind: 'revision-conflict', currentUpdatedAt: current.updatedAt } as const;
      }
      if (!current.isChecklistItem || !current.parentId) {
        return { kind: 'not-subtask' } as const;
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`task-ancillary:${current.parentId}`}))`,
      );
      const updated = await tx.update(tasks).set({
        parentId: null,
        depth: 0,
        isChecklistItem: false,
        updatedAt: input.now,
      }).where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.updatedAt, input.expectedUpdatedAt),
        eq(tasks.parentId, current.parentId),
        eq(tasks.isChecklistItem, true),
      )).returning({ id: tasks.id });
      return updated.length === 1
        ? { kind: 'promoted', previousParentId: current.parentId } as const
        : { kind: 'revision-conflict', currentUpdatedAt: current.updatedAt } as const;
    });
  }

  async listSubtasks(parentTaskId: string): Promise<TaskAncillarySubtask[]> {
    return this.db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      priority: tasks.priority,
      effort: tasks.effort,
      parentId: tasks.parentId,
      siblingOrder: tasks.siblingOrder,
    }).from(tasks).where(eq(tasks.parentId, parentTaskId))
      .orderBy(
        sql`CASE WHEN ${tasks.siblingOrder} IS NULL THEN 1 ELSE 0 END`,
        asc(tasks.siblingOrder),
        asc(tasks.createdAt),
        asc(tasks.id),
      );
  }

  async getSubtaskOrderState(parentTaskId: string) {
    const [parent] = await this.db.select({
      revision: tasks.subtaskOrderRevision,
    }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1);
    if (!parent) return null;
    return {
      revision: parent.revision,
      subtasks: await this.listSubtasks(parentTaskId),
    };
  }

  async reorderSubtasks(input: {
    readonly parentTaskId: string;
    readonly orderedChildIds: readonly string[];
    readonly expectedRevision: number;
  }) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`subtask-order:${input.parentTaskId}`}))`,
      );
      const [parent] = await tx.select({
        revision: tasks.subtaskOrderRevision,
      }).from(tasks).where(eq(tasks.id, input.parentTaskId)).limit(1);
      if (!parent) return { kind: 'parent-not-found' } as const;
      if (parent.revision !== input.expectedRevision) {
        return {
          kind: 'revision-conflict',
          currentRevision: parent.revision,
        } as const;
      }

      const children = await tx.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.parentId, input.parentTaskId));
      const currentIds = new Set(children.map((child) => child.id));
      const orderedIds = new Set(input.orderedChildIds);
      if (
        currentIds.size !== input.orderedChildIds.length
        || orderedIds.size !== input.orderedChildIds.length
        || input.orderedChildIds.some((id) => !currentIds.has(id))
      ) {
        return { kind: 'invalid-children' } as const;
      }

      for (const [siblingOrder, taskId] of input.orderedChildIds.entries()) {
        await tx.update(tasks).set({ siblingOrder }).where(and(
          eq(tasks.id, taskId),
          eq(tasks.parentId, input.parentTaskId),
        ));
      }
      const revision = parent.revision + 1;
      const updated = await tx.update(tasks).set({
        subtaskOrderRevision: revision,
      }).where(and(
        eq(tasks.id, input.parentTaskId),
        eq(tasks.subtaskOrderRevision, input.expectedRevision),
      )).returning({ id: tasks.id });
      if (updated.length !== 1) {
        return {
          kind: 'revision-conflict',
          currentRevision: parent.revision,
        } as const;
      }
      return { kind: 'reordered', revision } as const;
    });
  }

  private async readProposalSnapshot(
    database: PostgresTransaction,
    parentTaskId: string,
  ): Promise<TaskSubtaskProposalSnapshot | null> {
    const [parent] = await database.select({ updatedAt: tasks.updatedAt }).from(tasks)
      .where(eq(tasks.id, parentTaskId)).limit(1);
    if (!parent) return null;
    const [tagRows, projectRows, subtaskRows] = await Promise.all([
      database.select({ name: tags.name }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(eq(taskTags.taskId, parentTaskId))
        .limit(20),
      database.select({ name: hubProjects.name }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(eq(taskProjects.taskId, parentTaskId))
        .limit(10),
      database.select({ title: tasks.title }).from(tasks)
        .where(eq(tasks.parentId, parentTaskId))
        .limit(30),
    ]);
    return normalizedSnapshot({
      parentUpdatedAt: parent.updatedAt,
      tagNames: tagRows.map((row) => row.name),
      projectNames: projectRows.map((row) => row.name),
      subtaskTitles: subtaskRows.map((row) => row.title),
    });
  }

  async getSubtaskProposalSnapshot(
    parentTaskId: string,
  ): Promise<TaskSubtaskProposalSnapshot | null> {
    return this.db.transaction((tx) => this.readProposalSnapshot(tx, parentTaskId));
  }

  async createSubtask(input: {
    readonly task: TaskMoveTaskInsert;
  }): Promise<TaskSubtaskCreateOutcome> {
    return this.db.transaction(async (tx) => {
      if (!input.task.parentId) return { kind: 'parent-not-found' } as const;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`subtask-order:${input.task.parentId}`}))`,
      );
      const [existing] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, input.task.id)).limit(1);
      if (existing) {
        return existing.parentId === input.task.parentId
          ? { kind: 'already-created', subtask: toMoveTaskRow(existing) } as const
          : { kind: 'id-conflict' } as const;
      }
      const [parent] = await tx.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.id, input.task.parentId)).limit(1);
      if (!parent) return { kind: 'parent-not-found' } as const;
      const [lastSibling] = await tx.select({
        siblingOrder: sql<number>`COALESCE(MAX(${tasks.siblingOrder}), -1)`,
      }).from(tasks).where(eq(tasks.parentId, input.task.parentId))
        .limit(1);
      await tx.insert(tasks).values({
        ...moveTaskInsertValues(input.task),
        siblingOrder: (lastSibling?.siblingOrder ?? -1) + 1,
      });
      return { kind: 'created' } as const;
    });
  }

  async acceptSubtaskProposal(input: {
    readonly task: TaskMoveTaskInsert;
    readonly expected: TaskSubtaskProposalSnapshot;
  }): Promise<TaskSubtaskProposalOutcome> {
    return this.db.transaction(async (tx) => {
      if (!input.task.parentId) return { kind: 'stale' } as const;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`subtask-order:${input.task.parentId}`}))`,
      );
      const [existing] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, input.task.id)).limit(1);
      const current = await this.readProposalSnapshot(tx, input.task.parentId);
      if (!current) return { kind: 'stale' } as const;
      if (existing) {
        return existing.parentId === input.task.parentId
          ? { kind: 'duplicate', subtask: toMoveTaskRow(existing), snapshot: current } as const
          : { kind: 'id-conflict' } as const;
      }
      if (!sameSnapshot(current, input.expected)) return { kind: 'stale' } as const;
      const [lastSibling] = await tx.select({
        siblingOrder: sql<number>`COALESCE(MAX(${tasks.siblingOrder}), -1)`,
      }).from(tasks).where(eq(tasks.parentId, input.task.parentId))
        .limit(1);
      await tx.insert(tasks).values({
        ...moveTaskInsertValues(input.task),
        siblingOrder: (lastSibling?.siblingOrder ?? -1) + 1,
      });
      const snapshot = await this.readProposalSnapshot(tx, input.task.parentId);
      if (!snapshot) throw new Error('Subtask parent disappeared during proposal acceptance');
      return { kind: 'created', snapshot } as const;
    });
  }

  async completeSubtaskWriteThrough(input: {
    readonly taskId: string;
    readonly expectedSyncStatus: string;
    readonly sourceId: string;
    readonly metadata: Record<string, unknown>;
    readonly now: string;
  }): Promise<boolean> {
    const updated = await this.db.update(tasks).set({
      sourceId: input.sourceId,
      syncStatus: 'synced',
      lastSyncedAt: input.now,
      metadata: input.metadata,
    }).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.syncStatus, input.expectedSyncStatus),
    )).returning({ id: tasks.id });
    return updated.length === 1;
  }

  async failSubtaskWriteThrough(input: {
    readonly taskId: string;
    readonly expectedSyncStatus: string;
  }): Promise<boolean> {
    const updated = await this.db.update(tasks).set({
      syncStatus: 'push_failed',
      pushRetryCount: 5,
    }).where(and(
      eq(tasks.id, input.taskId),
      eq(tasks.syncStatus, input.expectedSyncStatus),
    )).returning({ id: tasks.id });
    return updated.length === 1;
  }

  async getTagMutationContext(taskId: string): Promise<TaskTagMutationContext> {
    const [task] = await this.db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      updatedAt: tasks.updatedAt,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return { task: null, storedCapabilities: {} };
    const [connector] = await this.db.select({
      capabilities: connectorConfigs.capabilities,
    }).from(connectorConfigs)
      .where(eq(connectorConfigs.id, task.connectorInstanceId)).limit(1);
    return {
      task,
      storedCapabilities: asRecord(connector?.capabilities),
    };
  }

  async addTaskTags(input: {
    readonly taskId: string;
    readonly candidates: readonly { id: string; name: string; slug: string }[];
    readonly tagCreationMode: 'freeform' | 'predefined';
    readonly now: string;
  }): Promise<TaskTagMutationResult> {
    return this.db.transaction(async (tx) => {
      await lockTaskTagMutation(tx);
      const ordered = [...input.candidates].sort((a, b) => a.slug.localeCompare(b.slug));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-ancillary:${input.taskId}`}))`);
      for (const candidate of ordered) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tag-slug:${candidate.slug}`}))`);
      }
      const existing = ordered.length
        ? await tx.select().from(tags).where(inArray(tags.slug, ordered.map((tag) => tag.slug)))
          .orderBy(asc(tags.slug), asc(tags.createdAt), asc(tags.id))
        : [];
      const bySlug = new Map(existing.map((tag) => [tag.slug, tag]));
      const rejectedTags: string[] = [];
      const resolved: Array<{ id: string; name: string }> = [];
      for (const candidate of ordered) {
        const match = bySlug.get(candidate.slug);
        if (match) {
          resolved.push({ id: match.id, name: match.name });
        } else if (input.tagCreationMode === 'predefined') {
          rejectedTags.push(candidate.name);
        } else {
          await tx.insert(tags).values({
            id: candidate.id,
            name: candidate.name,
            slug: candidate.slug,
            type: 'ai-inferred',
            source: 'ai',
            color: '#64748b',
            confirmed: false,
            createdAt: input.now,
          });
          resolved.push({ id: candidate.id, name: candidate.name });
        }
      }
      const existingLinks = new Set((await tx.select({ tagId: taskTags.tagId }).from(taskTags)
        .where(eq(taskTags.taskId, input.taskId))).map((row) => row.tagId));
      const addedTags = resolved.filter((tag) => !existingLinks.has(tag.id));
      if (addedTags.length) {
        await tx.insert(taskTags).values(addedTags.map((tag) => ({
          taskId: input.taskId,
          tagId: tag.id,
        })));
      }
      return { addedTags, rejectedTags };
    });
  }

  async removeTaskTag(input: {
    readonly taskId: string;
    readonly tagId: string;
  }): Promise<{ readonly removed: boolean; readonly tagName: string | null }> {
    return this.db.transaction(async (tx) => {
      await lockTaskTagMutation(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-ancillary:${input.taskId}`}))`);
      const [tag] = await tx.select({ name: tags.name }).from(tags)
        .where(eq(tags.id, input.tagId)).limit(1);
      const removed = await tx.delete(taskTags).where(and(
        eq(taskTags.taskId, input.taskId),
        eq(taskTags.tagId, input.tagId),
      )).returning({ tagId: taskTags.tagId });
      return { removed: removed.length > 0, tagName: tag?.name ?? null };
    });
  }
}

async function enqueueTaskCoreEvent(
  tx: PostgresTransaction,
  event: TaskCoreEvent,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('mission-control:event-outbox-sequence'))`);
  const [inserted] = await tx.insert(eventOutbox).values({
    stableKey: event.stableKey,
    eventType: event.type,
    payload: event.payload,
    occurredAt: event.timestamp,
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing({ target: eventOutbox.stableKey })
    .returning({ sequence: eventOutbox.sequence });
  if (!inserted) return;
  const subscriptions = await tx.select({
    id: outboundWebhooks.id,
    name: outboundWebhooks.name,
    url: outboundWebhooks.url,
    secret: outboundWebhooks.secret,
    eventTypes: outboundWebhooks.eventTypes,
    enabled: outboundWebhooks.enabled,
  }).from(outboundWebhooks).where(eq(outboundWebhooks.enabled, true));
  const now = new Date().toISOString();
  for (const subscription of subscriptions) {
    if (!eventSubscriptionMatches({
      ...subscription,
      eventTypes: parseEventTypes(subscription.eventTypes),
    }, event.type)) continue;
    await tx.insert(eventOutboxDeliveries).values({
      id: crypto.randomUUID(),
      eventSequence: inserted.sequence,
      webhookId: subscription.id,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }
}

class PostgresTaskDetailReadRepository implements TaskDetailReadRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getTaskDetail(taskId: string, myDayDate: string): Promise<TaskDetailResult | null> {
    const [task] = await this.db.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return null;
    const [tagRows, projectRows, subtasks, scheduleRows, myDayRows] = await Promise.all([
      this.db.select({ tagId: taskTags.tagId }).from(taskTags)
        .where(eq(taskTags.taskId, taskId)).orderBy(asc(taskTags.tagId)),
      this.db.select({ projectId: taskProjects.projectId }).from(taskProjects)
        .where(eq(taskProjects.taskId, taskId)).orderBy(asc(taskProjects.projectId)),
      this.db.select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        effort: tasks.effort,
        siblingOrder: tasks.siblingOrder,
      }).from(tasks).where(eq(tasks.parentId, taskId)).orderBy(
        sql`CASE WHEN ${tasks.siblingOrder} IS NULL THEN 1 ELSE 0 END`,
        asc(tasks.siblingOrder),
        asc(tasks.createdAt),
        asc(tasks.id),
      ),
      this.db.select({
        estimatedDuration: taskSchedules.estimatedDuration,
        recurrence: taskSchedules.recurrence,
        recurrenceMode: taskSchedules.recurrenceMode,
      }).from(taskSchedules).where(eq(taskSchedules.taskId, taskId)).limit(1),
      this.db.select({ id: myDayItems.id }).from(myDayItems).where(and(
        eq(myDayItems.taskId, taskId),
        eq(myDayItems.date, myDayDate),
      )).limit(1),
    ]);
    return {
      task: toMoveTaskRow(task),
      tagIds: tagRows.map((row) => row.tagId),
      projectIds: projectRows.map((row) => row.projectId),
      subtasks,
      subtaskOrderRevision: task.subtaskOrderRevision ?? 0,
      schedule: scheduleRows[0] ?? null,
      isInMyDay: myDayRows.length > 0,
    };
  }
}

class PostgresTaskCollectionReadRepository implements TaskCollectionReadRepository {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly queries: TaskQueryRepository,
  ) {}

  private async hydrate(taskIds: readonly string[], includeTags: boolean): Promise<{
    rows: TaskCollectionRow[];
    connectorContexts: TaskCollectionResult['connectorContexts'];
  }> {
    if (taskIds.length === 0) return { rows: [], connectorContexts: [] };
    const uniqueIds = [...new Set(taskIds)];
    const rawTasks = await this.db.select(MOVE_TASK_COLUMNS).from(tasks)
      .where(inArray(tasks.id, uniqueIds));
    const rawById = new Map(rawTasks.map((row) => [String(row.id), row]));
    const ordered = taskIds.flatMap((id) => rawById.get(id) ?? []);
    const parentIds = [...new Set(ordered.flatMap((row) => row.parentId ? [row.parentId] : []))];
    const connectorIds = [...new Set(ordered
      .map((row) => String(row.connectorInstanceId))
      .filter((id) => id !== 'local'))];
    const [scheduleRows, projectRows, phaseRows, childRows, tagRows, linkedRows, listRows, parentRows, connectorRows] =
      await Promise.all([
        this.db.select({
          taskId: taskSchedules.taskId,
          estimatedDuration: taskSchedules.estimatedDuration,
        }).from(taskSchedules).where(inArray(taskSchedules.taskId, uniqueIds)),
        this.db.select({
          taskId: taskProjects.taskId,
          projectId: taskProjects.projectId,
          projectName: hubProjects.name,
        }).from(taskProjects).leftJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
          .where(inArray(taskProjects.taskId, uniqueIds))
          .orderBy(asc(taskProjects.taskId), asc(taskProjects.projectId)),
        this.db.select({
          taskId: projectPhaseItems.taskId,
          phaseId: projectPhaseItems.phaseId,
          phaseName: projectPhases.name,
          projectId: projectPhases.projectId,
        }).from(projectPhaseItems)
          .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
          .where(inArray(projectPhaseItems.taskId, uniqueIds))
          .orderBy(
            asc(projectPhaseItems.taskId),
            asc(projectPhases.projectId),
            asc(projectPhaseItems.phaseId),
          ),
        this.db.select({
          parentId: tasks.parentId,
          total: sql<number>`COUNT(*)`,
          done: sql<number>`SUM(CASE WHEN ${tasks.status} = 'done' THEN 1 ELSE 0 END)`,
        }).from(tasks).where(inArray(tasks.parentId, uniqueIds)).groupBy(tasks.parentId),
        includeTags
          ? this.db.select({
              taskId: taskTags.taskId,
              id: tags.id,
              name: tags.name,
              slug: tags.slug,
              type: tags.type,
              source: tags.source,
              color: tags.color,
              confirmed: tags.confirmed,
              unifiedInto: tags.unifiedInto,
            }).from(taskTags).innerJoin(tags, eq(taskTags.tagId, tags.id))
              .where(inArray(taskTags.taskId, uniqueIds))
              .orderBy(asc(taskTags.taskId), asc(tags.id))
          : Promise.resolve([]),
        this.db.select({
          taskId: taskLinkedSources.taskId,
          count: sql<number>`COUNT(*)`,
        }).from(taskLinkedSources).where(inArray(taskLinkedSources.taskId, uniqueIds))
          .groupBy(taskLinkedSources.taskId),
        this.db.select({
          connectorInstanceId: sourceLists.connectorInstanceId,
          sourceId: sourceLists.sourceId,
          name: sourceLists.name,
          userDisplayName: sourceLists.userDisplayName,
        }).from(sourceLists),
        parentIds.length
          ? this.db.select({ id: tasks.id, title: tasks.title }).from(tasks)
              .where(inArray(tasks.id, parentIds))
          : Promise.resolve([]),
        connectorIds.length
          ? this.db.select({
              id: connectorConfigs.id,
              type: connectorConfigs.type,
              enabled: connectorConfigs.enabled,
              deletedAt: connectorConfigs.deletedAt,
              capabilities: connectorConfigs.capabilities,
              settings: connectorConfigs.settings,
            }).from(connectorConfigs).where(inArray(connectorConfigs.id, connectorIds))
              .orderBy(asc(connectorConfigs.id))
          : Promise.resolve([]),
      ]);
    const schedules = new Map(scheduleRows.map((row) => [row.taskId, row.estimatedDuration]));
    const parents = new Map(parentRows.map((row) => [row.id, row.title]));
    const children = new Map(childRows.map((row) => [
      row.parentId!,
      { total: Number(row.total), done: Number(row.done ?? 0) },
    ]));
    const linked = new Map(linkedRows.map((row) => [row.taskId, Number(row.count)]));
    const lists = new Map(listRows.map((row) => [
      `${row.connectorInstanceId}:${row.sourceId}`,
      row.userDisplayName || row.name,
    ]));
    const projectsByTask = new Map<string, typeof projectRows>();
    for (const row of projectRows) {
      const values = projectsByTask.get(row.taskId) ?? [];
      values.push(row);
      projectsByTask.set(row.taskId, values);
    }
    const phasesByTaskProject = new Map<string, typeof phaseRows>();
    for (const row of phaseRows) {
      const key = `${row.taskId}:${row.projectId}`;
      const values = phasesByTaskProject.get(key) ?? [];
      values.push(row);
      phasesByTaskProject.set(key, values);
    }
    const tagsByTask = new Map<string, typeof tagRows>();
    for (const row of tagRows) {
      const values = tagsByTask.get(row.taskId) ?? [];
      values.push(row);
      tagsByTask.set(row.taskId, values);
    }
    return {
      rows: ordered.map((raw) => {
        const task = toMoveTaskRow(raw);
        return {
          ...task,
          parentTitle: task.parentId ? parents.get(task.parentId) ?? null : null,
          authoritativeSourceListName: task.sourceListId
            ? lists.get(`${task.connectorInstanceId}:${task.sourceListId}`) ?? null
            : null,
          estimatedDuration: schedules.get(task.id) ?? null,
          subtaskTotal: children.get(task.id)?.total ?? 0,
          subtaskDone: children.get(task.id)?.done ?? 0,
          projectIds: (projectsByTask.get(task.id) ?? []).map((row) => row.projectId),
          projectPhaseMemberships: (projectsByTask.get(task.id) ?? []).flatMap(
            (project): TaskCollectionProjectPhaseMembership[] => {
              const phases = phasesByTaskProject.get(`${task.id}:${project.projectId}`) ?? [];
              return phases.length
                ? phases.map((phase) => ({
                    projectId: project.projectId,
                    projectName: project.projectName ?? 'Unknown Project',
                    phaseId: phase.phaseId,
                    phaseName: phase.phaseName,
                  }))
                : [{
                    projectId: project.projectId,
                    projectName: project.projectName ?? 'Unknown Project',
                    phaseId: null,
                    phaseName: null,
                  }];
            },
          ),
          linkedSourceCount: linked.get(task.id) ?? 0,
          tags: (tagsByTask.get(task.id) ?? []).map((tag) => ({
            ...tag,
            source: tag.source ?? null,
            color: tag.color ?? null,
            confirmed: Boolean(tag.confirmed),
            unifiedInto: tag.unifiedInto ?? null,
          })),
        };
      }),
      connectorContexts: connectorRows.map((row) => ({
        id: row.id,
        type: row.type,
        enabled: Boolean(row.enabled),
        deletedAt: row.deletedAt ?? null,
        capabilities: asRecord(row.capabilities),
        settings: asRecord(row.settings),
      })),
    };
  }

  async readTaskCollection(input: {
    spec: TaskFilterSpec;
    page: TaskListPage;
    includeTags: boolean;
    includeScoreInputs: boolean;
    countsOnly: boolean;
    smartScoreCandidateLimit: number;
  }): Promise<TaskCollectionResult> {
    const smart = input.page.order.field === 'smartScore';
    const [stats, sourceCounts, availableTags, total] = await Promise.all([
      this.queries.getStats(input.spec),
      this.queries.getSourceCounts(input.spec),
      input.countsOnly ? Promise.resolve([]) : this.queries.getAvailableTags(input.spec),
      this.queries.countTasks(input.spec, { includeQuickFilter: true }),
    ]);
    if (input.countsOnly) {
      return {
        rows: [],
        total,
        stats,
        sourceCounts,
        availableTags,
        connectorContexts: [],
        smartScore: null,
      };
    }
    const ids = await this.queries.listTaskIds(input.spec, smart
      ? { order: input.page.order, limit: input.smartScoreCandidateLimit, offset: 0 }
      : input.page);
    const hydrated = await this.hydrate(ids, input.includeTags || input.includeScoreInputs || smart);
    const rankings = smart || input.includeScoreInputs
      ? await this.db.select().from(sourceRankings)
          .orderBy(asc(sourceRankings.rank), asc(sourceRankings.id))
      : [];
    return {
      ...hydrated,
      total,
      stats,
      sourceCounts,
      availableTags,
      smartScore: smart || input.includeScoreInputs
        ? { rows: hydrated.rows, sourceRankings: rankings }
        : null,
    };
  }
}

class PostgresTaskCreateRepository implements TaskCreateRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async resolveTaskCreateTarget(input: {
    connectorType: string;
    requestedConnectorInstanceId: string | null;
    sourceListId: string | null;
  }): Promise<TaskCreateTargetOutcome> {
    let connectorInstanceId = input.requestedConnectorInstanceId;
    if (input.sourceListId) {
      const matches = await this.db.select({
        connectorInstanceId: sourceLists.connectorInstanceId,
      }).from(sourceLists).where(and(
        eq(sourceLists.sourceId, input.sourceListId),
        connectorInstanceId
          ? eq(sourceLists.connectorInstanceId, connectorInstanceId)
          : undefined,
      )).limit(2);
      if (matches.length === 0) return { kind: 'source-list-not-found' };
      if (!connectorInstanceId && matches.length > 1) return { kind: 'source-list-ambiguous' };
      connectorInstanceId = matches[0].connectorInstanceId;
    }
    if (!connectorInstanceId) {
      const matches = await this.db.select({ id: connectorConfigs.id })
        .from(connectorConfigs).where(and(
          eq(connectorConfigs.type, input.connectorType),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        )).limit(2);
      if (matches.length === 0) return { kind: 'connector-not-found' };
      if (matches.length > 1) return { kind: 'connector-ambiguous' };
      connectorInstanceId = matches[0].id;
    }
    const [connector] = await this.db.select().from(connectorConfigs)
      .where(and(
        eq(connectorConfigs.id, connectorInstanceId),
        isNull(connectorConfigs.deletedAt),
      )).limit(1);
    if (!connector) return { kind: 'connector-not-found' };
    if (connector.type !== input.connectorType) return { kind: 'connector-mismatch' };
    if (!connector.enabled) return { kind: 'connector-disabled' };
    if (input.sourceListId) {
      const [sourceList] = await this.db.select({
        id: sourceLists.id,
        sourceId: sourceLists.sourceId,
      }).from(sourceLists).where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        eq(sourceLists.sourceId, input.sourceListId),
      )).limit(1);
      if (!sourceList) return { kind: 'source-list-not-found' };
      if (!isSourceListSelected(connector, sourceList)) {
        return { kind: 'source-list-not-selected' };
      }
    }
    return {
      kind: 'resolved',
      connectorInstanceId,
      capabilities: asRecord(connector.capabilities),
      settings: asRecord(connector.settings),
    };
  }

  async createTask(input: TaskCreateInput): Promise<TaskCreateOutcome> {
    return this.db.transaction(async (tx) => {
      let task = input.task;
      let triageClaimId = input.triageClaimId;
      let ownsTriageClaim = false;
      const reject = async <T extends TaskCreateOutcome>(outcome: T): Promise<T> => {
        if (ownsTriageClaim && triageClaimId) {
          await tx.delete(triageActionClaims).where(and(
            eq(triageActionClaims.id, triageClaimId),
            eq(triageActionClaims.state, 'pending'),
          ));
          ownsTriageClaim = false;
        }
        return outcome;
      };
      if (input.triageItemId) {
        const [item] = await tx.select({
          id: triageItems.id,
          actionsTaken: triageItems.actionsTaken,
        }).from(triageItems).where(eq(triageItems.id, input.triageItemId)).limit(1).for('update');
        if (!item) return { kind: 'triage-not-found' } as const;
        const replay = asArray(item.actionsTaken).find((entry) => (
          asRecord(entry).actionType === 'create_task_todo'
        ));
        if (replay) {
          const metadata = asRecord(asRecord(replay).metadata);
          return {
            kind: 'triage-replay',
            taskId: typeof metadata.mcTaskId === 'string' ? metadata.mcTaskId : null,
          } as const;
        }
        triageClaimId ??= crypto.randomUUID();
        const claimed = await tx.insert(triageActionClaims).values({
          id: triageClaimId,
          triageItemId: input.triageItemId,
          actionType: 'create_task_todo',
          state: 'pending',
          claimedAt: task.createdAt,
        }).onConflictDoNothing().returning({ id: triageActionClaims.id });
        if (claimed.length === 0) {
          const [existing] = await tx.select({
            state: triageActionClaims.state,
            result: triageActionClaims.result,
          }).from(triageActionClaims).where(and(
            eq(triageActionClaims.triageItemId, input.triageItemId),
            eq(triageActionClaims.actionType, 'create_task_todo'),
          )).limit(1).for('update');
          if (existing?.state === 'completed') {
            const metadata = asRecord(asRecord(existing.result).metadata);
            return {
              kind: 'triage-replay',
              taskId: typeof metadata.mcTaskId === 'string' ? metadata.mcTaskId : null,
            } as const;
          }
          return { kind: 'triage-pending' } as const;
        }
        ownsTriageClaim = true;
      }
      if (task.connectorType !== 'local') {
        let connectorId = task.connectorInstanceId;
        if (connectorId === 'local') {
          const matches = await tx.select({ id: connectorConfigs.id }).from(connectorConfigs)
            .where(and(
              eq(connectorConfigs.type, task.connectorType),
              eq(connectorConfigs.enabled, true),
              isNull(connectorConfigs.deletedAt),
            )).limit(2).for('update');
          if (matches.length === 0) return reject({ kind: 'connector-not-found' } as const);
          if (matches.length > 1) return reject({ kind: 'source-list-ambiguous' } as const);
          connectorId = matches[0].id;
          task = { ...task, connectorInstanceId: connectorId };
        }
        const [connector] = await tx.select().from(connectorConfigs)
          .where(eq(connectorConfigs.id, connectorId)).limit(1).for('update');
        if (!connector || connector.deletedAt) return reject({ kind: 'connector-not-found' } as const);
        if (connector.type !== task.connectorType) return reject({ kind: 'connector-mismatch' } as const);
        if (input.requireConnectorEnabled && !connector.enabled) {
          return reject({ kind: 'connector-disabled' } as const);
        }
        if (input.requireSelectedSourceList && !task.sourceListId) {
          return reject({ kind: 'source-list-not-found' } as const);
        }
        if (task.sourceListId) {
          const matches = await tx.select({
            id: sourceLists.id,
            sourceId: sourceLists.sourceId,
          }).from(sourceLists).where(and(
            eq(sourceLists.connectorInstanceId, connectorId),
            eq(sourceLists.sourceId, task.sourceListId),
          )).limit(2).for('update');
          if (matches.length === 0) return reject({ kind: 'source-list-not-found' } as const);
          if (matches.length > 1) return reject({ kind: 'source-list-ambiguous' } as const);
          if (
            input.requireSelectedSourceList
            && !isSourceListSelected(connector, matches[0])
          ) {
            return reject({ kind: 'source-list-not-selected' } as const);
          }
        }
      }
      for (const projectId of [...new Set(input.projectIds)]) {
        const [project] = await tx.select({ id: hubProjects.id }).from(hubProjects)
          .where(eq(hubProjects.id, projectId)).limit(1).for('update');
        if (!project) return reject({ kind: 'project-not-found', projectId } as const);
      }
      if (input.tagIds.length > 0 || input.tagSlugs.length > 0) {
        await lockTaskTagMutation(tx);
      }
      for (const tagId of [...new Set(input.tagIds)]) {
        const [tag] = await tx.select({ id: tags.id }).from(tags)
          .where(eq(tags.id, tagId)).limit(1).for('update');
        if (!tag) return reject({ kind: 'tag-not-found', tagId } as const);
      }
      const slugTagIds: string[] = [];
      for (const raw of input.tagSlugs) {
        const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug) continue;
        const [existing] = await tx.select({ id: tags.id }).from(tags)
          .where(eq(tags.slug, slug)).limit(1);
        if (!existing && input.tagCreationMode === 'predefined') continue;
        const tagId = existing?.id ?? `tag-${slug}`;
        if (!existing) {
          await tx.insert(tags).values({
            id: tagId,
            name: raw,
            slug,
            type: 'hub',
            source: null,
            color: '#6b7280',
            confirmed: true,
            createdAt: task.createdAt,
          }).onConflictDoNothing();
        }
        slugTagIds.push(tagId);
      }
      await tx.insert(tasks).values(moveTaskInsertValues(task));
      const allTagIds = [...new Set([...input.tagIds, ...slugTagIds])];
      if (allTagIds.length) {
        await tx.insert(taskTags).values(allTagIds.map((tagId) => ({ taskId: task.id, tagId })));
      }
      const projectIds = [...new Set(input.projectIds)];
      if (projectIds.length) {
        await tx.insert(taskProjects).values(
          projectIds.map((projectId) => ({ taskId: task.id, projectId })),
        ).onConflictDoNothing();
      }
      if (input.schedule) {
        await tx.insert(taskSchedules).values(input.schedule).onConflictDoUpdate({
          target: taskSchedules.taskId,
          set: input.schedule,
        });
      }
      if (input.triageItemId && triageClaimId) {
        const record = {
          actionType: 'create_task_todo',
          appliedAt: task.createdAt,
          note: 'Created task from triage',
          metadata: {
            mcTaskId: task.id,
            connectorType: task.connectorType,
            sourceListId: task.sourceListId,
          },
        };
        const completed = await tx.update(triageActionClaims).set({
          state: 'completed',
          completedAt: task.createdAt,
          result: record,
        }).where(and(
          eq(triageActionClaims.id, triageClaimId),
          eq(triageActionClaims.state, 'pending'),
        )).returning({ id: triageActionClaims.id });
        if (completed.length !== 1) throw new Error('Triage task creation claim was lost');
        const [item] = await tx.select({ actionsTaken: triageItems.actionsTaken }).from(triageItems)
          .where(eq(triageItems.id, input.triageItemId)).limit(1);
        await tx.update(triageItems).set({
          status: 'actioned',
          snoozedUntil: null,
          actionsTaken: [...asArray(item?.actionsTaken), record],
        }).where(eq(triageItems.id, input.triageItemId));
      }
      const sourceTagNames = allTagIds.length
        ? (await tx.select({ name: tags.name, type: tags.type }).from(tags)
            .where(inArray(tags.id, allTagIds)))
            .filter((row) => row.type === 'source')
            .map((row) => row.name)
        : [];
      await enqueueTaskCoreEvent(tx, input.event);
      return { kind: 'committed', task, sourceTagNames } as const;
    });
  }
}

class PostgresTaskMutationRepository implements TaskMutationRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getTaskWriteContext(taskId: string, requestedTagIds: readonly string[] = []) {
    const [task, scheduleRows, tagRows, requestedTagRows, stateRows, evaluationRows] = await Promise.all([
      this.db.select(MOVE_TASK_COLUMNS).from(tasks).where(eq(tasks.id, taskId)).limit(1),
      this.db.select().from(taskSchedules).where(eq(taskSchedules.taskId, taskId)).limit(1),
      this.db.select({ id: tags.id, name: tags.name }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id)).where(eq(taskTags.taskId, taskId)),
      requestedTagIds.length
        ? this.db.select({ id: tags.id, name: tags.name }).from(tags)
            .where(inArray(tags.id, [...new Set(requestedTagIds)]))
        : Promise.resolve([]),
      this.db.select().from(taskFieldStates).where(eq(taskFieldStates.taskId, taskId)),
      this.db.select({ id: scoutReconciliationEvaluations.id })
        .from(scoutReconciliationEvaluations).where(and(
          eq(scoutReconciliationEvaluations.taskId, taskId),
          eq(scoutReconciliationEvaluations.action, 'auto-complete'),
          eq(scoutReconciliationEvaluations.applied, true),
        )).limit(1),
    ]);
    if (!task[0]) return null;
    return {
      task: toMoveTaskRow(task[0]),
      schedule: scheduleRows[0] ?? null,
      tagIds: tagRows.map((row) => row.id),
      tagNamesById: Object.fromEntries(
        [...tagRows, ...requestedTagRows].map((row) => [row.id, row.name]),
      ),
      fieldStates: stateRows.map((row) => ({
        ...row,
        locallyOverridden: Boolean(row.locallyOverridden),
      })),
      wasAutoCompletedByReconciliation: evaluationRows.length > 0,
    };
  }

  async mutateTask(request: TaskMutationRequest): Promise<TaskMutationOutcome> {
    return this.db.transaction(async (tx) => {
      if (request.replaceTagIds || request.recurrenceSuccessor) {
        await lockTaskTagMutation(tx);
      }
      const [current] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, request.taskId)).limit(1).for('update');
      if (!current) return { kind: 'not-found' } as const;
      const currentTask = toMoveTaskRow(current);
      if (currentTask.updatedAt !== request.expectedUpdatedAt) {
        return { kind: 'revision-conflict', currentUpdatedAt: currentTask.updatedAt } as const;
      }
      if (
        request.expectedStatusForTerminalTransition
        && currentTask.status !== request.expectedStatusForTerminalTransition
      ) {
        return { kind: 'revision-conflict', currentUpdatedAt: currentTask.updatedAt } as const;
      }
      const changed = await tx.update(tasks).set({
        ...request.patch,
        updatedAt: request.now,
      }).where(and(
        eq(tasks.id, request.taskId),
        eq(tasks.updatedAt, request.expectedUpdatedAt),
        request.expectedStatusForTerminalTransition
          ? eq(tasks.status, request.expectedStatusForTerminalTransition)
          : undefined,
      )).returning({ id: tasks.id });
      if (changed.length !== 1) {
        const [latest] = await tx.select({ updatedAt: tasks.updatedAt }).from(tasks)
          .where(eq(tasks.id, request.taskId)).limit(1);
        return latest
          ? { kind: 'revision-conflict', currentUpdatedAt: latest.updatedAt } as const
          : { kind: 'not-found' } as const;
      }
      if (request.schedulePatch) {
        await tx.insert(taskSchedules).values({
          taskId: request.taskId,
          scheduledDate: request.schedulePatch.scheduledDate,
          estimatedDuration: request.schedulePatch.estimatedDuration ?? null,
          recurrence: request.schedulePatch.recurrence ?? null,
          recurrenceMode: request.schedulePatch.recurrenceMode ?? 'schedule',
          isTimeBlocked: false,
        }).onConflictDoUpdate({
          target: taskSchedules.taskId,
          set: request.schedulePatch,
        });
      }
      if (request.replaceTagIds) {
        await tx.delete(taskTags).where(eq(taskTags.taskId, request.taskId));
        const ids = [...new Set(request.replaceTagIds)];
        if (ids.length) {
          await tx.insert(taskTags).values(ids.map((tagId) => ({
            taskId: request.taskId,
            tagId,
          })));
        }
      }
      for (const state of request.fieldStates ?? []) {
        await tx.insert(taskFieldStates).values({
          taskId: request.taskId,
          ...state,
        }).onConflictDoUpdate({
          target: [taskFieldStates.taskId, taskFieldStates.fieldName],
          set: state,
        });
      }
      if (request.priorityLog) {
        await tx.insert(prioritySyncLog).values({
          id: request.priorityLog.id,
          taskId: request.taskId,
          connectorType: currentTask.connectorType,
          connectorInstanceId: currentTask.connectorInstanceId,
          previousPriority: request.priorityLog.previousPriority,
          newPriority: request.priorityLog.newPriority,
          direction: 'outbound',
          writeBackTriggered: request.priorityLog.writeBackTriggered,
          note: request.priorityLog.note,
          timestamp: request.now,
        });
      }
      if (request.planningHistory) {
        await tx.insert(taskHistoryEvents).values({
          taskId: request.taskId,
          eventType: 'planning_horizon_changed',
          fieldName: 'planningHorizon',
          previousValue: request.planningHistory.previousValue,
          newValue: request.planningHistory.newValue,
          occurredAt: request.now,
          recordedAt: request.now,
          provenance: 'task-patch',
        });
      }
      if (request.suppressAutoCompletionAfterReopen) {
        await tx.insert(scoutReconciliationTaskState).values({
          taskId: request.taskId,
          neverAutoComplete: true,
          reason: 'reopened_after_auto_completion',
          updatedAt: request.now,
          updatedBy: 'task-reopen',
        }).onConflictDoUpdate({
          target: scoutReconciliationTaskState.taskId,
          set: {
            neverAutoComplete: true,
            reason: 'reopened_after_auto_completion',
            updatedAt: request.now,
            updatedBy: 'task-reopen',
          },
        });
        await tx.update(scoutReconciliationSuggestions).set({
          status: 'dismissed',
          updatedAt: request.now,
          actedAt: request.now,
          actedBy: 'task-reopen',
        }).where(and(
          eq(scoutReconciliationSuggestions.taskId, request.taskId),
          eq(scoutReconciliationSuggestions.status, 'pending'),
        ));
      }
      if (request.supersedePendingReconciliation) {
        await tx.update(scoutReconciliationSuggestions).set({
          status: 'superseded',
          updatedAt: request.now,
          actedAt: request.now,
          actedBy: 'task-terminal',
        }).where(and(
          eq(scoutReconciliationSuggestions.taskId, request.taskId),
          eq(scoutReconciliationSuggestions.status, 'pending'),
        ));
      }
      let recurrenceNextTaskId: string | null = null;
      if (request.recurrenceSuccessor) {
        const successor = request.recurrenceSuccessor;
        const inserted = await tx.insert(tasks).values(moveTaskInsertValues({
          ...currentTask,
          id: successor.id,
          sourceId: `local:${successor.id}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          status: 'todo',
          localDisposition: 'active',
          dueDate: successor.dueDate,
          createdAt: request.now,
          updatedAt: request.now,
          completedAt: null,
          recurrenceGeneratedFromTaskId: request.taskId,
          metadata: successor.metadata,
          syncStatus: 'synced',
          lastSyncedAt: request.now,
          pushRetryCount: 0,
          reminderAt: successor.reminderAt,
          isBulkImport: false,
        })).onConflictDoNothing().returning({ id: tasks.id });
        if (inserted.length) {
          recurrenceNextTaskId = successor.id;
          const [schedule] = await tx.select().from(taskSchedules)
            .where(eq(taskSchedules.taskId, request.taskId)).limit(1);
          if (schedule) {
            await tx.insert(taskSchedules).values({
              ...schedule,
              taskId: successor.id,
              scheduledDate: successor.scheduledDate,
              scheduledTime: successor.scheduledTime,
            });
          }
          const sourceTags = await tx.select({ tagId: taskTags.tagId }).from(taskTags)
            .where(eq(taskTags.taskId, request.taskId));
          if (sourceTags.length) {
            await tx.insert(taskTags).values(sourceTags.map((row) => ({
              taskId: successor.id,
              tagId: row.tagId,
            })));
          }
          const sourceProjects = await tx.select({ projectId: taskProjects.projectId })
            .from(taskProjects).where(eq(taskProjects.taskId, request.taskId));
          if (sourceProjects.length) {
            await tx.insert(taskProjects).values(sourceProjects.map((row) => ({
              taskId: successor.id,
              projectId: row.projectId,
            })));
          }
          const phases = await tx.select().from(projectPhaseItems)
            .where(eq(projectPhaseItems.taskId, request.taskId));
          if (phases.length) {
            await tx.insert(projectPhaseItems).values(phases.map((row) => ({
              ...row,
              id: crypto.randomUUID(),
              taskId: successor.id,
              createdAt: request.now,
            })));
          }
          const dependencies = await tx.select().from(taskDependencies)
            .where(eq(taskDependencies.taskId, request.taskId));
          if (dependencies.length) {
            await tx.insert(taskDependencies).values(dependencies.map((row) => ({
              ...row,
              id: crypto.randomUUID(),
              taskId: successor.id,
              syncStatus: 'local' as const,
              syncAction: null,
              syncError: null,
              lastSyncedAt: null,
              createdAt: request.now,
            })));
          }
          const attachments = await tx.select().from(taskAttachments)
            .where(eq(taskAttachments.taskId, request.taskId));
          if (attachments.length) {
            await tx.insert(taskAttachments).values(attachments.map((row) => ({
              ...row,
              id: crypto.randomUUID(),
              taskId: successor.id,
              createdAt: request.now,
            })));
          }
        } else {
          const [existing] = await tx.select({ id: tasks.id }).from(tasks)
            .where(eq(tasks.recurrenceGeneratedFromTaskId, request.taskId)).limit(1);
          recurrenceNextTaskId = existing?.id ?? null;
        }
      }
      for (const event of request.events ?? []) await enqueueTaskCoreEvent(tx, event);
      const [updated] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, request.taskId)).limit(1);
      if (!updated) return { kind: 'not-found' } as const;
      return {
        kind: 'committed',
        task: toMoveTaskRow(updated),
        recurrenceNextTaskId,
      } as const;
    });
  }
}

class PostgresTaskRemovalRepository implements TaskRemovalRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getTaskRemovalContext(taskId: string) {
    const [row] = await this.db.select(MOVE_TASK_COLUMNS).from(tasks)
      .where(eq(tasks.id, taskId)).limit(1);
    return row ? { task: toMoveTaskRow(row) } : null;
  }

  async applyTaskRemoval(input: {
    taskId: string;
    expectedUpdatedAt: string;
    mode: 'mirror-dismiss' | 'ingested-cancel' | 'local-delete' | 'remote-cancel-intent';
    now: string;
    events?: readonly TaskCoreEvent[];
  }): Promise<TaskRemovalOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, input.taskId)).limit(1).for('update');
      if (!current) return { kind: 'not-found' } as const;
      if (String(current.updatedAt) !== input.expectedUpdatedAt) {
        return {
          kind: 'revision-conflict',
          currentUpdatedAt: String(current.updatedAt),
        } as const;
      }
      if (input.mode === 'local-delete') {
        await deleteTaskWithinTransaction(tx, input.taskId, false);
      } else {
        const patch = input.mode === 'mirror-dismiss'
          ? { localDisposition: 'dismissed' as const, updatedAt: input.now }
          : input.mode === 'ingested-cancel'
            ? {
                status: 'cancelled',
                statusReason: 'not_planned',
                completedAt: null,
                microStatus: null,
                snoozedUntil: null,
                reminderAt: null,
                reminderRelative: null,
                reminderDueTime: null,
                updatedAt: input.now,
              }
            : {
                status: 'cancelled',
                statusReason: 'undo',
                syncStatus: 'pending_push',
                pushRetryCount: 0,
                updatedAt: input.now,
              };
        const changed = await tx.update(tasks).set(patch).where(and(
          eq(tasks.id, input.taskId),
          eq(tasks.updatedAt, input.expectedUpdatedAt),
        )).returning({ id: tasks.id });
        if (changed.length !== 1) {
          const [latest] = await tx.select({ updatedAt: tasks.updatedAt }).from(tasks)
            .where(eq(tasks.id, input.taskId)).limit(1);
          return latest
            ? { kind: 'revision-conflict', currentUpdatedAt: latest.updatedAt } as const
            : { kind: 'not-found' } as const;
        }
      }
      for (const event of input.events ?? []) await enqueueTaskCoreEvent(tx, event);
      return {
        kind: 'committed',
        action: input.mode === 'mirror-dismiss'
          ? 'dismissed'
          : input.mode === 'ingested-cancel'
            ? 'cancelled'
            : input.mode === 'local-delete'
              ? 'deleted'
              : 'pending-remote',
        taskVersion: input.mode === 'local-delete' ? null : input.now,
      } as const;
    });
  }

  async finalizeRemoteTaskRemoval(input: {
    taskId: string;
    leaseToken: string;
    expectedUpdatedAt: string;
  }): Promise<TaskRemovalOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select(MOVE_TASK_COLUMNS).from(tasks)
        .where(eq(tasks.id, input.taskId)).limit(1).for('update');
      if (!current) return { kind: 'not-found' } as const;
      if (
        String(current.updatedAt) !== input.expectedUpdatedAt
        || current.syncStatus !== 'pushing'
        || current.lastSyncedAt !== input.leaseToken
      ) {
        return {
          kind: 'revision-conflict',
          currentUpdatedAt: String(current.updatedAt),
        } as const;
      }
      await deleteTaskWithinTransaction(tx, input.taskId, false);
      return { kind: 'committed', action: 'deleted', taskVersion: null } as const;
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

/** SQLite spells this `json_extract(...)`; PostgreSQL uses a `jsonb` path. */
function claimTokenPredicate(token: string): SQL {
  return sql`(${tasks.metadata} #>> '{taskMoveClaim,token}') = ${token}`;
}

class PostgresWriteThroughTaskMoveRepository implements WriteThroughTaskMoveRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getTask(taskId: string): Promise<TaskMoveTaskRow | null> {
    const [row] = await this.db.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ? toMoveTaskRow(row) : null;
  }

  async listChildTasks(parentTaskId: string, limit: number): Promise<TaskMoveTaskRow[]> {
    const rows = await this.db.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.parentId, parentTaskId))
      .orderBy(
        sql`CASE WHEN ${tasks.siblingOrder} IS NULL THEN 1 ELSE 0 END`,
        asc(tasks.siblingOrder),
        asc(tasks.createdAt),
        asc(sql`${tasks.id} COLLATE "C"`),
      )
      .limit(limit);
    return rows.map(toMoveTaskRow);
  }

  async listTaskTagRefs(taskId: string): Promise<TaskMoveTagRef[]> {
    const rows = await this.db.select({
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
    const rows = await this.db.select({
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
    const rows = await this.db.select({
      id: taskAttachments.id,
      contentBase64: taskAttachments.contentBase64,
    })
      .from(taskAttachments)
      .where(inArray(taskAttachments.id, [...attachmentIds]));
    return rows.map((row) => ({ id: row.id, contentBase64: row.contentBase64 ?? null }));
  }

  async getTaskSchedule(taskId: string): Promise<TaskScheduleRow | null> {
    const [row] = await this.db.select().from(taskSchedules)
      .where(eq(taskSchedules.taskId, taskId)).limit(1);
    return row ?? null;
  }

  async findTargetListBySourceId(
    connectorInstanceId: string,
    sourceListId: string,
  ): Promise<TaskMoveListRow | null> {
    const [row] = await this.db
      .select({ id: sourceLists.id, name: sourceLists.name, sourceId: sourceLists.sourceId })
      .from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        eq(sourceLists.sourceId, sourceListId),
      ))
      .limit(1);
    return row ?? null;
  }

  async findDefaultTargetList(
    connectorInstanceId: string,
  ): Promise<TaskMoveListRow | null> {
    const projection = {
      id: sourceLists.id,
      name: sourceLists.name,
      sourceId: sourceLists.sourceId,
    };
    const [defaultList] = await this.db.select(projection)
      .from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, connectorInstanceId),
        eq(sourceLists.wellKnownListName, 'defaultList'),
      ))
      .orderBy(asc(sourceLists.sortOrder), asc(sql`${sourceLists.id} COLLATE "C"`))
      .limit(1);
    if (defaultList) return defaultList;

    const [firstList] = await this.db.select(projection)
      .from(sourceLists)
      .where(eq(sourceLists.connectorInstanceId, connectorInstanceId))
      .orderBy(asc(sourceLists.sortOrder), asc(sql`${sourceLists.id} COLLATE "C"`))
      .limit(1);
    return firstList ?? null;
  }

  async claimTaskMove(request: TaskMoveClaimRequest): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.update(tasks).set({
        syncStatus: request.claimSyncStatus,
        metadata: request.metadata,
      }).where(and(
        eq(tasks.id, request.taskId),
        eq(tasks.sourceId, request.expectedSourceId),
        eq(tasks.connectorInstanceId, request.expectedSourceConnectorInstanceId),
        eq(tasks.syncStatus, request.expectedSyncStatus),
      )).returning({ id: tasks.id });
      return claimed.length === 1;
    });
  }

  async releaseTaskMoveClaim(request: TaskMoveClaimReleaseRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(tasks).set({
        syncStatus: request.syncStatus,
        metadata: request.metadata,
      }).where(and(
        eq(tasks.id, request.taskId),
        claimTokenPredicate(request.claimToken),
      ));
    });
  }

  async discardMaterializedDestination(taskId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockTaskTagMutation(tx);
      await tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId));
      await tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId));
      await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
      await tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId));
      await tx.delete(tasks).where(eq(tasks.id, taskId));
    });
  }

  async materializeDestination(
    request: TaskMoveDestinationMaterialization,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (request.tagIds.length > 0 || request.subtaskCopies.length > 0) {
        await lockTaskTagMutation(tx);
      }
      await tx.insert(tasks).values(moveTaskInsertValues(request.task));

      if (request.tagIds.length > 0) {
        await tx.insert(taskTags).values(
          request.tagIds.map((tagId) => ({ taskId: request.task.id, tagId })),
        );
      }

      if (request.copyProjectsFromTaskId) {
        const sourceProjects = await tx.select().from(taskProjects)
          .where(eq(taskProjects.taskId, request.copyProjectsFromTaskId));
        if (sourceProjects.length > 0) {
          await tx.insert(taskProjects).values(
            sourceProjects.map((row) => ({ taskId: request.task.id, projectId: row.projectId })),
          );
        }
      }

      if (request.schedule) {
        await tx.insert(taskSchedules)
          .values({ ...request.schedule, taskId: request.task.id });
      }

      if (request.attachments.length > 0) {
        await tx.insert(taskAttachments).values(request.attachments.map(toAttachmentInsert));
      }

      for (const subtask of request.subtaskCopies) {
        await tx.insert(tasks).values(moveTaskInsertValues(subtask.task));

        const subtaskTags = await tx.select().from(taskTags)
          .where(eq(taskTags.taskId, subtask.copyFromTaskId));
        if (subtaskTags.length > 0) {
          await tx.insert(taskTags).values(
            subtaskTags.map((tag) => ({ taskId: subtask.task.id, tagId: tag.tagId })),
          );
        }

        const subtaskProjects = await tx.select().from(taskProjects)
          .where(eq(taskProjects.taskId, subtask.copyFromTaskId));
        if (subtaskProjects.length > 0) {
          await tx.insert(taskProjects).values(
            subtaskProjects.map((project) => ({
              taskId: subtask.task.id,
              projectId: project.projectId,
            })),
          );
        }

        const subtaskSchedules = await tx.select().from(taskSchedules)
          .where(eq(taskSchedules.taskId, subtask.copyFromTaskId));
        if (subtaskSchedules.length > 0) {
          await tx.insert(taskSchedules).values(
            subtaskSchedules.map((schedule) => ({ ...schedule, taskId: subtask.task.id })),
          );
        }

        if (subtask.attachments.length > 0) {
          await tx.insert(taskAttachments)
            .values(subtask.attachments.map(toAttachmentInsert));
        }
      }
    });
  }

  async finalizeMove(
    request: TaskMoveFinalizationRequest,
  ): Promise<TaskMoveFinalizationOutcome> {
    try {
      await this.db.transaction(async (tx) => {
        if (request.sourceDisposition.kind === 'delete') {
          await lockTaskTagMutation(tx);
        }
        const sourceUnchanged = await tx.update(tasks)
          .set({ updatedAt: sql`${tasks.updatedAt}` })
          .where(and(
            eq(tasks.id, request.sourceTaskId),
            claimTokenPredicate(request.claimToken),
            ...attachmentSnapshotPredicates(
              request.sourceTaskId,
              request.attachmentSnapshot,
            ),
          ))
          .returning({ id: tasks.id });
        if (sourceUnchanged.length !== 1) {
          throw new WriteThroughMoveSourceChangedError();
        }

        await repointTaskReferences(tx, request.sourceTaskId, request.successorTaskId);

        for (const repoint of request.subtaskRepoints) {
          await tx.update(tasks).set({
            sourceId: repoint.sourceId,
            connectorType: repoint.connectorType,
            connectorInstanceId: repoint.connectorInstanceId,
            sourceListId: repoint.sourceListId,
            sourceListName: repoint.sourceListName,
            parentId: repoint.parentId,
            updatedAt: repoint.updatedAt,
            syncStatus: repoint.syncStatus,
            lastSyncedAt: repoint.lastSyncedAt,
          }).where(eq(tasks.id, repoint.taskId));
          await tx.delete(taskAttachments)
            .where(eq(taskAttachments.taskId, repoint.taskId));
          if (repoint.attachments.length > 0) {
            await tx.insert(taskAttachments)
              .values(repoint.attachments.map(toAttachmentInsert));
          }
        }

        await tx.delete(taskSchedules)
          .where(eq(taskSchedules.taskId, request.sourceTaskId));
        await tx.delete(taskAttachments)
          .where(eq(taskAttachments.taskId, request.sourceTaskId));

        if (request.sourceDisposition.kind === 'delete') {
          await tx.delete(taskTags).where(eq(taskTags.taskId, request.sourceTaskId));
          await tx.delete(tasks).where(eq(tasks.id, request.sourceTaskId));
        } else {
          const disposition = request.sourceDisposition;
          await tx.update(tasks).set({
            status: disposition.status,
            statusReason: disposition.statusReason,
            description: disposition.description,
            updatedAt: disposition.updatedAt,
            syncStatus: disposition.syncStatus,
            metadata: disposition.metadata,
          }).where(eq(tasks.id, request.sourceTaskId));
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
    await this.db.update(tasks).set({
      syncStatus: request.syncStatus,
      metadata: request.metadata,
    }).where(eq(tasks.id, request.taskId));
  }

  async recordSourceCopyProvenance(
    request: TaskMoveSourceCopyProvenance,
  ): Promise<void> {
    await this.db.update(tasks).set({
      updatedAt: request.updatedAt,
      metadata: sql`COALESCE(${tasks.metadata}, '{}'::jsonb)
        || ${JSON.stringify({ copiedTo: request.copiedTo })}::jsonb`,
    }).where(eq(tasks.id, request.taskId));
  }
}

/* ------------------------------------------------------------------ *
 * Priority entities and source-list names
 * ------------------------------------------------------------------ */

class PostgresPriorityEntityRepository implements PriorityEntityRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async listPriorityEntitiesByRank(): Promise<PriorityEntityRow[]> {
    const rows = await this.db.select()
      .from(priorityEntities)
      .orderBy(
        asc(priorityEntities.rank),
        asc(sql`${priorityEntities.id} COLLATE "C"`),
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

  async createPriorityEntity(input: PriorityEntityCreate): Promise<PriorityEntityRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('priority-entities-order'))`);
      const [current] = await tx.select({ rank: priorityEntities.rank })
        .from(priorityEntities)
        .orderBy(desc(priorityEntities.rank))
        .limit(1);
      const [created] = await tx.insert(priorityEntities).values({
        id: input.id,
        name: input.name,
        type: input.type,
        referenceId: input.referenceId ?? null,
        description: input.description ?? null,
        tier: input.tier ?? 'standard',
        color: input.color ?? '#64748b',
        rank: input.rank ?? (current?.rank ?? 0) + 1,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning();
      return created;
    });
  }

  async updatePriorityEntities(inputs: readonly PriorityEntityUpdate[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('priority-entities-order'))`);
      for (const input of inputs) {
        const {
          id,
          updatedAt,
          ...changes
        } = input;
        await tx.update(priorityEntities)
          .set({ ...changes, updatedAt })
          .where(eq(priorityEntities.id, id));
      }
    });
  }

  async deletePriorityEntityAndRerank(id: string, updatedAt: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('priority-entities-order'))`);
      await tx.delete(priorityEntities).where(eq(priorityEntities.id, id));
      const remaining = await tx.select({ id: priorityEntities.id })
        .from(priorityEntities)
        .orderBy(
          asc(priorityEntities.rank),
          asc(sql`${priorityEntities.id} COLLATE "C"`),
        );
      for (const [index, row] of remaining.entries()) {
        await tx.update(priorityEntities)
          .set({ rank: index + 1, updatedAt })
          .where(eq(priorityEntities.id, row.id));
      }
    });
  }

  async listPriorityEntityOptions(): Promise<PriorityEntityOptions> {
    const projects = await this.db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      description: hubProjects.description,
      color: hubProjects.color,
    }).from(hubProjects)
      .where(eq(hubProjects.hidden, false))
      .orderBy(
        asc(sql`${hubProjects.name} COLLATE "C"`),
        asc(sql`${hubProjects.id} COLLATE "C"`),
      );
    const tagRows = await this.db.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      unifiedInto: tags.unifiedInto,
    }).from(tags)
      .where(and(eq(tags.confirmed, true), isNull(tags.unifiedInto)))
      .orderBy(
        asc(sql`${tags.name} COLLATE "C"`),
        asc(sql`${tags.id} COLLATE "C"`),
      );
    const sources = await this.db.select({
      connectorInstanceId: sourceLists.connectorInstanceId,
      sourceId: sourceLists.sourceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
      color: sourceLists.iconColor,
      connectorName: connectorConfigs.name,
      connectorType: connectorConfigs.type,
    }).from(sourceLists)
      .innerJoin(connectorConfigs, eq(sourceLists.connectorInstanceId, connectorConfigs.id))
      .where(and(
        eq(sourceLists.hidden, false),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
      ))
      .orderBy(
        asc(sql`${connectorConfigs.name} COLLATE "C"`),
        asc(sql`${sourceLists.name} COLLATE "C"`),
        asc(sql`${sourceLists.connectorInstanceId} COLLATE "C"`),
        asc(sql`${sourceLists.sourceId} COLLATE "C"`),
      );
    return {
      projects: projects.map((row) => ({ ...row, description: row.description ?? null })),
      tags: tagRows.map((row) => ({ ...row, color: row.color ?? null, unifiedInto: null })),
      sources: sources.map((row) => ({
        ...row,
        userDisplayName: row.userDisplayName ?? null,
        color: row.color ?? null,
      })),
    };
  }

  async listPrioritySyncLog(input: {
    readonly taskId?: string;
    readonly limit: number;
  }): Promise<PrioritySyncLogRow[]> {
    return this.db.select()
      .from(prioritySyncLog)
      .where(input.taskId ? eq(prioritySyncLog.taskId, input.taskId) : undefined)
      .orderBy(
        desc(prioritySyncLog.timestamp),
        asc(sql`${prioritySyncLog.id} COLLATE "C"`),
      )
      .limit(input.limit);
  }

  async getProjectReference(projectId: string): Promise<PriorityProjectReference | null> {
    const [row] = await this.db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      description: hubProjects.description,
      color: hubProjects.color,
    }).from(hubProjects).where(eq(hubProjects.id, projectId)).limit(1);
    return row
      ? { id: row.id, name: row.name, description: row.description ?? null, color: row.color ?? null }
      : null;
  }

  async getTagReference(tagId: string): Promise<PriorityTagReference | null> {
    const [row] = await this.db.select({
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
    const [row] = await this.db.select({
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
    const rows = await this.db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      description: hubProjects.description,
      color: hubProjects.color,
    }).from(hubProjects);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      color: row.color ?? null,
    }));
  }

  async listTagReferences(): Promise<PriorityTagReference[]> {
    const rows = await this.db.select({
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
    const rows = await this.db.select({
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

class PostgresSourceListNameRepository implements SourceListNameRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async listSourceListDisplayNames(
    sourceListIds: readonly string[],
  ): Promise<SourceListDisplayNameRow[]> {
    const uniqueIds = [...new Set(sourceListIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const rows = await this.db.select({
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

class PostgresTaskTransferIdentityRepository implements TaskTransferIdentityRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async resolveIdentityTargets(input: {
    taskId: string;
    connectorInstanceId: string;
    sourceListIds: readonly string[];
  }): Promise<{
    taskExists: boolean;
    taskMetadata: Record<string, unknown>;
    sourceLists: readonly { sourceId: string; localId: string }[];
  }> {
    return resolvePostgresTaskTransferIdentityTargets(this.db, input);
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
    return this.db.transaction((tx) => (
      reconcilePostgresTaskTransferIdentityRefreshInTransaction(
        bindPostgresTaskTransferIdentityDrizzleTransaction(tx),
        input,
      )
    ));
  }
}

type PostgresQuickSortOperationRow = typeof quickSortOperations.$inferSelect;

function toPostgresQuickSortOperation(
  row: PostgresQuickSortOperationRow,
): TaskQuickSortOperation {
  return {
    ...row,
    mode: parseTaskQuickSortQueueMode(row.mode),
    action: parseTaskQuickSortAction(row.action),
    state: parseTaskQuickSortOperationState(row.state),
  };
}

class PostgresTaskQuickSortRepository implements TaskQuickSortPersistenceRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async captureTask(taskId: string) {
    const rows = await this.db.select({
      updatedAt: tasks.updatedAt,
      status: tasks.status,
      statusReason: tasks.statusReason,
      localDisposition: tasks.localDisposition,
      priority: tasks.priority,
      planningHorizon: tasks.planningHorizon,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      microStatus: tasks.microStatus,
      snoozedUntil: tasks.snoozedUntil,
      reminderAt: tasks.reminderAt,
      effort: tasks.effort,
      tagId: taskTags.tagId,
    }).from(tasks)
      .leftJoin(taskTags, eq(taskTags.taskId, tasks.id))
      .where(eq(tasks.id, taskId));
    const task = rows[0];
    if (!task) return null;
    return {
      updatedAt: task.updatedAt,
      status: task.status,
      statusReason: task.statusReason,
      localDisposition: task.localDisposition,
      priority: task.priority,
      planningHorizon: task.planningHorizon,
      dueDate: task.dueDate,
      completedAt: task.completedAt,
      microStatus: task.microStatus,
      snoozedUntil: task.snoozedUntil,
      reminderAt: task.reminderAt,
      effort: task.effort,
      tagIds: rows.flatMap((row) => row.tagId === null ? [] : [row.tagId]).sort(),
    };
  }

  async getOperation(id: string): Promise<TaskQuickSortOperation | null> {
    const [operation] = await this.db.select().from(quickSortOperations)
      .where(eq(quickSortOperations.id, id))
      .limit(1);
    return operation ? toPostgresQuickSortOperation(operation) : null;
  }

  async reserveOperation(
    input: TaskQuickSortOperationReservation,
  ): Promise<TaskQuickSortReservationOutcome> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(quickSortOperations).values({
        ...input,
        state: 'applying',
        undoneAt: null,
      }).onConflictDoNothing().returning();
      if (inserted[0]) {
        return {
          kind: 'reserved',
          operation: toPostgresQuickSortOperation(inserted[0]),
        };
      }

      const [existing] = await tx.select().from(quickSortOperations)
        .where(eq(quickSortOperations.id, input.id))
        .limit(1);
      if (!existing) {
        throw new Error(`Quick Sort operation ${input.id} conflicted but could not be read`);
      }
      return { kind: 'existing', operation: toPostgresQuickSortOperation(existing) };
    });
  }

  async discardApplyingOperation(id: string): Promise<boolean> {
    const deleted = await this.db.delete(quickSortOperations).where(and(
      eq(quickSortOperations.id, id),
      eq(quickSortOperations.state, 'applying'),
    )).returning({ id: quickSortOperations.id });
    return deleted.length === 1;
  }

  async finalizeOperation(
    id: string,
    afterSnapshot: TaskQuickSortOperation['afterSnapshot'],
    logs: readonly TaskQuickSortLogEntry[],
  ): Promise<TaskQuickSortOperation | null> {
    return this.db.transaction(async (tx) => {
      const changed = await tx.update(quickSortOperations).set({
        afterSnapshot,
        state: 'applied',
      }).where(and(
        eq(quickSortOperations.id, id),
        eq(quickSortOperations.state, 'applying'),
      )).returning({ id: quickSortOperations.id });
      if (changed.length !== 1) return null;
      if (logs.length > 0) {
        await tx.insert(quickSortLog).values(logs.map((entry) => ({ ...entry })));
      }
      const [operation] = await tx.select().from(quickSortOperations)
        .where(eq(quickSortOperations.id, id))
        .limit(1);
      if (!operation) throw new Error(`Finalized Quick Sort operation ${id} disappeared`);
      return toPostgresQuickSortOperation(operation);
    });
  }

  async claimUndo(id: string): Promise<boolean> {
    const changed = await this.db.update(quickSortOperations)
      .set({ state: 'undoing' })
      .where(and(
        eq(quickSortOperations.id, id),
        eq(quickSortOperations.state, 'applied'),
        isNull(quickSortOperations.undoneAt),
      ))
      .returning({ id: quickSortOperations.id });
    return changed.length === 1;
  }

  async releaseUndo(id: string): Promise<boolean> {
    const changed = await this.db.update(quickSortOperations)
      .set({ state: 'applied' })
      .where(and(
        eq(quickSortOperations.id, id),
        eq(quickSortOperations.state, 'undoing'),
        isNull(quickSortOperations.undoneAt),
      ))
      .returning({ id: quickSortOperations.id });
    return changed.length === 1;
  }

  async finalizeUndo(id: string, undoneAt: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const changed = await tx.update(quickSortOperations).set({
        state: 'undone',
        undoneAt,
      }).where(and(
        eq(quickSortOperations.id, id),
        eq(quickSortOperations.state, 'undoing'),
        isNull(quickSortOperations.undoneAt),
      )).returning({ id: quickSortOperations.id });
      if (changed.length !== 1) return false;
      await tx.update(quickSortLog).set({ reversedAt: undoneAt })
        .where(eq(quickSortLog.operationId, id));
      return true;
    });
  }

  async countActivityByModeSince(since: string) {
    const rows = await this.db.select({
      mode: quickSortLog.mode,
      count: sql<number>`count(*)::int`,
    }).from(quickSortLog).where(and(
      gte(quickSortLog.triagedAt, since),
      isNull(quickSortLog.reversedAt),
      ne(quickSortLog.action, 'skipped'),
    )).groupBy(quickSortLog.mode);
    return rows.map((row) => ({
      mode: parseTaskQuickSortQueueMode(row.mode),
      count: Number(row.count),
    }));
  }

  async listActivityTimestampsSince(since: string): Promise<string[]> {
    const rows = await this.db.select({ triagedAt: quickSortLog.triagedAt })
      .from(quickSortLog)
      .where(and(
        gte(quickSortLog.triagedAt, since),
        isNull(quickSortLog.reversedAt),
        ne(quickSortLog.action, 'skipped'),
      ));
    return rows.map((row) => row.triagedAt);
  }

  async recordActivity(entry: TaskQuickSortLogEntry): Promise<void> {
    await this.db.insert(quickSortLog).values({ ...entry });
  }
}

/** Walks `unified_into` chains and returns the tags that resolve into a root. */
function collectAliasTagIds(
  aliases: ReadonlyArray<{ id: string; unifiedInto: string | null }>,
  consolidationRoots: ReadonlySet<string>,
  targetTagId: string,
): string[] {
  const aliasesById = new Map(aliases.map((tag) => [tag.id, tag]));
  return aliases.flatMap((tag) => {
    if (tag.id === targetTagId || !tag.unifiedInto) return [];
    const visited = new Set<string>([tag.id]);
    let currentId: string | null = tag.unifiedInto;
    while (currentId && !visited.has(currentId)) {
      if (consolidationRoots.has(currentId)) return [tag.id];
      visited.add(currentId);
      currentId = aliasesById.get(currentId)?.unifiedInto ?? null;
    }
    return [];
  });
}

/** The rename/recolor patch a tag consolidation optionally applies. */
function tagConsolidationRename(input: {
  readonly newName: string | null;
  readonly newSlug: string | null;
  readonly newColor: string | null;
}): { name?: string; slug?: string; color?: string } {
  const updates: { name?: string; slug?: string; color?: string } = {};
  if (input.newName) {
    updates.name = input.newName;
    if (input.newSlug) updates.slug = input.newSlug;
  }
  if (input.newColor) updates.color = input.newColor;
  return updates;
}

function decodeTemplateSubtasks(value: unknown): SubtaskTemplateItem[] {
  return decodeLenientJsonArray(value).flatMap((entry): SubtaskTemplateItem[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record: Record<string, unknown> = entry as Record<string, unknown>;
    if (typeof record.title !== 'string') return [];
    return [{
      title: record.title,
      priority: typeof record.priority === 'string' ? record.priority : null,
      estimatedMinutes: typeof record.estimatedMinutes === 'number'
        ? record.estimatedMinutes
        : null,
    }];
  });
}

function decodeTemplateWorkflowTasks(value: unknown): SubtaskTemplateWorkflowTask[] {
  return decodeLenientJsonArray(value).flatMap((entry): SubtaskTemplateWorkflowTask[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record: Record<string, unknown> = entry as Record<string, unknown>;
    if (typeof record.title !== 'string') return [];
    return [{
      title: record.title,
      description: typeof record.description === 'string' ? record.description : null,
      priority: typeof record.priority === 'string' ? record.priority : null,
      subtasks: decodeLenientJsonArray(record.subtasks)
        .filter((title): title is string => typeof title === 'string'),
    }];
  });
}

const SUBTASK_TEMPLATE_COLUMNS = {
  id: subtaskTemplates.id,
  name: subtaskTemplates.name,
  description: subtaskTemplates.description,
  category: subtaskTemplates.category,
  type: subtaskTemplates.type,
  subtasks: subtaskTemplates.subtasks,
  workflowTasks: subtaskTemplates.workflowTasks,
  icon: subtaskTemplates.icon,
  isBuiltIn: subtaskTemplates.isBuiltIn,
  createdAt: subtaskTemplates.createdAt,
  updatedAt: subtaskTemplates.updatedAt,
};

/** Sorted, de-duplicated projection matching the SQLite backend's output. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * PostgreSQL task-organization repository. Consolidation and template
 * application run under READ COMMITTED with a transaction-scoped advisory lock
 * so concurrent requests on the same tag or template serialize instead of
 * interleaving partial rewrites.
 */
class PostgresTaskOrganizationRepository implements TaskOrganizationRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async readTagOverview(input: {
    readonly type: string | null;
    readonly source: string | null;
    readonly listId: string | null;
    readonly includeUsageBreakdown: boolean;
  }): Promise<TagOverviewResult> {
    const conditions: SQL[] = [];
    if (input.type) conditions.push(eq(tags.type, input.type));
    if (input.source) {
      const linkedToConnectorType = this.db
        .select({ tagId: taskTags.tagId })
        .from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .where(eq(tasks.connectorType, input.source));
      conditions.push(
        or(eq(tags.source, input.source), inArray(tags.id, linkedToConnectorType))!,
      );
    }
    if (input.listId) {
      const linkedToList = this.db
        .select({ tagId: taskTags.tagId })
        .from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .where(eq(tasks.sourceListId, input.listId));
      conditions.push(inArray(tags.id, linkedToList));
    }

    const tagRows = await this.db.select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      createdAt: tags.createdAt,
      unifiedInto: tags.unifiedInto,
    }).from(tags)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        asc(sql`${tags.type} COLLATE "C"`),
        asc(sql`${tags.name} COLLATE "C"`),
        asc(sql`${tags.id} COLLATE "C"`),
      );

    const tagIds = tagRows.map((tag) => tag.id);
    if (!tagIds.length) {
      return { tags: [], sourceTagSlugs: await this.readSourceTagSlugs() };
    }

    const linkageRows = await this.db.select({
      tagId: taskTags.tagId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
    }).from(taskTags)
      .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
      .where(inArray(taskTags.tagId, tagIds));

    const usageCounts = new Map<string, number>();
    const connectorTypesByTag = new Map<string, string[]>();
    const listNamesByTag = new Map<string, string[]>();
    const sourceUsageByTag = new Map<string, Map<string, number>>();
    const listUsageByTag = new Map<string, Map<string, TagListUsageRow>>();
    for (const row of linkageRows) {
      usageCounts.set(row.tagId, (usageCounts.get(row.tagId) ?? 0) + 1);
      connectorTypesByTag.set(row.tagId, [
        ...(connectorTypesByTag.get(row.tagId) ?? []),
        row.connectorType,
      ]);
      if (row.sourceListName !== null) {
        listNamesByTag.set(row.tagId, [
          ...(listNamesByTag.get(row.tagId) ?? []),
          row.sourceListName,
        ]);
      }
      if (!input.includeUsageBreakdown) continue;

      const bySource = sourceUsageByTag.get(row.tagId) ?? new Map<string, number>();
      bySource.set(row.connectorType, (bySource.get(row.connectorType) ?? 0) + 1);
      sourceUsageByTag.set(row.tagId, bySource);

      if (row.sourceListId === null) continue;
      const byList = listUsageByTag.get(row.tagId) ?? new Map<string, TagListUsageRow>();
      const key = `${row.connectorInstanceId}\u0000${row.sourceListId}`;
      const existing = byList.get(key);
      byList.set(key, {
        tagId: row.tagId,
        connectorInstanceId: row.connectorInstanceId,
        sourceListId: row.sourceListId,
        usageCount: (existing?.usageCount ?? 0) + 1,
      });
      listUsageByTag.set(row.tagId, byList);
    }

    return {
      tags: tagRows.map((tag) => {
        const connectorTypes = sortedUnique(connectorTypesByTag.get(tag.id) ?? []);
        return {
          ...tag,
          usageCount: usageCounts.get(tag.id) ?? 0,
          sources: connectorTypes.length
            ? connectorTypes
            : tag.source ? [tag.source] : [],
          sourceNames: sortedUnique(listNamesByTag.get(tag.id) ?? []),
          listUsage: [...(listUsageByTag.get(tag.id)?.values() ?? [])]
            .sort((left, right) => (
              left.connectorInstanceId.localeCompare(right.connectorInstanceId)
              || (left.sourceListId ?? '').localeCompare(right.sourceListId ?? '')
            )),
          sourceUsage: [...(sourceUsageByTag.get(tag.id)?.entries() ?? [])]
            .map(([connectorType, usageCount]) => ({
              tagId: tag.id,
              connectorType,
              usageCount,
            }))
            .sort((left, right) => left.connectorType.localeCompare(right.connectorType)),
        };
      }),
      sourceTagSlugs: await this.readSourceTagSlugs(),
    };
  }

  private async readSourceTagSlugs(): Promise<string[]> {
    const rows = await this.db.select({ slug: tags.slug })
      .from(tags)
      .where(eq(tags.type, 'source'))
      .orderBy(asc(sql`${tags.slug} COLLATE "C"`), asc(sql`${tags.id} COLLATE "C"`));
    return rows.map((row) => row.slug);
  }

  async createHubTag(input: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: string;
    readonly createdAt: string;
  }): Promise<TagCreateOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tag-slug:${input.slug}`}))`);
      const [existing] = await tx.select({
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        type: tags.type,
        color: tags.color,
      }).from(tags).where(eq(tags.slug, input.slug)).limit(1);
      if (existing) return { kind: 'existing' as const, tag: existing };

      await tx.insert(tags).values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        type: 'hub',
        source: null,
        color: input.color,
        confirmed: true,
        createdAt: input.createdAt,
      });
      return {
        kind: 'created' as const,
        tag: {
          id: input.id,
          name: input.name,
          slug: input.slug,
          type: 'hub',
          color: input.color,
        },
      };
    });
  }

  async updateTag(input: {
    readonly tagId: string;
    readonly name?: string;
    readonly slug?: string;
    readonly color?: string;
    readonly confirmed?: boolean;
  }): Promise<{ affectedTaskIds: string[] }> {
    return this.db.transaction(async (tx) => {
      const updates: { name?: string; slug?: string; color?: string; confirmed?: boolean } = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.slug !== undefined) updates.slug = input.slug;
      if (input.color !== undefined) updates.color = input.color;
      if (input.confirmed !== undefined) updates.confirmed = input.confirmed;
      if (Object.keys(updates).length > 0) {
        await tx.update(tags).set(updates).where(eq(tags.id, input.tagId));
      }
      const affected = await tx.select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(eq(taskTags.tagId, input.tagId));
      return { affectedTaskIds: affected.map((row) => row.taskId) };
    });
  }

  async deleteHubTag(tagId: string): Promise<TagDeleteOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('tag-consolidation'))`,
      );
      const [tag] = await tx.select({ id: tags.id, type: tags.type })
        .from(tags).where(eq(tags.id, tagId)).limit(1).for('update');
      if (!tag) return { kind: 'missing' as const };
      if (tag.type === 'source') return { kind: 'source-managed' as const };

      const affected = await tx.select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(eq(taskTags.tagId, tagId));
      await tx.delete(taskTags).where(eq(taskTags.tagId, tagId));
      await tx.delete(tags).where(eq(tags.id, tagId));
      return { kind: 'deleted' as const, affectedTaskIds: affected.map((row) => row.taskId) };
    });
  }

  async getTagConsolidationCandidates(input: {
    readonly targetTagId: string;
    readonly sourceTagIds: readonly string[];
  }): Promise<TagConsolidationCandidates> {
    const [target] = await this.db.select({
      id: tags.id,
      name: tags.name,
      type: tags.type,
    }).from(tags).where(eq(tags.id, input.targetTagId)).limit(1);
    const sources = input.sourceTagIds.length
      ? await this.db.select({
          id: tags.id,
          name: tags.name,
          type: tags.type,
        }).from(tags)
          .where(inArray(tags.id, [...input.sourceTagIds]))
          .orderBy(asc(sql`${tags.id} COLLATE "C"`))
      : [];
    return { target: target ?? null, sources };
  }

  async mergeTags(input: {
    readonly targetTagId: string;
    readonly sourceTagIds: readonly string[];
    readonly newName: string | null;
    readonly newSlug: string | null;
    readonly newColor: string | null;
  }): Promise<TagMergeOutcome> {
    const tagsToRemove = [...input.sourceTagIds];
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('tag-consolidation'))`,
      );
      const [currentTarget] = await tx.select({ id: tags.id, type: tags.type })
        .from(tags).where(eq(tags.id, input.targetTagId)).limit(1).for('update');
      const currentSourceTags = await tx.select({ id: tags.id, type: tags.type })
        .from(tags).where(inArray(tags.id, tagsToRemove)).for('update');
      if (!currentTarget || currentSourceTags.length !== tagsToRemove.length) {
        return { kind: 'stale' as const };
      }
      if (
        currentTarget.type === 'source'
        || currentSourceTags.some((tag) => tag.type === 'source')
      ) {
        return { kind: 'source-backed' as const };
      }

      const aliasTagIds = collectAliasTagIds(
        await tx.select({ id: tags.id, unifiedInto: tags.unifiedInto }).from(tags),
        new Set([...tagsToRemove, input.targetTagId]),
        input.targetTagId,
      );
      await tx.update(tags).set({ unifiedInto: null })
        .where(eq(tags.id, input.targetTagId));
      if (aliasTagIds.length > 0) {
        await tx.update(tags).set({ unifiedInto: input.targetTagId })
          .where(inArray(tags.id, aliasTagIds));
      }

      const sourceTaskTags = await tx.select({ taskId: taskTags.taskId })
        .from(taskTags)
        .where(inArray(taskTags.tagId, [...new Set([...tagsToRemove, ...aliasTagIds])]));
      const existingTargetLinks = new Set(
        (await tx.select({ taskId: taskTags.taskId })
          .from(taskTags)
          .where(eq(taskTags.tagId, input.targetTagId)))
          .map((row) => row.taskId),
      );
      const uniqueTaskIds = [...new Set(
        sourceTaskTags
          .filter((row) => !existingTargetLinks.has(row.taskId))
          .map((row) => row.taskId),
      )];
      if (uniqueTaskIds.length > 0) {
        await tx.insert(taskTags)
          .values(uniqueTaskIds.map((taskId) => ({ taskId, tagId: input.targetTagId })));
      }

      await tx.delete(taskTags).where(inArray(taskTags.tagId, tagsToRemove));
      await tx.delete(tags).where(inArray(tags.id, tagsToRemove));

      const updates = tagConsolidationRename(input);
      if (Object.keys(updates).length > 0) {
        await tx.update(tags).set(updates).where(eq(tags.id, input.targetTagId));
      }
      return { kind: 'merged' as const, reassigned: uniqueTaskIds.length };
    }, { isolationLevel: 'read committed' });
  }

  async unifyTags(input: {
    readonly targetTagId: string;
    readonly sourceTagIds: readonly string[];
    readonly newName: string | null;
    readonly newSlug: string | null;
    readonly newColor: string | null;
  }): Promise<TagUnifyOutcome> {
    const tagsToUnify = [...input.sourceTagIds];
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('tag-consolidation'))`,
      );
      const [currentTarget] = await tx.select({ id: tags.id, type: tags.type })
        .from(tags).where(eq(tags.id, input.targetTagId)).limit(1).for('update');
      const currentSourceTags = await tx.select({ id: tags.id, type: tags.type })
        .from(tags).where(inArray(tags.id, tagsToUnify)).for('update');
      if (!currentTarget || currentSourceTags.length !== tagsToUnify.length) {
        return { kind: 'stale' as const };
      }

      const targetIsSourceBacked = currentTarget.type === 'source';
      const sourceBackedTagIds = currentSourceTags
        .filter((tag) => tag.type === 'source')
        .map((tag) => tag.id);
      const localTagIds = currentSourceTags
        .filter((tag) => tag.type !== 'source')
        .map((tag) => tag.id);
      const globallyConsolidatedTagIds = targetIsSourceBacked
        ? sourceBackedTagIds
        : tagsToUnify;

      const allTagAliases = await tx.select({
        id: tags.id,
        type: tags.type,
        unifiedInto: tags.unifiedInto,
      }).from(tags);
      const aliasTypeById = new Map(allTagAliases.map((tag) => [tag.id, tag.type]));
      const aliasTagIds = collectAliasTagIds(
        allTagAliases,
        new Set([...globallyConsolidatedTagIds, input.targetTagId]),
        input.targetTagId,
      );
      const tagsToCanonicalize = [...new Set([
        ...globallyConsolidatedTagIds,
        ...aliasTagIds,
      ].filter((id) => id !== input.targetTagId))];
      const selectedSourceTagIds = new Set([
        input.targetTagId,
        ...tagsToCanonicalize.filter((id) => aliasTypeById.get(id) === 'source'),
      ]);
      const selectedSourceScopeKeys = new Set(
        (await tx.select({
          connectorInstanceId: tasks.connectorInstanceId,
          sourceListId: tasks.sourceListId,
        }).from(taskTags)
          .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
          .where(inArray(taskTags.tagId, [...selectedSourceTagIds])))
          .map((row) => `${row.connectorInstanceId}\u0000${row.sourceListId ?? ''}`),
      );
      if (
        targetIsSourceBacked
        && localTagIds.length > 0
        && selectedSourceScopeKeys.size === 0
      ) {
        return { kind: 'missing-source-scope' as const };
      }

      await tx.update(tags).set({ unifiedInto: null })
        .where(eq(tags.id, input.targetTagId));
      if (tagsToCanonicalize.length > 0) {
        await tx.update(tags).set({ unifiedInto: input.targetTagId })
          .where(inArray(tags.id, tagsToCanonicalize));
      }

      // A source winner represents only its own connector/list scopes. Shared
      // local tags must remain available to every other source.
      const sourceTaskTags = await tx.select({
        taskId: taskTags.taskId,
        tagId: taskTags.tagId,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceListId: tasks.sourceListId,
      }).from(taskTags)
        .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
        .where(inArray(taskTags.tagId, [...new Set([...tagsToUnify, ...aliasTagIds])]));
      const existingTargetLinks = new Set(
        (await tx.select({ taskId: taskTags.taskId })
          .from(taskTags)
          .where(eq(taskTags.tagId, input.targetTagId)))
          .map((row) => row.taskId),
      );

      const uniqueTaskIds = [...new Set(
        sourceTaskTags
          .filter((row) => !targetIsSourceBacked || tagsToCanonicalize.includes(row.tagId))
          .map((row) => row.taskId)
          .filter((taskId) => !existingTargetLinks.has(taskId)),
      )];
      if (uniqueTaskIds.length > 0) {
        await tx.insert(taskTags)
          .values(uniqueTaskIds.map((taskId) => ({ taskId, tagId: input.targetTagId })));
      }

      let detached = 0;
      let detachedTaskIds: string[] = [];
      if (localTagIds.length > 0) {
        if (targetIsSourceBacked) {
          const sourceBackedTaskIds = new Set(
            sourceTaskTags
              .filter((row) => selectedSourceTagIds.has(row.tagId))
              .map((row) => row.taskId),
          );
          const scopedTaskIds = [...new Set(
            sourceTaskTags
              .filter((row) =>
                localTagIds.includes(row.tagId)
                && selectedSourceScopeKeys.has(
                  `${row.connectorInstanceId}\u0000${row.sourceListId ?? ''}`,
                )
                && (existingTargetLinks.has(row.taskId)
                  || sourceBackedTaskIds.has(row.taskId)))
              .map((row) => row.taskId),
          )];
          if (scopedTaskIds.length > 0) {
            const removed = await tx.delete(taskTags).where(and(
              inArray(taskTags.tagId, localTagIds),
              inArray(taskTags.taskId, scopedTaskIds),
            )).returning({ taskId: taskTags.taskId });
            detached = removed.length;
            detachedTaskIds = scopedTaskIds;
          }
        } else {
          await tx.delete(taskTags).where(inArray(taskTags.tagId, localTagIds));
          await tx.delete(tags).where(inArray(tags.id, localTagIds));
        }
      }

      const updates = tagConsolidationRename(input);
      if (Object.keys(updates).length > 0) {
        await tx.update(tags).set(updates).where(eq(tags.id, input.targetTagId));
      }

      return {
        kind: 'unified' as const,
        linked: uniqueTaskIds.length,
        detached,
        detachedTaskIds,
        localTagIds,
        targetIsSourceBacked,
      };
    }, { isolationLevel: 'read committed' });
  }

  async listTaskIdsForTag(tagId: string): Promise<string[]> {
    const rows = await this.db.select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(eq(taskTags.tagId, tagId));
    return rows.map((row) => row.taskId);
  }

  async getTagPushSubject(tagId: string): Promise<TagIdentityRow | null> {
    const [row] = await this.db.select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      color: tags.color,
    }).from(tags).where(eq(tags.id, tagId)).limit(1);
    return row ?? null;
  }

  async getTagSourceRemovalContext(tagId: string): Promise<TagSourceRemovalContext> {
    const [tag] = await this.db.select({ id: tags.id, name: tags.name })
      .from(tags).where(eq(tags.id, tagId)).limit(1);
    if (!tag) return { tag: null, tasks: [] };

    const linkedTaskIds = await this.db.select({ taskId: taskTags.taskId })
      .from(taskTags).where(eq(taskTags.tagId, tagId));
    if (!linkedTaskIds.length) return { tag, tasks: [] };

    const linkedTasks = await this.db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks)
      .where(inArray(tasks.id, linkedTaskIds.map((row) => row.taskId)))
      .orderBy(asc(sql`${tasks.id} COLLATE "C"`));
    return { tag, tasks: linkedTasks };
  }

  async ensureBuiltInSubtaskTemplates(
    seeds: readonly SubtaskTemplateSeed[],
    now: string,
  ): Promise<void> {
    if (!seeds.length) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('mission-control:subtask-template-seed'))`,
      );
      const existing = new Set(
        (await tx.select({ id: subtaskTemplates.id })
          .from(subtaskTemplates)
          .where(inArray(subtaskTemplates.id, seeds.map((seed) => seed.id))))
          .map((row) => row.id),
      );
      const missing = seeds.filter((seed) => !existing.has(seed.id));
      if (!missing.length) return;
      await tx.insert(subtaskTemplates).values(missing.map((seed) => ({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        category: seed.category,
        type: seed.type,
        icon: seed.icon,
        subtasks: seed.subtasks,
        workflowTasks: seed.workflowTasks,
        isBuiltIn: true,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoNothing();
    }, { isolationLevel: 'read committed' });
  }

  async listSubtaskTemplates(input: {
    readonly category: string | null;
    readonly type: string | null;
  }): Promise<SubtaskTemplateRow[]> {
    const conditions: SQL[] = [];
    if (input.category) conditions.push(eq(subtaskTemplates.category, input.category));
    if (input.type) conditions.push(eq(subtaskTemplates.type, input.type));
    return this.db.select(SUBTASK_TEMPLATE_COLUMNS)
      .from(subtaskTemplates)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(sql`${subtaskTemplates.id} COLLATE "C"`));
  }

  async getSubtaskTemplate(templateId: string): Promise<SubtaskTemplateRow | null> {
    const [row] = await this.db.select(SUBTASK_TEMPLATE_COLUMNS)
      .from(subtaskTemplates).where(eq(subtaskTemplates.id, templateId)).limit(1);
    return row ?? null;
  }

  async getSubtaskTemplateApplicationPlan(
    templateId: string,
  ): Promise<SubtaskTemplateApplicationPlan | null> {
    const [row] = await this.db.select({
      id: subtaskTemplates.id,
      type: subtaskTemplates.type,
      subtasks: subtaskTemplates.subtasks,
      workflowTasks: subtaskTemplates.workflowTasks,
    }).from(subtaskTemplates).where(eq(subtaskTemplates.id, templateId)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      subtasks: decodeTemplateSubtasks(row.subtasks),
      workflowTasks: decodeTemplateWorkflowTasks(row.workflowTasks),
    };
  }

  async createSubtaskTemplate(input: {
    readonly id: string;
    readonly template: SubtaskTemplateWrite;
    readonly now: string;
  }): Promise<SubtaskTemplateRow> {
    const [row] = await this.db.insert(subtaskTemplates).values({
      id: input.id,
      name: input.template.name,
      description: input.template.description,
      category: input.template.category,
      type: input.template.type,
      icon: input.template.icon,
      subtasks: input.template.subtasks,
      workflowTasks: input.template.workflowTasks,
      isBuiltIn: false,
      createdAt: input.now,
      updatedAt: input.now,
    }).returning(SUBTASK_TEMPLATE_COLUMNS);
    return row;
  }

  async updateSubtaskTemplate(input: {
    readonly id: string;
    readonly patch: SubtaskTemplatePatch;
    readonly now: string;
  }): Promise<SubtaskTemplateRow | null> {
    const patch = input.patch;
    const [row] = await this.db.update(subtaskTemplates).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.subtasks !== undefined ? { subtasks: patch.subtasks } : {}),
      ...(patch.workflowTasks !== undefined ? { workflowTasks: patch.workflowTasks } : {}),
      updatedAt: input.now,
    }).where(eq(subtaskTemplates.id, input.id)).returning(SUBTASK_TEMPLATE_COLUMNS);
    return row ?? null;
  }

  async deleteSubtaskTemplate(templateId: string): Promise<SubtaskTemplateDeleteOutcome> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select({
        id: subtaskTemplates.id,
        isBuiltIn: subtaskTemplates.isBuiltIn,
      }).from(subtaskTemplates).where(eq(subtaskTemplates.id, templateId)).limit(1);
      if (!existing) return { kind: 'missing' as const };
      if (existing.isBuiltIn) return { kind: 'built-in' as const };
      await tx.delete(subtaskTemplates).where(eq(subtaskTemplates.id, templateId));
      return { kind: 'deleted' as const };
    });
  }

  async applyWorkflowTemplate(input: {
    readonly templateId: string;
    readonly parentTaskId: string | null;
    readonly connectorType: string;
    readonly connectorInstanceId: string;
    readonly isLocalOnly: boolean;
    readonly sourceListId: string | null;
    readonly sourceListName: string | null;
    readonly now: string;
    readonly tasks: readonly TemplateWorkflowTaskInsert[];
  }): Promise<void> {
    if (!input.tasks.length) return;
    const syncStatus = input.isLocalOnly ? 'synced' : 'pending_push';
    const rootDepth = input.parentTaskId ? 1 : 0;
    await this.db.transaction(async (tx) => {
      if (input.parentTaskId) {
        await tx.select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.id, input.parentTaskId))
          .limit(1)
          .for('key share');
      }
      for (const workflowTask of input.tasks) {
        await tx.insert(tasks).values({
          id: workflowTask.id,
          sourceId: `template:${workflowTask.id}`,
          connectorType: input.connectorType,
          connectorInstanceId: input.connectorInstanceId,
          title: workflowTask.title,
          description: workflowTask.description,
          status: 'todo',
          priority: workflowTask.priority,
          parentId: input.parentTaskId,
          depth: rootDepth,
          isChecklistItem: false,
          syncStatus,
          createdAt: input.now,
          updatedAt: input.now,
          metadata: {
            fromTemplate: input.templateId,
            sourceListId: input.sourceListId,
            sourceListName: input.sourceListName,
          },
          lastSyncedAt: input.now,
        });

        for (const subtask of workflowTask.subtasks) {
          await tx.insert(tasks).values({
            id: subtask.id,
            sourceId: `template:${subtask.id}`,
            connectorType: input.connectorType,
            connectorInstanceId: input.connectorInstanceId,
            title: subtask.title,
            status: 'todo',
            priority: 'none',
            parentId: workflowTask.id,
            depth: rootDepth + 1,
            isChecklistItem: true,
            syncStatus,
            createdAt: input.now,
            updatedAt: input.now,
            metadata: { fromTemplate: input.templateId },
            lastSyncedAt: input.now,
          });
        }
      }
    });
  }

  async applySingleTemplate(input: {
    readonly templateId: string;
    readonly parentTaskId: string;
    readonly now: string;
    readonly subtasks: readonly TemplateSubtaskInsert[];
  }): Promise<TemplateSubtaskApplicationOutcome> {
    return this.db.transaction(async (tx) => {
      const [parent] = await tx.select({
        sourceId: tasks.sourceId,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        depth: tasks.depth,
      }).from(tasks).where(eq(tasks.id, input.parentTaskId)).limit(1).for('key share');
      if (!parent) return { kind: 'missing-parent' as const };

      const parentIsLocalOnly = parent.connectorType === 'local'
        || parent.sourceId.startsWith('local:');
      for (const subtask of input.subtasks) {
        await tx.insert(tasks).values({
          id: subtask.id,
          sourceId: `template:${subtask.id}`,
          connectorType: parent.connectorType,
          connectorInstanceId: parent.connectorInstanceId,
          title: subtask.title,
          status: 'todo',
          priority: subtask.priority,
          parentId: input.parentTaskId,
          depth: (parent.depth || 0) + 1,
          isChecklistItem: true,
          syncStatus: parentIsLocalOnly ? 'synced' : 'pending_push',
          createdAt: input.now,
          updatedAt: input.now,
          metadata: subtask.estimatedMinutes === null
            ? { fromTemplate: input.templateId }
            : {
                fromTemplate: input.templateId,
                estimatedMinutes: subtask.estimatedMinutes,
              },
          lastSyncedAt: input.now,
        });
      }
      return { kind: 'applied' as const };
    });
  }

  async getTaskMoveToListContext(taskId: string): Promise<TaskMoveToListTaskRow | null> {
    const [row] = await this.db.select({
      id: tasks.id,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListId: tasks.sourceListId,
    }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    return row ?? null;
  }

  async finalizeTaskMoveToList(input: {
    readonly taskId: string;
    readonly sourceListId: string;
    readonly sourceId: string | null;
    readonly updatedAt: string;
  }): Promise<void> {
    await this.db.update(tasks).set({
      sourceListId: input.sourceListId,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      updatedAt: input.updatedAt,
    }).where(eq(tasks.id, input.taskId));
  }

  async getTaskMovePreviewSnapshot(taskId: string): Promise<TaskMovePreviewSnapshot | null> {
    const [task] = await this.db.select(MOVE_TASK_COLUMNS)
      .from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) return null;

    const [tagRows, subtaskRows, schedules, attachments, projectRows] = await Promise.all([
      this.db.select({ name: tags.name, slug: tags.slug })
        .from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(eq(taskTags.taskId, taskId))
        .orderBy(asc(sql`${tags.id} COLLATE "C"`)),
      this.db.select({ count: sql<number>`count(*)` })
        .from(tasks).where(eq(tasks.parentId, taskId)),
      this.db.select({
        estimatedDuration: taskSchedules.estimatedDuration,
        recurrence: taskSchedules.recurrence,
        scheduledDate: taskSchedules.scheduledDate,
        scheduledTime: taskSchedules.scheduledTime,
        isTimeBlocked: taskSchedules.isTimeBlocked,
      }).from(taskSchedules).where(eq(taskSchedules.taskId, taskId)).limit(1),
      this.db.select({ sourceAttachmentId: taskAttachments.sourceAttachmentId })
        .from(taskAttachments).where(eq(taskAttachments.taskId, taskId)),
      this.db.select({ count: sql<number>`count(*)` })
        .from(taskProjects).where(eq(taskProjects.taskId, taskId)),
    ]);

    return {
      task: toMoveTaskRow(task),
      tags: tagRows,
      subtaskCount: Number(subtaskRows[0]?.count ?? 0),
      schedule: schedules[0] ?? null,
      storedAttachmentCount: attachments.length,
      storedAttachmentSourceIds: attachments
        .map((attachment) => attachment.sourceAttachmentId)
        .filter((id): id is string => id !== null),
      projectCount: Number(projectRows[0]?.count ?? 0),
    };
  }

  async readSmartScoreInputs(input: {
    readonly statuses: readonly string[];
  }): Promise<TaskSmartScoreSnapshot> {
    const [rankingRows, taskRows] = await Promise.all([
      this.db.select({
        id: sourceRankings.id,
        connectorType: sourceRankings.connectorType,
        name: sourceRankings.name,
        rank: sourceRankings.rank,
        updatedAt: sourceRankings.updatedAt,
      }).from(sourceRankings)
        .orderBy(asc(sourceRankings.rank), asc(sql`${sourceRankings.id} COLLATE "C"`)),
      input.statuses.length
        ? this.db.select(MOVE_TASK_COLUMNS).from(tasks)
            .where(inArray(tasks.status, [...input.statuses]))
            .orderBy(asc(sql`${tasks.id} COLLATE "C"`))
        : [],
    ]);

    const taskIds = taskRows.map((task) => task.id);
    if (!taskIds.length) {
      return {
        tasks: [],
        sourceRankings: rankingRows,
        taskTags: [],
        taskProjects: [],
        estimatedDurations: [],
      };
    }

    const [tagRows, projectRows, scheduleRows] = await Promise.all([
      this.db.select({
        taskId: taskTags.taskId,
        tagId: tags.id,
        unifiedInto: tags.unifiedInto,
        tagName: tags.name,
      }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, taskIds))
        .orderBy(
          asc(sql`${taskTags.taskId} COLLATE "C"`),
          asc(sql`${tags.id} COLLATE "C"`),
        ),
      this.db.select({
        taskId: taskProjects.taskId,
        projectId: hubProjects.id,
        projectName: hubProjects.name,
      }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(inArray(taskProjects.taskId, taskIds))
        .orderBy(
          asc(sql`${taskProjects.taskId} COLLATE "C"`),
          asc(sql`${hubProjects.id} COLLATE "C"`),
        ),
      this.db.select({
        taskId: taskSchedules.taskId,
        estimatedDuration: taskSchedules.estimatedDuration,
      }).from(taskSchedules)
        .where(inArray(taskSchedules.taskId, taskIds))
        .orderBy(asc(sql`${taskSchedules.taskId} COLLATE "C"`)),
    ]);

    return {
      tasks: taskRows.map(toMoveTaskRow),
      sourceRankings: rankingRows,
      taskTags: tagRows.map((row) => ({
        taskId: row.taskId,
        tagId: row.unifiedInto || row.tagId,
        tagName: row.tagName,
      })),
      taskProjects: projectRows,
      estimatedDurations: scheduleRows,
    };
  }
}

/**
 * Builds the whole PostgreSQL task-core composition atomically: either every
 * member resolves or nothing is registered, so there is never a
 * half-migrated task-core surface under PostgreSQL.
 */
export function createPostgresTaskCorePersistence(
  db: PostgresDatabase,
): TaskCorePersistence {
  const filterInputs = new PostgresTaskFilterInputRepository(db);
  const queries = new PostgresTaskQueryRepository(db, filterInputs);
  return {
    collections: new PostgresTaskCollectionReadRepository(db, queries),
    details: new PostgresTaskDetailReadRepository(db),
    creates: new PostgresTaskCreateRepository(db),
    mutations: new PostgresTaskMutationRepository(db),
    removals: new PostgresTaskRemovalRepository(db),
    taskReads: new PostgresTaskReadRepository(db, filterInputs),
    filterInputs,
    queries,
    policyIdentities: new PostgresTaskPolicyIdentityRepository(db),
    lifecycle: new PostgresLocalTaskLifecycleRepository(db),
    scoutDeletion: new PostgresScoutTaskHardDeleteRepository(db),
    moves: new PostgresTaskMoveRepository(db),
    writeThroughMoves: new PostgresWriteThroughTaskMoveRepository(db),
    priorityEntities: new PostgresPriorityEntityRepository(db),
    sourceListNames: new PostgresSourceListNameRepository(db),
    transferIdentity: new PostgresTaskTransferIdentityRepository(db),
    quickSort: new PostgresTaskQuickSortRepository(db),
    ancillary: new PostgresTaskAncillaryRepository(db),
    organization: new PostgresTaskOrganizationRepository(db),
  };
}
