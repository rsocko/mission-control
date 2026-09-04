import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let runDueTaskReminders: typeof import('@/lib/push/task-reminders').runDueTaskReminders;
let eq: typeof import('drizzle-orm').eq;

const NOW = new Date('2026-08-20T12:00:00.000Z');

beforeAll(async () => {
  db = (await importInitializedSqliteDatabase()).default;
  schema = await import('@/db/schema');
  ({ runDueTaskReminders } = await import('@/lib/push/task-reminders'));
  ({ eq } = await import('drizzle-orm'));
});

beforeEach(() => {
  db.delete(schema.notificationDeliveryEvents).run();
  db.delete(schema.taskReminderOccurrences).run();
  db.delete(schema.notificationActions).run();
  db.delete(schema.notifications).run();
  db.delete(schema.taskSchedules).run();
  db.delete(schema.tasks).run();
  db.delete(schema.pushPreferences).run();
  db.delete(schema.appSettings).run();
});

function addTask(
  id: string,
  reminderAt: string | null,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {},
) {
  db.insert(schema.tasks).values({
    id,
    sourceId: `local:${id}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: `Task ${id}`,
    status: 'todo',
    priority: 'none',
    reminderAt,
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    lastSyncedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  }).run();
}

describe('durable task reminder delivery', () => {
  it('fires a missed reminder once and preserves its occurrence history', async () => {
    const scheduledAt = '2026-08-20T11:55:00.000Z';
    addTask('missed', scheduledAt);

    const first = await runDueTaskReminders({ now: NOW });
    const second = await runDueTaskReminders({ now: NOW });

    expect(first).toMatchObject({ examined: 1, claimed: 1, fired: 1, failed: 0 });
    expect(second).toMatchObject({ examined: 0, claimed: 0, fired: 0 });
    expect(db.select().from(schema.notifications).all()).toEqual([
      expect.objectContaining({
        sourceId: `task-reminder:missed:${scheduledAt}`,
        templateKey: 'task_reminder',
        relatedTaskId: 'missed',
        navigationTarget: '/today?taskId=missed',
      }),
    ]);
    expect(db.select().from(schema.notificationActions).all()).toEqual([
      expect.objectContaining({
        actionType: 'navigate',
        label: 'View task',
        isPrimary: true,
      }),
      expect.objectContaining({
        actionType: 'remind_later',
        label: 'Remind later',
      }),
      expect.objectContaining({
        actionType: 'complete_task',
        label: 'Complete task',
      }),
      expect.objectContaining({
        actionType: 'dismiss_reminder',
        label: 'Dismiss reminder',
      }),
    ]);
    expect(db.select().from(schema.taskReminderOccurrences).all()).toEqual([
      expect.objectContaining({
        taskId: 'missed',
        scheduledAt,
        state: 'fired',
        attemptCount: 1,
      }),
    ]);
    expect(db.select({ reminderAt: schema.tasks.reminderAt }).from(schema.tasks).where(
      eq(schema.tasks.id, 'missed'),
    ).get()?.reminderAt).toBeNull();
  });

  it('preserves relative intent after firing a recurring task reminder', async () => {
    const scheduledAt = '2026-08-20T11:55:00.000Z';
    addTask('recurring-relative', scheduledAt, {
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
    db.insert(schema.taskSchedules).values({
      taskId: 'recurring-relative',
      scheduledDate: '2026-08-21',
      recurrence: 'daily',
      isTimeBlocked: false,
    }).run();

    await runDueTaskReminders({ now: NOW });

    expect(db.select({
      reminderAt: schema.tasks.reminderAt,
      reminderRelative: schema.tasks.reminderRelative,
      reminderDueTime: schema.tasks.reminderDueTime,
    }).from(schema.tasks).where(eq(schema.tasks.id, 'recurring-relative')).get()).toEqual({
      reminderAt: null,
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
  });

  it('recovers an expired processing lease after a restart', async () => {
    const scheduledAt = '2026-08-20T11:50:00.000Z';
    addTask('recover', scheduledAt);
    db.insert(schema.taskReminderOccurrences).values({
      id: 'occurrence-recover',
      taskId: 'recover',
      scheduledAt,
      state: 'processing',
      attemptCount: 1,
      claimToken: 'dead-process',
      claimedAt: '2026-08-20T11:40:00.000Z',
      leaseExpiresAt: '2026-08-20T11:45:00.000Z',
      createdAt: '2026-08-20T11:40:00.000Z',
      updatedAt: '2026-08-20T11:40:00.000Z',
    }).run();

    const result = await runDueTaskReminders({ now: NOW });

    expect(result).toMatchObject({ claimed: 1, fired: 1 });
    expect(db.select().from(schema.taskReminderOccurrences).where(
      eq(schema.taskReminderOccurrences.id, 'occurrence-recover'),
    ).get()).toMatchObject({
      state: 'fired',
      attemptCount: 2,
      claimToken: null,
    });
  });

  it('cancels a stale occurrence when the task was rescheduled', async () => {
    const oldSchedule = '2026-08-20T11:50:00.000Z';
    addTask('rescheduled', '2026-08-21T12:00:00.000Z');
    db.insert(schema.taskReminderOccurrences).values({
      id: 'occurrence-stale',
      taskId: 'rescheduled',
      scheduledAt: oldSchedule,
      state: 'processing',
      attemptCount: 1,
      claimToken: 'dead-process',
      claimedAt: '2026-08-20T11:40:00.000Z',
      leaseExpiresAt: '2026-08-20T11:45:00.000Z',
      createdAt: '2026-08-20T11:40:00.000Z',
      updatedAt: '2026-08-20T11:40:00.000Z',
    }).run();

    const result = await runDueTaskReminders({ now: NOW });

    expect(result).toMatchObject({ examined: 0, cancelled: 1, fired: 0 });
    expect(db.select().from(schema.taskReminderOccurrences).where(
      eq(schema.taskReminderOccurrences.id, 'occurrence-stale'),
    ).get()).toMatchObject({
      state: 'cancelled',
      claimToken: null,
    });
  });

  it('persists the reminder even when device delivery is disabled', async () => {
    addTask('delivery-off', '2026-08-20T11:55:00.000Z');
    db.insert(schema.appSettings).values({
      key: 'push_delivery_enabled',
      value: false,
      updatedAt: NOW.toISOString(),
    }).run();

    const result = await runDueTaskReminders({ now: NOW });

    expect(result.fired).toBe(1);
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'suppressed',
          suppressionReason: 'channel_disabled',
        }),
      ]),
    );
  });

  it('records invalid timestamps without creating a notification', async () => {
    addTask('invalid', 'not-a-timestamp');

    const first = await runDueTaskReminders({ now: NOW });
    const second = await runDueTaskReminders({ now: NOW });

    expect(first.failed).toBe(1);
    expect(second.failed).toBe(0);
    expect(db.select().from(schema.notifications).all()).toHaveLength(0);
    expect(db.select().from(schema.taskReminderOccurrences).all()).toEqual([
      expect.objectContaining({
        taskId: 'invalid',
        scheduledAt: 'not-a-timestamp',
        state: 'failed',
        attemptCount: 5,
        lastError: 'Invalid reminder timestamp',
      }),
    ]);
  });

  it('does not let an exhausted occurrence starve later due reminders', async () => {
    const exhaustedAt = '2026-08-20T11:00:00.000Z';
    addTask('exhausted', exhaustedAt);
    addTask('ready', '2026-08-20T11:30:00.000Z');
    db.insert(schema.taskReminderOccurrences).values({
      id: 'occurrence-exhausted',
      taskId: 'exhausted',
      scheduledAt: exhaustedAt,
      state: 'failed',
      attemptCount: 5,
      lastError: 'Permanent test failure',
      createdAt: '2026-08-20T11:00:00.000Z',
      updatedAt: '2026-08-20T11:00:00.000Z',
    }).run();

    const result = await runDueTaskReminders({ now: NOW, batchSize: 1 });

    expect(result).toMatchObject({ examined: 1, claimed: 1, fired: 1 });
    expect(db.select().from(schema.notifications).all()).toEqual([
      expect.objectContaining({ relatedTaskId: 'ready' }),
    ]);
  });

  it('does not let a future offset timestamp consume the due batch', async () => {
    addTask('future-offset', '2026-08-20T08:00:00-07:00');
    addTask('due-now', '2026-08-20T11:30:00.000Z');

    const result = await runDueTaskReminders({ now: NOW, batchSize: 1 });

    expect(result).toMatchObject({ examined: 1, claimed: 1, fired: 1 });
    expect(db.select().from(schema.notifications).all()).toEqual([
      expect.objectContaining({ relatedTaskId: 'due-now' }),
    ]);
  });
});
