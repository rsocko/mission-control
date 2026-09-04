import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

let db: typeof import('@/db').default;
let connectorConfigs: typeof import('@/db/schema').connectorConfigs;
let sourceLists: typeof import('@/db/schema').sourceLists;
let tasks: typeof import('@/db/schema').tasks;
let tags: typeof import('@/db/schema').tags;
let getConnectorLists: typeof import('@/app/api/connectors/[id]/lists/route').GET;
let purgeRetainedList: typeof import('@/app/api/connectors/[id]/retained-lists/[sourceListId]/route').DELETE;
let createTask: typeof import('@/app/api/tasks/route').POST;
let pushTag: typeof import('@/app/api/tags/push/route').POST;
let upsertSourceLists: typeof import('@/lib/sync/list-manager').upsertSourceLists;
let eq: typeof import('drizzle-orm').eq;

beforeAll(async () => {
  ({ default: db } = await importInitializedSqliteDatabase());
  ({ connectorConfigs, sourceLists, tasks, tags } = await import('@/db/schema'));
  ({ GET: getConnectorLists } = await import('@/app/api/connectors/[id]/lists/route'));
  ({ DELETE: purgeRetainedList } = await import('@/app/api/connectors/[id]/retained-lists/[sourceListId]/route'));
  ({ POST: createTask } = await import('@/app/api/tasks/route'));
  ({ POST: pushTag } = await import('@/app/api/tags/push/route'));
  ({ upsertSourceLists } = await import('@/lib/sync/list-manager'));
  ({ eq } = await import('drizzle-orm'));

  await db.insert(connectorConfigs).values({
    id: 'github-retention',
    type: 'github-issues',
    name: 'GitHub',
    settings: { repos: ['octo/active'] },
    syncedLists: ['octo/active'],
    capabilities: {},
    credentials: {},
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });
  await db.insert(sourceLists).values([
    {
      id: 'active-list',
      connectorInstanceId: 'github-retention',
      sourceId: 'octo/active',
      name: 'Active',
      type: 'repo',
    },
    {
      id: 'retained-list',
      connectorInstanceId: 'github-retention',
      sourceId: 'octo/removed',
      name: 'Retained',
      type: 'repo',
    },
  ]);
  await db.insert(tasks).values({
    id: 'retained-task',
    sourceId: 'issue-1',
    connectorType: 'github-issues',
    connectorInstanceId: 'github-retention',
    sourceListId: 'octo/removed',
    title: 'Retained issue',
    status: 'todo',
    priority: 'none',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    lastSyncedAt: '2026-08-13T00:00:00.000Z',
  });
  await db.insert(tags).values({
    id: 'retained-push-tag',
    name: 'Retained push',
    slug: 'retained-push',
    type: 'hub',
    createdAt: '2026-08-13T00:00:00.000Z',
  });
}, 30_000);

describe('GitHub retained source lists', () => {
  it('excludes retained repositories from destinations and purges them locally', async () => {
    await upsertSourceLists(
      'github-retention',
      [{
        id: 'active-list',
        connectorInstanceId: 'github-retention',
        sourceId: 'octo/active',
        name: 'Active',
        type: 'repo',
        taskCount: 0,
        lastSyncedAt: '2026-08-13T00:00:00.000Z',
      }],
      null,
      undefined,
      new Set(),
      true,
    );
    expect(await db.select().from(sourceLists).where(eq(sourceLists.id, 'retained-list'))).toHaveLength(1);

    const listsResponse = await getConnectorLists(
      new Request('http://localhost/api/connectors/github-retention/lists'),
      { params: Promise.resolve({ id: 'github-retention' }) },
    );
    expect(listsResponse.status).toBe(200);
    expect((await listsResponse.json()).sourceLists).toEqual([
      expect.objectContaining({ id: 'active-list', selectedForSync: true }),
    ]);

    const createResponse = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Should not be created',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-retention',
        sourceListId: 'octo/removed',
      }),
    }));
    expect(createResponse.status).toBe(400);
    expect(await createResponse.json()).toEqual(expect.objectContaining({
      error: 'sourceListId is not selected for sync',
    }));

    const tagPushResponse = await pushTag(new Request('http://localhost/api/tags/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tagId: 'retained-push-tag',
        sourceListId: 'retained-list',
      }),
    }));
    expect(tagPushResponse.status).toBe(400);
    expect(await tagPushResponse.json()).toEqual({
      error: 'sourceListId is not selected for sync',
    });

    const activePurgeResponse = await purgeRetainedList(
      new Request('http://localhost', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'github-retention', sourceListId: 'active-list' }) },
    );
    expect(activePurgeResponse.status).toBe(409);

    const purgeResponse = await purgeRetainedList(
      new Request('http://localhost', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'github-retention', sourceListId: 'retained-list' }) },
    );
    expect(purgeResponse.status).toBe(200);
    expect(await purgeResponse.json()).toEqual(expect.objectContaining({
      deletedTasks: 1,
      writeBack: 'none',
    }));
    expect(await db.select().from(tasks).where(eq(tasks.id, 'retained-task'))).toHaveLength(0);
    expect(await db.select().from(sourceLists).where(eq(sourceLists.id, 'retained-list'))).toHaveLength(0);
    expect(await db.select().from(sourceLists).where(eq(sourceLists.id, 'active-list'))).toHaveLength(1);
  });
});
