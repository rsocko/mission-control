import { and, asc, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
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
  quickSortLog,
  quickSortOperations,
  scoutReconciliationEvaluations,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
  sourceLists,
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
  type TaskFilterInputRepository,
  type TaskFilterSpec,
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
  type TaskScheduleRow,
  type TaskSourceCounts,
  type TaskSourceIdentityRow,
  type TaskStatsResult,
  type TaskTransferIdentityRepository,
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

/**
 * Explicit NULL placement for the nullable sort columns (`dueDate`,
 * `sourceListName`). PostgreSQL defaults to NULLS LAST ascending / FIRST
 * descending, which is the opposite of SQLite's "NULL is the lowest value".
 * The observable ordering of the legacy `/api/tasks` route is the SQLite one,
 * so both adapters state it explicitly instead of inheriting a dialect
 * default. `effort` needs no rank: `EFFORT_ORDER_EXPRESSION` coalesces NULL
 * away on both backends.
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
    return this.countWhere(scope.includeQuickFilter ? compiled.taskWhere : compiled.baseWhere);
  }

  async listTaskIds(spec: TaskFilterSpec, page: TaskListPage): Promise<string[]> {
    const compiled = compileCanonicalTaskFilter(spec, await this.resolveInputs(spec));
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
      ? sql`${column} COLLATE "C"`
      : column;

    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(compiled.taskWhere)
      // `id` is the deterministic tie-break so two backends can never
      // disagree about the page boundary for equal sort keys.
      .orderBy(
        ...(nullable ? [direction(nullsLowestRank(nullable))] : []),
        direction(orderedColumn),
        asc(sql`${tasks.id} COLLATE "C"`),
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

async function deleteTaskWithinTransaction(
  tx: PostgresTransaction,
  taskId: string,
  recursive: boolean,
): Promise<void> {
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

/**
 * `metadata` is a real `jsonb` column here, so the object is written as-is
 * rather than serialized the way the SQLite text column requires.
 */
function moveTaskInsertValues(task: TaskMoveTaskInsert) {
  return { ...task, metadata: task.metadata };
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
      .from(tasks).where(eq(tasks.parentId, parentTaskId)).limit(limit);
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

  async claimTaskMove(request: TaskMoveClaimRequest): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.update(tasks).set({
        syncStatus: request.claimSyncStatus,
        metadata: request.metadata,
      }).where(and(
        eq(tasks.id, request.taskId),
        eq(tasks.sourceId, request.expectedSourceId),
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
    const orderedUniqueSourceIds = [...new Set(input.sourceListIds.filter(Boolean))];
    const localIdBySourceId = new Map<string, string>();
    if (orderedUniqueSourceIds.length > 0) {
      const rows = await this.db.select({
        sourceId: sourceLists.sourceId,
        localId: sourceLists.id,
      }).from(sourceLists).where(and(
        eq(sourceLists.connectorInstanceId, input.connectorInstanceId),
        inArray(sourceLists.sourceId, orderedUniqueSourceIds),
      ));
      for (const row of rows) localIdBySourceId.set(row.sourceId, row.localId);
    }
    const resolvedSourceLists = orderedUniqueSourceIds
      .filter((sourceId) => localIdBySourceId.has(sourceId))
      .map((sourceId) => ({ sourceId, localId: localIdBySourceId.get(sourceId)! }));

    const [taskRow] = await this.db.select({ metadata: tasks.metadata })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);

    return {
      taskExists: Boolean(taskRow),
      taskMetadata: taskRow ? asRecord(taskRow.metadata) : {},
      sourceLists: resolvedSourceLists,
    };
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
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select({ metadata: tasks.metadata })
        .from(tasks)
        .where(and(
          eq(tasks.id, input.taskId),
          eq(tasks.connectorInstanceId, input.connectorInstanceId),
        ))
        .limit(1)
        .for('update');
      if (!current) return false;
      const metadata = {
        ...asRecord(current.metadata),
        ...input.task.metadata,
      };
      const updated = await tx.update(tasks).set({
        sourceId: input.task.sourceId,
        sourceListId: input.task.sourceListId,
        sourceListName: input.task.sourceListName,
        title: input.task.title,
        description: input.task.description,
        status: input.task.status,
        statusReason: input.task.statusReason,
        priority: input.task.priority,
        effort: input.task.effort,
        microStatus: input.task.microStatus,
        assignee: input.task.assignee,
        updatedAt: input.task.updatedAt,
        completedAt: input.task.completedAt,
        metadata,
        syncStatus: 'synced',
        lastSyncedAt: input.observedAt,
      }).where(and(
        eq(tasks.id, input.taskId),
        eq(tasks.connectorInstanceId, input.connectorInstanceId),
      )).returning({ id: tasks.id });
      return updated.length === 1;
    });
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
  return {
    filterInputs,
    queries: new PostgresTaskQueryRepository(db, filterInputs),
    policyIdentities: new PostgresTaskPolicyIdentityRepository(db),
    lifecycle: new PostgresLocalTaskLifecycleRepository(db),
    scoutDeletion: new PostgresScoutTaskHardDeleteRepository(db),
    moves: new PostgresTaskMoveRepository(db),
    writeThroughMoves: new PostgresWriteThroughTaskMoveRepository(db),
    priorityEntities: new PostgresPriorityEntityRepository(db),
    sourceListNames: new PostgresSourceListNameRepository(db),
    transferIdentity: new PostgresTaskTransferIdentityRepository(db),
  };
}
