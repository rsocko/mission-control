import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { IConnector } from '@/lib/connectors';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { SourceList, TaskItem } from '@/types';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());

vi.mock('@/db', () => {
  const rejectSqliteAccess = () => {
    sqliteTouch();
    throw new Error('SQLite must not be touched by PostgreSQL GitHub execution');
  };
  return {
    get default() {
      return rejectSqliteAccess();
    },
    get db() {
      return rejectSqliteAccess();
    },
    get sqlite() {
      return rejectSqliteAccess();
    },
    get runTransaction() {
      return rejectSqliteAccess();
    },
    get schema() {
      return rejectSqliteAccess();
    },
    get initializeDatabase() {
      return rejectSqliteAccess();
    },
    get withoutDatabaseObservation() {
      return rejectSqliteAccess();
    },
  };
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;
const ORIGINAL_POSTGRES_URL = process.env.MC_POSTGRES_URL;
const ORIGINAL_SSL_MODE = process.env.MC_POSTGRES_SSL_MODE;
const NOW = '2026-09-02T12:00:00.000Z';

let pool: Pool;
let shutdownRuntimeDatabase: (() => Promise<void>) | undefined;
let SyncExecutionPipeline: typeof import('@/lib/sync')['SyncExecutionPipeline'];
const connectorIds = new Set<string>();
const stableIds = new Set<string>();

function evidence(
  entityType: 'repository' | 'issue',
  stableId: string,
  repository: string,
  issueNumber?: number,
): ExternalIdentityEvidence['entity'] {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType,
      stableId,
    },
    locator: {
      owner: 'synthetic-owner',
      repository,
      ...(issueNumber === undefined ? {} : { issueNumber }),
    },
    observationSource: 'graphql',
    observedAt: NOW,
  };
}

function sourceList(
  connectorId: string,
  repositoryEvidence: ExternalIdentityEvidence['entity'],
  sourceId = `${repositoryEvidence.locator.owner}/${repositoryEvidence.locator.repository}`,
): SourceList {
  return {
    id: `${connectorId}:repo:${sourceId}`,
    connectorInstanceId: connectorId,
    sourceId,
    name: sourceId,
    type: 'repo',
    taskCount: 1,
    lastSyncedAt: NOW,
    externalIdentity: { entity: repositoryEvidence },
  };
}

function task(
  connectorId: string,
  issueNumber: number,
  issueEvidence: ExternalIdentityEvidence['entity'],
  repositoryEvidence: ExternalIdentityEvidence['entity'],
): TaskItem {
  const repositorySourceId =
    `${repositoryEvidence.locator.owner}/${repositoryEvidence.locator.repository}`;
  return {
    id: `${connectorId}:remote:${issueNumber}`,
    sourceId: `${repositorySourceId}:${issueNumber}`,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: `Synthetic issue ${issueNumber}`,
    status: 'todo',
    priority: 'none',
    createdAt: NOW,
    updatedAt: NOW,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: repositorySourceId,
    sourceListName: repositorySourceId,
    hubProjectIds: [],
    tags: [],
    metadata: {},
    externalIdentity: {
      entity: issueEvidence,
      repository: repositoryEvidence,
    },
    syncStatus: 'synced',
    lastSyncedAt: NOW,
  };
}

function connector(input: {
  connectorId: string;
  sourceLists: SourceList[];
  tasks: TaskItem[];
  beforeSourceLists?: () => Promise<void>;
}): IConnector {
  return {
    id: input.connectorId,
    type: 'github-issues',
    displayName: 'Inert synthetic GitHub',
    icon: 'github',
    capabilities: {
      read: true,
      write: true,
      delete: true,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: true,
      dependencyRead: false,
      dependencyWrite: false,
    },
    async initialize() {},
    async testConnection() {
      return { success: true, message: 'inert' };
    },
    async dispose() {},
    async fetchNotifications() {
      return [];
    },
    async fetchSourceLists() {
      await input.beforeSourceLists?.();
      return input.sourceLists;
    },
    async *fetchTasks() {
      yield input.tasks;
    },
    async getLastSyncToken() {
      return null;
    },
  };
}

async function seedConnector(connectorId: string): Promise<void> {
  connectorIds.add(connectorId);
  await pool.query(
    `
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings,
        synced_lists, created_at, updated_at
      ) VALUES (
        $1, 'github-issues', 'Inert synthetic GitHub', true, $2::jsonb,
        '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $3, $3
      )
    `,
    [
      connectorId,
      JSON.stringify({
        read: true,
        write: true,
        delete: true,
        sync: true,
        subtasks: true,
        lists: true,
        tags: true,
        tagWriteBack: true,
        dependencyRead: false,
        dependencyWrite: false,
      }),
      NOW,
    ],
  );
  await pool.query(
    `
      INSERT INTO github_identity_controls (
        connector_instance_id, mode_revision, updated_at
      ) VALUES ($1, 1, $2)
    `,
    [connectorId, NOW],
  );
}

async function runPipeline(
  connectorId: string,
  inertConnector: IConnector,
): Promise<Awaited<ReturnType<InstanceType<
  typeof SyncExecutionPipeline
>['runSyncLocally']>>> {
  const pipeline = new SyncExecutionPipeline();
  const internal = pipeline as unknown as {
    initializeConnectorFromDb: (id: string) => Promise<IConnector | null>;
  };
  internal.initializeConnectorFromDb = vi.fn(async () => inertConnector);
  return pipeline.runSyncLocally(connectorId, { full: true });
}

async function cleanupConnector(connectorId: string): Promise<void> {
  await pool.query(
    'DELETE FROM github_identity_collisions WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query(
    'DELETE FROM external_entity_bindings WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query(
    'DELETE FROM task_dependencies WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query(
    'DELETE FROM task_linked_sources WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM source_lists WHERE connector_instance_id = $1', [connectorId]);
  await pool.query('DELETE FROM sync_log WHERE connector_id = $1', [connectorId]);
  await pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [connectorId]);
  await pool.query(
    'DELETE FROM github_identity_controls WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query(
    'DELETE FROM github_identity_migrations WHERE connector_instance_id = $1',
    [connectorId],
  );
  await pool.query('DELETE FROM connector_configs WHERE id = $1', [connectorId]);
}

describePostgres('PostgreSQL GitHub SyncExecutionPipeline identity persistence', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString;
    process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString!).searchParams.get('sslmode')
      ?? 'disable';
    const runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    pool = runtime.getPostgresPersistenceBackend().context.pool;
    shutdownRuntimeDatabase = runtime.shutdownRuntimeDatabase;
    ({ SyncExecutionPipeline } = await import('@/lib/sync'));
  }, 120_000);

  beforeEach(() => {
    sqliteTouch.mockClear();
  });

  afterEach(async () => {
    for (const connectorId of connectorIds) {
      await cleanupConnector(connectorId);
    }
    connectorIds.clear();
    if (stableIds.size > 0) {
      await pool.query(
        `
          DELETE FROM external_entity_locators
          WHERE external_entity_id IN (
            SELECT id FROM external_entities WHERE stable_id = ANY($1::text[])
          )
          OR repository_entity_id IN (
            SELECT id FROM external_entities WHERE stable_id = ANY($1::text[])
          )
        `,
        [[...stableIds]],
      );
      await pool.query(
        'DELETE FROM external_entities WHERE stable_id = ANY($1::text[])',
        [[...stableIds]],
      );
    }
    stableIds.clear();
  });

  it('persists source-list and task NodeID bindings without SQLite runtime access', async () => {
    const connectorId = `gh-pipeline-${randomUUID()}`;
    const repositoryStableId = `R_kgSYNTHETIC_${randomUUID()}`;
    const issueStableId = `I_kwSYNTHETIC_${randomUUID()}`;
    stableIds.add(repositoryStableId);
    stableIds.add(issueStableId);
    await seedConnector(connectorId);
    const repositoryName = `repo-${connectorId}`;
    const repositoryEvidence = evidence('repository', repositoryStableId, repositoryName);
    const issueEvidence = evidence('issue', issueStableId, repositoryName, 41);
    const inertConnector = connector({
      connectorId,
      sourceLists: [sourceList(connectorId, repositoryEvidence)],
      tasks: [task(connectorId, 41, issueEvidence, repositoryEvidence)],
    });

    const result = await runPipeline(connectorId, inertConnector);

    expect(result).toMatchObject({ success: true, tasksAdded: 1 });
    const bindings = await pool.query<{
      bindingType: string;
      localId: string;
      stableId: string;
      state: string;
    }>(
      `
        SELECT binding.binding_type AS "bindingType",
               binding.local_id AS "localId",
               entity.stable_id AS "stableId",
               binding.state
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        WHERE binding.connector_instance_id = $1
        ORDER BY binding.binding_type
      `,
      [connectorId],
    );
    const localTask = await pool.query<{ id: string }>(
      'SELECT id FROM tasks WHERE connector_instance_id = $1 AND source_id = $2',
      [connectorId, `synthetic-owner/${repositoryName}:41`],
    );
    expect(bindings.rows).toEqual([
      {
        bindingType: 'source_list',
        localId: `${connectorId}:repo:synthetic-owner/${repositoryName}`,
        stableId: repositoryStableId,
        state: 'active',
      },
      {
        bindingType: 'task',
        localId: localTask.rows[0].id,
        stableId: issueStableId,
        state: 'active',
      },
    ]);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('fails the run and preserves first ownership when duplicate evidence collides', async () => {
    const connectorId = `gh-pipeline-${randomUUID()}`;
    const repositoryStableId = `R_kgSYNTHETIC_${randomUUID()}`;
    const issueStableId = `I_kwSYNTHETIC_${randomUUID()}`;
    stableIds.add(repositoryStableId);
    stableIds.add(issueStableId);
    await seedConnector(connectorId);
    const repositoryName = `repo-${connectorId}`;
    const repositoryEvidence = evidence('repository', repositoryStableId, repositoryName);
    const firstEvidence = evidence('issue', issueStableId, repositoryName, 51);
    const secondEvidence = evidence('issue', issueStableId, repositoryName, 52);
    const inertConnector = connector({
      connectorId,
      sourceLists: [sourceList(connectorId, repositoryEvidence)],
      tasks: [
        task(connectorId, 51, firstEvidence, repositoryEvidence),
        task(connectorId, 52, secondEvidence, repositoryEvidence),
      ],
    });

    const result = await runPipeline(connectorId, inertConnector);

    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/identity persistence failed/i);
    const owner = await pool.query<{ sourceId: string; state: string }>(
      `
        SELECT task.source_id AS "sourceId", binding.state
        FROM external_entity_bindings AS binding
        JOIN external_entities AS entity ON entity.id = binding.external_entity_id
        JOIN tasks AS task ON task.id = binding.local_id
        WHERE binding.connector_instance_id = $1
          AND binding.binding_type = 'task'
          AND entity.stable_id = $2
      `,
      [connectorId, issueStableId],
    );
    expect(owner.rows).toEqual([{
      sourceId: `synthetic-owner/${repositoryName}:51`,
      state: 'collision',
    }]);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('keeps a persisted source-list collision fail-closed on retry', async () => {
    const connectorId = `gh-pipeline-${randomUUID()}`;
    const repositoryStableId = `R_kgSYNTHETIC_${randomUUID()}`;
    stableIds.add(repositoryStableId);
    await seedConnector(connectorId);
    const repositoryName = `repo-${connectorId}`;
    const repositoryEvidence = evidence('repository', repositoryStableId, repositoryName);
    const sourceLists = [
      sourceList(connectorId, repositoryEvidence),
      sourceList(connectorId, repositoryEvidence, `synthetic-owner/${repositoryName}-alias`),
    ];
    await pool.query(
      `
        INSERT INTO source_lists (id, connector_instance_id, source_id, name, type)
        VALUES
          ($1, $3, $2, $2, 'repo'),
          ($4, $3, $5, $5, 'repo')
      `,
      [
        sourceLists[0].id,
        sourceLists[0].sourceId,
        connectorId,
        sourceLists[1].id,
        sourceLists[1].sourceId,
      ],
    );
    const { persistGitHubPrimaryIdentityBatch } = await import(
      '@/lib/external-identities/primary-identity'
    );
    await persistGitHubPrimaryIdentityBatch(
      sourceLists.map((list) => ({
        target: {
          connectorInstanceId: connectorId,
          bindingType: 'source_list' as const,
          localId: list.id,
          legacyIdentity: list.sourceId,
        },
        evidence: { entity: repositoryEvidence },
      })),
      {
        connectorInstanceId: connectorId,
        effectiveMode: 'stable',
        modeRevision: 1,
        capturedAt: NOW,
      },
    );
    const inertConnector = connector({
      connectorId,
      sourceLists,
      tasks: [],
    });

    const persistedCollisions = await pool.query<{ state: string }>(
      `
        SELECT state
        FROM github_identity_collisions
        WHERE connector_instance_id = $1
          AND binding_type = 'source_list'
      `,
      [connectorId],
    );
    const first = await runPipeline(connectorId, inertConnector);
    const retry = await runPipeline(connectorId, inertConnector);

    expect(persistedCollisions.rows.length).toBeGreaterThan(0);
    expect(persistedCollisions.rows.every(({ state }) => state === 'open')).toBe(true);
    expect(first.success).toBe(false);
    expect(retry.success).toBe(false);
    const syncRuns = await pool.query<{ success: boolean }>(
      `
        SELECT success
        FROM sync_log
        WHERE connector_id = $1
        ORDER BY synced_at
      `,
      [connectorId],
    );
    expect(syncRuns.rows).toEqual([{ success: false }, { success: false }]);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('does not publish success or bind evidence after identity epoch ownership changes', async () => {
    const connectorId = `gh-pipeline-${randomUUID()}`;
    const repositoryStableId = `R_kgSYNTHETIC_${randomUUID()}`;
    stableIds.add(repositoryStableId);
    await seedConnector(connectorId);
    const repositoryName = `repo-${connectorId}`;
    const repositoryEvidence = evidence('repository', repositoryStableId, repositoryName);
    const inertConnector = connector({
      connectorId,
      sourceLists: [sourceList(connectorId, repositoryEvidence)],
      tasks: [],
      beforeSourceLists: async () => {
        await pool.query(
          `
            UPDATE github_identity_controls
            SET mode_revision = mode_revision + 1, updated_at = $2
            WHERE connector_instance_id = $1
          `,
          [connectorId, new Date(Date.parse(NOW) + 1_000).toISOString()],
        );
      },
    });

    const result = await runPipeline(connectorId, inertConnector);

    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/identity runtime revision is stale/i);
    const bindings = await pool.query(
      'SELECT id FROM external_entity_bindings WHERE connector_instance_id = $1',
      [connectorId],
    );
    expect(bindings.rows).toEqual([]);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await shutdownRuntimeDatabase?.();
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
  if (ORIGINAL_POSTGRES_URL === undefined) delete process.env.MC_POSTGRES_URL;
  else process.env.MC_POSTGRES_URL = ORIGINAL_POSTGRES_URL;
  if (ORIGINAL_SSL_MODE === undefined) delete process.env.MC_POSTGRES_SSL_MODE;
  else process.env.MC_POSTGRES_SSL_MODE = ORIGINAL_SSL_MODE;
});
