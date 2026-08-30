import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresGitHubIdentityRepositories } from '@/db/postgres/repositories/github-identity-repositories';
import type { ExternalIdentityWrite } from '@/lib/external-identities/types';
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
  await pool.query(
    `DELETE FROM external_entity_locators
     WHERE external_entity_id IN (
       SELECT id FROM external_entities
       WHERE stable_id LIKE 'R_fresh-primary-%'
          OR stable_id LIKE 'I_fresh-primary-%'
     )`,
  );
  await pool.query(
    `DELETE FROM external_entity_bindings
     WHERE connector_instance_id = $1 OR connector_instance_id LIKE $2`,
    [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`],
  );
  await pool.query(`DELETE FROM external_entity_locators WHERE external_entity_id IN ('repo-entity', 'issue-entity')`);
  await pool.query(`DELETE FROM external_entities WHERE id IN ('repo-entity', 'issue-entity')`);
  await pool.query(
    `DELETE FROM external_entities
     WHERE stable_id LIKE 'R_fresh-primary-%'
        OR stable_id LIKE 'I_fresh-primary-%'`,
  );
  await pool.query(`DELETE FROM task_linked_sources WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM tasks WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM source_lists WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM github_identity_controls WHERE connector_instance_id = $1 OR connector_instance_id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
  await pool.query(`DELETE FROM github_identity_migrations WHERE connector_instance_id = $1 OR connector_instance_id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
  await pool.query(`DELETE FROM connector_configs WHERE id = $1 OR id LIKE $2`, [connectorInstanceId, `${FRESH_CONNECTOR_PREFIX}%`]);
}

function instrumentPostgresPool(pool: Pool, statements: string[]): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === 'query') {
                return (textOrConfig: unknown, ...args: unknown[]) => {
                  const text = typeof textOrConfig === 'string'
                    ? textOrConfig
                    : (
                        textOrConfig
                        && typeof textOrConfig === 'object'
                        && 'text' in textOrConfig
                        && typeof textOrConfig.text === 'string'
                          ? textOrConfig.text
                          : ''
                      );
                  statements.push(text.replace(/\s+/g, ' ').trim());
                  return Reflect.apply(
                    clientTarget.query,
                    clientTarget,
                    [textOrConfig, ...args],
                  );
                };
              }
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
        primaryBinding: async ({ connectorInstanceId, bindingType, localId }) => {
          const result = await pool.query<{
            stableId: string;
            state: string;
            verifiedAt: string | null;
          }>(
            `
              SELECT entity.stable_id AS "stableId", binding.state,
                binding.verified_at AS "verifiedAt"
              FROM external_entity_bindings AS binding
              JOIN external_entities AS entity ON entity.id = binding.external_entity_id
              WHERE binding.connector_instance_id = $1
                AND binding.binding_type = $2
                AND binding.local_id = $3
              LIMIT 1
            `,
            [connectorInstanceId, bindingType, localId],
          );
          return result.rows[0] ?? null;
        },
        close: () => undefined,
      };
    },
  );

  describe('GitHubIdentityPersistence bulk writes (PostgreSQL)', () => {
    beforeEach(async () => {
      await initialize();
      await cleanupContractRows();
    });

    it('persists a production-sized batch with bounded query count and isolated collisions', async () => {
      const pool = backend.context.pool;
      const repositories = createPostgresGitHubIdentityRepositories(pool);
      const connectorInstanceId = `fresh-primary-bulk-${randomUUID()}`;
      const observedAt = '2026-08-20T10:00:00.000Z';
      await pool.query(
        `
          INSERT INTO connector_configs (
            id, type, name, enabled, capabilities, credentials, settings,
            synced_lists, created_at, updated_at
          ) VALUES (
            $1, 'github-issues', 'GitHub bulk', true, '{}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2
          )
        `,
        [connectorInstanceId, observedAt],
      );
      await repositories.identity.ensureControls({ connectorInstanceId, now: observedAt });
      const modeSnapshot = await repositories.identity.getModeSnapshot(
        connectorInstanceId,
        observedAt,
      );
      const evidence = (suffix: string) => ({
        entity: {
          identity: {
            provider: 'github' as const,
            hostKey: 'github.com',
            entityType: 'repository' as const,
            stableId: `R_fresh-primary-bulk-${suffix}`,
          },
          locator: {
            owner: 'bulk-owner',
            repository: `repository-${suffix}`,
          },
          observationSource: 'graphql' as const,
          observedAt,
        },
      });
      const existingStableTarget = {
        connectorInstanceId,
        bindingType: 'source_list' as const,
        localId: `${connectorInstanceId}:existing-stable`,
        legacyIdentity: 'bulk-owner/repository-existing-stable',
      };
      const existingLocalTarget = {
        connectorInstanceId,
        bindingType: 'source_list' as const,
        localId: `${connectorInstanceId}:existing-local`,
        legacyIdentity: 'bulk-owner/repository-existing-local',
      };
      await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [
          { target: existingStableTarget, evidence: evidence('existing-stable') },
          { target: existingLocalTarget, evidence: evidence('existing-local') },
        ],
      });

      const writes: ExternalIdentityWrite[] = [
        {
          target: {
            ...existingStableTarget,
            localId: `${connectorInstanceId}:competing-local`,
          },
          evidence: evidence('existing-stable'),
        },
        {
          target: existingLocalTarget,
          evidence: evidence('competing-stable'),
        },
        ...Array.from({ length: 498 }, (_, index): ExternalIdentityWrite => ({
          target: {
            connectorInstanceId,
            bindingType: 'source_list',
            localId: `${connectorInstanceId}:list-${index}`,
            legacyIdentity: `bulk-owner/repository-${index}`,
          },
          evidence: evidence(String(index)),
        })),
      ];
      const statements: string[] = [];
      const instrumentedRepositories = createPostgresGitHubIdentityRepositories(
        instrumentPostgresPool(pool, statements),
      );
      const results = await instrumentedRepositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes,
      });

      expect(results).toHaveLength(500);
      expect(results.filter(({ state }) => state === 'bound')).toHaveLength(498);
      expect(results.slice(0, 2)).toEqual([
        expect.objectContaining({
          state: 'collision',
          collisionCategory: 'multiple_local_one_stable',
        }),
        expect.objectContaining({
          state: 'collision',
          collisionCategory: 'one_local_multiple_stable',
        }),
      ]);
      expect(statements).toHaveLength(14);
      expect(statements.filter((text) => text.includes('INSERT INTO external_entities')))
        .toHaveLength(1);
      expect(statements.filter((text) => text.includes('INSERT INTO external_entity_locators')))
        .toHaveLength(1);
      expect(statements.filter((text) => text.includes('INSERT INTO external_entity_bindings')))
        .toHaveLength(1);
      expect(statements.filter((text) => text.includes('FROM unnest'))).toHaveLength(6);

      const persisted = await pool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM external_entity_bindings
          WHERE connector_instance_id = $1
        `,
        [connectorInstanceId],
      );
      expect(persisted.rows[0]?.count).toBe('500');
      const competingBindings = await pool.query<{ localId: string }>(
        `
          SELECT local_id AS "localId"
          FROM external_entity_bindings
          WHERE connector_instance_id = $1
            AND local_id = ANY($2::text[])
        `,
        [
          connectorInstanceId,
          [
            `${connectorInstanceId}:competing-local`,
            existingLocalTarget.localId,
          ],
        ],
      );
      expect(competingBindings.rows.map(({ localId }) => localId)).toEqual([
        existingLocalTarget.localId,
      ]);

      const [retry] = await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [{
          target: existingStableTarget,
          evidence: evidence('existing-stable'),
        }],
      });
      expect(retry.state).toBe('bound');
      const collisionState = await pool.query<{ state: string }>(
        `
          SELECT state
          FROM external_entity_bindings
          WHERE connector_instance_id = $1
            AND binding_type = 'source_list'
            AND local_id = $2
        `,
        [connectorInstanceId, existingStableTarget.localId],
      );
      expect(collisionState.rows[0]?.state).toBe('collision');
    });

    it('preserves ordered locator handoffs through the sequential fallback', async () => {
      const pool = backend.context.pool;
      const repositories = createPostgresGitHubIdentityRepositories(pool);
      const connectorInstanceId = `fresh-primary-handoff-${randomUUID()}`;
      const initialAt = '2026-08-20T10:00:00.000Z';
      const movedAt = '2026-08-20T10:01:00.000Z';
      await pool.query(
        `
          INSERT INTO connector_configs (
            id, type, name, enabled, capabilities, credentials, settings,
            synced_lists, created_at, updated_at
          ) VALUES (
            $1, 'github-issues', 'GitHub handoff', true, '{}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2
          )
        `,
        [connectorInstanceId, initialAt],
      );
      await repositories.identity.ensureControls({ connectorInstanceId, now: initialAt });
      const modeSnapshot = await repositories.identity.getModeSnapshot(
        connectorInstanceId,
        initialAt,
      );
      const target = (suffix: string) => ({
        connectorInstanceId,
        bindingType: 'source_list' as const,
        localId: `${connectorInstanceId}:${suffix}`,
        legacyIdentity: `bulk-owner/${suffix}`,
      });
      const evidence = (
        stableId: string,
        repository: string,
        observedAt: string,
      ) => ({
        entity: {
          identity: {
            provider: 'github' as const,
            hostKey: 'github.com',
            entityType: 'repository' as const,
            stableId,
          },
          locator: { owner: 'bulk-owner', repository },
          observationSource: 'graphql' as const,
          observedAt,
        },
      });
      await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [{
          target: target('first'),
          evidence: evidence('R_fresh-primary-handoff-first', 'old-path', initialAt),
        }],
      });

      const results = await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [
          {
            target: target('first'),
            evidence: evidence('R_fresh-primary-handoff-first', 'new-path', movedAt),
          },
          {
            target: target('second'),
            evidence: evidence('R_fresh-primary-handoff-second', 'old-path', movedAt),
          },
        ],
      });
      expect(results.map(({ state }) => state)).toEqual(['bound', 'bound']);
      const locators = await pool.query<{ stableId: string; repository: string }>(
        `
          SELECT
            entity.stable_id AS "stableId",
            locator.repository
          FROM external_entities entity
          INNER JOIN external_entity_locators locator
            ON locator.external_entity_id = entity.id
           AND locator.valid_to IS NULL
          WHERE entity.stable_id = ANY($1::text[])
          ORDER BY entity.stable_id
        `,
        [[
          'R_fresh-primary-handoff-first',
          'R_fresh-primary-handoff-second',
        ]],
      );
      expect(locators.rows).toEqual([
        { stableId: 'R_fresh-primary-handoff-first', repository: 'new-path' },
        { stableId: 'R_fresh-primary-handoff-second', repository: 'old-path' },
      ]);
    });

    it('does not persist an issue whose repository locator is rejected', async () => {
      const pool = backend.context.pool;
      const repositories = createPostgresGitHubIdentityRepositories(pool);
      const connectorInstanceId = `fresh-primary-rejected-issue-${randomUUID()}`;
      const observedAt = '2026-08-20T10:00:00.000Z';
      await pool.query(
        `
          INSERT INTO connector_configs (
            id, type, name, enabled, capabilities, credentials, settings,
            synced_lists, created_at, updated_at
          ) VALUES (
            $1, 'github-issues', 'GitHub rejected issue', true, '{}'::jsonb,
            '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2
          )
        `,
        [connectorInstanceId, observedAt],
      );
      await repositories.identity.ensureControls({ connectorInstanceId, now: observedAt });
      const modeSnapshot = await repositories.identity.getModeSnapshot(
        connectorInstanceId,
        observedAt,
      );
      const repositoryObservation = (stableId: string) => ({
        identity: {
          provider: 'github' as const,
          hostKey: 'github.com',
          entityType: 'repository' as const,
          stableId,
        },
        locator: { owner: 'bulk-owner', repository: 'claimed-path' },
        observationSource: 'graphql' as const,
        observedAt,
      });
      await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [{
          target: {
            connectorInstanceId,
            bindingType: 'source_list',
            localId: `${connectorInstanceId}:owner`,
            legacyIdentity: 'bulk-owner/claimed-path',
          },
          evidence: {
            entity: repositoryObservation('R_fresh-primary-rejected-owner'),
          },
        }],
      });

      const rejectedIssueStableId = 'I_fresh-primary-rejected-issue';
      const [result] = await repositories.identity.persistExternalIdentityBatch({
        connectorInstanceId,
        modeSnapshot,
        writes: [{
          target: {
            connectorInstanceId,
            bindingType: 'task',
            localId: `${connectorInstanceId}:issue`,
            legacyIdentity: 'bulk-owner/claimed-path:17',
          },
          evidence: {
            repository: repositoryObservation('R_fresh-primary-rejected-competitor'),
            entity: {
              identity: {
                provider: 'github',
                hostKey: 'github.com',
                entityType: 'issue',
                stableId: rejectedIssueStableId,
              },
              locator: {
                owner: 'bulk-owner',
                repository: 'claimed-path',
                issueNumber: 17,
              },
              observationSource: 'graphql',
              observedAt,
            },
          },
        }],
      });
      expect(result).toMatchObject({
        state: 'collision',
        collisionCategory: 'repository_path_replacement',
      });
      const rejectedIssue = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM external_entities
          WHERE provider = 'github'
            AND host_key = 'github.com'
            AND entity_type = 'issue'
            AND stable_id = $1
        `,
        [rejectedIssueStableId],
      );
      expect(rejectedIssue.rows).toEqual([]);
    });
  });
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
