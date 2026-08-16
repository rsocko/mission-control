import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('FTS authoritative filters', () => {
  let searchFTS: typeof import('@/lib/search/fts').searchFTS;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [database, schema, fts] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/search/fts'),
    ]);
    const timestamp = '2030-01-01T00:00:00.000Z';
    const makeTask = (
      id: string,
      sourceListName: string,
      status: string,
    ) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Quarterly planning',
      status,
      priority: 'none',
      sourceListName,
      metadata: {},
      syncStatus: 'synced' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSyncedAt: timestamp,
    });

    await database.default.insert(schema.tasks).values([
      ...Array.from({ length: 55 }, (_, index) => (
        makeTask(`irrelevant-${index}`, 'Other project', 'todo')
      )),
      makeTask('filtered-match', 'Project Alpha', 'in_progress'),
      makeTask('completed-match', 'Project Alpha', 'done'),
    ]);

    searchFTS = fts.searchFTS;
  });

  it('applies task filters before the result limit', async () => {
    const results = await searchFTS('Quarterly planning', {
      type: 'tasks',
      source: 'Project Alpha',
      status: 'in_progress',
      excludeDone: true,
      limit: 5,
    });

    expect(results.map((result) => result.id)).toEqual(['filtered-match']);
  });
});
