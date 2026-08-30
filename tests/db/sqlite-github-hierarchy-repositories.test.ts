import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
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
    failsClosedOnSuccession: false,
    reset: async () => {
      sqlite.exec(`
        DELETE FROM github_identity_exception_events;
        DELETE FROM github_identity_controls;
        DELETE FROM task_projects;
        DELETE FROM tasks;
        DELETE FROM connector_configs WHERE id IN ('gh-hierarchy-contract', 'other');
      `);
      const now = '2026-08-09T00:00:00.000Z';
      for (const id of ['gh-hierarchy-contract', 'other']) {
        sqlite.prepare(`
          INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
          VALUES (?, 'github-issues', ?, '{}', ?, ?)
        `).run(id, id, now, now);
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
    seedSuccessionState: async () => undefined,
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
