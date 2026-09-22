import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeGitHubIdentityRepositoriesContract,
  GITHUB_IDENTITY_CONTRACT,
  type GitHubIdentityHarness,
} from '../contracts/github-identity-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `github-identity-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/schema'),
  import('@/db/persistence/sqlite-github-identity-repositories'),
]).then(([database, schema, adapter]) => ({
  database,
  schema,
  repositories: adapter.createSqliteGitHubIdentityRepositories(
    database.sqlite,
    database.default,
  ),
}));

const {
  connectorInstanceId,
  taskId,
  sourceListId,
  sourceId,
  taskVersion,
  pushLeaseToken,
  modeRevision,
} = GITHUB_IDENTITY_CONTRACT;

describeGitHubIdentityRepositoriesContract('SQLite', async (): Promise<GitHubIdentityHarness> => {
  const context = await contextPromise;
  const { sqlite } = context.database;
  const db = context.database.default;
  const schema = context.schema;

  sqlite.exec(`
    DELETE FROM github_identity_exception_events;
    DELETE FROM task_source_write_lease_targets;
    DELETE FROM task_source_write_leases;
    DELETE FROM github_identity_write_cycles;
    DELETE FROM external_entity_bindings;
    DELETE FROM external_entity_locators;
    DELETE FROM external_entities;
    DELETE FROM github_identity_controls;
    DELETE FROM github_identity_migrations;
    DELETE FROM task_linked_sources;
    DELETE FROM tasks;
    DELETE FROM source_lists;
    DELETE FROM connector_configs;
  `);

  return {
    repositories: context.repositories,
    seedConnector: async (id, now) => {
      db.insert(schema.connectorConfigs).values({
        id,
        type: 'github-issues',
        name: 'GitHub',
        capabilities: {},
        credentials: {},
        settings: {},
        syncedLists: [],
        createdAt: now,
        updatedAt: now,
      }).run();
    },
    seedBaseline: async (now) => {
      db.insert(schema.connectorConfigs).values({
        id: connectorInstanceId,
        type: 'github-issues',
        name: 'GitHub',
        capabilities: {},
        credentials: {},
        settings: {},
        syncedLists: [],
        createdAt: now,
        updatedAt: now,
      }).run();
      db.insert(schema.githubIdentityMigrations).values({
        connectorInstanceId,
        phase: 'complete',
        updatedAt: now,
      }).run();
      db.insert(schema.githubIdentityControls).values({
        connectorInstanceId,
        modeRevision,
        updatedAt: now,
      }).run();
      db.insert(schema.sourceLists).values({
        id: sourceListId,
        connectorInstanceId,
        sourceId: 'owner/repo',
        name: 'owner/repo',
        type: 'repo',
      }).run();
      db.insert(schema.tasks).values({
        id: taskId,
        connectorType: 'github-issues',
        connectorInstanceId,
        sourceId,
        sourceListId,
        title: 'Fence me',
        status: 'todo',
        priority: 'normal',
        metadata: {},
        syncStatus: 'pushing',
        createdAt: now,
        updatedAt: taskVersion,
        lastSyncedAt: pushLeaseToken,
      }).run();
      db.insert(schema.externalEntities).values([
        {
          id: 'repo-entity',
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'repository',
          stableId: 'R_repo',
          firstSeenAt: now,
          lastSeenAt: now,
          // A locator at revision 1 is seeded below, so the next revision must be 2.
          nextLocatorRevision: 2,
        },
        {
          id: 'issue-entity',
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: 'I_issue',
          firstSeenAt: now,
          lastSeenAt: now,
          // A locator at revision 1 is seeded below, so the next revision must be 2.
          nextLocatorRevision: 2,
        },
      ]).run();
      db.insert(schema.externalEntityLocators).values([
        {
          id: 'repo-locator',
          externalEntityId: 'repo-entity',
          provider: 'github',
          hostKey: 'github.com',
          owner: 'owner',
          repository: 'repo',
          ownerKey: 'owner',
          repositoryKey: 'repo',
          validFrom: now,
          lastSeenAt: now,
          observationSource: 'rest',
          locatorRevision: 1,
        },
        {
          id: 'issue-locator',
          externalEntityId: 'issue-entity',
          repositoryEntityId: 'repo-entity',
          provider: 'github',
          hostKey: 'github.com',
          owner: 'owner',
          repository: 'repo',
          ownerKey: 'owner',
          repositoryKey: 'repo',
          issueNumber: 7,
          validFrom: now,
          lastSeenAt: now,
          observationSource: 'rest',
          locatorRevision: 1,
        },
      ]).run();
      db.insert(schema.externalEntityBindings).values([
        {
          id: 'repo-binding',
          externalEntityId: 'repo-entity',
          connectorInstanceId,
          bindingType: 'source_list',
          localId: sourceListId,
          state: 'active',
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'issue-binding',
          externalEntityId: 'issue-entity',
          connectorInstanceId,
          bindingType: 'task',
          localId: taskId,
          state: 'active',
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ]).run();
      db.insert(schema.taskLinkedSources).values({
        id: GITHUB_IDENTITY_CONTRACT.linkedSourceId,
        taskId,
        connectorType: 'github-issues',
        connectorInstanceId,
        sourceId,
        title: 'Fence me',
        linkedAt: now,
      }).run();
    },
    seedTerminalException: async (now) => {
      db.insert(schema.githubIdentityExceptionEvents).values({
        connectorInstanceId,
        bindingType: 'task',
        localId: taskId,
        category: 'terminal_inaccessible',
        action: 'accept',
        idempotencyKey: `exception:${taskId}:accept`,
        actor: 'operator',
        reason: 'accepted terminal inaccessible identity',
        proofType: 'stage1_inaccessible',
        createdAt: now,
      }).run();
    },
    leaseState: async (leaseId) => {
      const row = sqlite.prepare(`
        SELECT state, mode_revision AS modeRevision, dispatched_at AS dispatchedAt
        FROM task_source_write_leases
        WHERE id = ?
      `).get(leaseId) as
        | { state: string; modeRevision: number; dispatchedAt: string | null }
        | undefined;
      return row ?? null;
    },
    writeCycleState: async (cycleId) => {
      const row = sqlite.prepare(`
        SELECT state FROM github_identity_write_cycles WHERE id = ?
      `).get(cycleId) as { state: string } | undefined;
      return row ? row.state : null;
    },
    primaryBinding: async ({ connectorInstanceId, bindingType, localId }) => {
      const row = sqlite.prepare(`
        SELECT entity.stable_id AS stableId, binding.state,
          binding.verified_at AS verifiedAt
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        WHERE binding.connector_instance_id = ?
          AND binding.binding_type = ?
          AND binding.local_id = ?
        LIMIT 1
      `).get(connectorInstanceId, bindingType, localId) as
        | { stableId: string; state: string; verifiedAt: string | null }
        | undefined;
      return row ?? null;
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
