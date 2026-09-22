import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('planning signals', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let planning: typeof import('@/lib/planning-signals');

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('@/db/schema');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, planningModule] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/planning-signals'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    planning = planningModule;

    const baseTask = {
      connectorType: 'local',
      connectorInstanceId: 'local',
      status: 'todo',
      priority: 'none',
      dueDate: null,
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:00.000Z',
      lastSyncedAt: '2026-08-18T12:00:00.000Z',
    };
    await db.insert(schema.tasks).values([
      { ...baseTask, id: 'my-day-miss', sourceId: 'local:my-day-miss', title: 'Missed My Day task' },
      { ...baseTask, id: 'withdrawn', sourceId: 'local:withdrawn', title: 'Withdrawn task' },
      { ...baseTask, id: 'withdrawn-only', sourceId: 'local:withdrawn-only', title: 'Withdrawn-only task' },
      { ...baseTask, id: 'focus-miss', sourceId: 'local:focus-miss', title: 'Missed focus task' },
      { ...baseTask, id: 'elapsed-block', sourceId: 'local:elapsed-block', title: 'Elapsed block task' },
      {
        ...baseTask,
        id: 'overdue',
        sourceId: 'local:overdue',
        title: 'Overdue task',
        dueDate: '2026-08-18',
        snoozedUntil: '2026-08-19T12:00:00.000Z',
      },
      {
        ...baseTask,
        id: 'completed',
        sourceId: 'local:completed',
        title: 'Completed commitment',
        status: 'done',
        completedAt: '2026-08-19T16:00:00.000Z',
      },
    ]);
    await db.insert(schema.myDayItems).values([
      {
        id: 'my-day-miss-item',
        taskId: 'my-day-miss',
        date: '2026-08-19',
        addedAt: '2026-08-19T12:00:00.000Z',
        isAutoIncluded: false,
        order: 1,
      },
      {
        id: 'completed-item',
        taskId: 'completed',
        date: '2026-08-19',
        addedAt: '2026-08-19T12:00:00.000Z',
        isAutoIncluded: false,
        order: 2,
      },
    ]);
    await db.insert(schema.focusItems).values({
      id: 'focus-miss-item',
      taskId: 'focus-miss',
      scope: 'today',
      date: '2026-08-19',
      slot: 1,
      addedAt: '2026-08-19T12:00:00.000Z',
      isAiSuggested: false,
    });
    await db.insert(schema.taskSchedules).values({
      taskId: 'elapsed-block',
      scheduledDate: '2026-08-19',
      scheduledTime: '09:00',
      estimatedDuration: 60,
      isTimeBlocked: true,
    });
    await planning.appendPlanningSignal({
      taskId: 'withdrawn',
      eventType: 'my_day_committed',
      date: '2026-08-19',
      occurredAt: '2026-08-19T12:00:00.000Z',
      provenance: 'test',
    });
    await planning.appendPlanningSignal({
      taskId: 'withdrawn',
      eventType: 'my_day_committed',
      date: '2026-08-19',
      occurredAt: '2026-08-19T14:00:00.000Z',
      provenance: 'test',
    });
    await planning.appendPlanningSignal({
      taskId: 'withdrawn-only',
      eventType: 'my_day_committed',
      date: '2026-08-19',
      occurredAt: '2026-08-19T12:00:00.000Z',
      provenance: 'test',
    });
    await planning.appendPlanningSignal({
      taskId: 'withdrawn-only',
      eventType: 'my_day_withdrawn',
      date: '2026-08-19',
      occurredAt: '2026-08-19T13:00:00.000Z',
      provenance: 'test',
    });
    await planning.appendPlanningSignal({
      taskId: 'withdrawn',
      eventType: 'my_day_withdrawn',
      date: '2026-08-19',
      occurredAt: '2026-08-19T13:00:00.000Z',
      provenance: 'test',
    });
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('derives retry-safe friction signals after day close', async () => {
    const first = await planning.finalizePlanningSignals('2026-08-20');
    const second = await planning.finalizePlanningSignals('2026-08-20');

    expect(first).toEqual({
      commitmentsBackfilled: 3,
      myDayMisses: 2,
      focusMisses: 1,
      elapsedBlocks: 1,
      overdueTransitions: 1,
    });

    expect(second).toEqual({
      commitmentsBackfilled: 0,
      myDayMisses: 0,
      focusMisses: 0,
      elapsedBlocks: 0,
      overdueTransitions: 0,
    });

    const events = sqlite.prepare(`
      SELECT task_id AS taskId, event_type AS eventType
      FROM task_history_events
      WHERE event_type IN ('my_day_missed', 'focus_missed', 'scheduled_block_elapsed', 'became_overdue')
      ORDER BY event_type, task_id
    `).all();
    expect(events).toEqual([
      { taskId: 'overdue', eventType: 'became_overdue' },
      { taskId: 'focus-miss', eventType: 'focus_missed' },
      { taskId: 'my-day-miss', eventType: 'my_day_missed' },
      { taskId: 'withdrawn', eventType: 'my_day_missed' },
      { taskId: 'elapsed-block', eventType: 'scheduled_block_elapsed' },
    ]);
  });

  it('coordinates automatic finalization through a durable five-minute window', async () => {
    const now = new Date('2026-08-20T12:02:00.000Z');
    const first = await planning.finalizePlanningSignalsIfDue('2026-08-20', now);
    const duplicate = await planning.finalizePlanningSignalsIfDue(
      '2026-08-20',
      new Date('2026-08-20T12:04:59.999Z'),
    );
    const nextWindow = await planning.finalizePlanningSignalsIfDue(
      '2026-08-20',
      new Date('2026-08-20T12:05:00.000Z'),
    );

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(nextWindow).toEqual({
      commitmentsBackfilled: 0,
      myDayMisses: 0,
      focusMisses: 0,
      elapsedBlocks: 0,
      overdueTransitions: 0,
    });
  });

  it('records only later snooze changes', () => {
    sqlite.prepare('UPDATE tasks SET snoozed_until = ? WHERE id = ?')
      .run('2026-08-19T10:00:00.000Z', 'overdue');
    sqlite.prepare('UPDATE tasks SET snoozed_until = ? WHERE id = ?')
      .run('2026-08-20T12:00:00.000Z', 'overdue');

    expect(sqlite.prepare(`
      SELECT previous_value AS previousValue, new_value AS newValue
      FROM task_history_events
      WHERE task_id = 'overdue' AND event_type = 'snooze_extended'
    `).all()).toEqual([{
      previousValue: '2026-08-19T10:00:00.000Z',
      newValue: '2026-08-20T12:00:00.000Z',
    }]);
  });
});
