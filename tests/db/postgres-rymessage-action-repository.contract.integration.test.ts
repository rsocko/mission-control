import type { Pool } from 'pg';
import { afterAll } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresRyMessageActionRepository } from '@/db/postgres/repositories/rymessage-action-repository';
import {
  RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID,
  runRyMessageActionRepositoryContract,
} from '../contracts/rymessage-action-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-rymessage-action-contract-test',
        }),
      }
    : {}),
});
let pool: Pool;
let repository: ReturnType<typeof createPostgresRyMessageActionRepository>;

async function reset(): Promise<void> {
  await pool.query(
    `DELETE FROM connector_configs WHERE id = $1`,
    [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID],
  );
  await pool.query(`
    INSERT INTO connector_configs (
      id, type, name, enabled, capabilities, credentials, settings, created_at, updated_at
    ) VALUES ($1, 'rymessage', 'RyMessage contract', true, '{}'::jsonb, '{}'::jsonb,
              '{}'::jsonb, $2, $2)
  `, [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID, '2026-09-29T23:00:00.000Z']);
}

runRyMessageActionRepositoryContract(
  'PostgreSQL RyMessage action repository contract',
  {
    enabled: Boolean(connectionString),
    harness: {
      async setup() {
        assertSafeIntegrationTestTarget(connectionString!);
        await backend.initialize();
        pool = backend.context.pool;
        repository = createPostgresRyMessageActionRepository(pool);
      },
      reset,
      repository: () => repository,
      async seedProviderTask(input) {
        await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            created_at, updated_at, last_synced_at
          ) VALUES ($1, $2, 'microsoft-todo', 'todo-contract', 'Provider task',
                    $3, $4, $4, $4)
        `, ['l11-rymessage-provider-task', input.sourceId, input.status, input.updatedAt]);
      },
      async queuedMutations() {
        const result = await pool.query<{
          operationId: string;
          mutation: unknown;
        }>(`
          SELECT operation_id AS "operationId", mutation
          FROM rymessage_action_outbound_mutations
          WHERE connector_id = $1 ORDER BY created_at, operation_id
        `, [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID]);
        return result.rows;
      },
      async mutationStatus(operationId) {
        const result = await pool.query<{
          status: string;
          errorCode: string | null;
        }>(
          `SELECT status, last_error_code AS "errorCode"
           FROM rymessage_action_outbound_mutations
           WHERE connector_id = $1 AND operation_id = $2`,
          [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID, operationId],
        );
        return result.rows[0] ?? null;
      },
      async seedTombstoneQuota(count) {
        await pool.query(`
          INSERT INTO rymessage_action_projections (
            connector_id, action_id, source_id, revision, payload, payload_digest,
            last_event_id, last_operation_id, tombstoned_at, created_at, updated_at
          )
          SELECT $1, 'retained-tombstone-' || value,
                 'retained-tombstone-source-' || value, 1, NULL,
                 'retained-tombstone-digest-' || value,
                 'retained-tombstone-event-' || value,
                 'retained-tombstone-operation-' || value, $2, $2, $2
          FROM generate_series(1, $3) AS value
        `, [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID, '2026-09-29T22:00:00.000Z', count]);
      },
      async projectionGeneration(actionId) {
        const result = await pool.query<{ generation: string | null }>(
          `SELECT last_seen_generation AS generation
           FROM rymessage_action_projections
           WHERE connector_id = $1 AND action_id = $2`,
          [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID, actionId],
        );
        return result.rows[0]?.generation ?? null;
      },
    },
  },
);

afterAll(async () => {
  if (!connectionString) return;
  await reset();
  await pool.query(
    `DELETE FROM connector_configs WHERE id = $1`,
    [RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID],
  );
  await backend.shutdown();
});
