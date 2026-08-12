import { and, eq, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { notifications } from '@/db/schema';

export const NOTIFICATION_IS_INBOX_SQL = [
  "disposition = 'inbox'",
  "source_state IN ('active', 'unknown')",
  '(snoozed_until IS NULL OR snoozed_until <= ?)',
].join(' AND ');

export const NOTIFICATION_NEEDS_ATTENTION_SQL = [
  NOTIFICATION_IS_INBOX_SQL,
  "read_state = 'unread'",
  "level <> 'digest'",
].join(' AND ');

export function notificationIsInInbox(now = new Date()): SQL {
  return and(
    eq(notifications.disposition, 'inbox'),
    inArray(notifications.sourceState, ['active', 'unknown']),
    or(
      isNull(notifications.snoozedUntil),
      lte(notifications.snoozedUntil, now.toISOString()),
    ),
  )!;
}

export function notificationNeedsAttention(now = new Date()): SQL {
  return and(
    notificationIsInInbox(now),
    eq(notifications.readState, 'unread'),
    or(
      isNull(notifications.level),
      inArray(notifications.level, ['urgent', 'action_needed', 'heads_up', 'fyi']),
    ),
  )!;
}
