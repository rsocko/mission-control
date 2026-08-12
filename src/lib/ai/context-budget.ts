import db from '@/db';
import { notifications, tasks } from '@/db/schema';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { aiLogger } from '@/lib/logger';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

export const AI_CONTEXT_ROWS_PER_CATEGORY = 5;
export const AI_CONTEXT_MAX_CHARACTERS = 6_000;

const openTaskCondition = sql`${tasks.status} NOT IN ('done', 'cancelled')`;
const priorityOrder = sql`CASE ${tasks.priority}
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  WHEN 'low' THEN 3
  ELSE 4
END`;

const taskSelection = {
  id: tasks.id,
  title: tasks.title,
  priority: tasks.priority,
  dueDate: tasks.dueDate,
  connectorType: tasks.connectorType,
};

export interface AIContextTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
}

export interface AIContextSnapshot {
  counts: {
    open: number;
    overdue: number;
    dueToday: number;
    inProgress: number;
    critical: number;
    unreadNotifications: number;
    urgentNotifications: number;
  };
  overdue: AIContextTask[];
  dueToday: AIContextTask[];
  inProgress: AIContextTask[];
  notifications: Array<{
    id: string;
    title: string;
    level: string;
    connectorType: string;
  }>;
  sources: string[];
  rowCount: number;
}

export async function loadAIContextSnapshot(today: string): Promise<AIContextSnapshot> {
  const [
    taskCounts,
    overdue,
    dueToday,
    inProgress,
    notificationCounts,
    notificationRows,
  ] = await Promise.all([
    db.select({
      open: sql<number>`COUNT(*)`,
      overdue: sql<number>`COALESCE(SUM(CASE WHEN ${tasks.dueDate} < ${today} THEN 1 ELSE 0 END), 0)`,
      dueToday: sql<number>`COALESCE(SUM(CASE WHEN ${tasks.dueDate} = ${today} THEN 1 ELSE 0 END), 0)`,
      inProgress: sql<number>`COALESCE(SUM(CASE WHEN ${tasks.status} = 'in_progress' THEN 1 ELSE 0 END), 0)`,
      critical: sql<number>`COALESCE(SUM(CASE WHEN ${tasks.priority} IN ('critical', 'high') THEN 1 ELSE 0 END), 0)`,
    }).from(tasks).where(openTaskCondition),
    db.select(taskSelection)
      .from(tasks)
      .where(and(openTaskCondition, lt(tasks.dueDate, today)))
      .orderBy(asc(tasks.dueDate), priorityOrder, asc(tasks.id))
      .limit(AI_CONTEXT_ROWS_PER_CATEGORY),
    db.select(taskSelection)
      .from(tasks)
      .where(and(openTaskCondition, eq(tasks.dueDate, today)))
      .orderBy(priorityOrder, desc(tasks.updatedAt), asc(tasks.id))
      .limit(AI_CONTEXT_ROWS_PER_CATEGORY),
    db.select(taskSelection)
      .from(tasks)
      .where(and(openTaskCondition, eq(tasks.status, 'in_progress')))
      .orderBy(priorityOrder, desc(tasks.updatedAt), asc(tasks.id))
      .limit(AI_CONTEXT_ROWS_PER_CATEGORY),
    db.select({
      unread: sql<number>`COUNT(*)`,
      urgent: sql<number>`COALESCE(SUM(CASE WHEN ${notifications.level} IN ('critical', 'urgent') THEN 1 ELSE 0 END), 0)`,
    }).from(notifications).where(notificationNeedsAttention()),
    db.select({
      id: notifications.id,
      title: notifications.title,
      level: notifications.level,
      connectorType: notifications.connectorType,
    })
      .from(notifications)
      .where(notificationNeedsAttention())
      .orderBy(asc(notifications.levelRank), desc(notifications.receivedAt), asc(notifications.id))
      .limit(AI_CONTEXT_ROWS_PER_CATEGORY),
  ]);

  const taskAggregate = taskCounts[0];
  const notificationAggregate = notificationCounts[0];
  const sources = [...new Set([
    ...overdue,
    ...dueToday,
    ...inProgress,
    ...notificationRows,
  ].map((row) => row.connectorType))];
  const rowCount = overdue.length + dueToday.length + inProgress.length + notificationRows.length;

  return {
    counts: {
      open: Number(taskAggregate?.open ?? 0),
      overdue: Number(taskAggregate?.overdue ?? 0),
      dueToday: Number(taskAggregate?.dueToday ?? 0),
      inProgress: Number(taskAggregate?.inProgress ?? 0),
      critical: Number(taskAggregate?.critical ?? 0),
      unreadNotifications: Number(notificationAggregate?.unread ?? 0),
      urgentNotifications: Number(notificationAggregate?.urgent ?? 0),
    },
    overdue,
    dueToday,
    inProgress,
    notifications: notificationRows,
    sources,
    rowCount,
  };
}

export function applyAIContextCharacterBudget(context: string, featureId: string): string {
  const bounded = context.length <= AI_CONTEXT_MAX_CHARACTERS
    ? context
    : `${context.slice(0, AI_CONTEXT_MAX_CHARACTERS - 24)}\n[Context truncated]`;
  aiLogger.info({
    event: 'ai_context_built',
    featureId,
    contextCharacters: bounded.length,
    contextTruncated: bounded.length < context.length,
  }, 'Built bounded AI context');
  return bounded;
}
