/**
 * Shared Stats Computation Engine for Mission Control.
 *
 * Provides a unified stats service consumed by:
 * - Dashboard KPI cards
 * - /insights page
 * - Weekly/Monthly Reset
 * - AI agents (daily digest, smart priority)
 *
 * Each metric is self-contained with a slug, computation function,
 * and typed result. Callers request the slugs they need and receive
 * a typed map of results — only requested metrics are computed.
 */

import db from '@/db';
import { tasks, notifications, myDayItems, focusItems, routines, routineCompletions, triageItems } from '@/db/schema';
import { and, eq, gte, lt, lte, sql, notInArray, inArray, isNotNull } from 'drizzle-orm';
import { getLocalToday, getLocalDaysFromNow, getLocalDayBoundsISO } from '@/lib/utils/date';
import type { CadenceConfig } from '@/lib/routines/streaks';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

// ─── Types ──────────────────────────────────────────────────────────────────

export type KpiSlug =
  | 'total-open'
  | 'overdue'
  | 'due-this-week'
  | 'unread-notifications'
  | 'my-day'
  | 'high-priority'
  | 'assigned-to-me'
  | 'completed-today'
  | 'this-week-progress'
  | 'routines-kept'
  | 'streak'
  | 'focus-3'
  | 'daily-avg'
  | 'triage-pending'
  | 'triage-stale'
  | 'doc-actions-pending'
  | 'doc-statements-missing'
  | 'doc-eob-unmatched';

export type KpiVisualType = 'counter' | 'fraction' | 'percentage' | 'sparkline' | 'dot-status';

export interface KpiResult {
  slug: KpiSlug;
  label: string;
  value: number;
  max?: number;
  type: KpiVisualType;
  accent: string;
  detail?: string;
  /** For sparkline-type KPIs, an array of recent data points */
  sparkline?: number[];
  /** For dot-status KPIs, individual dot states */
  dots?: boolean[];
}

export interface StatsSnapshot {
  computedAt: string;
  today: string;
  kpis: Record<string, KpiResult>;
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return fmtDate(d);
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekSunday(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return fmtDate(d);
}

function getDaysAgo(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

function getTodayBounds() {
  return getLocalDayBoundsISO();
}

// ─── Open-task base condition ───────────────────────────────────────────────

const openCondition = notInArray(tasks.status, ['done', 'cancelled']);

async function countOpen(extra?: ReturnType<typeof eq>): Promise<number> {
  const where = extra ? and(openCondition, extra) : openCondition;
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(where);
  return Number(row?.count ?? 0);
}

// ─── Individual KPI Computations ────────────────────────────────────────────

async function computeTotalOpen(): Promise<KpiResult> {
  const value = await countOpen();
  return { slug: 'total-open', label: 'Total Open', value, type: 'counter', accent: 'blue' };
}

async function computeOverdue(today: string): Promise<KpiResult> {
  const value = await countOpen(lt(tasks.dueDate, today));
  return {
    slug: 'overdue', label: 'Overdue', value, type: 'counter',
    accent: value > 0 ? 'red' : 'green',
  };
}

async function computeDueThisWeek(today: string, weekFromNow: string): Promise<KpiResult> {
  const value = await countOpen(and(gte(tasks.dueDate, today), lte(tasks.dueDate, weekFromNow)));
  return { slug: 'due-this-week', label: 'Due This Week', value, type: 'counter', accent: 'amber' };
}

async function computeUnreadAlerts(): Promise<KpiResult> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(notificationNeedsAttention());
  return { slug: 'unread-notifications', label: 'Unread Notifications', value: Number(row?.count ?? 0), type: 'counter', accent: 'orange' };
}

async function computeMyDay(today: string): Promise<KpiResult> {
  const rows = await db.select({ taskId: myDayItems.taskId })
    .from(myDayItems)
    .where(eq(myDayItems.date, today));
  const myDayTaskIds = rows.map(r => r.taskId);
  if (myDayTaskIds.length === 0) {
    return { slug: 'my-day', label: 'My Day', value: 0, type: 'counter', accent: 'cyan' };
  }
  const value = await countOpen(inArray(tasks.id, myDayTaskIds));
  return { slug: 'my-day', label: 'My Day', value, type: 'counter', accent: 'cyan' };
}

async function computeHighPriority(): Promise<KpiResult> {
  const value = await countOpen(inArray(tasks.priority, ['high', 'critical']));
  return {
    slug: 'high-priority', label: 'High Priority', value, type: 'counter',
    accent: value > 0 ? 'orange' : 'green',
  };
}

async function computeAssignedToMe(): Promise<KpiResult> {
  const value = await countOpen(isNotNull(tasks.assignee));
  return { slug: 'assigned-to-me', label: 'Assigned to Me', value, type: 'counter', accent: 'indigo' };
}

async function computeCompletedToday(): Promise<KpiResult> {
  const { todayStart, tomorrowStart } = getTodayBounds();
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.status, 'done'), gte(tasks.completedAt, todayStart), lt(tasks.completedAt, tomorrowStart)));
  return { slug: 'completed-today', label: 'Done Today', value: Number(row?.count ?? 0), type: 'counter', accent: 'emerald' };
}

async function computeThisWeekProgress(today: string): Promise<KpiResult> {
  const monday = getWeekMonday(today);
  const sunday = getWeekSunday(monday);
  const mondayISO = monday + 'T00:00:00.000Z';
  const sundayISO = sunday + 'T23:59:59.999Z';

  // Tasks due this week (open or completed)
  const [totalRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      sql`${tasks.status} != 'cancelled'`,
      gte(tasks.dueDate, monday),
      lte(tasks.dueDate, sunday),
    ));

  // Completed this week
  const [doneRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, mondayISO),
      lte(tasks.completedAt, sundayISO),
    ));

  const total = Number(totalRow?.count ?? 0);
  const done = Number(doneRow?.count ?? 0);
  const safeTotal = Math.max(total, done);

  return {
    slug: 'this-week-progress', label: 'This Week', value: done, max: safeTotal, type: 'fraction',
    accent: 'blue', detail: `${done}/${safeTotal} tasks`,
  };
}

async function computeRoutinesKept(today: string): Promise<KpiResult> {
  const monday = getWeekMonday(today);
  const sunday = getWeekSunday(monday);

  const activeRoutines = await db.select()
    .from(routines)
    .where(and(eq(routines.isActive, true), eq(routines.isArchived, false)));

  if (activeRoutines.length === 0) {
    return { slug: 'routines-kept', label: 'Routines', value: 0, max: 0, type: 'percentage', accent: 'green' };
  }

  const weekCompletions = await db.select()
    .from(routineCompletions)
    .where(and(gte(routineCompletions.date, monday), lte(routineCompletions.date, sunday)));

  let totalExpected = 0;
  let totalCompleted = 0;

  for (const routine of activeRoutines) {
    const config = (routine.cadenceConfig || {}) as CadenceConfig;
    const routineWeekComps = weekCompletions.filter(c => c.routineId === routine.id);
    const uniqueDays = new Set(routineWeekComps.map(c => c.date)).size;

    switch (routine.cadenceType) {
      case 'daily':
        totalExpected += 7;
        totalCompleted += uniqueDays;
        break;
      case 'specific_days':
        totalExpected += (config.days?.length ?? 0);
        totalCompleted += uniqueDays;
        break;
      case 'x_per_week':
        totalExpected += (config.target ?? 1);
        totalCompleted += uniqueDays;
        break;
      case 'weekly':
      case 'every_n_days':
        totalExpected += 1;
        totalCompleted += uniqueDays > 0 ? 1 : 0;
        break;
      default:
        break;
    }
  }

  const pct = totalExpected > 0 ? Math.round((totalCompleted / totalExpected) * 100) : 0;
  return {
    slug: 'routines-kept', label: 'Routines', value: pct, max: 100, type: 'percentage',
    accent: pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'red',
    detail: `${totalCompleted}/${totalExpected} this week`,
  };
}

async function computeStreak(today: string): Promise<KpiResult> {
  const daysToCheck = 90;
  const startDate = getDaysAgo(today, daysToCheck);

  const completions = await db.select({
    completedDate: sql<string>`date(${tasks.completedAt})`,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, startDate + 'T00:00:00.000Z'),
    ))
    .groupBy(sql`date(${tasks.completedAt})`);

  const completedDates = new Set(completions.map(c => c.completedDate).filter(Boolean));

  let streak = 0;
  const d = new Date(today + 'T12:00:00');

  for (let i = 0; i < daysToCheck; i++) {
    const dateStr = fmtDate(d);
    if (completedDates.has(dateStr)) {
      streak++;
    } else if (i === 0) {
      // Allow today to not have completions yet
      d.setDate(d.getDate() - 1);
      continue;
    } else {
      break;
    }
    d.setDate(d.getDate() - 1);
  }

  // 7-day dot indicators
  const dots: boolean[] = [];
  const dotDate = new Date(today + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    dots.unshift(completedDates.has(fmtDate(dotDate)));
    dotDate.setDate(dotDate.getDate() - 1);
  }

  return {
    slug: 'streak', label: 'Streak', value: streak, type: 'counter',
    accent: streak >= 7 ? 'green' : streak >= 3 ? 'amber' : 'slate',
    detail: `${streak} day${streak !== 1 ? 's' : ''}`,
    dots,
  };
}

async function computeFocus3(today: string): Promise<KpiResult> {
  const items = await db.select({
    id: focusItems.id,
    status: tasks.status,
  })
    .from(focusItems)
    .innerJoin(tasks, eq(focusItems.taskId, tasks.id))
    .where(and(eq(focusItems.scope, 'today'), eq(focusItems.date, today)));

  const total = items.length;
  const done = items.filter(i => i.status === 'done').length;

  const dots = items.map(i => i.status === 'done');
  while (dots.length < 3) dots.push(false);

  return {
    slug: 'focus-3', label: 'Focus 3', value: done, max: Math.min(total, 3), type: 'fraction',
    accent: done >= 3 ? 'green' : done >= 1 ? 'blue' : 'slate',
    detail: `${done}/${Math.min(total, 3)} today`,
    dots: dots.slice(0, 3),
  };
}

async function computeDailyAvg(today: string): Promise<KpiResult> {
  const days = 7;
  const sparkline: number[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = getDaysAgo(today, i);
    const nextDate = i > 0 ? getDaysAgo(today, i - 1) : today;
    const nextDateISO = i === 0
      ? new Date(new Date(today + 'T12:00:00').getTime() + 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z'
      : nextDate + 'T00:00:00.000Z';

    const [row] = await db.select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(
        eq(tasks.status, 'done'),
        gte(tasks.completedAt, date + 'T00:00:00.000Z'),
        lt(tasks.completedAt, nextDateISO),
      ));
    sparkline.push(Number(row?.count ?? 0));
  }

  const avg = sparkline.length > 0 ? sparkline.reduce((a, b) => a + b, 0) / sparkline.length : 0;

  return {
    slug: 'daily-avg', label: 'Daily Avg', value: Math.round(avg * 10) / 10, type: 'counter',
    accent: 'purple', detail: `${(Math.round(avg * 10) / 10)} tasks/day`,
    sparkline,
  };
}

async function computeTriagePending(): Promise<KpiResult> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'));
  const value = Number(row?.count ?? 0);
  return {
    slug: 'triage-pending', label: 'Triage Pending', value, type: 'counter',
    accent: value > 5 ? 'amber' : 'slate',
  };
}

async function computeTriageStale(): Promise<KpiResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(triageItems)
    .where(and(eq(triageItems.status, 'pending'), lt(triageItems.capturedAt, sevenDaysAgo)));
  const value = Number(row?.count ?? 0);
  return {
    slug: 'triage-stale', label: 'Triage Stale', value, type: 'counter',
    accent: value > 0 ? 'red' : 'slate',
  };
}

async function computeDocActionsPending(): Promise<KpiResult> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      eq(tasks.connectorType, 'document-intelligence'),
      notInArray(tasks.status, ['done', 'cancelled']),
    ));
  const value = Number(row?.count ?? 0);
  return {
    slug: 'doc-actions-pending', label: 'Doc Actions', value, type: 'counter',
    accent: value > 3 ? 'indigo' : 'slate',
  };
}

async function computeDocStatementsMissing(): Promise<KpiResult> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(
      eq(notifications.connectorType, 'document-intelligence'),
      notificationNeedsAttention(),
      eq(notifications.category, 'document'),
    ));
  const value = Number(row?.count ?? 0);
  return {
    slug: 'doc-statements-missing', label: 'Missing Stmts', value, type: 'counter',
    accent: value > 0 ? 'purple' : 'slate',
  };
}

async function computeDocEobUnmatched(): Promise<KpiResult> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(
      eq(notifications.connectorType, 'document-intelligence'),
      notificationNeedsAttention(),
      eq(notifications.category, 'medical'),
    ));
  const value = Number(row?.count ?? 0);
  return {
    slug: 'doc-eob-unmatched', label: 'Unmatched EOBs', value, type: 'counter',
    accent: value > 0 ? 'pink' : 'slate',
  };
}

// ─── KPI Registry ───────────────────────────────────────────────────────────

type KpiComputer = (today: string, weekFromNow: string) => Promise<KpiResult>;

const KPI_REGISTRY: Record<KpiSlug, KpiComputer> = {
  'total-open': () => computeTotalOpen(),
  'overdue': (today) => computeOverdue(today),
  'due-this-week': (today, weekFromNow) => computeDueThisWeek(today, weekFromNow),
  'unread-notifications': () => computeUnreadAlerts(),
  'my-day': (today) => computeMyDay(today),
  'high-priority': () => computeHighPriority(),
  'assigned-to-me': () => computeAssignedToMe(),
  'completed-today': () => computeCompletedToday(),
  'this-week-progress': (today) => computeThisWeekProgress(today),
  'routines-kept': (today) => computeRoutinesKept(today),
  'streak': (today) => computeStreak(today),
  'focus-3': (today) => computeFocus3(today),
  'daily-avg': (today) => computeDailyAvg(today),
  'triage-pending': () => computeTriagePending(),
  'triage-stale': () => computeTriageStale(),
  'doc-actions-pending': () => computeDocActionsPending(),
  'doc-statements-missing': () => computeDocStatementsMissing(),
  'doc-eob-unmatched': () => computeDocEobUnmatched(),
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a subset of KPI metrics. Only requested slugs are evaluated.
 */
export async function computeKpis(
  slugs?: KpiSlug[],
  options?: { today?: string },
): Promise<StatsSnapshot> {
  const today = options?.today ?? getLocalToday();
  const weekFromNow = getLocalDaysFromNow(7);

  const requested = slugs && slugs.length > 0
    ? slugs.filter((s): s is KpiSlug => s in KPI_REGISTRY)
    : (Object.keys(KPI_REGISTRY) as KpiSlug[]);

  const results = await Promise.all(
    requested.map(slug => KPI_REGISTRY[slug](today, weekFromNow)),
  );

  const kpis = Object.fromEntries(results.map(r => [r.slug, r])) as Record<string, KpiResult>;

  return { computedAt: new Date().toISOString(), today, kpis };
}

/**
 * Convenience: compute a single KPI and return its result.
 */
export async function computeKpi(slug: KpiSlug, options?: { today?: string }): Promise<KpiResult> {
  const snapshot = await computeKpis([slug], options);
  return snapshot.kpis[slug];
}

/** All valid KPI slugs for validation */
export const ALL_KPI_SLUGS: KpiSlug[] = Object.keys(KPI_REGISTRY) as KpiSlug[];

/** KPI metadata for the settings UI / card registry */
export const KPI_CATALOG: Array<{
  slug: KpiSlug;
  label: string;
  category: 'counts' | 'progress' | 'integrations';
  type: KpiVisualType;
  description: string;
}> = [
  { slug: 'total-open', label: 'Total Open', category: 'counts', type: 'counter', description: 'All open tasks across sources' },
  { slug: 'overdue', label: 'Overdue', category: 'counts', type: 'counter', description: 'Tasks past their due date' },
  { slug: 'due-this-week', label: 'Due This Week', category: 'counts', type: 'counter', description: 'Tasks due within 7 days' },
  { slug: 'unread-notifications', label: 'Unread Notifications', category: 'counts', type: 'counter', description: 'Unread notifications' },
  { slug: 'my-day', label: 'My Day', category: 'counts', type: 'counter', description: 'Tasks in your My Day list' },
  { slug: 'high-priority', label: 'High Priority', category: 'counts', type: 'counter', description: 'High or critical priority tasks' },
  { slug: 'assigned-to-me', label: 'Assigned to Me', category: 'counts', type: 'counter', description: 'Tasks assigned to you' },
  { slug: 'completed-today', label: 'Done Today', category: 'counts', type: 'counter', description: 'Tasks completed since midnight' },
  { slug: 'this-week-progress', label: 'This Week', category: 'progress', type: 'fraction', description: 'Weekly task completion progress' },
  { slug: 'routines-kept', label: 'Routines', category: 'progress', type: 'percentage', description: 'Routine completion rate this week' },
  { slug: 'streak', label: 'Streak', category: 'progress', type: 'counter', description: 'Consecutive days with completions' },
  { slug: 'focus-3', label: 'Focus 3', category: 'progress', type: 'fraction', description: 'Focus items completed today' },
  { slug: 'daily-avg', label: 'Daily Avg', category: 'progress', type: 'counter', description: '7-day rolling average completions' },
  { slug: 'triage-pending', label: 'Triage Pending', category: 'integrations', type: 'counter', description: 'Items awaiting triage' },
  { slug: 'triage-stale', label: 'Triage Stale', category: 'integrations', type: 'counter', description: 'Triage items older than 7 days' },
  { slug: 'doc-actions-pending', label: 'Doc Actions', category: 'integrations', type: 'counter', description: 'Pending document intelligence actions' },
  { slug: 'doc-statements-missing', label: 'Missing Stmts', category: 'integrations', type: 'counter', description: 'Missing statement alerts from DI' },
  { slug: 'doc-eob-unmatched', label: 'Unmatched EOBs', category: 'integrations', type: 'counter', description: 'Unmatched EOB alerts from DI' },
];
