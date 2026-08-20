/**
 * Push notification triggers.
 *
 * These functions are called from a scheduled job (e.g., cron route)
 * to send contextual push notifications at the right times.
 *
 * All triggers pass through the quiet-hours gate (#1542) before sending.
 *
 * Refs: #1539, #1540, #1541, #1542
 */
import db from '@/db';
import { tasks, myDayItems, notifications, triageItems } from '@/db/schema';
import { eq, and, lt, ne, inArray, like, sql } from 'drizzle-orm';
import { getPreferences } from '@/lib/notifications/quiet-hours';
import {
  createNotification,
  type CreateNotificationResult,
  type MissionControlPushPayload,
} from '@/lib/notifications';
import { getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';

type ScheduledPushPayload = Omit<MissionControlPushPayload, 'notificationId' | 'body'> & {
  body: string;
};

/**
 * Write a notification record to the notifications table so it shows
 * in the mobile notification screen alongside push delivery.
 *
 * Uses a date-based dedupeKey for daily idempotency — if a notification
 * with the same dedupeKey already exists, the insert is skipped and
 * the function returns null (caller should skip push delivery).
 */
async function writeNotificationRecord(opts: {
  title: string;
  body: string;
  templateKey: string;
  category: string;
  level: 'fyi' | 'heads_up';
  navigationTarget?: string;
  occurrenceKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<CreateNotificationResult> {
  const today = getLocalToday();
  const dedupeKey = `push:${opts.templateKey}:${today}`;
  return createNotification({
    sourceId: opts.occurrenceKey ? `${dedupeKey}:${opts.occurrenceKey}` : dedupeKey,
    connectorType: 'system',
    connectorInstanceId: 'push-triggers',
    title: opts.title,
    body: opts.body,
    level: opts.level,
    category: opts.category,
    templateKey: opts.templateKey,
    dedupeKey,
    navigationTarget: opts.navigationTarget,
    occurrenceKey: opts.occurrenceKey,
    metadata: opts.metadata,
  });
}

function parseTriageNudgeCount(
  row: Pick<typeof notifications.$inferSelect, 'sourceId' | 'metadata'>,
  sourcePrefix: string,
): number | null {
  const metadata = row.metadata && typeof row.metadata === 'object'
    ? row.metadata as Record<string, unknown>
    : {};
  const metadataCount = metadata.queueSize;
  if (typeof metadataCount === 'number' && Number.isInteger(metadataCount) && metadataCount >= 0) {
    return metadataCount;
  }

  const sourceCount = Number(row.sourceId.slice(sourcePrefix.length));
  return Number.isInteger(sourceCount) && sourceCount >= 0 ? sourceCount : null;
}

export async function getTriageNudgeHighWater(today = getLocalToday()): Promise<number | null> {
  const sourcePrefix = `push:triage_nudge:${today}:`;
  const priorNudges = await db.select({
    sourceId: notifications.sourceId,
    metadata: notifications.metadata,
  }).from(notifications).where(and(
    eq(notifications.connectorType, 'system'),
    eq(notifications.connectorInstanceId, 'push-triggers'),
    eq(notifications.templateKey, 'triage_nudge'),
    like(notifications.sourceId, `${sourcePrefix}%`),
  ));

  let highWater: number | null = null;
  for (const row of priorNudges) {
    const count = parseTriageNudgeCount(row, sourcePrefix);
    if (count !== null && (highWater === null || count > highWater)) highWater = count;
  }
  return highWater;
}

/**
 * Fetch calendar events for today from the calendar-events API.
 * Returns a summary string for the morning notification.
 */
async function getCalendarSummary(): Promise<{ count: number; summary: string }> {
  try {
    const today = getLocalToday();
    // Use internal API to get calendar events (same data the dashboard uses)
    const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3099';
    const res = await fetch(`${baseUrl}/api/calendar-events?date=${today}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { count: 0, summary: '' };

    const data = await res.json();
    const events = (data.events || []) as Array<{ subject: string; startTime: string; endTime: string; isAllDay: boolean }>;

    if (events.length === 0) return { count: 0, summary: '' };

    // Only count non-all-day events as "meetings"
    const timeEvents = events.filter(e => !e.isAllDay);
    if (timeEvents.length === 0) return { count: 0, summary: '' };

    const preview = timeEvents.slice(0, 3);
    const lines = preview.map(e => `${e.startTime} ${e.subject}`);
    const suffix = timeEvents.length > 3 ? ` (+${timeEvents.length - 3} more)` : '';

    return {
      count: timeEvents.length,
      summary: lines.join(', ') + suffix,
    };
  } catch {
    return { count: 0, summary: '' };
  }
}

/**
 * #1539 — Morning "Start My Day" notification.
 *
 * Checks tasks due today, overdue items, and calendar blocks.
 * Generates a summary notification to kick off the day.
 */
export async function triggerMorningNotification(): Promise<boolean> {
  const prefs = await getPreferences();
  if (!prefs.morningEnabled) return false;

  const today = getLocalToday();

  // 1. Tasks due today
  const todayMyDay = await db.select({ taskId: myDayItems.taskId })
    .from(myDayItems)
    .where(eq(myDayItems.date, today))
    .limit(50);

  const todayTaskIds = todayMyDay.map(i => i.taskId);
  let plannedCount = 0;
  if (todayTaskIds.length > 0) {
    const plannedTasks = await db.select({ id: tasks.id })
      .from(tasks)
      .where(and(
        inArray(tasks.id, todayTaskIds),
        ne(tasks.status, 'done'),
        ne(tasks.status, 'cancelled'),
      ));
    plannedCount = plannedTasks.length;
  }

  // 2. Overdue tasks (due before today, not completed/cancelled)
  const overdueTasks = await db.select({ id: tasks.id })
    .from(tasks)
    .where(and(
      lt(tasks.dueDate, today),
      ne(tasks.status, 'done'),
      ne(tasks.status, 'cancelled'),
    ))
    .limit(100);
  const overdueCount = overdueTasks.length;

  // 3. Calendar events
  const calendar = await getCalendarSummary();

  // Build notification body
  const parts: string[] = [];
  if (plannedCount > 0) {
    parts.push(`${plannedCount} ${plannedCount === 1 ? 'task' : 'tasks'} planned`);
  }
  if (overdueCount > 0) {
    parts.push(`${overdueCount} overdue`);
  }
  if (calendar.count > 0) {
    parts.push(`${calendar.count} ${calendar.count === 1 ? 'meeting' : 'meetings'}`);
  }

  let body: string;
  if (parts.length > 0) {
    body = parts.join(' · ');
    if (calendar.summary) {
      body += `\n📅 ${calendar.summary}`;
    }
  } else {
    body = 'No tasks planned yet — check your suggestions.';
  }

  const payload: ScheduledPushPayload = {
    title: '☀️ Start Your Day',
    body,
    tag: 'morning-start',
    url: '/today',
  };

  // Write to notifications table (idempotent — skips if already sent today)
  const result = await writeNotificationRecord({
    title: payload.title,
    body: payload.body,
    templateKey: 'morning_start_day',
    category: 'tasks',
    level: 'fyi',
    navigationTarget: '/today',
  });

  logger.info(
    {
      notificationId: result.notification.id,
      deliveryStatus: result.deliveryEvent?.status ?? 'ineligible',
      deliveryChannels: result.deliveryEvents.map(event => ({
        channel: event.channel,
        status: event.status,
      })),
      plannedCount,
      overdueCount,
      calendarCount: calendar.count,
    },
    'Morning notification created',
  );
  return result.created && result.deliveryEvents.some(event => event.status === 'pending');
}

/**
 * #1540 — Triage queue threshold nudge.
 *
 * Sends a notification when unprocessed triage items exceed the threshold.
 * Includes deduplication to prevent re-notifying for the same breach.
 */
export async function triggerTriageNudge(): Promise<boolean> {
  const prefs = await getPreferences();
  if (!prefs.triageNudgeEnabled) return false;

  // Count unprocessed triage items using SQL COUNT for accuracy
  const [{ count: rawCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'));

  const count = Number(rawCount);
  const threshold = prefs.triageNudgeThreshold ?? 5;
  if (count < threshold) return false;

  const today = getLocalToday();
  const highWater = await getTriageNudgeHighWater(today);
  if (highWater !== null && count <= highWater) {
    logger.info({ count, highWater }, 'Triage nudge skipped (queue has not grown)');
    return false;
  }

  const payload: ScheduledPushPayload = {
    title: '📥 Triage Queue',
    body: `${count} items waiting for review. Quick triage session?`,
    tag: 'triage-nudge',
    url: '/triage',
  };

  const result = await writeNotificationRecord({
    title: payload.title,
    body: payload.body,
    templateKey: 'triage_nudge',
    category: 'tasks',
    level: 'heads_up',
    navigationTarget: '/triage',
    occurrenceKey: String(count),
    metadata: { queueSize: count },
  });
  logger.info(
    {
      notificationId: result.notification.id,
      deliveryStatus: result.deliveryEvent?.status ?? 'ineligible',
      deliveryChannels: result.deliveryEvents.map(event => ({
        channel: event.channel,
        status: event.status,
      })),
      queueSize: count,
    },
    'Triage nudge created',
  );
  return result.created && result.deliveryEvents.some(event => event.status === 'pending');
}

/**
 * #1541 — End-of-day carry-forward reminder.
 *
 * Checks for tasks that were scheduled for today but not completed.
 * Generates notification listing the incomplete count.
 */
export async function triggerCarryForwardReminder(): Promise<boolean> {
  const prefs = await getPreferences();
  if (!prefs.carryForwardEnabled) return false;

  const today = getLocalToday();

  // Get today's My Day items
  const todayMyDay = await db.select({ taskId: myDayItems.taskId })
    .from(myDayItems)
    .where(eq(myDayItems.date, today))
    .limit(50);

  const todayTaskIds = todayMyDay.map(i => i.taskId);
  if (todayTaskIds.length === 0) return false;

  // Find incomplete tasks among today's items (exclude done and cancelled)
  const incompleteTasks = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(
      inArray(tasks.id, todayTaskIds),
      ne(tasks.status, 'done'),
      ne(tasks.status, 'cancelled'),
    ));

  const incompleteCount = incompleteTasks.length;
  if (incompleteCount === 0) return false;

  // Build body with up to 3 task names for context
  const preview = incompleteTasks.slice(0, 3).map(t => t.title);
  let body = `${incompleteCount} ${incompleteCount === 1 ? 'task remains' : 'tasks remain'} incomplete.`;
  if (preview.length > 0) {
    body += '\n• ' + preview.join('\n• ');
    if (incompleteCount > 3) {
      body += `\n…and ${incompleteCount - 3} more`;
    }
  }
  body += '\nCarry forward to tomorrow?';

  const payload: ScheduledPushPayload = {
    title: '🌙 End of Day',
    body,
    tag: 'carry-forward',
    url: '/today',
  };

  // Write to notifications table (idempotent — skips if already sent today)
  const result = await writeNotificationRecord({
    title: payload.title,
    body: payload.body,
    templateKey: 'carry_forward',
    category: 'tasks',
    level: 'heads_up',
    navigationTarget: '/today',
  });

  logger.info(
    {
      notificationId: result.notification.id,
      deliveryStatus: result.deliveryEvent?.status ?? 'ineligible',
      deliveryChannels: result.deliveryEvents.map(event => ({
        channel: event.channel,
        status: event.status,
      })),
      incompleteCount,
    },
    'Carry-forward notification created',
  );
  return result.created && result.deliveryEvents.some(event => event.status === 'pending');
}
