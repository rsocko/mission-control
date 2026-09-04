import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { createPostgresGitHubIdentityRepositories } from '@/db/postgres/repositories/github-identity-repositories';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const connectorA = `transfer-a-${randomUUID()}`;
const connectorB = `transfer-b-${randomUUID()}`;
const taskId = `transfer-task-${randomUUID()}`;
const conflictTaskId = `transfer-conflict-${randomUUID()}`;
const sourceListId = `transfer-list-${randomUUID()}`;
const rollbackSourceListId = `transfer-list-${randomUUID()}`;
const issueStableId = `I_transfer_${randomUUID()}`;
const repositoryStableId = `R_transfer_${randomUUID()}`;
const now = '2026-09-01T00:00:00.000Z';

const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-transfer-identity-test',
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

async function cleanup(): Promise<void> {
  if (!initialized) return;
  const pool = backend.context.pool;
  await pool.query(
    `DELETE FROM external_entity_bindings
     WHERE connector_instance_id = ANY($1::text[])`,
    [[connectorA, connectorB]],
  );
  await pool.query(
    `DELETE FROM external_entity_locators
     WHERE external_entity_id IN (
       SELECT id FROM external_entities WHERE stable_id = ANY($1::text[])
     )`,
    [[issueStableId, repositoryStableId]],
  );
  await pool.query(
    `DELETE FROM external_entities WHERE stable_id = ANY($1::text[])`,
    [[issueStableId, repositoryStableId]],
  );
  await pool.query(
    `DELETE FROM tasks WHERE id = ANY($1::text[])`,
    [[taskId, conflictTaskId]],
  );
  await pool.query(
    `DELETE FROM source_lists WHERE id = ANY($1::text[])`,
    [[sourceListId, rollbackSourceListId]],
  );
  await pool.query(
    `DELETE FROM connector_configs WHERE id = ANY($1::text[])`,
    [[connectorA, connectorB]],
  );
}

async function seed(): Promise<void> {
  const pool = backend.context.pool;
  for (const id of [connectorA, connectorB]) {
    await pool.query(
      `INSERT INTO connector_configs (
         id, type, name, enabled, capabilities, credentials, settings,
         synced_lists, created_at, updated_at
       ) VALUES (
         $1, 'github-issues', $1, true, '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '[]'::jsonb, $2, $2
       )`,
      [id, now],
    );
    await pool.query(
      `INSERT INTO github_identity_controls (
         connector_instance_id, mode_revision, updated_at
       ) VALUES ($1, 1, $2)`,
      [id, now],
    );
  }
  await pool.query(
    `INSERT INTO source_lists (
       id, connector_instance_id, source_id, name, type
     ) VALUES ($1, $2, 'octo/old', 'octo/old', 'repo')`,
    [sourceListId, connectorA],
  );
  await pool.query(
    `INSERT INTO source_lists (
       id, connector_instance_id, source_id, name, type
     ) VALUES ($1, $2, 'octo/wrong', 'octo/wrong', 'repo')`,
    [rollbackSourceListId, connectorB],
  );
  await pool.query(
    `INSERT INTO tasks (
       id, source_id, connector_type, connector_instance_id, title, status,
       local_disposition, priority, created_at, updated_at, metadata, sync_status
     ) VALUES (
       $1, 'octo/old#41', 'github', $2, 'Transfer me', 'todo',
       'active', 'medium', $3, $3, '{"preserved":true}'::jsonb, 'synced'
     )`,
    [taskId, connectorA, now],
  );
}

interface ConnectorLockControl {
  afterQueryStarted(connection: number, processId: number): void;
  afterLockAcquired(connection: number): Promise<void>;
}

function instrumentPool(
  pool: Pool,
  statements: string[],
  lockControl?: ConnectorLockControl,
): Pool {
  let connection = 0;
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          connection += 1;
          const connectionNumber = connection;
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === 'query') {
                return (query: unknown, ...args: unknown[]) => {
                  const text = typeof query === 'string'
                    ? query
                    : query && typeof query === 'object' && 'text' in query
                      ? String(query.text)
                      : '';
                  statements.push(text.replace(/\s+/g, ' ').trim());
                  const result = Reflect.apply(
                    clientTarget.query,
                    clientTarget,
                    [query, ...args],
                  );
                  if (
                    lockControl
                    && text.includes('pg_advisory_xact_lock(hashtextextended($1, 0))')
                    && !text.includes('unnest')
                  ) {
                    lockControl.afterQueryStarted(connectionNumber, clientTarget.processID);
                    return Promise.resolve(result).then(async (value) => {
                      await lockControl.afterLockAcquired(connectionNumber);
                      return value;
                    });
                  }
                  return result;
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

function repositoryEvidence() {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository' as const,
      stableId: repositoryStableId,
    },
    locator: {
      owner: 'space',
      repository: 'new-home',
      apiUrl: 'https://api.github.com/repos/space/new-home',
      webUrl: 'https://github.com/space/new-home',
    },
    observationSource: 'rest' as const,
    observedAt: now,
  };
}

function issueEvidence() {
  return {
    entity: {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'issue' as const,
        stableId: issueStableId,
      },
      locator: {
        owner: 'space',
        repository: 'new-home',
        issueNumber: 41,
        apiUrl: 'https://api.github.com/repos/space/new-home/issues/41',
        webUrl: 'https://github.com/space/new-home/issues/41',
      },
      observationSource: 'rest' as const,
      observedAt: now,
    },
    repository: repositoryEvidence(),
  };
}

function bridgeInput(connectorInstanceId = connectorA) {
  return {
    taskId,
    connectorInstanceId,
    sourceId: 'space/new-home:41',
    sourceListId: connectorInstanceId === connectorA ? 'octo/old' : 'octo/wrong',
    taskEvidence: issueEvidence(),
    sourceLists: [],
    reconcileTask: {
      sourceId: 'space/new-home:41',
      sourceListId: 'octo/old',
      sourceListName: 'octo/old',
      title: 'Transferred title',
      description: null,
      status: 'done',
      statusReason: 'completed',
      priority: 'medium',
      effort: null,
      microStatus: null,
      assignee: 'octocat',
      updatedAt: '2026-09-01T01:00:00.000Z',
      completedAt: '2026-09-01T00:55:00.000Z',
      metadata: { refreshed: true },
    },
    observedAt: now,
  } as const;
}

function transferRefresh(connectorInstanceId = connectorA) {
  return {
    task: {
      id: 'remote-placeholder',
      sourceId: 'space/new-home:41',
      connectorType: 'github-issues',
      connectorInstanceId,
      title: 'Transferred title',
      status: 'done' as const,
      statusReason: 'completed' as const,
      priority: 'medium' as const,
      createdAt: now,
      updatedAt: '2026-09-01T01:00:00.000Z',
      completedAt: '2026-09-01T00:55:00.000Z',
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'octo/old',
      sourceListName: 'octo/old',
      hubProjectIds: [],
      tags: [],
      assignee: 'octocat',
      metadata: { refreshed: true },
      externalIdentity: issueEvidence(),
      syncStatus: 'synced' as const,
      lastSyncedAt: now,
    },
    sourceLists: [],
  };
}

describePostgres('transfer identity bridge (PostgreSQL)', () => {
  beforeEach(async () => {
    await initialize();
    await cleanup();
    await seed();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/db');
    vi.doUnmock('@/lib/external-identities/worker-persistence');
  });

  afterAll(async () => {
    if (initialized) {
      await cleanup();
      await backend.shutdown();
      initialized = false;
    }
  });

  it('uses PostgreSQL with SQLite poisoned and commits task plus identity atomically', async () => {
    const statements: string[] = [];
    const pool = instrumentPool(backend.context.pool, statements);
    const repository = createPostgresGitHubIdentityRepositories(pool).transferIdentity;
    vi.doMock('@/db', () => {
      throw new Error('SQLite access is poisoned in this PostgreSQL test');
    });
    vi.doMock('@/lib/external-identities/worker-persistence', () => ({
      getGitHubTransferIdentityRepository: async () => repository,
    }));

    const { reconcileTransferIdentity } = await import(
      '@/lib/connectors/transfer-identity'
    );
    await reconcileTransferIdentity(taskId, connectorA, transferRefresh());

    const task = await backend.context.pool.query<{
      source_id: string;
      title: string;
      status: string;
    }>(
      `SELECT source_id, title, status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(task.rows[0]).toEqual({
      source_id: 'space/new-home:41',
      title: 'Transferred title',
      status: 'done',
    });

    const bindings = await backend.context.pool.query<{
      stable_id: string;
      binding_type: string;
      local_id: string;
    }>(
      `SELECT e.stable_id, b.binding_type, b.local_id
       FROM external_entity_bindings b
       JOIN external_entities e ON e.id = b.external_entity_id
       WHERE b.connector_instance_id = $1
       ORDER BY e.stable_id`,
      [connectorA],
    );
    expect(bindings.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stable_id: issueStableId,
        binding_type: 'task',
        local_id: taskId,
      }),
      expect.objectContaining({
        stable_id: repositoryStableId,
        binding_type: 'source_list',
        local_id: sourceListId,
      }),
    ]));
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('COMMIT');
    expect(statements.some((statement) => (
      statement.includes('pg_advisory_xact_lock')
      && statement.includes('array_position')
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.toLowerCase().includes('from "tasks"')
      && statement.toLowerCase().includes('for update')
    ))).toBe(true);
    expect(statements.some((statement) => (
      statement.toLowerCase().includes('from "source_lists"')
      && statement.toLowerCase().includes('for share')
    ))).toBe(true);
  });

  it('rolls back task, source-list binding, and entity rows on a late task failure', async () => {
    const repository = createPostgresGitHubIdentityRepositories(
      backend.context.pool,
    ).transferIdentity;
    await backend.context.pool.query(
      `INSERT INTO tasks (
         id, source_id, connector_type, connector_instance_id, title, status,
         local_disposition, priority, created_at, updated_at, metadata, sync_status
       ) VALUES (
         $1, 'space/new-home:41', 'github', $2, 'Conflicting task', 'todo',
         'active', 'medium', $3, $3, '{}'::jsonb, 'synced'
       )`,
      [conflictTaskId, connectorA, now],
    );

    await expect(repository.persist(bridgeInput())).rejects.toThrow();

    const task = await backend.context.pool.query<{
      source_id: string;
      title: string;
    }>('SELECT source_id, title FROM tasks WHERE id = $1', [taskId]);
    expect(task.rows[0]).toEqual({
      source_id: 'octo/old#41',
      title: 'Transfer me',
    });
    const identities = await backend.context.pool.query(
      `SELECT id FROM external_entities WHERE stable_id = ANY($1::text[])`,
      [[issueStableId, repositoryStableId]],
    );
    expect(identities.rows).toEqual([]);
    const bindings = await backend.context.pool.query(
      `SELECT id FROM external_entity_bindings
       WHERE local_id = ANY($1::text[])`,
      [[taskId, sourceListId]],
    );
    expect(bindings.rows).toEqual([]);
  });

  it('serializes concurrent retries behind deterministic connector and identity locks', async () => {
    const statements: string[] = [];
    let markFirstLocked: (() => void) | undefined;
    let markSecondAttempted: ((processId: number) => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstLocked = new Promise<void>((resolve) => {
      markFirstLocked = resolve;
    });
    const secondAttempted = new Promise<number>((resolve) => {
      markSecondAttempted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pool = instrumentPool(backend.context.pool, statements, {
      afterQueryStarted(connection, processId) {
        if (connection === 2) markSecondAttempted?.(processId);
      },
      async afterLockAcquired(connection) {
        if (connection !== 1) return;
        markFirstLocked?.();
        await firstRelease;
      },
    });
    const repository = createPostgresGitHubIdentityRepositories(pool).transferIdentity;

    const first = repository.persist(bridgeInput());
    await firstLocked;
    const second = repository.persist(bridgeInput());
    const secondProcessId = await secondAttempted;

    try {
      let waiting = false;
      for (let attempt = 0; attempt < 20 && !waiting; attempt += 1) {
        const result = await backend.context.pool.query<{ waiting: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',
          [secondProcessId],
        );
        waiting = result.rows[0]?.waiting ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      releaseFirst?.();
    }

    expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
    expect(statements.filter((statement) => statement === 'BEGIN')).toHaveLength(2);
    expect(statements.filter((statement) => statement === 'COMMIT')).toHaveLength(2);
    expect(statements.filter((statement) => (
      statement.includes('pg_advisory_xact_lock')
      && statement.includes('array_position')
    ))).toHaveLength(2);
    expect(statements.some((statement) => statement === 'ROLLBACK')).toBe(false);
  });
});

describe.skipIf(Boolean(connectionString))('transfer identity bridge (PostgreSQL)', () => {
  it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
});
