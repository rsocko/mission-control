import { expect, it } from 'vitest';
import type {
  ClaimedTaskReminder,
  TaskReminderRepository,
} from '@/db/persistence/task-reminders';

export const TASK_REMINDER_BASE_TIME = new Date('2026-08-31T12:00:00.000Z');
export const TASK_REMINDER_DELIVERY_CONTEXT = {
  currentHour: 12,
  webPushConfigured: false,
  apns: null,
  globalMaxPerHour: 100,
} as const;

export interface ReminderOccurrenceState {
  state: string;
  attemptCount: number;
  claimToken: string | null;
  nextAttemptAt: string | null;
  notificationId: string | null;
}

export interface TaskReminderContractHarness {
  repository: TaskReminderRepository;
  reset(): Promise<void>;
  seedTask(input: {
    id: string;
    reminderAt: string | null;
    status?: string;
    reminderRelative?: string | null;
    reminderDueTime?: string | null;
    recurrence?: string | null;
  }): Promise<void>;
  seedOccurrence(input: {
    id: string;
    taskId: string;
    scheduledAt: string;
    state: string;
    attemptCount?: number;
    claimToken?: string | null;
    leaseExpiresAt?: string | null;
    nextAttemptAt?: string | null;
  }): Promise<void>;
  updateTask(
    id: string,
    values: { reminderAt?: string | null; status?: string },
  ): Promise<void>;
  deleteTask(id: string): Promise<void>;
  setOccurrenceProcessing(
    id: string,
    claimToken: string,
    attemptCount: number,
  ): Promise<void>;
  getOccurrence(taskId: string, scheduledAt: string): Promise<ReminderOccurrenceState | null>;
  getTaskReminder(id: string): Promise<{
    reminderAt: string | null;
    reminderRelative: string | null;
    reminderDueTime: string | null;
  } | null>;
  getArtifacts(): Promise<{
    notifications: Array<{ sourceId: string }>;
    actions: Array<{ actionType: string; sortOrder: number; payload: unknown }>;
    deliveries: Array<{ channel: string; status: string; dedupeKey: string }>;
  }>;
}

async function fire(
  harness: TaskReminderContractHarness,
  claim: ClaimedTaskReminder,
) {
  return harness.repository.fire(claim, {
    now: TASK_REMINDER_BASE_TIME,
    delivery: TASK_REMINDER_DELIVERY_CONTEXT,
  });
}

export function describeTaskReminderRepositoryContract(
  createHarness: () => Promise<TaskReminderContractHarness>,
): void {
  let harness: TaskReminderContractHarness;

  it('fires a missed reminder once and dedupes its notification, actions, and outbox', async () => {
    harness = await createHarness();
    await harness.reset();
    const scheduledAt = '2026-08-31T11:55:00.000Z';
    await harness.seedTask({
      id: 'missed',
      reminderAt: scheduledAt,
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
      recurrence: 'daily',
    });
    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 300_000,
      maxAttempts: 5,
    });
    expect(claim).not.toBeNull();
    await expect(fire(harness, claim!)).resolves.toEqual({
      outcome: 'fired',
      pendingDelivery: false,
    });

    await harness.updateTask('missed', { reminderAt: scheduledAt });
    await harness.setOccurrenceProcessing(claim!.id, 'replay-token', 2);
    await expect(fire(harness, { ...claim!, claimToken: 'replay-token', attemptCount: 2 }))
      .resolves.toEqual({ outcome: 'fired', pendingDelivery: false });

    const artifacts = await harness.getArtifacts();
    expect(artifacts.notifications).toEqual([
      { sourceId: `task-reminder:missed:${scheduledAt}` },
    ]);
    expect(artifacts.actions).toEqual([
      { actionType: 'navigate', sortOrder: 0, payload: { target: '/today?taskId=missed' } },
      { actionType: 'remind_later', sortOrder: 1, payload: {} },
      { actionType: 'complete_task', sortOrder: 2, payload: {} },
      { actionType: 'dismiss_reminder', sortOrder: 3, payload: {} },
    ]);
    expect(artifacts.deliveries).toHaveLength(2);
    expect(new Set(artifacts.deliveries.map((event) => event.channel))).toEqual(
      new Set(['web_push', 'apns']),
    );
    expect(await harness.getTaskReminder('missed')).toEqual({
      reminderAt: null,
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
  });

  it('claims one owner, excludes a live lease, recovers expiry, and fences stale owners', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedTask({
      id: 'ownership',
      reminderAt: '2026-08-31T11:55:00.000Z',
    });

    const [first, concurrent] = await Promise.all([
      harness.repository.claimNext({
        now: TASK_REMINDER_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      }),
      harness.repository.claimNext({
        now: TASK_REMINDER_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      }),
    ]);
    const owner = first ?? concurrent;
    expect(owner).not.toBeNull();
    expect(first === null || concurrent === null).toBe(true);
    expect(await harness.repository.claimNext({
      now: new Date(TASK_REMINDER_BASE_TIME.getTime() + 59_999),
      leaseMs: 60_000,
      maxAttempts: 5,
    })).toBeNull();

    const recovered = await harness.repository.claimNext({
      now: new Date(TASK_REMINDER_BASE_TIME.getTime() + 60_000),
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(recovered).toMatchObject({ taskId: 'ownership', attemptCount: 2 });
    expect(recovered?.claimToken).not.toBe(owner?.claimToken);
    expect(await harness.repository.fail(owner!, {
      now: TASK_REMINDER_BASE_TIME,
      nextAttemptAt: '2026-08-31T12:01:00.000Z',
      lastError: 'stale',
    })).toBe(false);
    await expect(fire(harness, owner!)).resolves.toEqual({
      outcome: 'lost',
      pendingDelivery: false,
    });
    await expect(harness.repository.fire(recovered!, {
      now: new Date(TASK_REMINDER_BASE_TIME.getTime() + 60_000),
      delivery: TASK_REMINDER_DELIVERY_CONTEXT,
    })).resolves.toMatchObject({ outcome: 'fired' });
  });

  it('enforces retry timing, backoff inputs, and five-attempt exhaustion', async () => {
    harness = await createHarness();
    await harness.reset();
    const scheduledAt = '2026-08-31T11:50:00.000Z';
    await harness.seedTask({ id: 'retry', reminderAt: scheduledAt });
    let now = TASK_REMINDER_BASE_TIME;
    let claim = await harness.repository.claimNext({
      now,
      leaseMs: 60_000,
      maxAttempts: 5,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(claim?.attemptCount).toBe(attempt);
      const exhausted = attempt === 5;
      const nextAttemptAt = exhausted
        ? null
        : new Date(now.getTime() + Math.min(15, 2 ** (attempt - 1)) * 60_000).toISOString();
      expect(await harness.repository.fail(claim!, {
        now,
        nextAttemptAt,
        lastError: exhausted ? 'retry_limit_exhausted' : 'transient',
      })).toBe(true);
      if (exhausted) break;
      expect(await harness.repository.claimNext({
        now: new Date(Date.parse(nextAttemptAt!) - 1),
        leaseMs: 60_000,
        maxAttempts: 5,
      })).toBeNull();
      now = new Date(nextAttemptAt!);
      claim = await harness.repository.claimNext({ now, leaseMs: 60_000, maxAttempts: 5 });
    }

    expect(await harness.repository.claimNext({
      now: new Date('2026-09-01T12:00:00.000Z'),
      leaseMs: 60_000,
      maxAttempts: 5,
    })).toBeNull();
    expect(await harness.getOccurrence('retry', scheduledAt)).toMatchObject({
      state: 'failed',
      attemptCount: 5,
      nextAttemptAt: null,
    });
  });

  it('terminalizes an expired final-attempt crash without starving later work', async () => {
    harness = await createHarness();
    await harness.reset();
    const crashedAt = '2026-08-31T11:30:00.000Z';
    await harness.seedTask({ id: 'crashed-final', reminderAt: crashedAt });
    await harness.seedOccurrence({
      id: 'crashed-final-occurrence',
      taskId: 'crashed-final',
      scheduledAt: crashedAt,
      state: 'processing',
      attemptCount: 5,
      claimToken: 'crashed-owner',
      leaseExpiresAt: '2026-08-31T11:59:00.000Z',
    });
    await harness.seedTask({
      id: 'ready-after-crash',
      reminderAt: '2026-08-31T11:45:00.000Z',
    });

    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });

    expect(claim?.taskId).toBe('ready-after-crash');
    expect(await harness.getOccurrence('crashed-final', crashedAt)).toMatchObject({
      state: 'failed',
      attemptCount: 5,
      claimToken: null,
      nextAttemptAt: null,
    });
  });

  it('records invalid values in bounded exhausted rows and orders offsets by instant', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedTask({ id: 'invalid-a', reminderAt: 'not-a-timestamp' });
    await harness.seedTask({ id: 'invalid-b', reminderAt: '2026-99-99T00:00:00Z' });
    await harness.seedTask({ id: 'invalid-local', reminderAt: '2026-08-31 11:00:00' });
    await harness.seedTask({ id: 'invalid-calendar', reminderAt: '2026-02-30T12:00:00Z' });
    expect(await harness.repository.recordInvalidTimestamps({
      now: TASK_REMINDER_BASE_TIME,
      limit: 1,
      maxAttempts: 5,
    })).toBe(1);
    expect(await harness.repository.recordInvalidTimestamps({
      now: TASK_REMINDER_BASE_TIME,
      limit: 1,
      maxAttempts: 5,
    })).toBe(1);
    expect(await harness.repository.recordInvalidTimestamps({
      now: TASK_REMINDER_BASE_TIME,
      limit: 2,
      maxAttempts: 5,
    })).toBe(2);

    await harness.seedTask({ id: 'future-offset', reminderAt: '2026-08-31T08:00:00-07:00' });
    await harness.seedTask({ id: 'due-offset', reminderAt: '2026-08-31T08:00:00+02:00' });
    await harness.seedTask({ id: 'due-z', reminderAt: '2026-08-31T11:30:00.000Z' });
    await harness.seedOccurrence({
      id: 'exhausted-occurrence',
      taskId: 'due-offset',
      scheduledAt: '2026-08-31T08:00:00+02:00',
      state: 'failed',
      attemptCount: 5,
    });

    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(claim?.taskId).toBe('due-z');
    expect(await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    })).toBeNull();
  });

  it('bounds invalidation and cancels a fire-time reschedule', async () => {
    harness = await createHarness();
    await harness.reset();
    for (const id of ['rescheduled', 'completed', 'deleted']) {
      const scheduledAt = `2026-08-31T11:5${id.length % 10}:00.000Z`;
      await harness.seedTask({ id, reminderAt: scheduledAt });
      await harness.seedOccurrence({
        id: `${id}-occurrence`,
        taskId: id,
        scheduledAt,
        state: 'pending',
      });
    }
    await harness.updateTask('rescheduled', { reminderAt: '2026-09-01T12:00:00.000Z' });
    await harness.updateTask('completed', { status: 'done' });
    await harness.deleteTask('deleted');
    expect(await harness.getOccurrence(
      'deleted',
      '2026-08-31T11:57:00.000Z',
    )).toBeNull();
    expect(await harness.repository.cancelInvalidated({
      now: TASK_REMINDER_BASE_TIME,
      limit: 1,
    })).toBe(1);
    expect(await harness.repository.cancelInvalidated({
      now: TASK_REMINDER_BASE_TIME,
      limit: 1,
    })).toBe(1);

    await harness.reset();
    const scheduledAt = '2026-08-31T11:55:00.000Z';
    await harness.seedTask({ id: 'race', reminderAt: scheduledAt });
    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    await harness.updateTask('race', { reminderAt: '2026-09-01T12:00:00.000Z' });
    await expect(fire(harness, claim!)).resolves.toEqual({
      outcome: 'cancelled',
      pendingDelivery: false,
    });
    expect((await harness.getArtifacts()).notifications).toHaveLength(0);
  });

  it('clears all reminder intent for nonrecurring tasks', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedTask({
      id: 'one-shot',
      reminderAt: '2026-08-31T11:55:00.000Z',
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    });
    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    await fire(harness, claim!);
    expect(await harness.getTaskReminder('one-shot')).toEqual({
      reminderAt: null,
      reminderRelative: null,
      reminderDueTime: null,
    });
  });
}
