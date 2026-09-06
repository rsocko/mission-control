import type { Pool, PoolClient } from 'pg';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { and, asc, eq, getTableColumns, gt, isNull, or } from 'drizzle-orm';
import {
  connectorConfigs,
  hubProjects,
  notifications,
  sourceLists,
  syncLog,
  tags,
  tasks,
  taskTags,
} from '../schema';
import type { PostgresDatabase } from '../runtime';
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
} from '@/db/persistence/operational-utility';

/**
 * `search_vector` is a PostgreSQL-only generated column: excluding it keeps the
 * exported record shape byte-identical to the SQLite adapter's.
 *
 * The maps are built lazily on first export read so that merely importing this
 * module never calls into `drizzle-orm`.
 */
function omitSearchVector<T extends Record<string, unknown>>(
  columns: T,
): Omit<T, 'searchVector'> {
  const rest: Record<string, unknown> = { ...columns };
  delete rest.searchVector;
  return rest as Omit<T, 'searchVector'>;
}

function buildExportColumns() {
  return {
    task: omitSearchVector(getTableColumns(tasks)),
    notification: omitSearchVector(getTableColumns(notifications)),
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
  id, title, source_list_id AS "sourceListId",
  connector_instance_id AS "connectorInstanceId", due_date AS "dueDate",
  completed_at AS "completedAt", updated_at AS "updatedAt", metadata
`;

function afterId(column: PgColumn, query: ExportKeysetQuery) {
  return query.afterId === undefined ? undefined : gt(column, query.afterId);
}

async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function deleteTasksCascade(
  client: PoolClient,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const ids = [...taskIds];
  await client.query('DELETE FROM task_tags WHERE task_id = ANY($1::text[])', [ids]);
  await client.query(
    'DELETE FROM project_auto_include_exclusions WHERE task_id = ANY($1::text[])',
    [ids],
  );
  await client.query('DELETE FROM task_projects WHERE task_id = ANY($1::text[])', [ids]);
  await client.query('DELETE FROM my_day_items WHERE task_id = ANY($1::text[])', [ids]);
  await client.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [ids]);
}

export function createPostgresOperationalUtilityRepository(
  db: PostgresDatabase,
  pool: Pool,
): OperationalUtilityPersistence {
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
      async runDuplicateCleanup(): Promise<MaintenanceCleanupResult> {
        return withTransaction(pool, async (client) => {
          const duplicateGroups = (await client.query<{
            sourceId: string;
            connectorInstanceId: string;
          }>(`
            SELECT source_id AS "sourceId",
                   connector_instance_id AS "connectorInstanceId"
            FROM tasks
            GROUP BY source_id, connector_instance_id
            HAVING COUNT(*) > 1
            ORDER BY source_id, connector_instance_id
          `)).rows;

          let tasksRemoved = 0;
          for (const group of duplicateGroups) {
            const rows = (await client.query<{
              id: string;
              lastSyncedAt: string | null;
              updatedAt: string | null;
            }>(`
              SELECT id, last_synced_at AS "lastSyncedAt", updated_at AS "updatedAt"
              FROM tasks
              WHERE source_id = $1 AND connector_instance_id = $2
            `, [group.sourceId, group.connectorInstanceId])).rows;
            const doomed = planDuplicateDeletions(rows);
            await deleteTasksCascade(client, doomed);
            tasksRemoved += doomed.length;
          }

          const completed = (await client.query<CleanupTaskCandidate>(
            `SELECT ${CLEANUP_COLUMNS} FROM tasks WHERE status = 'done'`,
          )).rows;
          const completedDoomed = planCompletedRecurringDeletions(completed);
          await deleteTasksCascade(client, completedDoomed);

          const open = (await client.query<CleanupTaskCandidate>(
            `SELECT ${CLEANUP_COLUMNS} FROM tasks WHERE status NOT IN ('done', 'cancelled')`,
          )).rows;
          const openDoomed = planOpenRecurringDeletions(open);
          await deleteTasksCascade(client, openDoomed);

          return {
            duplicateGroupsFound: duplicateGroups.length,
            tasksRemoved,
            recurringInstancesRemoved: completedDoomed.length,
            openRecurringInstancesRemoved: openDoomed.length,
          };
        });
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
        return withTransaction(pool, async (client) => {
          const { task } = command;
          await client.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title,
              description, status, priority, created_at, updated_at,
              last_synced_at, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
          `, [
            task.id,
            task.sourceId,
            task.connectorType,
            task.connectorInstanceId,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.createdAt,
            task.updatedAt,
            task.lastSyncedAt,
            JSON.stringify(task.metadata),
          ]);

          const tagIds: string[] = [];
          for (const tag of command.tags) {
            const existing = (await client.query<{ id: string }>(
              'SELECT id FROM tags WHERE slug = $1 LIMIT 1',
              [tag.slug],
            )).rows[0];
            const tagId = existing?.id ?? tag.newTagId;
            if (!existing) {
              await client.query(`
                INSERT INTO tags (id, name, slug, type, color, confirmed, created_at)
                VALUES ($1, $2, $3, 'hub', $4, TRUE, $5)
              `, [tagId, tag.name, tag.slug, tag.color, task.createdAt]);
            }
            await client.query(`
              INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)
              ON CONFLICT DO NOTHING
            `, [task.id, tagId]);
            tagIds.push(tagId);
          }
          return { taskId: task.id, tagIds };
        });
      },
    },
    publicDemo: {
      async ensureReady() {
        await pool.query('SELECT 1');
      },
      async markSeeded(seededAt: string) {
        await withTransaction(pool, async (client) => {
          await client.query(`
            CREATE TABLE IF NOT EXISTS public_demo_runtime (
              id TEXT PRIMARY KEY,
              seeded_at TEXT NOT NULL
            )
          `);
          await client.query(`
            INSERT INTO public_demo_runtime (id, seeded_at)
            VALUES ('seed', $1)
            ON CONFLICT (id) DO UPDATE SET seeded_at = EXCLUDED.seeded_at
          `, [seededAt]);
        });
      },
    },
  };
}
