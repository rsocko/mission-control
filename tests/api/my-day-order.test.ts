import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('PATCH /api/my-day ordering', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let patchMyDay: typeof import('@/app/api/my-day/route').PATCH;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/my-day/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    patchMyDay = routeModule.PATCH;

    const task = (
      id: string,
      localDisposition: 'active' | 'handled' = 'active',
    ) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: id,
      status: 'todo',
      localDisposition,
      priority: 'none',
      metadata: {},
      syncStatus: 'synced' as const,
      lastSyncedAt: '2026-08-05T12:00:00.000Z',
      createdAt: '2026-08-05T12:00:00.000Z',
      updatedAt: '2026-08-05T12:00:00.000Z',
    });
    await db.insert(schema.tasks).values([
      task('task-1'),
      task('task-2'),
      task('task-3'),
      task('task-hidden', 'handled'),
    ]);
    await db.insert(schema.myDayItems).values([
      {
        id: 'day-item-1',
        taskId: 'task-1',
        date: '2026-08-05',
        addedAt: '2026-08-05T12:00:00.000Z',
        order: 1,
      },
      {
        id: 'day-item-2',
        taskId: 'task-2',
        date: '2026-08-05',
        addedAt: '2026-08-05T12:01:00.000Z',
        order: 2,
      },
      {
        id: 'day-item-3',
        taskId: 'task-3',
        date: '2026-08-05',
        addedAt: '2026-08-05T12:02:00.000Z',
        order: 3,
      },
      {
        id: 'day-item-hidden',
        taskId: 'task-hidden',
        date: '2026-08-05',
        addedAt: '2026-08-05T12:03:00.000Z',
        order: 4,
      },
    ]);
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('persists the complete order atomically', async () => {
    const response = await patchMyDay(new Request('http://localhost/api/my-day', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-08-05',
        orderedItemIds: ['day-item-3', 'day-item-1', 'day-item-2'],
      }),
    }));

    expect(response.status).toBe(200);
    const items = sqlite
      .prepare('SELECT id, "order" FROM my_day_items WHERE date = ? ORDER BY "order"')
      .all('2026-08-05');
    expect(items).toEqual([
      { id: 'day-item-3', order: 1 },
      { id: 'day-item-1', order: 2 },
      { id: 'day-item-2', order: 3 },
      { id: 'day-item-hidden', order: 4 },
    ]);
  });

  it('rejects stale or partial item sets without changing the order', async () => {
    const response = await patchMyDay(new Request('http://localhost/api/my-day', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-08-05',
        orderedItemIds: ['day-item-1', 'day-item-2'],
      }),
    }));

    expect(response.status).toBe(409);
    const items = sqlite
      .prepare('SELECT id FROM my_day_items WHERE date = ? ORDER BY "order"')
      .all('2026-08-05') as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual([
      'day-item-3',
      'day-item-1',
      'day-item-2',
      'day-item-hidden',
    ]);
  });
});
