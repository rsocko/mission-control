import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { digestHistoricalProof } from '@/db/persistence/github-transfer-succession';
import {
  describeGitHubHierarchyRepositoriesContract,
  type GitHubHierarchyHarness,
} from '../contracts/github-hierarchy-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `github-hierarchy-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;
const NOW = '2026-08-09T00:00:00.000Z';

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-github-hierarchy-repositories'),
]).then(([database, adapter]) => ({
  database,
  repositories: adapter.createSqliteGitHubHierarchyRepositories(
    database.sqlite,
    database.default,
  ),
}));

describeGitHubHierarchyRepositoriesContract('SQLite', async (): Promise<GitHubHierarchyHarness> => {
  const context = await contextPromise;
  const sqlite = context.database.sqlite;
  return {
    repositories: context.repositories,
    reset: async () => {
      sqlite.exec(`
        DELETE FROM github_identity_task_transfer_reconciliations;
        DELETE FROM github_identity_exception_events;
        DELETE FROM github_identity_controls;
        DELETE FROM external_entity_bindings;
        DELETE FROM external_entity_locators;
        DELETE FROM external_entities;
        DELETE FROM task_projects;
        DELETE FROM tasks;
        DELETE FROM connector_configs WHERE id IN ('gh-hierarchy-contract', 'other');
      `);
      for (const id of ['gh-hierarchy-contract', 'other']) {
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
      `).run(connectorInstanceId, modeRevision, '2026-08-09T00:00:00.000Z');
    },
    seedTask: async (row) => {
      const now = '2026-08-09T00:00:00.000Z';
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          local_disposition, priority, push_count, created_at, updated_at,
          last_synced_at, parent_id, depth, is_checklist_item, metadata, sync_status
        ) VALUES (?, ?, ?, ?, ?, 'todo', 'active', 'none', 0, ?, ?, ?, ?, ?, ?, ?, 'synced')
      `).run(
        row.id,
        row.sourceId,
        row.connectorType ?? 'github-issues',
        row.connectorInstanceId,
        row.id,
        now,
        now,
        now,
        row.parentId ?? null,
        row.depth ?? 0,
        row.isChecklistItem ? 1 : 0,
        row.metadata === undefined || row.metadata === null ? '{}' : JSON.stringify(row.metadata),
      );
    },
    seedExceptionEvent: async (row) => {
      const proofType = row.action === 'accept' ? 'stage1_inaccessible' : null;
      sqlite.prepare(`
        INSERT INTO github_identity_exception_events (
          connector_instance_id, binding_type, local_id, category, action,
          idempotency_key, actor, reason, proof_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'test', 'contract-seed', ?, ?)
      `).run(
        row.connectorInstanceId,
        row.bindingType ?? 'task',
        row.localId,
        row.category ?? 'terminal_inaccessible',
        row.action,
        randomUUID(),
        proofType,
        new Date().toISOString(),
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
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          local_disposition, priority, push_count, created_at, updated_at,
          last_synced_at, depth, is_checklist_item, metadata, sync_status
        ) VALUES (?, ?, 'github-issues', ?, ?, 'todo', 'active', 'none', 0, ?, ?, ?, 0, 0, '{}', 'synced')
      `).run('source', 'acme/source:1', connectorInstanceId, 'source', NOW, NOW, NOW);
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          local_disposition, priority, push_count, created_at, updated_at,
          last_synced_at, depth, is_checklist_item, metadata, sync_status
        ) VALUES (?, ?, 'github-issues', ?, ?, 'todo', 'active', 'none', 0, ?, ?, ?, 0, 0, '{}', 'synced')
      `).run('successor', 'acme/target:2', connectorInstanceId, 'successor', NOW, NOW, NOW);
      const insertEntity = sqlite.prepare(`
        INSERT INTO external_entities (
          id, provider, host_key, entity_type, stable_id, first_seen_at, last_seen_at
        ) VALUES (?, 'github', 'github.com', ?, ?, ?, ?)
      `);
      insertEntity.run(sourceRepositoryEntity, 'repository', `repo-${randomUUID()}`, NOW, NOW);
      insertEntity.run(successorRepositoryEntity, 'repository', `repo-${randomUUID()}`, NOW, NOW);
      insertEntity.run(sourceEntity, 'issue', sourceStableId, NOW, NOW);
      insertEntity.run(successorEntity, 'issue', successorStableId, NOW, NOW);
      const insertLocator = sqlite.prepare(`
        INSERT INTO external_entity_locators (
          id, external_entity_id, repository_entity_id, provider, host_key, owner,
          repository, owner_key, repository_key, issue_number, valid_from,
          last_seen_at, observation_source, locator_revision
        ) VALUES (?, ?, ?, 'github', 'github.com', 'acme', ?, 'acme', ?, ?, ?, ?, 'rest', 1)
      `);
      insertLocator.run(randomUUID(), sourceEntity, sourceRepositoryEntity, 'source', 'source', 1, NOW, NOW);
      insertLocator.run(randomUUID(), successorEntity, successorRepositoryEntity, 'target', 'target', 2, NOW, NOW);
      const insertBinding = sqlite.prepare(`
        INSERT INTO external_entity_bindings (
          id, external_entity_id, connector_instance_id, binding_type, local_id,
          state, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'task', ?, 'active', ?, ?, ?)
      `);
      insertBinding.run(randomUUID(), sourceEntity, connectorInstanceId, 'source', NOW, NOW, NOW);
      insertBinding.run(randomUUID(), successorEntity, connectorInstanceId, 'successor', NOW, NOW, NOW);
      sqlite.prepare(`
        INSERT INTO github_identity_task_transfer_reconciliations (
          id, connector_instance_id, source_task_id, successor_task_id,
          source_external_entity_id, successor_external_entity_id,
          expected_mode_revision, proof_kind, proof, proof_digest,
          observed_at, actor, reason, idempotency_key, created_at
        ) VALUES (?, ?, 'source', 'successor', ?, ?, 1,
          'rest_historical_redirect', ?, ?, ?, 'test', 'contract-seed', ?, ?)
      `).run(
        randomUUID(),
        connectorInstanceId,
        sourceEntity,
        successorEntity,
        JSON.stringify(proof),
        digestHistoricalProof(proof),
        NOW,
        randomUUID(),
        NOW,
      );
    },
    getTaskState: async (id) => {
      const row = sqlite.prepare(`
        SELECT parent_id AS parentId, depth, metadata FROM tasks WHERE id = ?
      `).get(id) as { parentId: string | null; depth: number; metadata: unknown } | undefined;
      if (!row) return null;
      // Mirror the app read path: metadata may be double-encoded, so parse until
      // an object (or give up) exactly like the defensive readers do.
      let metadata: unknown = row.metadata;
      for (let i = 0; i < 3 && typeof metadata === 'string'; i += 1) {
        try { metadata = JSON.parse(metadata); } catch { break; }
      }
      return {
        parentId: row.parentId,
        depth: row.depth,
        metadata: (metadata && typeof metadata === 'object'
          ? metadata as Record<string, unknown>
          : {}),
      };
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
