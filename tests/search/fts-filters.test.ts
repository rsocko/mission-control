import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('FTS authoritative filters', () => {
  let searchFTS: typeof import('@/lib/search/fts').searchFTS;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [database, schema, fts] = await Promise.all([
      importInitializedSqliteDatabase(),
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
      {
        ...makeTask('github-issue-123', 'octo/repo', 'todo'),
        sourceId: 'octo/repo:123',
        connectorType: 'github-issues',
        title: 'Fix command palette lookup',
        metadata: { issueNumber: 123 },
      },
      {
        ...makeTask('local-task-123', 'Local', 'todo'),
        sourceId: 'local:123',
        title: 'Not a GitHub issue',
      },
      {
        ...makeTask('deleted-match', 'Project Alpha', 'todo'),
        connectorInstanceId: 'deleted-connector',
      },
      {
        ...makeTask('child-match', 'Project Alpha', 'todo'),
        parentId: 'filtered-match',
      },
      {
        ...makeTask('notification-match', 'Project Alpha', 'todo'),
        connectorType: 'outlook-email',
      },
      {
        ...makeTask('dismissed-match', 'Project Alpha', 'todo'),
        localDisposition: 'dismissed',
      },
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

  it('applies Universe visibility before the result limit', async () => {
    const results = await searchFTS('Quarterly planning', {
      type: 'tasks',
      source: 'Project Alpha',
      universeEligible: true,
      excludeConnectorInstanceIds: ['deleted-connector'],
      limit: 50,
    });

    expect(results.map((result) => result.id)).not.toEqual(expect.arrayContaining([
      'deleted-match',
      'child-match',
      'notification-match',
      'dismissed-match',
    ]));
    expect(results.map((result) => result.id)).toContain('filtered-match');
  });

  it.each(['123', '#123'])('finds a GitHub issue by number with query %s', async (query) => {
    const results = await searchFTS(query, {
      type: 'tasks',
      excludeDone: true,
      limit: 5,
    });

    expect(results.map((result) => result.id)).toContain('github-issue-123');
    expect(results.map((result) => result.id)).not.toContain('local-task-123');
    expect(results.find((result) => result.id === 'github-issue-123')?.metadata.issueNumber).toBe(123);
  });
});
