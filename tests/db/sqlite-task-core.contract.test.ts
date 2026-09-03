import { afterAll, beforeAll, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as SchemaModule from '@/db/schema';
import {
  describeTaskCoreContract,
  type SeedAttachment,
  type SeedConnector,
  type SeedPriorityEntity,
  type SeedSourceList,
  type SeedTag,
  type SeedTask,
  type TaskCoreContractHarness,
} from '../contracts/task-core.contract';

/**
 * Runs the shared task-core contract suite against the real SQLite adapter
 * (in-process better-sqlite3, migrations applied by `@/db`'s bootstrap).
 */

const originalDbPath = process.env.MC_DB_PATH;
let db: BetterSQLite3Database<typeof SchemaModule>;
let sqlite: Database.Database;
let schema: typeof SchemaModule;
let harness: TaskCoreContractHarness;

const DEFAULT_NOW = '2026-08-05T12:00:00.000Z';

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
    persistence,
    async reset() {
      const tables = [
        schema.taskIngestSuppressions,
        schema.taskAttachments,
        schema.taskSchedules,
        schema.projectPhaseItems,
        schema.taskProjects,
        schema.taskTags,
        schema.myDayExclusions,
        schema.myDayItems,
        schema.priorityEntities,
        schema.sourceLists,
        schema.connectorConfigs,
        schema.appSettings,
        schema.tags,
        schema.hubProjects,
        schema.tasks,
      ];
      for (const table of tables) await db.delete(table);
    },
    async insertTasks(rows: SeedTask[]) {
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
        planningHorizon: (row.planningHorizon ?? null) as 'next' | null,
        dueDate: row.dueDate ?? null,
        createdAt: row.createdAt ?? DEFAULT_NOW,
        updatedAt: row.updatedAt ?? DEFAULT_NOW,
        completedAt: row.completedAt ?? null,
        parentId: row.parentId ?? null,
        depth: row.depth ?? 0,
        isChecklistItem: row.isChecklistItem ?? false,
        sourceListId: row.sourceListId ?? null,
        sourceListName: row.sourceListName ?? null,
        assignee: row.assignee ?? null,
        microStatus: row.microStatus ?? null,
        metadata: row.metadata ?? {},
        syncStatus: row.syncStatus ?? 'synced',
        lastSyncedAt: row.lastSyncedAt ?? DEFAULT_NOW,
        effort: row.effort ?? null,
      })));
    },
    async insertTags(rows: SeedTag[]) {
      if (rows.length === 0) return;
      await db.insert(schema.tags).values(rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type ?? 'label',
        source: row.source ?? null,
        color: row.color ?? null,
        confirmed: row.confirmed ?? true,
        createdAt: row.createdAt ?? DEFAULT_NOW,
        unifiedInto: row.unifiedInto ?? null,
      })));
    },
    async insertTaskTags(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskTags).values([...rows]);
    },
    async insertProjects(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.hubProjects).values(rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: DEFAULT_NOW,
        updatedAt: DEFAULT_NOW,
      })));
    },
    async insertTaskProjects(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskProjects).values([...rows]);
    },
    async insertSourceLists(rows: SeedSourceList[]) {
      if (rows.length === 0) return;
      await db.insert(schema.sourceLists).values(rows.map((row) => ({
        id: row.id,
        connectorInstanceId: row.connectorInstanceId,
        sourceId: row.sourceId,
        name: row.name,
        type: row.type ?? 'list',
        userDisplayName: row.userDisplayName ?? null,
        groupId: row.groupId ?? null,
        iconColor: row.iconColor ?? null,
      })));
    },
    async insertMyDayItems(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.myDayItems).values(rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        date: row.date,
        addedAt: DEFAULT_NOW,
      })));
    },
    async insertMyDayExclusion(row) {
      await db.insert(schema.myDayExclusions).values({
        id: row.id,
        taskId: row.taskId,
        date: row.date,
        removedAt: DEFAULT_NOW,
      });
    },
    async insertTaskSchedules(rows) {
      if (rows.length === 0) return;
      await db.insert(schema.taskSchedules).values(rows.map((row) => ({
        taskId: row.taskId,
        scheduledDate: row.scheduledDate ?? '2026-08-10',
        scheduledTime: row.scheduledTime ?? null,
        estimatedDuration: row.estimatedDuration ?? null,
        isTimeBlocked: row.isTimeBlocked ?? false,
        recurrence: row.recurrence ?? null,
        recurrenceMode: row.recurrenceMode ?? 'schedule',
      })));
    },
    async insertConnectors(rows: SeedConnector[]) {
      if (rows.length === 0) return;
      await db.insert(schema.connectorConfigs).values(rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name ?? row.id,
        enabled: row.enabled ?? true,
        capabilities: {},
        credentials: {},
        settings: row.settings ?? {},
        syncedLists: row.syncedLists ?? [],
        createdAt: DEFAULT_NOW,
        updatedAt: DEFAULT_NOW,
        deletedAt: row.deletedAt ?? null,
      })));
    },
    async setAppSetting(key, value) {
      await db.insert(schema.appSettings)
        .values({ key, value, updatedAt: DEFAULT_NOW })
        .onConflictDoUpdate({
          target: schema.appSettings.key,
          set: { value, updatedAt: DEFAULT_NOW },
        });
    },
    async insertAttachments(rows: SeedAttachment[]) {
      if (rows.length === 0) return;
      await db.insert(schema.taskAttachments).values(rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        name: row.name,
        contentType: row.contentType ?? 'text/plain',
        size: row.size,
        contentBase64: row.contentBase64 ?? null,
        sourceAttachmentId: row.sourceAttachmentId ?? null,
        createdAt: row.createdAt ?? DEFAULT_NOW,
      })));
    },
    async insertPriorityEntities(rows: SeedPriorityEntity[]) {
      if (rows.length === 0) return;
      await db.insert(schema.priorityEntities).values(rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        referenceId: row.referenceId ?? null,
        tier: 'standard',
        color: '#64748b',
        rank: row.rank ?? 0,
        activeTaskCount: 0,
        createdAt: DEFAULT_NOW,
        updatedAt: DEFAULT_NOW,
      })));
    },
    async listTaskIds() {
      const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks);
      return rows.map((row) => row.id).sort();
    },
    async listTaskTagIds(taskId) {
      const rows = sqlite
        .prepare('SELECT tag_id AS tagId FROM task_tags WHERE task_id = ?')
        .all(taskId) as Array<{ tagId: string }>;
      return rows.map((row) => row.tagId).sort();
    },
    async listTaskProjectIds(taskId) {
      const rows = sqlite
        .prepare('SELECT project_id AS projectId FROM task_projects WHERE task_id = ?')
        .all(taskId) as Array<{ projectId: string }>;
      return rows.map((row) => row.projectId).sort();
    },
    async listMyDayTaskIds() {
      const rows = sqlite
        .prepare('SELECT DISTINCT task_id AS taskId FROM my_day_items')
        .all() as Array<{ taskId: string }>;
      return rows.map((row) => row.taskId).sort();
    },
    async listIngestSuppressions() {
      const rows = sqlite
        .prepare('SELECT connector_instance_id AS connectorInstanceId, source_id AS sourceId FROM task_ingest_suppressions')
        .all() as Array<{ connectorInstanceId: string; sourceId: string }>;
      return rows;
    },
    async listAttachmentTaskIds() {
      const rows = sqlite
        .prepare('SELECT DISTINCT task_id AS taskId FROM task_attachments')
        .all() as Array<{ taskId: string }>;
      return rows.map((row) => row.taskId).sort();
    },
    async getTaskUpdatedAt(taskId) {
      const row = sqlite
        .prepare('SELECT updated_at AS updatedAt FROM tasks WHERE id = ?')
        .get(taskId) as { updatedAt: string } | undefined;
      return row?.updatedAt ?? null;
    },
    async countMyDayItems() {
      const row = sqlite
        .prepare('SELECT COUNT(*) AS total FROM my_day_items')
        .get() as { total: number };
      return Number(row.total);
    },
  };
}, 60_000);

afterAll(() => {
  sqlite?.close();
  if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = originalDbPath;
});

describeTaskCoreContract('SQLite adapter', async () => harness);
