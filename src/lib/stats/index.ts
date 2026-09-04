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
 *
 * Every read is delegated to the composed `analytics.kpis` repository; this
 * module owns no driver, SQL, transaction, or backend selection.
 */

import type { KpiAnalyticsRepository } from '@/db/persistence/analytics';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  formatDateInLocalTimezone,
  getLocalDateBoundsISO,
  getLocalToday,
  getLocalDaysFromNow,
  getLocalDayBoundsISO,
  parseStoredTimestamp,
} from '@/lib/utils/date';
import type { CadenceConfig } from '@/lib/routines/streaks';
import {
  NEXT_7_DAYS,
  NEXT_7_DAYS_DESCRIPTION,
  NEXT_7_DAYS_LABEL,
} from '@/lib/tasks/due-window';

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

// ─── Persistence ────────────────────────────────────────────────────────────

async function kpiRepository(): Promise<KpiAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.kpis;
}

// ─── Individual KPI Computations ────────────────────────────────────────────

async function computeTotalOpen(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countOpenTasks();
  return { slug: 'total-open', label: 'Total Open', value, type: 'counter', accent: 'blue' };
}

async function computeOverdue(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const value = await repository.countOpenTasksDueBefore(today);
  return {
    slug: 'overdue', label: 'Overdue', value, type: 'counter',
    accent: value > 0 ? 'red' : 'green',
  };
}

async function computeDueThisWeek(
  repository: KpiAnalyticsRepository,
  today: string,
  weekFromNow: string,
): Promise<KpiResult> {
  const value = await repository.countOpenTasksDueBetween({ from: today, to: weekFromNow });
  return { slug: 'due-this-week', label: NEXT_7_DAYS_LABEL, value, type: 'counter', accent: 'amber' };
}

async function computeUnreadAlerts(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countNotificationsNeedingAttention();
  return { slug: 'unread-notifications', label: 'Unread Notifications', value, type: 'counter', accent: 'orange' };
}

async function computeMyDay(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const myDayTaskIds = await repository.listMyDayTaskIds(today);
  if (myDayTaskIds.length === 0) {
    return { slug: 'my-day', label: 'My Day', value: 0, type: 'counter', accent: 'cyan' };
  }
  const value = await repository.countOpenTasksInIds(myDayTaskIds);
  return { slug: 'my-day', label: 'My Day', value, type: 'counter', accent: 'cyan' };
}

async function computeHighPriority(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countOpenTasksWithPriorities(['high', 'critical']);
  return {
    slug: 'high-priority', label: 'High Priority', value, type: 'counter',
    accent: value > 0 ? 'orange' : 'green',
  };
}

async function computeAssignedToMe(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countOpenTasksWithAssignee();
  return { slug: 'assigned-to-me', label: 'Assigned to Me', value, type: 'counter', accent: 'indigo' };
}

async function computeCompletedToday(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const { todayStart, tomorrowStart } = getTodayBounds();
  const value = await repository.countTasksCompletedIn({
    startInclusive: todayStart,
    endExclusive: tomorrowStart,
  });
  return { slug: 'completed-today', label: 'Done Today', value, type: 'counter', accent: 'emerald' };
}

async function computeThisWeekProgress(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const monday = getWeekMonday(today);
  const sunday = getWeekSunday(monday);
  const { dayStart: mondayISO } = getLocalDateBoundsISO(monday);
  const { nextDayStart: weekEndExclusiveISO } = getLocalDateBoundsISO(sunday);

  // Tasks due this week (open or completed)
  const total = await repository.countNonCancelledTasksDueBetween({ from: monday, to: sunday });

  // Completed this week
  const done = await repository.countTasksCompletedIn({
    startInclusive: mondayISO,
    endExclusive: weekEndExclusiveISO,
  });

  const safeTotal = Math.max(total, done);

  return {
    slug: 'this-week-progress', label: 'This Week', value: done, max: safeTotal, type: 'fraction',
    accent: 'blue', detail: `${done}/${safeTotal} tasks`,
  };
}

async function computeRoutinesKept(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const monday = getWeekMonday(today);
  const sunday = getWeekSunday(monday);

  const activeRoutines = await repository.listActiveRoutines();

  if (activeRoutines.length === 0) {
    return { slug: 'routines-kept', label: 'Routines', value: 0, max: 0, type: 'percentage', accent: 'green' };
  }

  const weekCompletions = await repository.listRoutineCompletionsBetween({
    from: monday,
    to: sunday,
  });

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

async function computeStreak(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const daysToCheck = 90;
  const startDate = getDaysAgo(today, daysToCheck);
  const { dayStart: startDateISO } = getLocalDateBoundsISO(startDate);

  const completions = await repository.listCompletedTimestampsSince(startDateISO);

  const completedDates = new Set(completions.flatMap((completedAt) => (
    completedAt
      ? [formatDateInLocalTimezone(new Date(parseStoredTimestamp(completedAt)))]
      : []
  )));

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

async function computeFocus3(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const items = await repository.listFocusItemStatuses('today', today);

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

async function computeDailyAvg(
  repository: KpiAnalyticsRepository,
  today: string,
): Promise<KpiResult> {
  const days = 7;
  const sparkline: number[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = getDaysAgo(today, i);
    const { dayStart, nextDayStart } = getLocalDateBoundsISO(date);

    sparkline.push(await repository.countTasksCompletedIn({
      startInclusive: dayStart,
      endExclusive: nextDayStart,
    }));
  }

  const avg = sparkline.length > 0 ? sparkline.reduce((a, b) => a + b, 0) / sparkline.length : 0;

  return {
    slug: 'daily-avg', label: 'Daily Avg', value: Math.round(avg * 10) / 10, type: 'counter',
    accent: 'purple', detail: `${(Math.round(avg * 10) / 10)} tasks/day`,
    sparkline,
  };
}

async function computeTriagePending(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countTriageItemsWithStatus('pending');
  return {
    slug: 'triage-pending', label: 'Triage Pending', value, type: 'counter',
    accent: value > 5 ? 'amber' : 'slate',
  };
}

async function computeTriageStale(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const value = await repository.countTriageItemsWithStatusCapturedBefore('pending', sevenDaysAgo);
  return {
    slug: 'triage-stale', label: 'Triage Stale', value, type: 'counter',
    accent: value > 0 ? 'red' : 'slate',
  };
}

async function computeDocActionsPending(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countOpenTasksByConnectorType('document-intelligence');
  return {
    slug: 'doc-actions-pending', label: 'Doc Actions', value, type: 'counter',
    accent: value > 3 ? 'indigo' : 'slate',
  };
}

async function computeDocStatementsMissing(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countNotificationsNeedingAttentionInCategory(
    'document-intelligence',
    'document',
  );
  return {
    slug: 'doc-statements-missing', label: 'Missing Stmts', value, type: 'counter',
    accent: value > 0 ? 'purple' : 'slate',
  };
}

async function computeDocEobUnmatched(repository: KpiAnalyticsRepository): Promise<KpiResult> {
  const value = await repository.countNotificationsNeedingAttentionInCategory(
    'document-intelligence',
    'medical',
  );
  return {
    slug: 'doc-eob-unmatched', label: 'Unmatched EOBs', value, type: 'counter',
    accent: value > 0 ? 'pink' : 'slate',
  };
}

// ─── KPI Registry ───────────────────────────────────────────────────────────

type KpiComputer = (
  repository: KpiAnalyticsRepository,
  today: string,
  weekFromNow: string,
) => Promise<KpiResult>;

const KPI_REGISTRY: Record<KpiSlug, KpiComputer> = {
  'total-open': (repository) => computeTotalOpen(repository),
  'overdue': (repository, today) => computeOverdue(repository, today),
  'due-this-week': (repository, today, weekFromNow) => computeDueThisWeek(repository, today, weekFromNow),
  'unread-notifications': (repository) => computeUnreadAlerts(repository),
  'my-day': (repository, today) => computeMyDay(repository, today),
  'high-priority': (repository) => computeHighPriority(repository),
  'assigned-to-me': (repository) => computeAssignedToMe(repository),
  'completed-today': (repository) => computeCompletedToday(repository),
  'this-week-progress': (repository, today) => computeThisWeekProgress(repository, today),
  'routines-kept': (repository, today) => computeRoutinesKept(repository, today),
  'streak': (repository, today) => computeStreak(repository, today),
  'focus-3': (repository, today) => computeFocus3(repository, today),
  'daily-avg': (repository, today) => computeDailyAvg(repository, today),
  'triage-pending': (repository) => computeTriagePending(repository),
  'triage-stale': (repository) => computeTriageStale(repository),
  'doc-actions-pending': (repository) => computeDocActionsPending(repository),
  'doc-statements-missing': (repository) => computeDocStatementsMissing(repository),
  'doc-eob-unmatched': (repository) => computeDocEobUnmatched(repository),
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
  const weekFromNow = getLocalDaysFromNow(NEXT_7_DAYS);

  const requested = slugs && slugs.length > 0
    ? slugs.filter((s): s is KpiSlug => s in KPI_REGISTRY)
    : (Object.keys(KPI_REGISTRY) as KpiSlug[]);

  const repository = await kpiRepository();
  const results = await Promise.all(
    requested.map(slug => KPI_REGISTRY[slug](repository, today, weekFromNow)),
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
  { slug: 'due-this-week', label: NEXT_7_DAYS_LABEL, category: 'counts', type: 'counter', description: NEXT_7_DAYS_DESCRIPTION },
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
