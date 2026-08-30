import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeGitHubProjectRepositoriesContract,
  type GitHubProjectHarness,
} from '../contracts/github-project-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `github-project-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-github-project-repositories'),
]).then(([database, adapter]) => ({
  database,
  repositories: adapter.createSqliteGitHubProjectRepositories(
    database.sqlite,
    database.default,
  ),
}));

const NOW = '2026-08-09T00:00:00.000Z';

describeGitHubProjectRepositoriesContract('SQLite', async (): Promise<GitHubProjectHarness> => {
  const context = await contextPromise;
  const sqlite = context.database.sqlite;
  return {
    repositories: context.repositories,
    reset: async () => {
      sqlite.exec(`
        DELETE FROM external_entity_locators;
        DELETE FROM external_entity_bindings;
        DELETE FROM external_entities;
        DELETE FROM github_identity_controls;
        DELETE FROM task_projects;
        DELETE FROM hub_projects;
        DELETE FROM tasks;
        DELETE FROM connector_configs WHERE id IN ('gh-project-contract', 'other');
      `);
      for (const id of ['gh-project-contract', 'other']) {
        sqlite.prepare(`
          INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
          VALUES (?, 'github-issues', ?, '{}', ?, ?)
        `).run(id, id, NOW, NOW);
      }
    },
    seedControl: async (connectorInstanceId, modeRevision) => {
      sqlite.prepare(`
        INSERT INTO github_identity_controls (connector_instance_id, mode_revision, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(connector_instance_id) DO UPDATE SET mode_revision = excluded.mode_revision
      `).run(connectorInstanceId, modeRevision, NOW);
    },
    seedTask: async (row) => {
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          local_disposition, priority, push_count, created_at, updated_at,
          last_synced_at, depth, is_checklist_item, metadata, sync_status
        ) VALUES (?, ?, 'github-issues', ?, ?, 'todo', 'active', 'none', 0, ?, ?, ?, 0, 0, '{}', 'synced')
      `).run(row.id, row.sourceId, row.connectorInstanceId, row.id, NOW, NOW, NOW);
    },
    seedActiveBinding: async (row) => {
      const bindingType = row.bindingType ?? 'task';
      const entityId = `entity-${randomUUID()}`;
      const bindingRevision = NOW;
      const locatorRevision = 1;
      sqlite.prepare(`
        INSERT INTO external_entities (
          id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at
        ) VALUES (?, 'github', 'github.com', 'issue', ?, ?, ?)
      `).run(entityId, `stable-${randomUUID()}`, NOW, NOW);
      sqlite.prepare(`
        INSERT INTO external_entity_bindings (
          id, external_entity_id, connector_instance_id, binding_type, local_id,
          state, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        `binding-${randomUUID()}`,
        entityId,
        row.connectorInstanceId,
        bindingType,
        row.localId,
        bindingRevision,
        NOW,
        NOW,
      );
      sqlite.prepare(`
        INSERT INTO external_entity_locators (
          id, external_entity_id, provider, host_key, owner, repository,
          owner_key, repository_key, valid_from, valid_to, last_seen_at,
          observation_source, locator_revision
        ) VALUES (?, ?, 'github', 'github.com', 'acme', 'app', 'acme', 'app', ?, NULL, ?, 'graphql', ?)
      `).run(`locator-${randomUUID()}`, entityId, NOW, NOW, locatorRevision);
      return { externalEntityId: entityId, bindingRevision, locatorRevision };
    },
    seedExistingLink: async (projectIdValue, taskId) => {
      sqlite.prepare(`
        INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
        ON CONFLICT(task_id, project_id) DO NOTHING
      `).run(taskId, projectIdValue);
    },
    getHubProject: async (projectIdValue) => {
      const row = sqlite.prepare(`
        SELECT name, description, metadata FROM hub_projects WHERE id = ?
      `).get(projectIdValue) as { name: string; description: string | null; metadata: unknown } | undefined;
      if (!row) return null;
      let metadata: unknown = row.metadata;
      for (let i = 0; i < 3 && typeof metadata === 'string'; i += 1) {
        try { metadata = JSON.parse(metadata); } catch { break; }
      }
      return {
        name: row.name,
        description: row.description,
        metadata: (metadata && typeof metadata === 'object'
          ? metadata as Record<string, unknown>
          : {}),
      };
    },
    listLinkedTaskIds: async (projectIdValue) => {
      const rows = sqlite.prepare(`
        SELECT task_id AS taskId FROM task_projects WHERE project_id = ? ORDER BY task_id
      `).all(projectIdValue) as Array<{ taskId: string }>;
      return rows.map((r) => r.taskId);
    },
    close: () => undefined,
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
