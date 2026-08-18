import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('task due-date push tracking', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let tasks: typeof import('@/db/schema').tasks;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.resetModules();

    const [dbModule, schema] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    tasks = schema.tasks;

    await db.insert(tasks).values({
      id: 'push-tracking-task',
      sourceId: 'local:push-tracking-task',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Track reschedules',
      status: 'todo',
      priority: 'none',
      dueDate: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      lastSyncedAt: '2026-08-17T12:00:00.000Z',
    });
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('counts only moves to a later existing due date and records each event', () => {
    const updateDueDate = sqlite.prepare(
      'UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?',
    );

    updateDueDate.run('2026-08-20', '2026-08-17T13:00:00.000Z', 'push-tracking-task');
    updateDueDate.run('2026-08-19', '2026-08-17T14:00:00.000Z', 'push-tracking-task');
    updateDueDate.run('2026-08-25', '2026-08-17T15:00:00.000Z', 'push-tracking-task');
    updateDueDate.run(null, '2026-08-17T16:00:00.000Z', 'push-tracking-task');
    updateDueDate.run('2026-09-01', '2026-08-17T17:00:00.000Z', 'push-tracking-task');

    const task = sqlite.prepare(
      'SELECT push_count AS pushCount FROM tasks WHERE id = ?',
    ).get('push-tracking-task') as { pushCount: number };
    const events = sqlite.prepare(`
      SELECT previous_value AS previousValue, new_value AS newValue, metadata
      FROM task_history_events
      WHERE task_id = ? AND event_type = 'due_date_pushed'
    `).all('push-tracking-task') as Array<{
      previousValue: string;
      newValue: string;
      metadata: string;
    }>;

    expect(task.pushCount).toBe(1);
    expect(events).toEqual([expect.objectContaining({
      previousValue: '2026-08-19',
      newValue: '2026-08-25',
    })]);
    expect(JSON.parse(events[0].metadata)).toEqual({ delayDays: 6 });
  });
});
