import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeGitHubDependencyRepositoriesContract,
  type GitHubDependencyHarness,
} from '../contracts/github-dependency-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `github-dependency-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/schema'),
  import('@/db/persistence/sqlite-github-dependency-repositories'),
]).then(([database, schema, adapter]) => ({
  database,
  schema,
  repositories: adapter.createSqliteGitHubDependencyRepositories(
    database.sqlite,
    database.default,
  ),
}));

describeGitHubDependencyRepositoriesContract(
  'SQLite',
  async (): Promise<GitHubDependencyHarness> => {
    const context = await contextPromise;
    const { default: db, sqlite } = context.database;
    const {
      connectorConfigs,
      githubIdentityControls,
      dependencyReconciliationSnapshots,
      taskDependencies,
      tasks,
    } = context.schema;

    sqlite.exec(`
      DELETE FROM dependency_reconciliation_candidates;
      DELETE FROM dependency_reconciliation_edges;
      DELETE FROM dependency_reconciliation_items;
      DELETE FROM dependency_reconciliation_snapshots;
      DELETE FROM task_dependencies;
      DELETE FROM github_identity_controls;
      DELETE FROM tasks;
      DELETE FROM connector_configs;
    `);

    const now = '2026-09-01T12:00:00.000Z';
    return {
      repositories: context.repositories,
      setIdentityEpoch: async (connectorInstanceId, revision) => {
        db.insert(githubIdentityControls).values({
          connectorInstanceId,
          modeRevision: revision,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: githubIdentityControls.connectorInstanceId,
          set: { modeRevision: revision, updatedAt: now },
        }).run();
      },
      seedConnectorConfig: async (connectorId) => {
        db.insert(connectorConfigs).values({
          id: connectorId,
          type: 'github-issues',
          name: 'Portable dependency connector',
          enabled: true,
          capabilities: {},
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing().run();
      },
      seedSnapshot: async (record) => {
        db.insert(dependencyReconciliationSnapshots).values(record).run();
      },
      seedTask: async (id, connectorInstanceId) => {
        db.insert(tasks).values({
          id,
          sourceId: `source:${id}`,
          connectorType: 'github-issues',
          connectorInstanceId,
          title: id,
          createdAt: now,
          updatedAt: now,
          lastSyncedAt: now,
        }).onConflictDoNothing().run();
      },
      seedDependency: async (row) => {
        db.insert(taskDependencies).values(row).run();
      },
      close: () => {
        sqlite.exec(`
          DELETE FROM dependency_reconciliation_candidates;
          DELETE FROM dependency_reconciliation_edges;
          DELETE FROM dependency_reconciliation_items;
          DELETE FROM dependency_reconciliation_snapshots;
          DELETE FROM task_dependencies;
          DELETE FROM github_identity_controls;
          DELETE FROM tasks;
          DELETE FROM connector_configs;
        `);
      },
    };
  },
);

afterAll(async () => {
  const context = await contextPromise;
  context.database.sqlite.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (previousPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = previousPath;
});
