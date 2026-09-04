import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from '@/lib/graph-workspace/repository';
import {
  describeIdeationWorkspaceRepositoryContract,
} from '../contracts/ideation-workspace-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

const document = createIdeationWorkspaceDocument([{
  id: 'root',
  label: 'PostgreSQL workspace',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {},
}]);

async function truncate(pool: Pool) {
  await pool.query('DELETE FROM graph_workspaces');
}

/**
 * One pool is shared by both suites in this file; the contract harness only
 * truncates between cases, and the root teardown closes it.
 */
let sharedPool: Pool | null = null;

async function getSharedPool(): Promise<Pool> {
  if (!sharedPool) {
    assertSafeIntegrationTestTarget(connectionString!);
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString });
  }
  return sharedPool;
}

afterAll(async () => {
  await sharedPool?.end();
  sharedPool = null;
});

// The shared contract runs against a live PostgreSQL adapter. It is registered
// only when an integration target is configured, mirroring `describe.skipIf`
// for a helper that owns its own `describe` block.
if (connectionString) {
  describeIdeationWorkspaceRepositoryContract('PostgreSQL', async () => {
    const pool = await getSharedPool();
    const { createPostgresIdeationWorkspaceRepository } = await import(
      '@/db/postgres/repositories/ideation-workspace-repository'
    );
    await truncate(pool);
    return {
      repository: createPostgresIdeationWorkspaceRepository(pool),
      close: () => truncate(pool),
    };
  });
}

describe.skipIf(!connectionString)('PostgreSQL ideation workspace adapter', () => {
  let pool: Pool;
  let repository: IdeationWorkspaceRepository;

  beforeAll(async () => {
    pool = await getSharedPool();
    const { createPostgresIdeationWorkspaceRepository } = await import(
      '@/db/postgres/repositories/ideation-workspace-repository'
    );
    repository = createPostgresIdeationWorkspaceRepository(pool);
    await truncate(pool);
  });

  afterEach(async () => {
    await truncate(pool);
  });

  afterAll(async () => {
    await truncate(pool);
  });

  it('lets exactly one of two concurrent saves win the compare-and-swap', async () => {
    await repository.create({
      id: 'workspace-race',
      name: 'Race',
      document,
      reason: 'created',
      now: '2026-01-01T00:00:00.000Z',
    });

    const save = (label: string) => repository.updateContent(
      'workspace-race',
      1,
      { ...document, nodes: [{ ...document.nodes[0], label }] },
      '2026-01-01T00:00:10.000Z',
    );
    const results = await Promise.allSettled([save('left'), save('right')]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason)
      .toBeInstanceOf(IdeationWorkspaceConflictError);

    const current = await repository.get('workspace-race');
    expect(current?.contentRevision).toBe(2);
    expect(['left', 'right']).toContain(current?.document.nodes[0]?.label);
  });

  it('rolls back a duplicate migration source without poisoning the pooled client', async () => {
    await repository.create({
      id: 'workspace-source-a',
      name: 'A',
      document,
      migrationSource: 'shared-source',
      reason: 'migrated',
      now: '2026-01-01T00:00:00.000Z',
    });

    await expect(repository.create({
      id: 'workspace-source-b',
      name: 'B',
      document,
      migrationSource: 'shared-source',
      reason: 'migrated',
      now: '2026-01-01T00:00:01.000Z',
    })).rejects.toThrow();

    // The aborted transaction must have been rolled back and its client
    // returned clean, so the very next query on the pool still succeeds.
    expect(await repository.get('workspace-source-b')).toBeNull();
    expect(await repository.findByMigrationSource('shared-source'))
      .toMatchObject({ id: 'workspace-source-a' });
    expect(await repository.list(false)).toHaveLength(1);
  });

  it('serializes concurrent restores behind the row lock', async () => {
    await repository.create({
      id: 'workspace-restore-race',
      name: 'Restore race',
      document,
      reason: 'created',
      now: '2026-01-01T00:00:00.000Z',
    });
    await repository.updateContent(
      'workspace-restore-race',
      1,
      { ...document, nodes: [{ ...document.nodes[0], label: 'Second' }] },
      '2026-01-01T00:00:01.000Z',
    );

    const restore = () => repository.restore(
      'workspace-restore-race',
      1,
      2,
      '2026-01-01T00:00:02.000Z',
    );
    const results = await Promise.allSettled([restore(), restore()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult)
      .reason).toBeInstanceOf(IdeationWorkspaceConflictError);
    expect((await repository.get('workspace-restore-race'))?.contentRevision).toBe(3);
  });

  it('round trips a jsonb document whose keys and numbers are normalized', async () => {
    const rich = createIdeationWorkspaceDocument([{
      id: 'root',
      label: 'Ünïcode … "quoted" \\ backslash',
      kind: 'idea',
      parentId: null,
      sortOrder: 0,
      properties: {
        zeta: { key: 'zeta', rawValue: '1', value: ['1'] },
        alpha: { key: 'alpha', rawValue: 'a, b', value: ['a', 'b'] },
      },
    }]);

    const created = await repository.create({
      id: 'workspace-jsonb',
      name: 'Jsonb',
      document: rich,
      reason: 'created',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(created.document).toEqual(rich);
    expect((await repository.get('workspace-jsonb'))?.document).toEqual(rich);
    expect((await repository.getVersion('workspace-jsonb', 1))?.document).toEqual(rich);
  });
});
