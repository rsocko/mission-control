import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubIdentityRepositories } from '@/db/postgres/repositories/github-identity-repositories';
import {
  describeGitHubIdentityRepositoriesContract,
  GITHUB_IDENTITY_CONTRACT,
  type GitHubIdentityHarness,
} from '../contracts/github-identity-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-identity-test',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

const {
  connectorInstanceId,
  taskId,
  sourceListId,
  sourceId,
  taskVersion,
  pushLeaseToken,
  modeRevision,
  linkedSourceId,
} = GITHUB_IDENTITY_CONTRACT;

const FRESH_CONNECTOR_PREFIX = 'fresh-';

async function cleanupContractRows(): Promise<void> {
  const pool = backend.context.pool;
  await pool.query(`DELETE FROM github_identity_exception_events WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM task_source_write_lease_targets WHERE lease_id IN (SELECT id FROM task_source_write_leases WHERE connector_instance_id = $1)`, [connectorInstanceId]);
  await pool.query(`DELETE FROM task_source_write_leases WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM github_identity_write_cycles WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM external_entity_bindings WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM external_entity_locators WHERE external_entity_id IN ('repo-entity', 'issue-entity')`);
  await pool.query(`DELETE FROM external_entities WHERE id IN ('repo-entity', 'issue-entity')`);
  await pool.query(`DELETE FROM task_linked_sources WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM tasks WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM source_lists WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM github_identity_controls WHERE connector_instance_id = $1 OR connector_instance_id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
  await pool.query(`DELETE FROM github_identity_migrations WHERE connector_instance_id = $1 OR connector_instance_id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
  await pool.query(`DELETE FROM connector_configs WHERE id = $1 OR id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
}

if (connectionString) {
  describeGitHubIdentityRepositoriesContract(
    'PostgreSQL',
    async (): Promise<GitHubIdentityHarness> => {
      await initialize();
      await cleanupContractRows();
      const pool = backend.context.pool;
      const repositories = createPostgresGitHubIdentityRepositories(pool);

      const insertConnector = async (id: string, now: string): Promise<void> => {
        await pool.query(
          `
            INSERT INTO connector_configs (
              id, type, name, enabled, capabilities, credentials, settings,
              synced_lists, created_at, updated_at
            ) VALUES ($1, 'github-issues', 'GitHub', true, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2)
          `,
          [id, now],
        );
      };

      return {
        repositories,
        seedConnector: async (id, now) => {
          await insertConnector(id, now);
        },
        seedBaseline: async (now) => {
          await insertConnector(connectorInstanceId, now);
          await pool.query(
            `INSERT INTO github_identity_migrations (connector_instance_id, phase, updated_at)
             VALUES ($1, 'complete', $2)`,
            [connectorInstanceId, now],
          );
          await pool.query(
            `INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
             VALUES ($1, $2, $3)`,
            [connectorInstanceId, modeRevision, now],
          );
          await pool.query(
            `INSERT INTO source_lists (id, connector_instance_id, source_id, name, type)
             VALUES ($1, $2, 'owner/repo', 'owner/repo', 'repo')`,
            [sourceListId, connectorInstanceId],
          );
          await pool.query(
            `
              INSERT INTO tasks (
                id, source_id, connector_type, connector_instance_id, title, status,
                priority, sync_status, source_list_id, metadata, created_at, updated_at,
                last_synced_at
              ) VALUES ($1, $2, 'github-issues', $3, 'Fence me', 'todo', 'normal', 'pushing',
                $4, '{}'::jsonb, $5, $6, $7)
            `,
            [taskId, sourceId, connectorInstanceId, sourceListId, now, taskVersion, pushLeaseToken],
          );
          await pool.query(
            `
              INSERT INTO external_entities (id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at)
              VALUES
                ('repo-entity', 'github', 'github.com', 'repository', 'R_repo', $1, $1),
                ('issue-entity', 'github', 'github.com', 'issue', 'I_issue', $1, $1)
            `,
            [now],
          );
          await pool.query(
            `
              INSERT INTO external_entity_locators (
                id, external_entity_id, repository_entity_id, provider, host_key, owner,
                repository, owner_key, repository_key, issue_number, valid_from, last_seen_at,
                observation_source, locator_revision
              ) VALUES
                ('repo-locator', 'repo-entity', NULL, 'github', 'github.com', 'owner', 'repo',
                  'owner', 'repo', NULL, $1, $1, 'rest', 1),
                ('issue-locator', 'issue-entity', 'repo-entity', 'github', 'github.com', 'owner', 'repo',
                  'owner', 'repo', 7, $1, $1, 'rest', 1)
            `,
            [now],
          );
          await pool.query(
            `
              INSERT INTO external_entity_bindings (
                id, external_entity_id, connector_instance_id, binding_type, local_id, state,
                verified_at, created_at, updated_at
              ) VALUES
                ('repo-binding', 'repo-entity', $1, 'source_list', $2, 'active', $3, $3, $3),
                ('issue-binding', 'issue-entity', $1, 'task', $4, 'active', $3, $3, $3)
            `,
            [connectorInstanceId, sourceListId, now, taskId],
          );
          await pool.query(
            `
              INSERT INTO task_linked_sources (
                id, task_id, connector_type, connector_instance_id, source_id, title, linked_at
              ) VALUES ($1, $2, 'github-issues', $3, $4, 'Fence me', $5)
            `,
            [linkedSourceId, taskId, connectorInstanceId, sourceId, now],
          );
        },
        seedTerminalException: async (now) => {
          await pool.query(
            `
              INSERT INTO github_identity_exception_events (
                connector_instance_id, binding_type, local_id, category, action,
                idempotency_key, actor, reason, proof_type, created_at
              ) VALUES ($1, 'task', $2, 'terminal_inaccessible', 'accept', $3, 'operator',
                'accepted terminal inaccessible identity', 'stage1_inaccessible', $4)
            `,
            [connectorInstanceId, taskId, `exception:${taskId}:accept`, now],
          );
        },
        leaseState: async (leaseId) => {
          const result = await pool.query<{
            state: string;
            modeRevision: number;
            dispatchedAt: string | null;
          }>(
            `
              SELECT state, mode_revision AS "modeRevision", dispatched_at AS "dispatchedAt"
              FROM task_source_write_leases
              WHERE id = $1
            `,
            [leaseId],
          );
          return result.rows[0] ?? null;
        },
        writeCycleState: async (cycleId) => {
          const result = await pool.query<{ state: string }>(
            `SELECT state FROM github_identity_write_cycles WHERE id = $1`,
            [cycleId],
          );
          return result.rows[0]?.state ?? null;
        },
        close: () => undefined,
      };
    },
  );
}

describe.skipIf(Boolean(connectionString))('GitHubIdentityPersistence (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await cleanupContractRows();
    await backend.shutdown();
    initialized = false;
  }
});
