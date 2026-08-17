import { NextResponse } from 'next/server';
import { and, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import db from '@/db';
import {
  myDayItems,
  notifications,
  scoutReconciliationSuggestions,
  tasks,
  triageItems,
} from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import { notificationIsInInbox, notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';
import { getNotificationBadgeTone, type NavigationCounts } from '@/lib/navigation/badges';
import { getLocalToday } from '@/lib/utils/date';

export async function GET() {
  try {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const today = getLocalToday();
    const visibleTask = and(
      sql`${tasks.connectorInstanceId} NOT IN (
        SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
      )`,
      notInArray(tasks.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
    );
    const openTask = notInArray(tasks.status, ['done', 'cancelled']);
    const availableTask = or(isNull(tasks.snoozedUntil), lte(tasks.snoozedUntil, now));
    const activeNotificationConnector = sql`${notifications.connectorInstanceId} NOT IN (
      SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
    )`;
    const inboxCondition = notificationIsInInbox(nowDate);
    const attentionCondition = notificationNeedsAttention(nowDate);

    const [
      myDayRows,
      notificationRows,
      triageRows,
      quickSortRows,
      reconciliationRows,
      overdueRows,
    ] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)` })
        .from(myDayItems)
        .innerJoin(tasks, eq(tasks.id, myDayItems.taskId))
        .where(and(eq(myDayItems.date, today), visibleTask, openTask)),
      db.select({
        attention: sql<number>`COALESCE(SUM(CASE WHEN ${attentionCondition} THEN 1 ELSE 0 END), 0)`,
        unread: sql<number>`COALESCE(SUM(CASE WHEN ${inboxCondition} AND ${notifications.readState} = 'unread' THEN 1 ELSE 0 END), 0)`,
        urgent: sql<number>`COALESCE(SUM(CASE WHEN ${attentionCondition} AND ${notifications.level} = 'urgent' THEN 1 ELSE 0 END), 0)`,
        actionNeeded: sql<number>`COALESCE(SUM(CASE WHEN ${attentionCondition} AND ${notifications.level} = 'action_needed' THEN 1 ELSE 0 END), 0)`,
      }).from(notifications).where(activeNotificationConnector),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(triageItems)
        .where(eq(triageItems.status, 'pending')),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(tasks)
        .where(and(
          visibleTask,
          openTask,
          isNull(tasks.parentId),
          availableTask,
          eq(tasks.priority, 'none'),
        )),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(scoutReconciliationSuggestions)
        .innerJoin(tasks, eq(tasks.id, scoutReconciliationSuggestions.taskId))
        .where(and(
          eq(scoutReconciliationSuggestions.status, 'pending'),
          gt(scoutReconciliationSuggestions.expiresAt, now),
          inArray(tasks.status, ['todo', 'in_progress']),
        )),
      db.select({ count: sql<number>`COUNT(*)` })
        .from(tasks)
        .where(and(visibleTask, openTask, sql`${tasks.dueDate} < ${today}`)),
    ]);

    const notificationsCount = Number(notificationRows[0]?.attention ?? 0);
    const urgentCount = Number(notificationRows[0]?.urgent ?? 0);
    const actionNeededCount = Number(notificationRows[0]?.actionNeeded ?? 0);
    const response: NavigationCounts = {
      myDay: Number(myDayRows[0]?.count ?? 0),
      notifications: notificationsCount,
      triage: Number(triageRows[0]?.count ?? 0),
      quickSort: Number(quickSortRows[0]?.count ?? 0),
      reconciliation: Number(reconciliationRows[0]?.count ?? 0),
      overdue: Number(overdueRows[0]?.count ?? 0),
      unreadNotifications: Number(notificationRows[0]?.unread ?? 0),
      notificationTone: getNotificationBadgeTone(urgentCount, actionNeededCount),
    };

    return NextResponse.json(response);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch navigation counts', error);
  }
}
