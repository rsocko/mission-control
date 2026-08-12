import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('GET /api/my-day suggestions', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let getMyDay: typeof import('@/app/api/my-day/route').GET;
  let deleteMyDay: typeof import('@/app/api/my-day/route').DELETE;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/my-day/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    getMyDay = routeModule.GET;
    deleteMyDay = routeModule.DELETE;

    const recent = '2026-08-04T12:00:00.000Z';
    const old = '2026-07-01T12:00:00.000Z';
    const task = (
      id: string,
      options: {
        dueDate?: string;
        priority?: string;
        parentId?: string;
        depth?: number;
        timestamp?: string;
        localDisposition?: 'active' | 'handled' | 'dismissed';
        connectorType?: string;
        status?: string;
        completedAt?: string;
      } = {},
    ) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: options.connectorType ?? 'local',
      connectorInstanceId: options.connectorType ?? 'local',
      title: id,
      status: options.status ?? 'todo',
      localDisposition: options.localDisposition ?? 'active',
      priority: options.priority ?? 'none',
      dueDate: options.dueDate,
      parentId: options.parentId,
      depth: options.depth ?? 0,
      metadata: {},
      syncStatus: 'synced',
      createdAt: options.timestamp ?? recent,
      updatedAt: options.timestamp ?? recent,
      lastSyncedAt: options.timestamp ?? recent,
      completedAt: options.completedAt,
    });

    await db.insert(schema.tasks).values([
      task('top-today', { dueDate: '2026-08-05', priority: 'high' }),
      task('child-today', {
        dueDate: '2026-08-05',
        priority: 'high',
        parentId: 'top-today',
        depth: 1,
      }),
      task('child-inconsistent-depth', {
        dueDate: '2026-08-05',
        priority: 'high',
        parentId: 'top-today',
        depth: 0,
      }),
      task('top-overdue', { dueDate: '2026-08-04', timestamp: old }),
      task('child-overdue', {
        dueDate: '2026-08-04',
        parentId: 'top-overdue',
        depth: 1,
        timestamp: old,
      }),
      task('top-week', { dueDate: '2026-08-07', timestamp: old }),
      task('child-week', {
        dueDate: '2026-08-07',
        parentId: 'top-week',
        depth: 1,
        timestamp: old,
      }),
      task('top-carried', { timestamp: old }),
      task('child-carried', {
        parentId: 'top-carried',
        depth: 1,
        timestamp: old,
      }),
      task('handled-today', {
        dueDate: '2026-08-05',
        priority: 'high',
        localDisposition: 'handled',
      }),
      task('dismissed-today', {
        dueDate: '2026-08-05',
        priority: 'high',
        localDisposition: 'dismissed',
      }),
      task('notification-today', {
        dueDate: '2026-08-05',
        priority: 'high',
        connectorType: 'monarch-money',
      }),
      task('completed-today', {
        status: 'done',
        completedAt: '2026-08-05T16:00:00.000Z',
      }),
      task('completed-microsoft-today', {
        status: 'done',
        completedAt: '2026-08-05T16:30:00.0000000',
        connectorType: 'microsoft-todo',
      }),
      task('completed-before-local-day', {
        status: 'done',
        completedAt: '2026-08-05T03:59:59.999Z',
      }),
      task('completed-child', {
        status: 'done',
        completedAt: '2026-08-05T17:30:00.000Z',
        parentId: 'top-today',
        depth: 1,
      }),
      task('completed-excluded', {
        status: 'done',
        completedAt: '2026-08-05T17:00:00.000Z',
      }),
    ]);

    const myDayItem = (id: string, taskId: string, date: string, order: number) => ({
      id,
      taskId,
      date,
      order,
      addedAt: `${date}T12:00:00.000Z`,
    });
    await db.insert(schema.myDayItems).values([
      myDayItem('yesterday-top', 'top-today', '2026-08-04', 1),
      myDayItem('yesterday-child', 'child-today', '2026-08-04', 2),
      myDayItem('carried-top-1', 'top-carried', '2026-08-01', 1),
      myDayItem('carried-top-2', 'top-carried', '2026-08-02', 1),
      myDayItem('carried-top-3', 'top-carried', '2026-08-03', 1),
      myDayItem('carried-child-1', 'child-carried', '2026-08-01', 2),
      myDayItem('carried-child-2', 'child-carried', '2026-08-02', 2),
      myDayItem('carried-child-3', 'child-carried', '2026-08-03', 2),
      myDayItem('today-handled', 'handled-today', '2026-08-05', 1),
      myDayItem('today-dismissed', 'dismissed-today', '2026-08-05', 2),
      myDayItem('today-notification', 'notification-today', '2026-08-05', 3),
    ]);
    await db.insert(schema.myDayExclusions).values({
      id: 'exclude-completed',
      taskId: 'completed-excluded',
      date: '2026-08-05',
      removedAt: '2026-08-05T18:00:00.000Z',
    });
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('returns only top-level tasks in every suggestion group', async () => {
    const response = await getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-08-05',
    ));
    const body = await response.json() as {
      items: Array<{
        id: string;
        taskId: string;
        isAutoIncluded: boolean;
        addedAt: string;
      }>;
      suggestions: Record<string, Array<{ id: string }>>;
    };

    expect(response.status).toBe(200);
    expect(body.suggestions.yesterday.map(({ id }) => id)).toContain('top-today');
    expect(body.suggestions.overdue.map(({ id }) => id)).toContain('top-overdue');
    expect(body.suggestions.dueToday.map(({ id }) => id)).toContain('top-today');
    expect(body.suggestions.dueThisWeek.map(({ id }) => id)).toContain('top-week');
    expect(body.suggestions.highPriority.map(({ id }) => id)).toContain('top-today');
    expect(body.suggestions.aiRecommended.map(({ id }) => id)).toContain('top-today');
    expect(body.suggestions.recentlyAdded.map(({ id }) => id)).toContain('top-today');
    expect(body.suggestions.carriedForward.map(({ id }) => id)).toContain('top-carried');

    const suggestedIds = Object.values(body.suggestions)
      .flat()
      .map(({ id }) => id);
    expect(suggestedIds.some((id) => id.startsWith('child-'))).toBe(false);
    expect(body.items).toHaveLength(2);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'completed-today',
        isAutoIncluded: true,
        addedAt: '2026-08-05T16:00:00.000Z',
      }),
      expect.objectContaining({
        taskId: 'completed-microsoft-today',
        isAutoIncluded: true,
        addedAt: '2026-08-05T16:30:00.0000000',
      }),
    ]));
    expect(suggestedIds).not.toContain('handled-today');
    expect(suggestedIds).not.toContain('dismissed-today');
    expect(suggestedIds).not.toContain('notification-today');

    await getMyDay(new Request('http://localhost/api/my-day?date=2026-08-05'));
    const completedItems = sqlite.prepare(
      'SELECT task_id FROM my_day_items WHERE date = ? AND task_id LIKE ?',
    ).all('2026-08-05', 'completed-%') as Array<{ task_id: string }>;
    expect(completedItems.map(({ task_id }) => task_id).sort()).toEqual([
      'completed-microsoft-today',
      'completed-today',
    ]);

    const completedTodayItem = body.items.find(
      ({ taskId }) => taskId === 'completed-today',
    );
    if (!completedTodayItem) {
      throw new Error('Expected completed-today to be materialized in My Day');
    }
    const deleteResponse = await deleteMyDay(new Request(
      `http://localhost/api/my-day?id=${completedTodayItem.id}`,
      { method: 'DELETE' },
    ));
    expect(deleteResponse.status).toBe(200);

    const afterDeleteResponse = await getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-08-05',
    ));
    const afterDeleteBody = await afterDeleteResponse.json() as {
      items: Array<{ taskId: string }>;
    };
    expect(afterDeleteBody.items.map(({ taskId }) => taskId)).not.toContain('completed-today');
    const removalExclusion = sqlite.prepare(
      'SELECT date FROM my_day_exclusions WHERE task_id = ?',
    ).get('completed-today') as { date: string };
    expect(removalExclusion.date).toBe('2026-08-05');

    const invalidDateResponse = await getMyDay(new Request(
      'http://localhost/api/my-day?date=2026-02-31',
    ));
    expect(invalidDateResponse.status).toBe(400);
  });
});
