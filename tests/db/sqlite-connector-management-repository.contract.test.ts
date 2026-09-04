import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type {
  ConnectorManagementPersistence,
  SyncHistoryRecord,
} from '@/db/persistence/connector-management';
import {
  runConnectorManagementRepositoryContract,
} from '../contracts/connector-management-repository.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `connector-management-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-connector-management-repository'),
]).then(([database, adapter]) => ({
  database,
  repository: adapter.createSqliteConnectorManagementRepository(
    database.sqlite,
    database.default,
  ),
}));
let repository: ConnectorManagementPersistence;

async function reset(): Promise<void> {
  const { database } = await contextPromise;
  database.sqlite.exec(`
    DELETE FROM github_identity_controls
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM github_identity_migrations
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM work_todo_bridge_state
      WHERE connector_id LIKE 'l11-management%';
    DELETE FROM source_lists
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM tasks
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM sync_log
      WHERE id LIKE 'l11-management%';
    DELETE FROM source_rankings
      WHERE id LIKE 'l11-management%';
    DELETE FROM connector_configs
      WHERE id LIKE 'l11-management%';
  `);
}

runConnectorManagementRepositoryContract(
  'SQLite connector management repository contract',
  {
    async setup() {
      repository = (await contextPromise).repository;
      await reset();
    },
    reset,
    async teardown() {
      await reset();
      const { database } = await contextPromise;
      database.sqlite.close();
      if (previousPath === undefined) delete process.env.MC_DB_PATH;
      else process.env.MC_DB_PATH = previousPath;
      rmSync(databasePath, { force: true });
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
    },
    repository: () => repository,
    async githubIdentityRows(connectorId) {
      const { database } = await contextPromise;
      const count = (table: string) => Number((
        database.sqlite.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE connector_instance_id = ?`,
        ).get(connectorId) as { count: number }
      ).count);
      return {
        controls: count('github_identity_controls'),
        migrations: count('github_identity_migrations'),
      };
    },
    async markWorkTodoIngested(connectorId) {
      const { database } = await contextPromise;
      database.sqlite.prepare(`
        UPDATE work_todo_bridge_state SET last_ingest_at = ? WHERE connector_id = ?
      `).run('2026-09-04T04:02:00.000Z', connectorId);
    },
    async seedTask(connectorId, sourceListId) {
      const { database } = await contextPromise;
      database.sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title,
          created_at, updated_at, last_synced_at, source_list_id, source_list_name
        ) VALUES (?, ?, 'test', ?, 'Contract task', ?, ?, ?, ?, 'Old name')
      `).run(
        `${connectorId}-task`,
        `${connectorId}-remote-task`,
        connectorId,
        '2026-09-04T04:00:00.000Z',
        '2026-09-04T04:00:00.000Z',
        '2026-09-04T04:00:00.000Z',
        sourceListId,
      );
    },
    async taskSourceListName(connectorId) {
      const { database } = await contextPromise;
      const row = database.sqlite.prepare(`
        SELECT source_list_name AS sourceListName FROM tasks
        WHERE connector_instance_id = ? LIMIT 1
      `).get(connectorId) as { sourceListName: string | null } | undefined;
      return row?.sourceListName ?? null;
    },
    async seedSyncHistory(records: readonly SyncHistoryRecord[]) {
      const { database } = await contextPromise;
      const insert = database.sqlite.prepare(`
        INSERT INTO sync_log (
          id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
          tasks_pushed, local_only_protected, alerts_added, errors, details,
          synced_at, duration_ms, job_id, trigger, scheduled_for, started_at,
          attempt, max_attempts, identity_mode, identity_mode_revision
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      for (const record of records) {
        insert.run(
          record.id,
          record.connectorId,
          record.success ? 1 : 0,
          record.tasksAdded,
          record.tasksUpdated,
          record.tasksRemoved,
          record.tasksPushed,
          record.localOnlyProtected,
          record.notificationsAdded,
          JSON.stringify(record.errors),
          JSON.stringify(record.details),
          record.syncedAt,
          record.durationMs,
          record.jobId,
          record.trigger,
          record.scheduledFor,
          record.startedAt,
          record.attempt,
          record.maxAttempts,
          record.identityMode,
          record.identityModeRevision,
        );
      }
    },
  },
);
