import { eq, or, sql } from 'drizzle-orm';
import type { Tag, TaskItem } from '@/types';
import type { TaskRepository } from '@/db/persistence/core-repositories';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import {
  focusItems,
  myDayExclusions,
  myDayItems,
  notifications,
  prioritySyncLog,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  quickSortLog,
  quickSortOperations,
  tags,
  taskAttachments,
  taskDependencies,
  taskLinkedSources,
  taskProjects,
  taskSchedules,
  tasks,
  taskTags,
  weeklyOneThing,
} from '../schema';

type TaskRow = typeof tasks.$inferSelect;

type Queryable = PostgresDatabase | PostgresTransaction;

interface TagRow {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  color: string | null;
  confirmed: boolean;
  createdAt: string;
}

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as Tag['type'],
    source: row.source ?? undefined,
    color: row.color ?? undefined,
    confirmed: row.confirmed,
    createdAt: row.createdAt,
  };
}

function toTaskItem(
  row: TaskRow,
  relations: { tags: Tag[]; hubProjectIds: string[]; childIds: string[] },
): TaskItem {
  return {
    id: row.id,
    sourceId: row.sourceId,
    connectorType: row.connectorType,
    connectorInstanceId: row.connectorInstanceId,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskItem['status'],
    localDisposition: row.localDisposition as TaskItem['localDisposition'],
    microStatus: (row.microStatus ?? undefined) as TaskItem['microStatus'],
    statusReason: (row.statusReason ?? undefined) as TaskItem['statusReason'],
    priority: row.priority as TaskItem['priority'],
    planningHorizon: row.planningHorizon,
    dueDate: row.dueDate ?? undefined,
    pushCount: row.pushCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
    snoozedUntil: row.snoozedUntil,
    parentId: row.parentId ?? undefined,
    childIds: relations.childIds,
    depth: row.depth,
    isChecklistItem: row.isChecklistItem,
    sourceListId: row.sourceListId ?? undefined,
    sourceListName: row.sourceListName ?? undefined,
    hubProjectIds: relations.hubProjectIds,
    tags: relations.tags,
    assignee: row.assignee ?? undefined,
    metadata: row.metadata as Record<string, unknown>,
    syncStatus: row.syncStatus as TaskItem['syncStatus'],
    lastSyncedAt: row.lastSyncedAt,
    effort: row.effort ?? undefined,
    kanbanColumn: row.kanbanColumn ?? undefined,
    kanbanOrder: row.kanbanOrder ?? undefined,
  };
}

async function loadTaskTags(client: Queryable, taskId: string): Promise<Tag[]> {
  const rows = await client
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      createdAt: tags.createdAt,
    })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(eq(taskTags.taskId, taskId));
  return rows.map(toTag);
}

async function loadHubProjectIds(client: Queryable, taskId: string): Promise<string[]> {
  const rows = await client
    .select({ projectId: taskProjects.projectId })
    .from(taskProjects)
    .where(eq(taskProjects.taskId, taskId));
  return rows.map((row) => row.projectId);
}

async function loadChildIds(client: Queryable, taskId: string): Promise<string[]> {
  const rows = await client
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentId, taskId));
  return rows.map((row) => row.id);
}

/**
 * Ports the SQLite adapter's `detachTaskDescendants` (see
 * `src/lib/tasks/task-hierarchy-deletion.ts`): before a task is deleted, its
 * direct children are detached (`parent_id` set to NULL) rather than left
 * dangling, and the whole descendant subtree's `depth` is recomputed
 * relative to its new roots (immediate children become depth 0, their
 * children depth 1, etc.) — otherwise grandchildren would keep depth values
 * that are now off by the removed ancestor. A path array guards against
 * cycles in malformed data, mirroring the SQLite version's `instr` check.
 */
async function detachTaskDescendants(tx: PostgresTransaction, taskId: string): Promise<void> {
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

async function loadRelations(
  client: Queryable,
  taskId: string,
): Promise<{ tags: Tag[]; hubProjectIds: string[]; childIds: string[] }> {
  const [taskTagList, hubProjectIds, childIds] = await Promise.all([
    loadTaskTags(client, taskId),
    loadHubProjectIds(client, taskId),
    loadChildIds(client, taskId),
  ]);
  return { tags: taskTagList, hubProjectIds, childIds };
}

/**
 * Upserts the shared `tags` rows referenced by a task, then replaces the
 * `task_tags` junction rows to exactly match the provided set. Tag
 * "unification" (`unified_into`) is intentionally preserved by omitting it
 * from the upsert's SET clause, since it isn't part of the portable `Tag`
 * type.
 */
async function syncTaskTags(
  tx: PostgresTransaction,
  taskId: string,
  taskTagList: Tag[],
): Promise<void> {
  for (const tag of taskTagList) {
    await tx
      .insert(tags)
      .values({
        id: tag.id,
        name: tag.name,
        slug: tag.slug,
        type: tag.type,
        source: tag.source ?? null,
        color: tag.color ?? null,
        confirmed: tag.confirmed,
        createdAt: tag.createdAt,
      })
      .onConflictDoUpdate({
        target: tags.id,
        set: {
          name: tag.name,
          slug: tag.slug,
          type: tag.type,
          source: tag.source ?? null,
          color: tag.color ?? null,
          confirmed: tag.confirmed,
        },
      });
  }

  await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
  if (taskTagList.length > 0) {
    await tx.insert(taskTags).values(
      taskTagList.map((tag) => ({ taskId, tagId: tag.id })),
    );
  }
}

async function syncHubProjectIds(
  tx: PostgresTransaction,
  taskId: string,
  hubProjectIds: string[],
): Promise<void> {
  await tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId));
  if (hubProjectIds.length > 0) {
    await tx.insert(taskProjects).values(
      hubProjectIds.map((projectId) => ({ taskId, projectId })),
    );
  }
}

/**
 * PostgreSQL-backed implementation of the portable `TaskRepository`
 * contract. `TaskItem.childIds` is a derived, read-only relation (the
 * reverse of `parentId`) and is never written by `upsert` — it is
 * recomputed on every `get`. `tags` and `hubProjectIds` are owned
 * many-to-many relations that are fully replaced on every `upsert` to match
 * the provided arrays.
 *
 * Note: `TaskItem.externalIdentity`, `githubParentIdentity`, and
 * `taskSourceModel` are transient connector-evidence fields with no
 * dedicated column in `tasks` (they are consumed by higher-level identity
 * resolution flows, not persisted directly), so this repository does not
 * round-trip them; `get()` always returns them as `undefined`.
 */
export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string): Promise<TaskItem | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    if (!row) return null;
    const relations = await loadRelations(this.db, id);
    return toTaskItem(row, relations);
  }

  async upsert(task: TaskItem): Promise<TaskItem> {
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const values = {
        id: task.id,
        sourceId: task.sourceId,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        title: task.title,
        description: task.description ?? null,
        status: task.status,
        localDisposition: task.localDisposition ?? 'active',
        priority: task.priority,
        planningHorizon: task.planningHorizon ?? null,
        dueDate: task.dueDate ?? null,
        pushCount: task.pushCount ?? 0,
        createdAt: task.createdAt ?? now,
        updatedAt: now,
        completedAt: task.completedAt ?? null,
        parentId: task.parentId ?? null,
        depth: task.depth,
        isChecklistItem: task.isChecklistItem,
        sourceListId: task.sourceListId ?? null,
        sourceListName: task.sourceListName ?? null,
        assignee: task.assignee ?? null,
        microStatus: task.microStatus ?? null,
        statusReason: task.statusReason ?? null,
        metadata: task.metadata,
        syncStatus: task.syncStatus,
        lastSyncedAt: task.lastSyncedAt ?? now,
        kanbanColumn: task.kanbanColumn ?? null,
        kanbanOrder: task.kanbanOrder ?? null,
        snoozedUntil: task.snoozedUntil ?? null,
        effort: task.effort ?? null,
      };

      const [row] = await tx
        .insert(tasks)
        .values(values)
        .onConflictDoUpdate({
          target: tasks.id,
          set: {
            sourceId: values.sourceId,
            connectorType: values.connectorType,
            connectorInstanceId: values.connectorInstanceId,
            title: values.title,
            description: values.description,
            status: values.status,
            localDisposition: values.localDisposition,
            priority: values.priority,
            planningHorizon: values.planningHorizon,
            dueDate: values.dueDate,
            pushCount: values.pushCount,
            updatedAt: values.updatedAt,
            completedAt: values.completedAt,
            parentId: values.parentId,
            depth: values.depth,
            isChecklistItem: values.isChecklistItem,
            sourceListId: values.sourceListId,
            sourceListName: values.sourceListName,
            assignee: values.assignee,
            microStatus: values.microStatus,
            statusReason: values.statusReason,
            metadata: values.metadata,
            syncStatus: values.syncStatus,
            lastSyncedAt: values.lastSyncedAt,
            kanbanColumn: values.kanbanColumn,
            kanbanOrder: values.kanbanOrder,
            snoozedUntil: values.snoozedUntil,
            effort: values.effort,
          },
        })
        .returning();

      await syncTaskTags(tx, task.id, task.tags);
      await syncHubProjectIds(tx, task.id, task.hubProjectIds);

      const relations = await loadRelations(tx, task.id);
      return toTaskItem(row, relations);
    });
  }

  /**
   * Deletes a task, detaching (not cascading into) its descendant subtree
   * and cleaning up every other table that references the task by id,
   * mirroring `deleteTaskLocally` in `src/lib/tasks/local-task-lifecycle.ts`.
   */
  async delete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await detachTaskDescendants(tx, id);

      await tx.delete(taskTags).where(eq(taskTags.taskId, id));
      await tx.delete(projectAutoIncludeExclusions).where(eq(projectAutoIncludeExclusions.taskId, id));
      await tx.delete(taskProjects).where(eq(taskProjects.taskId, id));
      await tx.delete(taskSchedules).where(eq(taskSchedules.taskId, id));
      await tx.delete(myDayItems).where(eq(myDayItems.taskId, id));
      await tx.delete(myDayExclusions).where(eq(myDayExclusions.taskId, id));
      await tx.delete(focusItems).where(eq(focusItems.taskId, id));
      await tx.delete(weeklyOneThing).where(eq(weeklyOneThing.taskId, id));
      await tx.delete(prioritySyncLog).where(eq(prioritySyncLog.taskId, id));
      await tx.delete(quickSortLog).where(eq(quickSortLog.taskId, id));
      await tx.delete(quickSortOperations).where(eq(quickSortOperations.taskId, id));
      await tx.delete(taskLinkedSources).where(eq(taskLinkedSources.taskId, id));
      await tx.delete(taskAttachments).where(eq(taskAttachments.taskId, id));
      await tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, id));
      await tx.update(notifications).set({ relatedTaskId: null }).where(eq(notifications.relatedTaskId, id));
      await tx.delete(taskDependencies).where(
        or(eq(taskDependencies.taskId, id), eq(taskDependencies.dependsOnTaskId, id)),
      );

      const deleted = await tx
        .delete(tasks)
        .where(eq(tasks.id, id))
        .returning({ id: tasks.id });
      return deleted.length > 0;
    });
  }
}
