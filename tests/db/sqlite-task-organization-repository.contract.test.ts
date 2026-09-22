import { afterAll, beforeAll, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as SchemaModule from '@/db/schema';
import {
  describeTaskOrganizationRepositoryContract,
  type TaskOrganizationContractHarness,
} from '../contracts/task-organization-repository.contract';

/**
 * Runs the shared task-organization contract against the real SQLite adapter
 * (in-process better-sqlite3, migrations applied by `@/db`'s bootstrap).
 */

const originalDbPath = process.env.MC_DB_PATH;
let db: BetterSQLite3Database<typeof SchemaModule>;
let sqlite: Database.Database;
let schema: typeof SchemaModule;
let harness: TaskOrganizationContractHarness;

const DEFAULT_NOW = '2026-09-01T09:00:00.000Z';

beforeAll(async () => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.resetModules();

  const [dbModule, schemaModule, adapter] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/db/persistence/sqlite-task-core-repositories'),
  ]);
  db = dbModule.default;
  sqlite = dbModule.sqlite;
  schema = schemaModule;

  const persistence = adapter.createSqliteTaskCorePersistence(db, dbModule.runTransaction);

  harness = {
    repository: persistence.organization,
    async reset() {
      const tables = [
        schema.taskAttachments,
        schema.taskSchedules,
        schema.taskProjects,
        schema.taskTags,
        schema.subtaskTemplates,
        schema.sourceRankings,
        schema.sourceLists,
        schema.tags,
        schema.hubProjects,
        schema.tasks,
      ];
      for (const table of tables) await db.delete(table);
    },
    async insertTasks(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.tasks).values(rows.map((row) => ({
        id: row.id,
        sourceId: row.sourceId ?? `local:${row.id}`,
        connectorType: row.connectorType ?? 'local',
        connectorInstanceId: row.connectorInstanceId ?? 'local',
        title: row.title ?? row.id,
        description: row.description ?? null,
        status: row.status ?? 'todo',
        localDisposition: row.localDisposition ?? 'active',
        priority: row.priority ?? 'none',
        dueDate: row.dueDate ?? null,
        createdAt: row.createdAt ?? DEFAULT_NOW,
        updatedAt: row.updatedAt ?? DEFAULT_NOW,
        parentId: row.parentId ?? null,
        depth: row.depth ?? 0,
        isChecklistItem: row.isChecklistItem ?? false,
        sourceListId: row.sourceListId ?? null,
        sourceListName: row.sourceListName ?? null,
        assignee: row.assignee ?? null,
        metadata: {},
        syncStatus: 'synced',
        lastSyncedAt: DEFAULT_NOW,
        effort: row.effort ?? null,
      })));
    },
    async insertTags(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.tags).values(rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type ?? 'hub',
        source: row.source ?? null,
        color: row.color ?? null,
        confirmed: row.confirmed ?? true,
        createdAt: row.createdAt ?? DEFAULT_NOW,
        unifiedInto: row.unifiedInto ?? null,
      })));
    },
    async insertTaskTags(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskTags).values(rows.map((row) => ({ ...row })));
    },
    async insertSourceLists(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.sourceLists).values(rows.map((row) => ({
        id: row.id,
        connectorInstanceId: row.connectorInstanceId,
        sourceId: row.sourceId,
        name: row.name,
        type: 'list',
        hidden: false,
        sortOrder: 0,
      })));
    },
    async insertSchedules(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskSchedules).values(rows.map((row) => ({
        taskId: row.taskId,
        scheduledDate: row.scheduledDate ?? '2026-09-10',
        scheduledTime: row.scheduledTime ?? null,
        estimatedDuration: row.estimatedDuration ?? null,
        isTimeBlocked: row.isTimeBlocked ?? false,
        recurrence: row.recurrence ?? null,
        recurrenceMode: 'schedule' as const,
      })));
    },
    async insertAttachments(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskAttachments).values(rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        name: row.name,
        contentType: 'text/plain',
        size: row.size,
        contentBase64: null,
        sourceAttachmentId: row.sourceAttachmentId ?? null,
        createdAt: DEFAULT_NOW,
      })));
    },
    async insertProjects(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.hubProjects).values(rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: '#3b82f6',
        hidden: false,
        createdAt: DEFAULT_NOW,
        updatedAt: DEFAULT_NOW,
      })));
    },
    async insertTaskProjects(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskProjects).values(rows.map((row) => ({ ...row })));
    },
    async insertSourceRankings(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.sourceRankings).values(rows.map((row) => ({
        id: row.id,
        connectorType: row.connectorType,
        name: row.name,
        rank: row.rank,
        updatedAt: DEFAULT_NOW,
      })));
    },
    async listTagIds() {
      const rows = sqlite.prepare('SELECT id FROM tags ORDER BY id')
        .all() as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    async getTagUnifiedInto(tagId) {
      const row = sqlite
        .prepare('SELECT unified_into AS unifiedInto FROM tags WHERE id = ?')
        .get(tagId) as { unifiedInto: string | null } | undefined;
      return row === undefined ? undefined : row.unifiedInto;
    },
    async listTaskTagIds(taskId) {
      const rows = sqlite
        .prepare('SELECT tag_id AS tagId FROM task_tags WHERE task_id = ? ORDER BY tag_id')
        .all(taskId) as Array<{ tagId: string }>;
      return rows.map((row) => row.tagId);
    },
    async listTaskIds() {
      const rows = sqlite.prepare('SELECT id FROM tasks ORDER BY id')
        .all() as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    async getTaskParentId(taskId) {
      const row = sqlite.prepare('SELECT parent_id AS parentId FROM tasks WHERE id = ?')
        .get(taskId) as { parentId: string | null } | undefined;
      return row?.parentId;
    },
    deleteTask: (taskId, recursive) =>
      persistence.lifecycle.deleteTaskLocally({ taskId, recursive }),
    async getTaskSource(taskId) {
      const row = sqlite
        .prepare('SELECT source_list_id AS sourceListId, source_id AS sourceId FROM tasks WHERE id = ?')
        .get(taskId) as { sourceListId: string | null; sourceId: string } | undefined;
      return row ?? null;
    },
    async forceMergeFailure(input) {
      // An abort trigger on the source-tag delete forces the merge to fail
      // after it has already reassigned links, which is exactly the window a
      // non-atomic implementation would leave durable.
      sqlite.exec(`
        CREATE TRIGGER organization_merge_forced_failure
        BEFORE DELETE ON tags
        WHEN OLD.id = '${input.sourceTagIds[0].replaceAll("'", "''")}'
        BEGIN
          SELECT RAISE(ABORT, 'forced merge failure');
        END;
      `);
      try {
        await harness.repository.mergeTags({
          targetTagId: input.targetTagId,
          sourceTagIds: [...input.sourceTagIds],
          newName: null,
          newSlug: null,
          newColor: null,
        });
        return null;
      } catch (error) {
        return error;
      } finally {
        sqlite.exec('DROP TRIGGER organization_merge_forced_failure');
      }
    },
  };
}, 60_000);

afterAll(() => {
  sqlite?.close();
  if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = originalDbPath;
});

describeTaskOrganizationRepositoryContract('SQLite adapter', () => harness);
