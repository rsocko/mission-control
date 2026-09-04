import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let POST: typeof import('@/app/api/notifications/[id]/actions/[actionId]/route').POST;
let getRemindLaterTarget:
  typeof import('@/app/api/notifications/[id]/actions/[actionId]/route').getRemindLaterTarget;
let eq: typeof import('drizzle-orm').eq;

const NOW = '2026-08-21T19:00:00.000Z';

beforeAll(async () => {
  const dbModule = await import('@/db');
  db = dbModule.default;
  schema = await import('@/db/schema');
  ({ POST, getRemindLaterTarget } = await import(
    '@/app/api/notifications/[id]/actions/[actionId]/route'
  ));
  ({ eq } = await import('drizzle-orm'));
  await dbModule.initializeSqlitePersistenceComposition();
});

beforeEach(() => {
  db.delete(schema.notificationActions).run();
  db.delete(schema.notifications).run();
  db.delete(schema.taskReminderOccurrences).run();
  db.delete(schema.tasks).run();
  db.delete(schema.pushPreferences).run();
});

function addReminder(actionType: 'remind_later' | 'complete_task' | 'dismiss_reminder') {
  db.insert(schema.tasks).values({
    id: 'task-1',
    sourceId: 'local:task-1',
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: 'Follow up',
    status: 'todo',
    priority: 'none',
    reminderAt: null,
    reminderRelative: '1_day_before',
    reminderDueTime: '09:00',
    createdAt: NOW,
    updatedAt: NOW,
    lastSyncedAt: NOW,
  }).run();
  db.insert(schema.notifications).values({
    id: 'notification-1',
    sourceId: 'task-reminder:task-1:2026-08-21T18:00:00.000Z',
    connectorType: 'system',
    connectorInstanceId: 'push-triggers',
    title: 'Reminder: Follow up',
    templateKey: 'task_reminder',
    relatedTaskId: 'task-1',
    sourceState: 'active',
    disposition: 'inbox',
    receivedAt: NOW,
    sortAt: NOW,
  }).run();
  db.insert(schema.notificationActions).values({
    id: `notification-1:${actionType}`,
    notificationId: 'notification-1',
    actionType,
    label: actionType,
    payload: {},
  }).run();
}

function postAction(
  actionType: 'remind_later' | 'complete_task' | 'dismiss_reminder',
  body: Record<string, unknown> = {},
) {
  return POST(new Request(`http://localhost/api/notifications/notification-1/actions/notification-1:${actionType}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), {
    params: Promise.resolve({
      id: 'notification-1',
      actionId: `notification-1:${actionType}`,
    }),
  });
}

describe('task reminder actions', () => {
  it('computes tomorrow morning in the configured timezone', () => {
    expect(getRemindLaterTarget(
      'tomorrow_morning',
      new Date('2026-08-21T23:30:00.000Z'),
      'America/New_York',
      8,
    )).toBe('2026-08-22T12:00:00.000Z');
  });

  it('reschedules a fired reminder without discarding relative recurrence intent', async () => {
    addReminder('remind_later');

    const response = await postAction('remind_later', { duration: '15m' });

    expect(response.status).toBe(200);
    const reminderAt = db.select({
      reminderAt: schema.tasks.reminderAt,
      reminderRelative: schema.tasks.reminderRelative,
      reminderDueTime: schema.tasks.reminderDueTime,
    }).from(schema.tasks).where(eq(schema.tasks.id, 'task-1')).get();
    expect(Date.parse(reminderAt!.reminderAt!)).toBeGreaterThan(Date.parse(NOW));
    expect(reminderAt).toMatchObject({
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
    expect(db.select().from(schema.notifications)
      .where(eq(schema.notifications.id, 'notification-1')).get()).toMatchObject({
        disposition: 'handled',
        isActionable: false,
      });

    expect((await postAction('remind_later', { duration: '1h' })).status).toBe(409);
  });

  it('does not overwrite a reminder changed by another client', async () => {
    addReminder('remind_later');
    db.update(schema.tasks).set({ reminderAt: '2026-08-22T15:00:00.000Z' })
      .where(eq(schema.tasks.id, 'task-1')).run();

    expect((await postAction('remind_later', { duration: '1h' })).status).toBe(409);
    expect(db.select({ reminderAt: schema.tasks.reminderAt }).from(schema.tasks)
      .where(eq(schema.tasks.id, 'task-1')).get()?.reminderAt)
      .toBe('2026-08-22T15:00:00.000Z');
  });

  it('dismisses the reminder and clears all reminder intent', async () => {
    addReminder('dismiss_reminder');

    expect((await postAction('dismiss_reminder')).status).toBe(200);
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task-1')).get())
      .toMatchObject({
        reminderAt: null,
        reminderRelative: null,
        reminderDueTime: null,
      });
    expect(db.select().from(schema.notifications)
      .where(eq(schema.notifications.id, 'notification-1')).get()).toMatchObject({
        disposition: 'dismissed',
        isActionable: false,
      });
  });

  it('completes the task once and creates its completion-anchored successor', async () => {
    addReminder('complete_task');
    db.insert(schema.taskSchedules).values({
      taskId: 'task-1',
      scheduledDate: '2026-08-21',
      recurrence: 'daily',
      recurrenceMode: 'completion',
    }).run();

    const response = await postAction('complete_task');
    expect(response.status).toBe(200);
    const result = await response.json() as {
      result: { recurrenceNextTaskId?: string };
    };
    expect(result.result.recurrenceNextTaskId).toEqual(expect.any(String));
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task-1')).get())
      .toMatchObject({
        status: 'done',
        statusReason: 'completed',
        reminderAt: null,
      });
    expect(db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, result.result.recurrenceNextTaskId!)).get())
      .toMatchObject({
        status: 'todo',
        recurrenceGeneratedFromTaskId: 'task-1',
      });
    expect((await postAction('complete_task')).status).toBe(409);
  });
});
