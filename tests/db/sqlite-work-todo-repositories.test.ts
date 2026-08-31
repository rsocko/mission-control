import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeWorkTodoRepositoriesContract,
  isJsonSeedValue,
  taskAssociationSeedRows,
  CANONICAL_TASK_ASSOCIATION_TABLES,
  type WorkTodoHarness,
} from '../contracts/work-todo-repositories.contract';
vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `work-todo-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-work-todo-repositories'),
]).then(([database, adapter]) => ({
  database,
  repositories: adapter.createSqliteWorkTodoRepositories(
    database.sqlite,
    database.default,
  ),
}));

const CONNECTOR = 'work-todo-contract';
const NOW = '2026-08-07T00:00:00.000Z';

function parseJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

describeWorkTodoRepositoriesContract('SQLite', async (): Promise<WorkTodoHarness> => {
  const context = await contextPromise;
  const sqlite = context.database.sqlite;
  let seedVariant = 0;

  function setConnector(input: {
    id: string;
    type: string;
    enabled: boolean;
    deletedAt?: string | null;
  }): void {
    sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, '{}', '{}', '{}', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        enabled = excluded.enabled,
        deleted_at = excluded.deleted_at
    `).run(
      input.id,
      input.type,
      input.id,
      input.enabled ? 1 : 0,
      NOW,
      NOW,
      input.deletedAt ?? null,
    );
  }

  return {
    repositories: context.repositories,
    reset: async () => {
      sqlite.exec(`
        DELETE FROM work_todo_outbound_changes;
        DELETE FROM work_todo_list_delta_state;
        DELETE FROM work_todo_bridge_state;
        ${CANONICAL_TASK_ASSOCIATION_TABLES.map((table) => `DELETE FROM ${table};`).join('\n        ')}
        DELETE FROM notifications;
        DELETE FROM tags;
        DELETE FROM tasks;
        DELETE FROM source_lists;
        DELETE FROM connector_configs;
      `);
      setConnector({ id: CONNECTOR, type: 'microsoft-todo-work', enabled: true });
    },
    setConnector: async (input) => setConnector(input),
    seedBridgeState: async (state) => {
      sqlite.prepare(`
        INSERT INTO work_todo_bridge_state (
          connector_id, transport, capability_profile, list_delta_link,
          reset_required, last_ingest_at, last_ingest_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector_id) DO UPDATE SET
          transport = excluded.transport,
          capability_profile = excluded.capability_profile,
          list_delta_link = excluded.list_delta_link,
          reset_required = excluded.reset_required,
          last_ingest_at = excluded.last_ingest_at,
          last_ingest_mode = excluded.last_ingest_mode
      `).run(
        state.connectorId,
        state.transport,
        state.capabilityProfile,
        state.listDeltaLink ?? null,
        state.resetRequired ? 1 : 0,
        state.lastIngestAt ?? null,
        state.lastIngestMode ?? null,
        NOW,
        NOW,
      );
    },
    seedListDeltaState: async (input) => {
      sqlite.prepare(`
        INSERT INTO work_todo_list_delta_state (
          connector_id, list_source_id, delta_link, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(connector_id, list_source_id) DO UPDATE SET
          delta_link = excluded.delta_link
      `).run(input.connectorId, input.listSourceId, input.deltaLink, NOW);
    },
    seedSourceListHidden: async (input) => {
      sqlite.prepare(`
        UPDATE source_lists SET hidden = ?
        WHERE connector_instance_id = ? AND source_id = ?
      `).run(input.hidden ? 1 : 0, input.connectorId, input.sourceId);
    },
    listTasks: async (connectorId) => (sqlite.prepare(`
      SELECT id, source_id AS sourceId, title, status, priority,
             due_date AS dueDate, sync_status AS syncStatus,
             updated_at AS updatedAt, last_synced_at AS lastSyncedAt,
             parent_id AS parentId, metadata
      FROM tasks WHERE connector_instance_id = ? ORDER BY source_id
    `).all(connectorId) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      sourceId: row.sourceId as string,
      title: row.title as string,
      status: row.status as string,
      priority: row.priority as string,
      dueDate: (row.dueDate ?? null) as string | null,
      syncStatus: row.syncStatus as string,
      updatedAt: row.updatedAt as string,
      lastSyncedAt: row.lastSyncedAt as string,
      parentId: (row.parentId ?? null) as string | null,
      metadata: parseJson(row.metadata),
    })),
    updateTask: async (taskId, patch) => {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (patch.title !== undefined) { assignments.push('title = ?'); values.push(patch.title); }
      if (patch.status !== undefined) { assignments.push('status = ?'); values.push(patch.status); }
      if (patch.priority !== undefined) {
        assignments.push('priority = ?');
        values.push(patch.priority);
      }
      if (patch.dueDate !== undefined) {
        assignments.push('due_date = ?');
        values.push(patch.dueDate);
      }
      if (patch.syncStatus !== undefined) {
        assignments.push('sync_status = ?');
        values.push(patch.syncStatus);
      }
      if (patch.updatedAt !== undefined) {
        assignments.push('updated_at = ?');
        values.push(patch.updatedAt);
      }
      if (patch.metadata !== undefined) {
        assignments.push('metadata = ?');
        values.push(JSON.stringify(patch.metadata));
      }
      if (assignments.length === 0) return;
      values.push(taskId);
      sqlite.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    },
    listChanges: async (connectorId) => (sqlite.prepare(`
      SELECT idempotency_key AS idempotencyKey, task_id AS taskId,
             source_id AS sourceId, list_source_id AS listSourceId,
             remote_task_id AS remoteTaskId, operation, fields,
             task_version AS taskVersion, status, lease_id AS leaseId,
             lease_expires_at AS leaseExpiresAt, attempt_count AS attemptCount,
             last_error AS lastError
      FROM work_todo_outbound_changes WHERE connector_id = ? ORDER BY created_at
    `).all(connectorId) as Array<Record<string, unknown>>).map((row) => ({
      idempotencyKey: row.idempotencyKey as string,
      taskId: row.taskId as string,
      sourceId: row.sourceId as string,
      listSourceId: row.listSourceId as string,
      remoteTaskId: row.remoteTaskId as string,
      operation: row.operation as string,
      fields: row.fields == null ? null : parseJson(row.fields),
      taskVersion: row.taskVersion as string,
      status: row.status as string,
      leaseId: (row.leaseId ?? null) as string | null,
      leaseExpiresAt: (row.leaseExpiresAt ?? null) as string | null,
      attemptCount: Number(row.attemptCount ?? 0),
      lastError: (row.lastError ?? null) as string | null,
    })),
    expireLease: async (idempotencyKey, leaseExpiresAt) => {
      sqlite.prepare('UPDATE work_todo_outbound_changes SET lease_expires_at = ? WHERE idempotency_key = ?')
        .run(leaseExpiresAt, idempotencyKey);
    },
    getBridgeState: async (connectorId) => {
      const row = sqlite.prepare(`
        SELECT transport, capability_profile AS capabilityProfile,
               list_delta_link AS listDeltaLink, reset_required AS resetRequired,
               last_ingest_at AS lastIngestAt, last_ingest_mode AS lastIngestMode
        FROM work_todo_bridge_state WHERE connector_id = ?
      `).get(connectorId) as Record<string, unknown> | undefined;
      return row
        ? {
            transport: row.transport as string,
            capabilityProfile: row.capabilityProfile as string,
            listDeltaLink: (row.listDeltaLink ?? null) as string | null,
            resetRequired: Boolean(row.resetRequired),
            lastIngestAt: (row.lastIngestAt ?? null) as string | null,
            lastIngestMode: (row.lastIngestMode ?? null) as string | null,
          }
        : null;
    },
    listSourceListIds: async (connectorId) => (sqlite.prepare(
      'SELECT source_id AS sourceId FROM source_lists WHERE connector_instance_id = ? ORDER BY source_id',
    ).all(connectorId) as Array<{ sourceId: string }>).map((row) => row.sourceId),
    listTaskTagSlugs: async (taskId) => (sqlite.prepare(`
      SELECT tags.slug AS slug FROM task_tags
      INNER JOIN tags ON tags.id = task_tags.tag_id
      WHERE task_tags.task_id = ? ORDER BY tags.slug
    `).all(taskId) as Array<{ slug: string }>).map((row) => row.slug),
    seedTaskAssociations: async (taskId) => {
      const variant = seedVariant++;
      for (const row of taskAssociationSeedRows(taskId, variant)) {
        const columns = Object.keys(row.values);
        const values = columns.map((column) => {
          const value = row.values[column];
          if (isJsonSeedValue(value)) return JSON.stringify(value.__json);
          if (typeof value === 'boolean') return value ? 1 : 0;
          return value;
        });
        sqlite.prepare(`
          INSERT INTO ${row.table} (${columns.map((column) => `"${column}"`).join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
        `).run(...values);
      }
    },
    residualTaskAssociations: async (taskId) => {
      const residual = CANONICAL_TASK_ASSOCIATION_TABLES.filter((table) => {
        const clause = table === 'task_dependencies'
          ? 'task_id = ? OR depends_on_task_id = ?'
          : 'task_id = ?';
        const parameters = table === 'task_dependencies' ? [taskId, taskId] : [taskId];
        const row = sqlite.prepare(
          `SELECT COUNT(*) AS total FROM ${table} WHERE ${clause}`,
        ).get(...parameters) as { total: number };
        return Number(row.total) > 0;
      });
      const notifications = sqlite.prepare(
        'SELECT COUNT(*) AS total FROM notifications WHERE related_task_id = ?',
      ).get(taskId) as { total: number };
      return Number(notifications.total) > 0
        ? [...residual, 'notifications']
        : [...residual];
    },
    getNotification: async (id) => {
      const row = sqlite.prepare(
        'SELECT id, related_task_id AS relatedTaskId FROM notifications WHERE id = ?',
      ).get(id) as { id: string; relatedTaskId: string | null } | undefined;
      return row
        ? { id: row.id, relatedTaskId: row.relatedTaskId ?? null }
        : null;
    },
    close: () => {},
  };
});

afterAll(async () => {
  const context = await contextPromise;
  context.database.sqlite.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (previousPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = previousPath;
});
