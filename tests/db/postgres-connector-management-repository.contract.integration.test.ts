import type { Pool } from 'pg';
import { resolvePostgresConfig } from '@/db/postgres/config';
import type {
  ConnectorManagementPersistence,
  SyncHistoryRecord,
} from '@/db/persistence/connector-management';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresConnectorManagementRepository,
} from '@/db/postgres/repositories/connector-management-repository';
import {
  runConnectorManagementRepositoryContract,
} from '../contracts/connector-management-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-management-contract-test',
        }),
      }
    : {}),
});
let pool: Pool;
let repository: ConnectorManagementPersistence;

async function reset(): Promise<void> {
  await pool.query(`
    DELETE FROM github_identity_controls
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM github_identity_migrations
      WHERE connector_instance_id LIKE 'l11-management%';
    DELETE FROM work_todo_bridge_state
      WHERE connector_id LIKE 'l11-management%';
    DELETE FROM list_fix_audit_log
      WHERE id LIKE 'l11-management%';
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
  'PostgreSQL connector management repository contract',
  {
    enabled: Boolean(connectionString),
    async setup() {
      assertSafeIntegrationTestTarget(connectionString!);
      await backend.initialize();
      pool = backend.context.pool;
      repository = createPostgresConnectorManagementRepository(pool);
      await reset();
    },
    reset,
    async teardown() {
      await reset();
      await backend.shutdown();
    },
    repository: () => repository,
    async githubIdentityRows(connectorId) {
      const [controls, migrations] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM github_identity_controls WHERE connector_instance_id = $1`,
          [connectorId],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM github_identity_migrations WHERE connector_instance_id = $1`,
          [connectorId],
        ),
      ]);
      return {
        controls: Number(controls.rows[0].count),
        migrations: Number(migrations.rows[0].count),
      };
    },
    async markWorkTodoIngested(connectorId) {
      await pool.query(
        `UPDATE work_todo_bridge_state
         SET last_ingest_at = $1 WHERE connector_id = $2`,
        ['2026-09-04T04:02:00.000Z', connectorId],
      );
    },
    async seedTask(connectorId, sourceListId) {
      await pool.query(
        `
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title,
            created_at, updated_at, last_synced_at, source_list_id, source_list_name
          ) VALUES ($1, $2, 'test', $3, 'Contract task', $4, $4, $4, $5, 'Old name')
        `,
        [
          `${connectorId}-task`,
          `${connectorId}-remote-task`,
          connectorId,
          '2026-09-04T04:00:00.000Z',
          sourceListId,
        ],
      );
    },
    async taskSourceListName(connectorId) {
      const result = await pool.query<{ sourceListName: string | null }>(
        `
          SELECT source_list_name AS "sourceListName" FROM tasks
          WHERE connector_instance_id = $1 LIMIT 1
        `,
        [connectorId],
      );
      return result.rows[0]?.sourceListName ?? null;
    },
    async seedSyncHistory(records: readonly SyncHistoryRecord[]) {
      for (const record of records) {
        await pool.query(
          `
            INSERT INTO sync_log (
              id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
              tasks_pushed, local_only_protected, alerts_added, errors, details,
              synced_at, duration_ms, job_id, trigger, scheduled_for, started_at,
              attempt, max_attempts, identity_mode, identity_mode_revision
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
              $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
            )
          `,
          [
            record.id,
            record.connectorId,
            record.success,
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
          ],
        );
      }
    },
  },
);
