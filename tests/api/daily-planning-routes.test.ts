import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

/**
 * End-to-end behavior for the daily-planning routes that previously had no
 * dedicated coverage, exercised against the real SQLite composition so route
 * HTTP semantics and the neutral capability stay pinned together.
 */
describe('daily-planning routes on the selected SQLite composition', () => {
  let sqlite: Database.Database;
  let energy: typeof import('@/app/api/energy/route');
  let focus: typeof import('@/app/api/focus-items/route');
  let schedule: typeof import('@/app/api/schedule/route');

  const BASE = 'http://localhost:3099';

  function json(path: string, method: string, body: unknown) {
    return new Request(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const { importInitializedSqliteDatabase } = await import(
      '../helpers/initialized-sqlite-database'
    );
    const [database, energyRoute, focusRoute, scheduleRoute] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/app/api/energy/route'),
      import('@/app/api/focus-items/route'),
      import('@/app/api/schedule/route'),
    ]);
    sqlite = database.sqlite;
    energy = energyRoute;
    focus = focusRoute;
    schedule = scheduleRoute;
  }, 30_000);

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  beforeEach(() => {
    sqlite.exec(`
      DELETE FROM focus_items;
      DELETE FROM task_schedules;
      DELETE FROM energy_checkins;
      DELETE FROM tasks;
    `);
    const insert = sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        local_disposition, priority, depth, is_checklist_item, metadata,
        sync_status, created_at, updated_at, last_synced_at
      ) VALUES (?, ?, 'local', 'local', ?, 'todo', 'active', 'high', 0, 0, '{}', 'synced',
        '2026-09-04T12:00:00.000Z', '2026-09-04T12:00:00.000Z', '2026-09-04T12:00:00.000Z')
    `);
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4']) {
      insert.run(id, `source-${id}`, `Task ${id}`);
    }
  });

  it('stores one energy check-in per date and reads it back', async () => {
    await expect((await energy.GET(new Request(`${BASE}/api/energy?date=2026-09-05`))).json())
      .resolves.toEqual({ checkin: null });

    expect((await energy.POST(json('/api/energy', 'POST', {
      level: 'low',
      note: 'slow start',
      date: '2026-09-05',
    }))).status).toBe(200);
    expect((await energy.POST(json('/api/energy', 'POST', {
      level: 'high',
      date: '2026-09-05',
    }))).status).toBe(200);

    const read = await (await energy.GET(
      new Request(`${BASE}/api/energy?date=2026-09-05`),
    )).json();
    expect(read.checkin).toMatchObject({ date: '2026-09-05', level: 'high', note: null });
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM energy_checkins WHERE date = ?',
    ).get('2026-09-05')).toEqual({ count: 1 });

    expect((await energy.POST(json('/api/energy', 'POST', { level: 'nope' }))).status).toBe(400);
  });

  it('enforces Focus 3 capacity, duplicates, reordering, and withdrawal', async () => {
    const add = (taskId: string) => focus.POST(json('/api/focus-items', 'POST', {
      taskId,
      scope: 'today',
      date: '2026-09-05',
    }));

    expect((await add('task-1')).status).toBe(201);
    expect((await add('task-2')).status).toBe(201);
    expect((await add('task-3')).status).toBe(201);
    expect((await add('task-1')).status).toBe(409);
    expect((await add('task-4')).status).toBe(409);

    const board = await (await focus.GET(
      new Request(`${BASE}/api/focus-items?date=2026-09-05`),
    )).json();
    expect(board.today.map((item: { taskId: string; slot: number }) => [item.taskId, item.slot]))
      .toEqual([['task-1', 1], ['task-2', 2], ['task-3', 3]]);
    expect(board.weekMonday).toBe('2026-08-31');
    expect(board.today[0]).toHaveProperty('editPolicy');

    const moved = await focus.PATCH(json('/api/focus-items', 'PATCH', {
      id: board.today[2].id,
      slot: 1,
    }));
    expect(moved.status).toBe(200);
    const reordered = await (await focus.GET(
      new Request(`${BASE}/api/focus-items?date=2026-09-05`),
    )).json();
    expect(reordered.today.map((item: { taskId: string }) => item.taskId))
      .toEqual(['task-3', 'task-2', 'task-1']);

    expect((await focus.PATCH(json('/api/focus-items', 'PATCH', {
      id: 'missing',
      slot: 1,
    }))).status).toBe(404);
    expect((await focus.PATCH(json('/api/focus-items', 'PATCH', {
      id: reordered.today[0].id,
      slot: 9,
    }))).status).toBe(400);

    expect((await focus.DELETE(new Request(
      `${BASE}/api/focus-items?taskId=task-3&scope=today&date=2026-09-05`,
      { method: 'DELETE' },
    ))).status).toBe(200);
    expect((await focus.DELETE(new Request(
      `${BASE}/api/focus-items`,
      { method: 'DELETE' },
    ))).status).toBe(400);

    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_history_events WHERE event_type = 'focus_withdrawn'",
    ).get()).toEqual({ count: 1 });
  });

  it('upserts a task schedule and reports blocked and unblocked stats', async () => {
    expect((await schedule.POST(json('/api/schedule', 'POST', {
      taskId: 'task-1',
      date: '2026-09-05',
      time: '09:00',
      duration: 45,
      isTimeBlocked: true,
    }))).status).toBe(200);
    expect((await schedule.POST(json('/api/schedule', 'POST', {
      taskId: 'task-2',
      date: '2026-09-05',
    }))).status).toBe(200);
    expect((await schedule.POST(json('/api/schedule', 'POST', { taskId: 'task-3' }))).status)
      .toBe(400);

    const listed = await (await schedule.GET(
      new Request(`${BASE}/api/schedule?date=2026-09-05`),
    )).json();
    expect(listed.stats).toEqual({ totalTasks: 2, totalMinutes: 75, blockedMinutes: 45 });
    expect(listed.timeBlocked.map((row: { taskId: string }) => row.taskId)).toEqual(['task-1']);
    expect(listed.unblocked.map((row: { taskId: string }) => row.taskId)).toEqual(['task-2']);

    // Re-scheduling the same task replaces its single primary-keyed row.
    expect((await schedule.POST(json('/api/schedule', 'POST', {
      taskId: 'task-1',
      date: '2026-09-06',
      time: '11:00',
    }))).status).toBe(200);
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM task_schedules WHERE task_id = ?',
    ).get('task-1')).toEqual({ count: 1 });
    await expect((await schedule.GET(
      new Request(`${BASE}/api/schedule?date=2026-09-05`),
    )).json()).resolves.toMatchObject({ stats: { totalTasks: 1 } });

    expect((await schedule.DELETE(new Request(
      `${BASE}/api/schedule?taskId=task-1`,
      { method: 'DELETE' },
    ))).status).toBe(200);
    expect((await schedule.DELETE(new Request(
      `${BASE}/api/schedule`,
      { method: 'DELETE' },
    ))).status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM task_schedules').get())
      .toEqual({ count: 1 });
  });
});
