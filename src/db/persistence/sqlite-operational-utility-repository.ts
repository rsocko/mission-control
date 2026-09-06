import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { and, asc, eq, getTableColumns, gt, isNull, or } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  hubProjects,
  notifications,
  sourceLists,
  syncLog,
  tags,
  tasks,
  taskTags,
} from '@/db/schema';
import {
  planCompletedRecurringDeletions,
  planDuplicateDeletions,
  planOpenRecurringDeletions,
  type BugReportCommand,
  type BugReportResult,
  type CleanupTaskCandidate,
  type ConnectorFeatureSnapshot,
  type ExportKeysetQuery,
  type ExportTaskTagQuery,
  type MaintenanceCleanupResult,
  type OperationalExportRecord,
  type OperationalUtilityPersistence,
  type RetainedSourceListSnapshot,
} from './operational-utility';

type SqliteDb = BetterSQLite3Database<typeof schema>;

/**
 * Export column maps are built lazily on first read so that merely importing
 * this module never calls into `drizzle-orm`.
 */
function buildExportColumns() {
  return {
    task: getTableColumns(tasks),
    notification: getTableColumns(notifications),
    tag: getTableColumns(tags),
    taskTag: getTableColumns(taskTags),
    hubProject: getTableColumns(hubProjects),
    syncLog: getTableColumns(syncLog),
  };
}

let exportColumnCache: ReturnType<typeof buildExportColumns> | null = null;

function exportColumns(): ReturnType<typeof buildExportColumns> {
  exportColumnCache ??= buildExportColumns();
  return exportColumnCache;
}

const connectorExportColumns = {
  id: connectorConfigs.id,
  type: connectorConfigs.type,
  name: connectorConfigs.name,
  enabled: connectorConfigs.enabled,
};

const CLEANUP_COLUMNS = `
  id, title, source_list_id AS sourceListId,
  connector_instance_id AS connectorInstanceId, due_date AS dueDate,
  completed_at AS completedAt, updated_at AS updatedAt, metadata
`;

function afterId(column: SQLiteColumn, query: ExportKeysetQuery) {
  return query.afterId === undefined ? undefined : gt(column, query.afterId);
}

export function createSqliteOperationalUtilityRepository(
  sqlite: Database.Database,
  db: SqliteDb,
): OperationalUtilityPersistence {
  function deleteTaskCascade(taskId: string): void {
    sqlite.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM project_auto_include_exclusions WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM task_projects WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM my_day_items WHERE task_id = ?').run(taskId);
    sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  const runCleanup = sqlite.transaction((): MaintenanceCleanupResult => {
    const duplicateGroups = sqlite.prepare(`
      SELECT source_id AS sourceId, connector_instance_id AS connectorInstanceId
      FROM tasks
      GROUP BY source_id, connector_instance_id
      HAVING COUNT(*) > 1
      ORDER BY source_id, connector_instance_id
    `).all() as Array<{ sourceId: string; connectorInstanceId: string }>;

    let tasksRemoved = 0;
    for (const group of duplicateGroups) {
      const rows = sqlite.prepare(`
        SELECT id, last_synced_at AS lastSyncedAt, updated_at AS updatedAt
        FROM tasks
        WHERE source_id = ? AND connector_instance_id = ?
      `).all(group.sourceId, group.connectorInstanceId) as Array<{
        id: string;
        lastSyncedAt: string | null;
        updatedAt: string | null;
      }>;
      for (const id of planDuplicateDeletions(rows)) {
        deleteTaskCascade(id);
        tasksRemoved++;
      }
    }

    const completed = sqlite.prepare(`
      SELECT ${CLEANUP_COLUMNS} FROM tasks WHERE status = 'done'
    `).all() as CleanupTaskCandidate[];
    let recurringInstancesRemoved = 0;
    for (const id of planCompletedRecurringDeletions(completed)) {
      deleteTaskCascade(id);
      recurringInstancesRemoved++;
    }

    const open = sqlite.prepare(`
      SELECT ${CLEANUP_COLUMNS} FROM tasks WHERE status NOT IN ('done', 'cancelled')
    `).all() as CleanupTaskCandidate[];
    let openRecurringInstancesRemoved = 0;
    for (const id of planOpenRecurringDeletions(open)) {
      deleteTaskCascade(id);
      openRecurringInstancesRemoved++;
    }

    return {
      duplicateGroupsFound: duplicateGroups.length,
      tasksRemoved,
      recurringInstancesRemoved,
      openRecurringInstancesRemoved,
    };
  });

  return {
    retainedSourceLists: {
      async loadSnapshot({ connectorId, sourceListId }): Promise<RetainedSourceListSnapshot> {
        const [connector] = await db.select({
          id: connectorConfigs.id,
          type: connectorConfigs.type,
          settings: connectorConfigs.settings,
          syncedLists: connectorConfigs.syncedLists,
        })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.id, connectorId))
          .limit(1);
        if (!connector) return { connector: null, sourceList: null };

        const [sourceList] = await db.select({
          id: sourceLists.id,
          sourceId: sourceLists.sourceId,
        })
          .from(sourceLists)
          .where(and(
            eq(sourceLists.id, sourceListId),
            eq(sourceLists.connectorInstanceId, connectorId),
          ))
          .limit(1);
        return { connector, sourceList: sourceList ?? null };
      },
      async listRetainedTaskIds({ connectorId, sourceListSourceId }) {
        const rows = await db.select({ id: tasks.id })
          .from(tasks)
          .where(and(
            eq(tasks.connectorInstanceId, connectorId),
            eq(tasks.sourceListId, sourceListSourceId),
          ))
          .orderBy(asc(tasks.id));
        return rows.map((row) => row.id);
      },
      async deleteSourceList({ connectorId, sourceListId }) {
        await db.delete(sourceLists).where(and(
          eq(sourceLists.id, sourceListId),
          eq(sourceLists.connectorInstanceId, connectorId),
        ));
      },
    },
    maintenance: {
      async runDuplicateCleanup() {
        return runCleanup();
      },
    },
    exports: {
      async listTasksPage(query): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().task).from(tasks)
          .where(afterId(tasks.id, query))
          .orderBy(asc(tasks.id))
          .limit(query.limit);
      },
      async listNotificationsPage(query): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().notification).from(notifications)
          .where(afterId(notifications.id, query))
          .orderBy(asc(notifications.id))
          .limit(query.limit);
      },
      async listTagsPage(query): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().tag).from(tags)
          .where(afterId(tags.id, query))
          .orderBy(asc(tags.id))
          .limit(query.limit);
      },
      async listTaskTagsPage(query: ExportTaskTagQuery): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().taskTag).from(taskTags)
          .where(query.after === undefined ? undefined : or(
            gt(taskTags.taskId, query.after.taskId),
            and(eq(taskTags.taskId, query.after.taskId), gt(taskTags.tagId, query.after.tagId)),
          ))
          .orderBy(asc(taskTags.taskId), asc(taskTags.tagId))
          .limit(query.limit);
      },
      async listHubProjectsPage(query): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().hubProject).from(hubProjects)
          .where(afterId(hubProjects.id, query))
          .orderBy(asc(hubProjects.id))
          .limit(query.limit);
      },
      async listConnectorsPage(query): Promise<OperationalExportRecord[]> {
        return db.select(connectorExportColumns).from(connectorConfigs)
          .where(and(isNull(connectorConfigs.deletedAt), afterId(connectorConfigs.id, query)))
          .orderBy(asc(connectorConfigs.id))
          .limit(query.limit);
      },
      async listSyncLogPage(query): Promise<OperationalExportRecord[]> {
        return db.select(exportColumns().syncLog).from(syncLog)
          .where(afterId(syncLog.id, query))
          .orderBy(asc(syncLog.id))
          .limit(query.limit);
      },
    },
    features: {
      async listActiveConnectors(): Promise<readonly ConnectorFeatureSnapshot[]> {
        return db.select({
          id: connectorConfigs.id,
          type: connectorConfigs.type,
          name: connectorConfigs.name,
          capabilities: connectorConfigs.capabilities,
          settings: connectorConfigs.settings,
        })
          .from(connectorConfigs)
          .where(and(
            isNull(connectorConfigs.deletedAt),
            eq(connectorConfigs.enabled, true),
          ))
          .orderBy(asc(connectorConfigs.createdAt), asc(connectorConfigs.id));
      },
    },
    bugReports: {
      async create(command: BugReportCommand): Promise<BugReportResult> {
        return db.transaction((tx) => {
          tx.insert(tasks).values(command.task).run();

          const tagIds: string[] = [];
          for (const tag of command.tags) {
            const [existing] = tx.select({ id: tags.id }).from(tags)
              .where(eq(tags.slug, tag.slug))
              .limit(1)
              .all();
            const tagId = existing?.id ?? tag.newTagId;
            if (!existing) {
              tx.insert(tags).values({
                id: tagId,
                name: tag.name,
                slug: tag.slug,
                type: 'hub',
                color: tag.color,
                confirmed: true,
                createdAt: command.task.createdAt,
              }).run();
            }
            tx.insert(taskTags)
              .values({ taskId: command.task.id, tagId })
              .onConflictDoNothing()
              .run();
            tagIds.push(tagId);
          }
          return { taskId: command.task.id, tagIds };
        });
      },
    },
    publicDemo: {
      async ensureReady() {
        sqlite.prepare('SELECT 1').get();
      },
      async markSeeded(seededAt: string) {
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS public_demo_runtime (
            id TEXT PRIMARY KEY,
            seeded_at TEXT NOT NULL
          )
        `);
        sqlite.prepare(`
          INSERT INTO public_demo_runtime (id, seeded_at)
          VALUES ('seed', ?)
          ON CONFLICT(id) DO UPDATE SET seeded_at = excluded.seeded_at
        `).run(seededAt);
      },
    },
  };
}
