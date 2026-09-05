import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresHoustonMemoryRepository } from '@/db/postgres/repositories/houston-memory-repository';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const prefix = `houston-memory-${randomUUID()}-`;

describePostgres('PostgreSQL Houston memory repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-houston-memory-test',
          }),
        }
      : {}),
  });
  let repository: PostgresHoustonMemoryRepository;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    await backend.initialize();
    repository = new PostgresHoustonMemoryRepository(backend.context.db);
  }, 120_000);

  afterEach(async () => {
    await backend.context.pool.query(
      'DELETE FROM houston_conversation_memories WHERE id LIKE $1',
      [`${prefix}%`],
    );
  });

  afterAll(async () => {
    await backend.shutdown();
  });

  function write(id: string, now: string) {
    return {
      id: `${prefix}${id}`,
      authorizationScope: 'installation',
      title: `Title ${id}`,
      summary: `Summary ${id}`,
      decisions: ['Use the PostgreSQL adapter'],
      commitments: ['Verify parity'],
      topics: ['postgres'],
      linkedEntities: [{ type: 'project' as const, id: 'project-1', label: 'Project' }],
      sensitivity: 'restricted' as const,
      retainUntil: '2026-12-01T00:00:00.000Z',
      now,
    };
  }

  it('preserves authorization, stable ordering, and bounded expiry deletion', async () => {
    await repository.upsert(write('b', '2026-09-04T12:00:00.000Z'));
    await repository.upsert(write('a', '2026-09-04T12:00:00.000Z'));
    await repository.upsert({
      ...write('expired', '2026-09-03T12:00:00.000Z'),
      retainUntil: '2026-09-04T00:00:00.000Z',
    });

    await expect(repository.list({
      authorizationScope: 'other',
      limit: 20,
      now: '2026-09-05T00:00:00.000Z',
    })).resolves.toEqual([]);
    const listed = await repository.list({
      authorizationScope: 'installation',
      limit: 20,
      now: '2026-09-05T00:00:00.000Z',
    });
    expect(listed.map(({ id }) => id)).toEqual([`${prefix}a`, `${prefix}b`]);
    await expect(repository.deleteExpired('2026-09-05T00:00:00.000Z', 1))
      .resolves.toEqual([`${prefix}expired`]);
  });

  it('keeps exclusion sticky across a concurrent recapture and redacts deletion', async () => {
    const original = write('sticky', '2026-09-04T12:00:00.000Z');
    await repository.upsert(original);
    await Promise.all([
      repository.exclude(
        original.id,
        original.authorizationScope,
        '2026-09-04T12:01:00.000Z',
      ),
      repository.upsert({
        ...original,
        summary: 'Concurrent replacement',
        now: '2026-09-04T12:02:00.000Z',
      }),
    ]);

    const excluded = await repository.get(original.id, original.authorizationScope);
    expect(excluded?.excludedAt).not.toBeNull();
    await expect(repository.list({
      authorizationScope: original.authorizationScope,
      limit: 20,
      now: '2026-09-04T12:03:00.000Z',
    })).resolves.toEqual([]);

    await expect(repository.delete(original.id, original.authorizationScope))
      .resolves.toBe(true);
    await expect(repository.get(original.id, original.authorizationScope))
      .resolves.toMatchObject({
        title: '',
        summary: '',
        decisions: [],
        commitments: [],
        topics: [],
        linkedEntities: [],
      });
  });
});
