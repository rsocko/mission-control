import { randomUUID } from 'node:crypto';
import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubHierarchyRepositories } from '@/db/postgres/repositories/github-hierarchy-repositories';
import { digestHistoricalProof } from '@/db/persistence/github-transfer-succession';
import {
  describeGitHubHierarchyRepositoriesContract,
  type GitHubHierarchyHarness,
} from '../contracts/github-hierarchy-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-github-hierarchy-test',
        }),
      }
    : {}),
});
let initialized = false;

const CONNECTORS = ['gh-hierarchy-contract', 'other'];
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
  await pool.query(
    'DELETE FROM github_identity_task_transfer_reconciliations WHERE connector_instance_id = ANY($1::text[])',
    [CONNECTORS],
  );
  await pool.query('DELETE FROM github_identity_exception_events WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM github_identity_controls WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM external_entity_locators WHERE external_entity_id LIKE $1', ['gh-hier-%']);
  await pool.query('DELETE FROM external_entity_bindings WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM external_entities WHERE id LIKE $1', ['gh-hier-%']);
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = ANY($1::text[])', [CONNECTORS]);
  await pool.query('DELETE FROM connector_configs WHERE id = ANY($1::text[])', [CONNECTORS]);
}

if (connectionString) {
  describeGitHubHierarchyRepositoriesContract('PostgreSQL', async (): Promise<GitHubHierarchyHarness> => {
    await initialize();
    await cleanup();
    const pool = backend.context.pool;
    for (const id of CONNECTORS) {
      await pool.query(
        `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
         VALUES ($1, 'github-issues', $1, '{}'::jsonb, $2, $2)`,
        [id, NOW],
      );
    }
    return {
      repositories: createPostgresGitHubHierarchyRepositories(pool),
      reset: async () => {
        await cleanup();
        for (const id of CONNECTORS) {
          await pool.query(
            `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
             VALUES ($1, 'github-issues', $1, '{}'::jsonb, $2, $2)`,
            [id, NOW],
          );
        }
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
             created_at, updated_at, last_synced_at, parent_id, depth,
             is_checklist_item, metadata
           ) VALUES ($1, $2, $3, $4, $1, 'todo', $5, $5, $5, $6, $7, $8, $9::jsonb)`,
          [
            row.id,
            row.sourceId,
            row.connectorType ?? 'github-issues',
            row.connectorInstanceId,
            NOW,
            row.parentId ?? null,
            row.depth ?? 0,
            row.isChecklistItem ?? false,
            JSON.stringify(row.metadata ?? {}),
          ],
        );
      },
      seedExceptionEvent: async (row) => {
        const proofType = row.action === 'accept' ? 'stage1_inaccessible' : null;
        await pool.query(
          `INSERT INTO github_identity_exception_events (
             connector_instance_id, binding_type, local_id, category, action,
             idempotency_key, actor, reason, proof_type, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'test', 'contract-seed', $7, $8)`,
          [
            row.connectorInstanceId,
            row.bindingType ?? 'task',
            row.localId,
            row.category ?? 'terminal_inaccessible',
            row.action,
            randomUUID(),
            proofType,
            new Date().toISOString(),
          ],
        );
      },
      seedSuccessionState: async (connectorInstanceId) => {
        const sourceEntity = `gh-hier-src-${randomUUID()}`;
        const successorEntity = `gh-hier-suc-${randomUUID()}`;
        const sourceRepositoryEntity = `gh-hier-src-repo-${randomUUID()}`;
        const successorRepositoryEntity = `gh-hier-suc-repo-${randomUUID()}`;
        const sourceStableId = `src-${randomUUID()}`;
        const successorStableId = `suc-${randomUUID()}`;
        const proof = {
          requestedSourceId: 'acme/source:1',
          successorSourceId: 'acme/target:2',
          sourceStableId,
          successorStableId,
          observedStableId: successorStableId,
        };
        await pool.query(
          `INSERT INTO tasks (
             id, source_id, connector_type, connector_instance_id, title, status,
             created_at, updated_at, last_synced_at, depth, is_checklist_item, metadata
           ) VALUES
             ('source', 'acme/source:1', 'github-issues', $1, 'source', 'todo', $2, $2, $2, 0, false, '{}'::jsonb),
             ('successor', 'acme/target:2', 'github-issues', $1, 'successor', 'todo', $2, $2, $2, 0, false, '{}'::jsonb)`,
          [connectorInstanceId, NOW],
        );
        for (const [id, entityType, stable] of [
          [sourceRepositoryEntity, 'repository', `repo-${randomUUID()}`],
          [successorRepositoryEntity, 'repository', `repo-${randomUUID()}`],
          [sourceEntity, 'issue', sourceStableId],
          [successorEntity, 'issue', successorStableId],
        ]) {
          await pool.query(
            `INSERT INTO external_entities (
               id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at
             ) VALUES ($1, 'github', 'github.com', $2, $3, $4, $4)`,
            [id, entityType, stable, NOW],
          );
        }
        await pool.query(
          `INSERT INTO external_entity_locators (
             id, external_entity_id, repository_entity_id, provider, host_key,
             owner, repository, owner_key, repository_key, issue_number,
             valid_from, last_seen_at, observation_source, locator_revision
           ) VALUES
             ($1, $2, $3, 'github', 'github.com', 'acme', 'source', 'acme', 'source', 1, $4, $4, 'rest', 1),
             ($5, $6, $7, 'github', 'github.com', 'acme', 'target', 'acme', 'target', 2, $4, $4, 'rest', 1)`,
          [
            randomUUID(), sourceEntity, sourceRepositoryEntity, NOW,
            randomUUID(), successorEntity, successorRepositoryEntity,
          ],
        );
        await pool.query(
          `INSERT INTO external_entity_bindings (
             id, external_entity_id, connector_instance_id, binding_type,
             local_id, state, verified_at, created_at, updated_at
           ) VALUES
             ($1, $2, $3, 'task', 'source', 'active', $4, $4, $4),
             ($5, $6, $3, 'task', 'successor', 'active', $4, $4, $4)`,
          [randomUUID(), sourceEntity, connectorInstanceId, NOW, randomUUID(), successorEntity],
        );
        await pool.query(
          `INSERT INTO github_identity_task_transfer_reconciliations (
             id, connector_instance_id, source_task_id, successor_task_id,
             source_external_entity_id, successor_external_entity_id,
             expected_mode_revision, proof_kind, proof, proof_digest,
             observed_at, actor, reason, idempotency_key, created_at
           ) VALUES ($1, $2, 'source', 'successor', $3, $4, 1,
             'rest_historical_redirect', $5::jsonb, $6, $7, 'test',
             'contract-seed', $8, $7)`,
          [
            randomUUID(),
            connectorInstanceId,
            sourceEntity,
            successorEntity,
            JSON.stringify(proof),
            digestHistoricalProof(proof),
            NOW,
            randomUUID(),
          ],
        );
      },
      getTaskState: async (id) => {
        const result = await pool.query<{ parentId: string | null; depth: number; metadata: unknown }>(
          'SELECT parent_id AS "parentId", depth, metadata FROM tasks WHERE id = $1',
          [id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const metadata = row.metadata && typeof row.metadata === 'object'
          ? row.metadata as Record<string, unknown>
          : {};
        return { parentId: row.parentId, depth: row.depth, metadata };
      },
      close: () => undefined,
    };
  });
}

describe.skipIf(Boolean(connectionString))('GitHubHierarchyPersistence (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});

afterAll(async () => {
  if (initialized) {
    await cleanup();
    await backend.shutdown();
    initialized = false;
  }
});
