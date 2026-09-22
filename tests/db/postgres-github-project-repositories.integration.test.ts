import { randomUUID } from 'node:crypto';
import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubProjectRepositories } from '@/db/postgres/repositories/github-project-repositories';
import {
  describeGitHubProjectRepositoriesContract,
  type GitHubProjectHarness,
} from '../contracts/github-project-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-project-test',
        }),
      }
    : {}),
});
let initialized = false;

const CONNECTORS = ['gh-project-contract', 'other'];
const NOW = '2026-08-09T00:00:00.000Z';

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function cleanup(): Promise<void> {
  const pool = backend.context.pool;
  await pool.query('DELETE FROM task_projects WHERE project_id LIKE $1', ['gh-project:%']);
  await pool.query('DELETE FROM hub_projects WHERE id LIKE $1', ['gh-project:%']);
  await pool.query('DELETE FROM external_entity_locators WHERE external_entity_id LIKE $1', ['gh-proj-%']);
  await pool.query('DELETE FROM external_entity_bindings WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM external_entities WHERE id LIKE $1', ['gh-proj-%']);
  await pool.query('DELETE FROM github_identity_controls WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM connector_configs WHERE id = ANY($1::text[])', [CONNECTORS]);
}

async function seedConnectors(): Promise<void> {
  const pool = backend.context.pool;
  for (const id of CONNECTORS) {
    await pool.query(
      `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
       VALUES ($1, 'github-issues', $1, '{}'::jsonb, $2, $2)`,
      [id, NOW],
    );
  }
}

if (connectionString) {
  describeGitHubProjectRepositoriesContract('PostgreSQL', async (): Promise<GitHubProjectHarness> => {
    await initialize();
    await cleanup();
    await seedConnectors();
    const pool = backend.context.pool;
    return {
      repositories: createPostgresGitHubProjectRepositories(pool),
      reset: async () => {
        await cleanup();
        await seedConnectors();
      },
      seedControl: async (connectorInstanceId, modeRevision) => {
        await pool.query(
          `INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (connector_instance_id) DO UPDATE SET mode_revision = EXCLUDED.mode_revision`,
          [connectorInstanceId, modeRevision, NOW],
        );
      },
      seedTask: async (row) => {
        await pool.query(
          `INSERT INTO tasks (
             id, source_id, connector_type, connector_instance_id, title, status,
             created_at, updated_at, last_synced_at, depth, is_checklist_item, metadata
           ) VALUES ($1, $2, 'github-issues', $3, $1, 'todo', $4, $4, $4, 0, false, '{}'::jsonb)`,
          [row.id, row.sourceId, row.connectorInstanceId, NOW],
        );
      },
      seedActiveBinding: async (row) => {
        const bindingType = row.bindingType ?? 'task';
        const entityId = `gh-proj-${randomUUID()}`;
        const bindingRevision = NOW;
        const locatorRevision = 1;
        await pool.query(
          `INSERT INTO external_entities (
             id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at
           ) VALUES ($1, 'github', 'github.com', 'issue', $2, $3, $3)`,
          [entityId, `stable-${randomUUID()}`, NOW],
        );
        await pool.query(
          `INSERT INTO external_entity_bindings (
             id, external_entity_id, connector_instance_id, binding_type, local_id,
             state, verified_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)`,
          [`gh-proj-b-${randomUUID()}`, entityId, row.connectorInstanceId, bindingType, row.localId, bindingRevision, NOW],
        );
        await pool.query(
          `INSERT INTO external_entity_locators (
             id, external_entity_id, provider, host_key, owner, repository,
             owner_key, repository_key, valid_from, valid_to, last_seen_at,
             observation_source, locator_revision
           ) VALUES ($1, $2, 'github', 'github.com', 'acme', 'app', 'acme', 'app', $3, NULL, $3, 'graphql', $4)`,
          [`gh-proj-l-${randomUUID()}`, entityId, NOW, locatorRevision],
        );
        return { externalEntityId: entityId, bindingRevision, locatorRevision };
      },
      seedExistingLink: async (projectIdValue, taskId) => {
        await pool.query(
          `INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
           ON CONFLICT (task_id, project_id) DO NOTHING`,
          [taskId, projectIdValue],
        );
      },
      getHubProject: async (projectIdValue) => {
        const result = await pool.query<{
          name: string;
          description: string | null;
          metadata: unknown;
        }>(
          'SELECT name, description, metadata FROM hub_projects WHERE id = $1',
          [projectIdValue],
        );
        const row = result.rows[0];
        if (!row) return null;
        const metadata = row.metadata && typeof row.metadata === 'object'
          ? row.metadata as Record<string, unknown>
          : {};
        return { name: row.name, description: row.description, metadata };
      },
      listLinkedTaskIds: async (projectIdValue) => {
        const result = await pool.query<{ taskId: string }>(
          'SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1 ORDER BY task_id',
          [projectIdValue],
        );
        return result.rows.map((r) => r.taskId);
      },
      close: () => undefined,
    };
  });
}

describe.skipIf(Boolean(connectionString))('GitHubProjectPersistence (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await cleanup();
    await backend.shutdown();
    initialized = false;
  }
});
