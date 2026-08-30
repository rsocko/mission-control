import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeGitHubRecoveryRepositoriesContract,
  type GitHubRecoveryHarness,
  type RecoveryFixture,
} from '../contracts/github-recovery-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `github-recovery-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const NOW = '2026-08-20T12:00:00.000Z';

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-github-recovery-repositories'),
]).then(([database, adapter]) => ({
  database,
  repositories: adapter.createSqliteGitHubRecoveryRepositories(
    database.sqlite,
    database.default,
  ),
}));

describeGitHubRecoveryRepositoriesContract('SQLite', async (): Promise<GitHubRecoveryHarness> => {
  const context = await contextPromise;
  const sqlite = context.database.sqlite;

  function reset(): void {
    sqlite.exec(`
      DELETE FROM github_bulk_transfer_events;
      DELETE FROM github_bulk_transfer_successions;
      DELETE FROM github_bulk_transfer_items;
      DELETE FROM github_bulk_transfer_runs;
      DELETE FROM github_repository_repoint_events;
      DELETE FROM github_repository_repoints;
      DELETE FROM github_identity_task_transfer_reconciliations;
      DELETE FROM github_identity_collisions;
      DELETE FROM github_identity_controls;
      DELETE FROM connector_maintenance_locks;
      DELETE FROM connector_operation_leases;
      DELETE FROM external_entity_locators;
      DELETE FROM external_entity_bindings;
      DELETE FROM external_entities;
      DELETE FROM task_linked_sources;
      DELETE FROM task_ingest_suppressions;
      DELETE FROM tasks;
      DELETE FROM source_lists;
      DELETE FROM connector_configs;
    `);
  }

  return {
    repositories: context.repositories,
    seed: async (fixture: RecoveryFixture) => {
      reset();
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, capabilities, credentials, settings, synced_lists,
          created_at, updated_at
        ) VALUES (?, 'github-issues', ?, ?, '{}', ?, ?, ?, ?, ?)
      `).run(
        fixture.connectorInstanceId,
        fixture.connectorInstanceId,
        fixture.enabled ? 1 : 0,
        JSON.stringify({ token: fixture.token }),
        JSON.stringify({ repos: fixture.repos }),
        JSON.stringify(fixture.syncedLists),
        NOW,
        NOW,
      );
      sqlite.prepare(`
        INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
        VALUES (?, ?, ?)
      `).run(fixture.connectorInstanceId, fixture.modeRevision, NOW);
      for (const list of fixture.sourceLists) {
        sqlite.prepare(`
          INSERT INTO source_lists (
            id, connector_instance_id, source_id, name, type, last_known_remote_name
          ) VALUES (?, ?, ?, ?, 'list', ?)
        `).run(list.id, fixture.connectorInstanceId, list.sourceId, list.sourceId, list.sourceId);
      }
      for (const task of fixture.tasks) {
        sqlite.prepare(`
          INSERT INTO tasks (
            id, title, status, priority, connector_type, connector_instance_id,
            source_id, source_list_id, source_list_name, metadata, sync_status,
            last_synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'medium', 'github-issues', ?, ?, ?, ?, '{}', 'synced', ?, ?, ?)
        `).run(
          task.id,
          task.title,
          task.status,
          fixture.connectorInstanceId,
          task.sourceId,
          task.sourceId.split(':')[0],
          task.sourceId.split(':')[0],
          NOW,
          NOW,
          NOW,
        );
      }
      const revision = 1;
      for (const entity of fixture.entities) {
        sqlite.prepare(`
          INSERT INTO external_entities (
            id, provider, host_key, entity_type, stable_id, identity_version,
            next_locator_revision, first_seen_at, last_seen_at
          ) VALUES (?, 'github', 'github.com', ?, ?, 1, ?, ?, ?)
        `).run(entity.id, entity.entityType, entity.stableId, revision + 1, NOW, NOW);
        sqlite.prepare(`
          INSERT INTO external_entity_locators (
            id, external_entity_id, repository_entity_id, provider, host_key,
            owner, repository, owner_key, repository_key, issue_number, api_url,
            web_url, valid_from, valid_to, last_seen_at, observation_source, locator_revision
          ) VALUES (?, ?, ?, 'github', 'github.com', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, 'rest', ?)
        `).run(
          randomUUID(),
          entity.id,
          entity.repositoryEntityId ?? null,
          entity.owner,
          entity.repository,
          entity.owner.toLowerCase(),
          entity.repository.toLowerCase(),
          entity.issueNumber ?? null,
          NOW,
          NOW,
          revision,
        );
      }
      for (const binding of fixture.bindings) {
        sqlite.prepare(`
          INSERT INTO external_entity_bindings (
            id, external_entity_id, connector_instance_id, binding_type, local_id,
            state, verified_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          binding.id,
          binding.externalEntityId,
          fixture.connectorInstanceId,
          binding.bindingType,
          binding.localId,
          binding.state,
          NOW,
          NOW,
          NOW,
        );
      }
    },
    readTask: async (taskId) => (sqlite.prepare(`
      SELECT source_id AS sourceId, source_list_id AS sourceListId FROM tasks WHERE id = ?
    `).get(taskId) as { sourceId: string; sourceListId: string | null } | undefined) ?? null,
    setTaskTitle: async (taskId, title) => {
      sqlite.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, taskId);
    },
    connectorEnabled: async (connectorInstanceId) => Boolean(
      (sqlite.prepare('SELECT enabled FROM connector_configs WHERE id = ?')
        .get(connectorInstanceId) as { enabled: number } | undefined)?.enabled,
    ),
    countOpenCollisions: async (connectorInstanceId) => Number(
      (sqlite.prepare(`
        SELECT COUNT(*) AS value FROM github_identity_collisions
        WHERE connector_instance_id = ? AND state = 'open'
      `).get(connectorInstanceId) as { value: number }).value,
    ),
    countMaintenanceLocks: async (connectorInstanceId) => Number(
      (sqlite.prepare(`
        SELECT COUNT(*) AS value FROM connector_maintenance_locks WHERE connector_instance_id = ?
      `).get(connectorInstanceId) as { value: number }).value,
    ),
    readSourceList: async (id) => (sqlite.prepare(
      'SELECT source_id AS sourceId, name FROM source_lists WHERE id = ?',
    ).get(id) as { sourceId: string; name: string } | undefined) ?? null,
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
