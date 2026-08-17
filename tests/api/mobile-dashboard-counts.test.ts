import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('GET /api/mobile-dashboard task counts', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let GET: typeof import('@/app/api/mobile-dashboard/route').GET;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/mobile-dashboard/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    GET = routeModule.GET;

    await db.delete(schema.triageItems);
    await db.delete(schema.tasks);

    const now = new Date().toISOString();
    const baseTask = {
      connectorType: 'local',
      connectorInstanceId: 'local',
      priority: 'none' as const,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    };
    await db.insert(schema.tasks).values([
      {
        ...baseTask,
        id: 'open-parent',
        sourceId: 'open-parent',
        title: 'Open parent',
        status: 'todo',
        dueDate: '2000-01-01',
      },
      {
        ...baseTask,
        id: 'open-subtask',
        sourceId: 'open-subtask',
        title: 'Open subtask',
        status: 'todo',
        dueDate: '2000-01-01',
        parentId: 'open-parent',
        depth: 1,
      },
      {
        ...baseTask,
        id: 'done-parent',
        sourceId: 'done-parent',
        title: 'Done parent',
        status: 'done',
        completedAt: now,
      },
      {
        ...baseTask,
        id: 'done-subtask',
        sourceId: 'done-subtask',
        title: 'Done subtask',
        status: 'done',
        completedAt: now,
        parentId: 'done-parent',
        depth: 1,
      },
    ]);
  }, 30_000);

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('excludes subtasks from status, queue, and recent-activity totals', async () => {
    const response = await GET(new Request(
      'http://localhost/api/mobile-dashboard?today=2026-08-17',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      today: {
        totalOpen: 1,
        completedToday: 1,
        inProgress: 0,
        overdue: 1,
        completionPct: 50,
      },
      queues: {
        triage: 0,
        sort: 1,
        overdue: 1,
      },
      recentActivity: [
        expect.objectContaining({ id: 'done-parent' }),
      ],
    });
  });
});
