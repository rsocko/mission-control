import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubRecoveryRepositories } from '@/db/postgres/repositories/github-recovery-repositories';
import {
  describeGitHubRecoveryBackupAttestationContract,
  describeGitHubRecoveryRepositoriesContract,
  type GitHubRecoveryHarness,
  type RecoveryFixture,
} from '../contracts/github-recovery-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');
describeGitHubRecoveryBackupAttestationContract('PostgreSQL');

/**
 * Fail-closed guard: the PostgreSQL recovery adapter must never reach a SQLite
 * driver or a SQLite runtime module, even transitively.
 */
vi.mock('better-sqlite3', () => {
  throw new Error('PostgreSQL recovery adapter must not load better-sqlite3');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-recovery-test',
        }),
      }
    : {}),
});
let initialized = false;

const NOW = '2026-08-20T12:00:00.000Z';
const CONNECTORS = ['recovery-contract'];

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function cleanup(): Promise<void> {
  const pool = backend.context.pool;
  for (const statement of [
    'DELETE FROM github_bulk_transfer_events',
    'DELETE FROM github_bulk_transfer_successions',
    'DELETE FROM github_bulk_transfer_items',
    'DELETE FROM github_bulk_transfer_runs WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM github_repository_repoint_events',
    'DELETE FROM github_repository_repoints WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM github_identity_task_transfer_reconciliations WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM github_identity_collisions WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM github_identity_controls WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM connector_maintenance_locks WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM connector_operation_leases WHERE connector_id = ANY($1::text[])',
    'DELETE FROM external_entity_locators WHERE external_entity_id LIKE \'entity-%\'',
    'DELETE FROM external_entity_bindings WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM external_entities WHERE id LIKE \'entity-%\'',
    'DELETE FROM task_linked_sources WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM task_ingest_suppressions WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM tasks WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM source_lists WHERE connector_instance_id = ANY($1::text[])',
    'DELETE FROM connector_configs WHERE id = ANY($1::text[])',
  ]) {
    await pool.query(statement, statement.includes('$1') ? [CONNECTORS] : []);
  }
}

if (connectionString) {
  describeGitHubRecoveryRepositoriesContract(
    'PostgreSQL',
    async (): Promise<GitHubRecoveryHarness> => {
      await initialize();
      const pool = backend.context.pool;
      return {
        repositories: createPostgresGitHubRecoveryRepositories(pool),
        seed: async (fixture: RecoveryFixture) => {
          await cleanup();
          await pool.query(
            `INSERT INTO connector_configs (
               id, type, name, enabled, capabilities, credentials, settings,
               synced_lists, created_at, updated_at
             ) VALUES ($1, 'github-issues', $1, $2, '{}'::jsonb, $3::jsonb, $4::jsonb,
                       $5::jsonb, $6, $6)`,
            [
              fixture.connectorInstanceId,
              fixture.enabled,
              JSON.stringify({ token: fixture.token }),
              JSON.stringify({ repos: fixture.repos }),
              JSON.stringify(fixture.syncedLists),
              NOW,
            ],
          );
          await pool.query(
            `INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
             VALUES ($1, $2, $3)`,
            [fixture.connectorInstanceId, fixture.modeRevision, NOW],
          );
          for (const list of fixture.sourceLists) {
            await pool.query(
              `INSERT INTO source_lists (
                 id, connector_instance_id, source_id, name, type, last_known_remote_name
               ) VALUES ($1, $2, $3, $3, 'list', $3)`,
              [list.id, fixture.connectorInstanceId, list.sourceId],
            );
          }
          for (const task of fixture.tasks) {
            const listId = task.sourceId.split(':')[0];
            await pool.query(
              `INSERT INTO tasks (
                 id, title, status, priority, connector_type, connector_instance_id,
                 source_id, source_list_id, source_list_name, metadata, sync_status,
                 last_synced_at, created_at, updated_at
               ) VALUES ($1,$2,$3,'medium','github-issues',$4,$5,$6,$6,'{}'::jsonb,'synced',
                         $7,$7,$7)`,
              [
                task.id,
                task.title,
                task.status,
                fixture.connectorInstanceId,
                task.sourceId,
                listId,
                NOW,
              ],
            );
          }
          const revision = 1;
          for (const entity of fixture.entities) {
            await pool.query(
              `INSERT INTO external_entities (
                 id, provider, host_key, entity_type, stable_id, identity_version,
                 next_locator_revision, first_seen_at, last_seen_at
               ) VALUES ($1,'github','github.com',$2,$3,1,$4,$5,$5)`,
              [entity.id, entity.entityType, entity.stableId, revision + 1, NOW],
            );
            await pool.query(
              `INSERT INTO external_entity_locators (
                 id, external_entity_id, repository_entity_id, provider, host_key,
                 owner, repository, owner_key, repository_key, issue_number, api_url,
                 web_url, valid_from, valid_to, last_seen_at, observation_source,
                 locator_revision
               ) VALUES (
                 gen_random_uuid()::text, $1, $2, 'github', 'github.com', $3, $4, $5, $6,
                 $7, NULL, NULL, $8, NULL, $8, 'rest', $9
               )`,
              [
                entity.id,
                entity.repositoryEntityId ?? null,
                entity.owner,
                entity.repository,
                entity.owner.toLowerCase(),
                entity.repository.toLowerCase(),
                entity.issueNumber ?? null,
                NOW,
                revision,
              ],
            );
          }
          for (const binding of fixture.bindings) {
            await pool.query(
              `INSERT INTO external_entity_bindings (
                 id, external_entity_id, connector_instance_id, binding_type, local_id,
                 state, verified_at, created_at, updated_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)`,
              [
                binding.id,
                binding.externalEntityId,
                fixture.connectorInstanceId,
                binding.bindingType,
                binding.localId,
                binding.state,
                NOW,
              ],
            );
          }
        },
        readTask: async (taskId) => {
          const result = await pool.query(
            'SELECT source_id AS "sourceId", source_list_id AS "sourceListId" FROM tasks WHERE id = $1',
            [taskId],
          );
          return result.rows[0] ?? null;
        },
        setTaskTitle: async (taskId, title) => {
          await pool.query('UPDATE tasks SET title = $2 WHERE id = $1', [taskId, title]);
        },
        connectorEnabled: async (connectorInstanceId) => {
          const result = await pool.query(
            'SELECT enabled FROM connector_configs WHERE id = $1',
            [connectorInstanceId],
          );
          return Boolean(result.rows[0]?.enabled);
        },
        countOpenCollisions: async (connectorInstanceId) => {
          const result = await pool.query(
            `SELECT COUNT(*)::int AS value FROM github_identity_collisions
             WHERE connector_instance_id = $1 AND state = 'open'`,
            [connectorInstanceId],
          );
          return Number(result.rows[0].value);
        },
        countMaintenanceLocks: async (connectorInstanceId) => {
          const result = await pool.query(
            `SELECT COUNT(*)::int AS value FROM connector_maintenance_locks
             WHERE connector_instance_id = $1`,
            [connectorInstanceId],
          );
          return Number(result.rows[0].value);
        },
        readSourceList: async (id) => {
          const result = await pool.query(
            'SELECT source_id AS "sourceId", name FROM source_lists WHERE id = $1',
            [id],
          );
          return result.rows[0] ?? null;
        },
      };
    },
  );
}

describe.skipIf(Boolean(connectionString))('GitHubRecoveryPersistence (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await cleanup();
    await backend.shutdown();
  }
});
