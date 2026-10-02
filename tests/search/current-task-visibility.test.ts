import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('SQLite keyword search current-task visibility', () => {
  let search: typeof import('@/lib/search/fts');
  let sqlite: typeof import('@/db').sqlite;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [database, schema, fts] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/search/fts'),
    ]);
    sqlite = database.sqlite;
    search = fts;

    const now = '2030-01-01T00:00:00.000Z';
    await database.default.insert(schema.connectorConfigs).values([
      {
        id: 'search-live',
        type: 'github-issues',
        name: 'Live search connector',
        enabled: true,
        capabilities: {},
        credentials: {},
        settings: {},
        syncedLists: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'search-deleted',
        type: 'github-issues',
        name: 'Deleted search connector',
        enabled: false,
        capabilities: {},
        credentials: {},
        settings: {},
        syncedLists: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ]);
    await database.default.insert(schema.tasks).values([
      {
        id: 'search-visible',
        sourceId: 'owner:deleted:42',
        connectorType: 'github-issues',
        connectorInstanceId: 'search-live',
        title: 'Visibility marker current',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'search-deleted-task',
        sourceId: 'owner:handled:42',
        connectorType: 'github-issues',
        connectorInstanceId: 'search-live',
        title: 'Visibility marker deleted',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
        deletedAt: now,
      },
      {
        id: 'search-handled-task',
        sourceId: 'owner:disconnected:42',
        connectorType: 'github-issues',
        connectorInstanceId: 'search-live',
        title: 'Visibility marker handled',
        status: 'todo',
        localDisposition: 'handled',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'search-disconnected-task',
        sourceId: 'owner:repo:42',
        connectorType: 'github-issues',
        connectorInstanceId: 'search-deleted',
        title: 'Visibility marker disconnected',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'search-notification-task',
        sourceId: 'notification:42',
        connectorType: 'outlook-email',
        connectorInstanceId: 'search-live',
        title: 'Visibility marker notification',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);

    await search.rebuildSearchIndex();
  });

  it('rebuilds and queries the FTS projection with canonical current visibility', async () => {
    const indexCount = sqlite.prepare('SELECT COUNT(*) AS count FROM tasks_fts')
      .get() as { count: number };
    expect(indexCount.count).toBe(1);

    const results = await search.searchFTS('visibility marker', {
      type: 'tasks',
      limit: 20,
    });
    expect(results.map((result) => result.id)).toEqual(['search-visible']);
  });

  it('applies the same visibility to exact GitHub issue lookup and facets', async () => {
    const results = await search.searchFTS('#42', { type: 'tasks', limit: 20 });
    expect(results.map((result) => result.id)).toEqual(['search-visible']);

    await expect(search.searchFTSFacets('#42', { type: 'tasks' })).resolves.toEqual({
      sources: [{ value: 'github-issues', count: 1 }],
      statuses: [{ value: 'todo', count: 1 }],
    });
  });
});
