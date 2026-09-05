import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { RoutinesRepository } from '@/db/persistence/routines';
import {
  describeRoutinesRepositoryContract,
  ROUTINES_NOW,
  type RoutinesContractHarness,
} from '../contracts/routines-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL routines adapter', () => {
  let pool: Pool;
  let repository: RoutinesRepository;
  let harness: RoutinesContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresRoutinesRepository }] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/routines-repository'),
    ]);
    pool = new Pool({ connectionString, max: 8 });
    repository = createPostgresRoutinesRepository(pool);
    harness = {
      repository,
      async reset() {
        await pool.query('DELETE FROM routine_completions; DELETE FROM routines;');
      },
    };
  });

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeRoutinesRepositoryContract('PostgreSQL', () => harness);

  it('allocates unique stable sort orders under concurrent creates', async () => {
    await harness.reset();

    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      repository.createRoutine({
        id: `routine-sort-${index}`,
        name: `Routine ${index}`,
        description: null,
        cadenceType: 'daily',
        cadenceConfig: {},
        icon: null,
        createdAt: ROUTINES_NOW,
        updatedAt: ROUTINES_NOW,
      })
    )));

    const routines = await repository.listRoutines(true);
    expect(routines.map(({ sortOrder }) => sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('allows exactly one same-day daily completion under concurrency', async () => {
    await harness.reset();
    await repository.createRoutine({
      id: 'routine-concurrent',
      name: 'Concurrent',
      description: null,
      cadenceType: 'daily',
      cadenceConfig: {},
      icon: null,
      createdAt: ROUTINES_NOW,
      updatedAt: ROUTINES_NOW,
    });

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      repository.createCompletion({
        id: `completion-concurrent-${index}`,
        routineId: 'routine-concurrent',
        date: '2026-09-05',
        notes: null,
        completedAt: ROUTINES_NOW,
      })
    )));
    expect(results.filter(({ outcome }) => outcome === 'created')).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === 'duplicate')).toHaveLength(7);
    await expect(repository.listCompletions({
      fromInclusive: '2026-09-05',
      toInclusive: '2026-09-05',
      routineId: 'routine-concurrent',
      order: 'unspecified',
    })).resolves.toHaveLength(1);
  });
});
