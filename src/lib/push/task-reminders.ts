import 'server-only';

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import { taskReminderOccurrences, tasks } from '@/db/schema';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
} from '@/lib/notifications/service';
import logger from '@/lib/logger';

const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;
const CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 100;

type TaskReminderOccurrence = typeof taskReminderOccurrences.$inferSelect;
type ReminderTask = Pick<
  typeof tasks.$inferSelect,
  'id' | 'title' | 'status' | 'reminderAt'
>;

export interface TaskReminderRunResult {
  examined: number;
  claimed: number;
  fired: number;
  cancelled: number;
  failed: number;
}

interface ClaimedReminder {
  occurrence: TaskReminderOccurrence;
  task: ReminderTask;
  claimToken: string;
}

function isDueReminder(reminderAt: string | null, now: Date): reminderAt is string {
  if (!reminderAt) return false;
  const timestamp = Date.parse(reminderAt);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function claimReminder(taskId: string, scheduledAt: string, now: Date): ClaimedReminder | null {
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const claimToken = crypto.randomUUID();

  return runTransaction((tx) => {
    const task = tx.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      reminderAt: tasks.reminderAt,
    }).from(tasks).where(eq(tasks.id, taskId)).get();
    if (
      !task
      || task.reminderAt !== scheduledAt
      || TERMINAL_TASK_STATUSES.includes(task.status as typeof TERMINAL_TASK_STATUSES[number])
      || !isDueReminder(task.reminderAt, now)
    ) {
      return null;
    }

    tx.insert(taskReminderOccurrences).values({
      id: crypto.randomUUID(),
      taskId,
      scheduledAt,
      state: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).onConflictDoNothing().run();

    const claim = tx.update(taskReminderOccurrences).set({
      state: 'processing',
      claimToken,
      claimedAt: nowIso,
      leaseExpiresAt,
      attemptCount: sql`CASE
        WHEN ${taskReminderOccurrences.state} = 'cancelled' THEN 1
        ELSE ${taskReminderOccurrences.attemptCount} + 1
      END`,
      lastError: null,
      nextAttemptAt: null,
      cancelledAt: null,
      updatedAt: nowIso,
    }).where(and(
      eq(taskReminderOccurrences.taskId, taskId),
      eq(taskReminderOccurrences.scheduledAt, scheduledAt),
      or(
        eq(taskReminderOccurrences.state, 'cancelled'),
        lt(taskReminderOccurrences.attemptCount, MAX_ATTEMPTS),
      ),
      or(
        eq(taskReminderOccurrences.state, 'pending'),
        and(
          eq(taskReminderOccurrences.state, 'failed'),
          or(
            isNull(taskReminderOccurrences.nextAttemptAt),
            lte(taskReminderOccurrences.nextAttemptAt, nowIso),
          ),
        ),
        and(
          eq(taskReminderOccurrences.state, 'processing'),
          or(
            isNull(taskReminderOccurrences.leaseExpiresAt),
            lte(taskReminderOccurrences.leaseExpiresAt, nowIso),
          ),
        ),
        eq(taskReminderOccurrences.state, 'cancelled'),
      ),
    )).run();
    if (claim.changes === 0) return null;

    const occurrence = tx.select().from(taskReminderOccurrences).where(
      eq(taskReminderOccurrences.claimToken, claimToken),
    ).get();
    return occurrence ? { occurrence, task, claimToken } : null;
  });
}

function failClaim(claimed: ClaimedReminder, now: Date, error: unknown): void {
  const nowIso = now.toISOString();
  const retryMinutes = Math.min(15, 2 ** Math.max(0, claimed.occurrence.attemptCount - 1));
  const nextAttemptAt = new Date(now.getTime() + retryMinutes * 60 * 1_000).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.update(taskReminderOccurrences).set({
    state: 'failed',
    claimToken: null,
    leaseExpiresAt: null,
    lastError: message.slice(0, 1_000),
    nextAttemptAt,
    updatedAt: nowIso,
  }).where(and(
    eq(taskReminderOccurrences.id, claimed.occurrence.id),
    eq(taskReminderOccurrences.state, 'processing'),
    eq(taskReminderOccurrences.claimToken, claimed.claimToken),
  )).run();
}

function fireClaim(claimed: ClaimedReminder, now: Date): 'fired' | 'cancelled' {
  const nowIso = now.toISOString();
  return runTransaction((tx) => {
    const task = tx.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      reminderAt: tasks.reminderAt,
    }).from(tasks).where(eq(tasks.id, claimed.task.id)).get();
    if (
      !task
      || task.reminderAt !== claimed.occurrence.scheduledAt
      || TERMINAL_TASK_STATUSES.includes(task.status as typeof TERMINAL_TASK_STATUSES[number])
      || !isDueReminder(task.reminderAt, now)
    ) {
      tx.update(taskReminderOccurrences).set({
        state: 'cancelled',
        claimToken: null,
        leaseExpiresAt: null,
        cancelledAt: nowIso,
        lastError: 'Task was completed, cancelled, deleted, or rescheduled before delivery',
        updatedAt: nowIso,
      }).where(and(
        eq(taskReminderOccurrences.id, claimed.occurrence.id),
        eq(taskReminderOccurrences.claimToken, claimed.claimToken),
      )).run();
      return 'cancelled';
    }

    const sourceId = `task-reminder:${task.id}:${claimed.occurrence.scheduledAt}`;
    const [created] = createNotificationsInTransaction(tx, [{
      sourceId,
      connectorType: 'system',
      connectorInstanceId: 'push-triggers',
      title: `Reminder: ${task.title}`,
      body: 'This task is ready for your attention.',
      level: 'heads_up',
      category: 'tasks',
      templateKey: 'task_reminder',
      dedupeKey: sourceId,
      relatedTaskId: task.id,
      relatedEntityType: 'task',
      relatedEntityId: task.id,
      navigationTarget: `/today?taskId=${encodeURIComponent(task.id)}`,
      occurrenceKey: claimed.occurrence.scheduledAt,
      metadata: {
        scheduledAt: claimed.occurrence.scheduledAt,
        reminderOccurrenceId: claimed.occurrence.id,
      },
    }], {
      now,
      wakeDispatcher: false,
    });

    const completed = tx.update(taskReminderOccurrences).set({
      state: 'fired',
      claimToken: null,
      leaseExpiresAt: null,
      firedAt: nowIso,
      notificationId: created.notification.id,
      lastError: null,
      nextAttemptAt: null,
      cancelledAt: null,
      updatedAt: nowIso,
    }).where(and(
      eq(taskReminderOccurrences.id, claimed.occurrence.id),
      eq(taskReminderOccurrences.state, 'processing'),
      eq(taskReminderOccurrences.claimToken, claimed.claimToken),
    )).run();
    if (completed.changes !== 1) {
      throw new Error(`Reminder occurrence "${claimed.occurrence.id}" lost its claim`);
    }

    tx.update(tasks).set({
      reminderAt: null,
      updatedAt: nowIso,
    }).where(and(
      eq(tasks.id, task.id),
      eq(tasks.reminderAt, claimed.occurrence.scheduledAt),
    )).run();
    return 'fired';
  });
}

function cancelInvalidatedOccurrences(now: Date, batchSize: number): number {
  const nowIso = now.toISOString();
  return runTransaction((tx) => {
    const invalidated = tx.select({ id: taskReminderOccurrences.id })
      .from(taskReminderOccurrences)
      .leftJoin(tasks, eq(taskReminderOccurrences.taskId, tasks.id))
      .where(and(
        inArray(taskReminderOccurrences.state, ['pending', 'processing', 'failed']),
        or(
          isNull(tasks.id),
          isNull(tasks.reminderAt),
          ne(tasks.reminderAt, taskReminderOccurrences.scheduledAt),
          inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        ),
      ))
      .orderBy(taskReminderOccurrences.updatedAt)
      .limit(batchSize)
      .all();
    if (invalidated.length === 0) return 0;

    return tx.update(taskReminderOccurrences).set({
      state: 'cancelled',
      claimToken: null,
      leaseExpiresAt: null,
      cancelledAt: nowIso,
      lastError: 'Task was completed, cancelled, deleted, or rescheduled',
      updatedAt: nowIso,
    }).where(and(
      inArray(taskReminderOccurrences.id, invalidated.map(occurrence => occurrence.id)),
      inArray(taskReminderOccurrences.state, ['pending', 'processing', 'failed']),
    )).run().changes;
  });
}

function recordInvalidReminderTimestamps(now: Date, batchSize: number): number {
  const invalidTasks = db.select({
    id: tasks.id,
    reminderAt: tasks.reminderAt,
  }).from(tasks).where(and(
    isNotNull(tasks.reminderAt),
    notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    sql`julianday(${tasks.reminderAt}) IS NULL`,
  )).limit(batchSize).all();
  if (invalidTasks.length === 0) return 0;

  const nowIso = now.toISOString();
  let recorded = 0;
  for (const task of invalidTasks) {
    if (!task.reminderAt) continue;
    recorded += db.insert(taskReminderOccurrences).values({
      id: crypto.randomUUID(),
      taskId: task.id,
      scheduledAt: task.reminderAt,
      state: 'failed',
      attemptCount: MAX_ATTEMPTS,
      lastError: 'Invalid reminder timestamp',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).onConflictDoNothing().run().changes;
  }
  return recorded;
}

export async function runDueTaskReminders(options: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<TaskReminderRunResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 500));
  const result: TaskReminderRunResult = {
    examined: 0,
    claimed: 0,
    fired: 0,
    cancelled: 0,
    failed: 0,
  };
  result.cancelled = cancelInvalidatedOccurrences(now, batchSize);
  result.failed = recordInvalidReminderTimestamps(now, batchSize);

  const candidates = db.select({
    id: tasks.id,
    reminderAt: tasks.reminderAt,
  }).from(tasks).where(and(
    isNotNull(tasks.reminderAt),
    notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    and(
      lte(tasks.reminderAt, now.toISOString()),
      sql`julianday(${tasks.reminderAt}) <= julianday(${now.toISOString()})`,
    ),
    sql`(
      NOT EXISTS (
        SELECT 1 FROM task_reminder_occurrences occurrence
        WHERE occurrence.task_id = ${tasks.id}
          AND occurrence.scheduled_at = ${tasks.reminderAt}
      )
      OR EXISTS (
        SELECT 1 FROM task_reminder_occurrences occurrence
        WHERE occurrence.task_id = ${tasks.id}
          AND occurrence.scheduled_at = ${tasks.reminderAt}
          AND (
            occurrence.state = 'cancelled'
            OR (
              occurrence.state = 'pending'
              AND occurrence.attempt_count < ${MAX_ATTEMPTS}
            )
            OR (
              occurrence.state = 'failed'
              AND occurrence.attempt_count < ${MAX_ATTEMPTS}
              AND (occurrence.next_attempt_at IS NULL OR occurrence.next_attempt_at <= ${now.toISOString()})
            )
            OR (
              occurrence.state = 'processing'
              AND occurrence.attempt_count < ${MAX_ATTEMPTS}
              AND (occurrence.lease_expires_at IS NULL OR occurrence.lease_expires_at <= ${now.toISOString()})
            )
          )
      )
    )`,
  )).orderBy(tasks.reminderAt).limit(batchSize).all();

  result.examined = candidates.length;
  for (const candidate of candidates) {
    if (!isDueReminder(candidate.reminderAt, now)) continue;

    const claimed = claimReminder(candidate.id, candidate.reminderAt, now);
    if (!claimed) continue;
    result.claimed += 1;

    try {
      const outcome = fireClaim(claimed, now);
      result[outcome] += 1;
    } catch (error) {
      failClaim(claimed, now, error);
      result.failed += 1;
      logger.error(
        { err: error, taskId: candidate.id, occurrenceId: claimed.occurrence.id },
        'Task reminder delivery failed',
      );
    }
  }

  if (result.fired > 0) wakeNotificationDeliveryDispatcher();
  return result;
}
