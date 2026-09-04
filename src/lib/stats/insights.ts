/**
 * Insights Query Layer — period-based aggregate queries for /insights page
 * and dashboard progress rollup widgets.
 *
 * Shares the stats engine's date helpers. Provides:
 * - Completion trends (daily time series)
 * - Source breakdown (connector_type grouping)
 * - Task age distribution
 * - Project velocity
 * - Period KPIs with delta comparisons
 *
 * Every read is delegated to the composed `analytics.insights` repository; this
 * module owns no driver, SQL, transaction, or backend selection. The
 * multi-query composites below stay deliberately non-atomic on both backends.
 */

import type { InsightsAnalyticsRepository } from '@/db/persistence/analytics';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  addCalendarDays,
  buildDeliveryMetrics,
  dateInTimeZone,
  getInclusivePeriodBoundaries,
  type DeliveryInterval,
  type DeliveryMetrics,
  type DeliveryTaskRecord,
} from './delivery';

export type {
  DeliveryInterval,
  DeliveryMetrics,
  DeliverySeriesPoint,
  LeadTimeDistributionBucket,
  LeadTimeTrendPoint,
  VelocitySeriesPoint,
} from './delivery';
import { addDays, subYears } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import {
  formatDateInLocalTimezone,
  getLocalDateBoundsISO,
  getLocalToday,
  parseStoredTimestamp,
} from '@/lib/utils/date';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { computeFlowInsights, type FlowInsightsResult } from '@/lib/stats/flow-query';
import type { FlowFilters } from '@/lib/stats/flow';
import { buildTaskAgeDistribution, type TaskAgeBucket } from './task-age';
import {
  buildRoutineHeatmapDays,
  getRoutineWeekContext,
  type RoutineCadenceConfig,
} from './routine-heatmap';
import { planningFrictionEventTypes } from '@/lib/planning-signals';

export type { TaskAgeBucket } from './task-age';

// ─── Types ──────────────────────────────────────────────────────────────────

export type InsightsPeriod = 7 | 30 | 90;

export interface InsightsFilters {
  interval?: DeliveryInterval;
  projectId?: string;
  source?: string;
  timeZone?: string;
}

export interface InsightsFilterOption {
  value: string;
  label: string;
}

export interface PeriodKpi {
  label: string;
  value: number;
  previousValue?: number;
  delta?: number; // percentage change
  unit?: string;
}

export interface TrendDataPoint {
  date: string; // YYYY-MM-DD
  completed: number;
  created: number;
}

export interface SourceBreakdownItem {
  source: string;
  count: number;
  percentage: number;
}

export interface ProjectActivityItem {
  projectId: string;
  projectName: string;
  color: string;
  completed: number;
  open: number;
  delta: number; // completed - created in period
}

export interface RoutineHeatmapEntry {
  routineId: string;
  routineName: string;
  icon: string | null;
  // 7 entries for Mon-Sun, each: true (done), false (missed), null (not scheduled)
  days: (boolean | null)[];
}

export interface ActivityHeatmapEntry {
  date: string;
  taskCompletions: number;
  routineCompletions: number;
}

export interface PlanningFrictionCategory {
  label: string;
  count: number;
}

export interface PlanningFrictionTask {
  id: string;
  title: string;
  dueDate: string | null;
  pushCount: number;
  pushesInPeriod: number;
  daysDeferredInPeriod: number;
  signalsInPeriod: number;
  missedCommitmentsInPeriod: number;
}

export interface PlanningFrictionInsights {
  signalsInPeriod: number;
  affectedTaskCount: number;
  pushesInPeriod: number;
  pushedTaskCount: number;
  missedCommitments: number;
  elapsedBlocks: number;
  overdueTransitions: number;
  snoozeExtensions: number;
  totalDaysDeferred: number;
  averageDaysPerPush: number;
  topTasks: PlanningFrictionTask[];
  topLists: PlanningFrictionCategory[];
  topTags: PlanningFrictionCategory[];
}

export interface InsightsSnapshot {
  period: InsightsPeriod;
  periodStart: string;
  periodEnd: string;
  kpis: {
    completed: PeriodKpi;
    created: PeriodKpi;
    netChange: PeriodKpi;
    avgTaskAge: PeriodKpi;
    streak: PeriodKpi;
  };
  trends: TrendDataPoint[];
  sourceBreakdown: SourceBreakdownItem[];
  taskAge: TaskAgeBucket[];
  planningFriction: PlanningFrictionInsights;
  projectActivity: ProjectActivityItem[];
  routineHeatmap: RoutineHeatmapEntry[];
  delivery: DeliveryMetrics;
  deliveryFilters: {
    interval: DeliveryInterval;
    projectId: string | null;
    source: string | null;
    timeZone: string;
    projects: InsightsFilterOption[];
    sources: InsightsFilterOption[];
  };
  deliverySemantics: {
    completion: string;
    intervals: string;
    leadTime: string;
    exclusions: string;
    unsupportedMeasures: string;
  };
  activityHeatmap: ActivityHeatmapEntry[];
  flow: FlowInsightsResult | null;
}

export type InsightsSection = 'summary' | 'delivery' | 'flow' | 'activity';

export interface InsightsSummarySection {
  section: 'summary';
  period: InsightsPeriod;
  periodStart: string;
  periodEnd: string;
  kpis: InsightsSnapshot['kpis'];
  trends: TrendDataPoint[];
  sourceBreakdown: SourceBreakdownItem[];
  taskAge: TaskAgeBucket[];
  planningFriction: PlanningFrictionInsights;
}

export interface InsightsDeliverySection {
  section: 'delivery';
  period: InsightsPeriod;
  delivery: DeliveryMetrics;
  deliveryFilters: InsightsSnapshot['deliveryFilters'];
  deliverySemantics: InsightsSnapshot['deliverySemantics'];
}

export interface InsightsFlowSection {
  section: 'flow';
  period: InsightsPeriod;
  flow: FlowInsightsResult | null;
}

export interface InsightsActivitySection {
  section: 'activity';
  period: InsightsPeriod;
  projectActivity: ProjectActivityItem[];
  routineHeatmap: RoutineHeatmapEntry[];
  activityHeatmap: ActivityHeatmapEntry[];
}

export type InsightsSectionSnapshot =
  | InsightsSummarySection
  | InsightsDeliverySection
  | InsightsFlowSection
  | InsightsActivitySection;

export interface InsightsQueryOptions extends InsightsFilters {
  startDate?: string;
  endDate?: string;
  flowFilters?: FlowFilters;
  staleThresholdDays?: number;
  includeFlow?: boolean;
}

// ─── Date Helpers ───────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(from: string, n: number): string {
  const d = new Date(from + 'T12:00:00');
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function getRangeBounds(start: string, end: string) {
  const { dayStart } = getLocalDateBoundsISO(start);
  const { nextDayStart } = getLocalDateBoundsISO(end);
  return { startInclusive: dayStart, endExclusive: nextDayStart };
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function insightsRepository(): Promise<InsightsAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.insights;
}

// ─── Query Functions ────────────────────────────────────────────────────────

async function getCompletedInRange(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<number> {
  return repository.countTasksCompletedIn(getRangeBounds(start, end));
}

async function getCreatedInRange(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<number> {
  return repository.countTopLevelTasksCreatedIn(getRangeBounds(start, end));
}

async function getCompletionTrends(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<TrendDataPoint[]> {
  const range = getRangeBounds(start, end);
  const completedTimestamps = await repository.listCompletedTimestampsIn(range);
  const createdTimestamps = await repository.listCreatedTimestampsIn(range);

  const completedMap = new Map<string, number>();
  for (const timestamp of completedTimestamps) {
    if (!timestamp) continue;
    const date = formatDateInLocalTimezone(new Date(parseStoredTimestamp(timestamp)));
    completedMap.set(date, (completedMap.get(date) ?? 0) + 1);
  }
  const createdMap = new Map<string, number>();
  for (const timestamp of createdTimestamps) {
    const date = formatDateInLocalTimezone(new Date(parseStoredTimestamp(timestamp)));
    createdMap.set(date, (createdMap.get(date) ?? 0) + 1);
  }

  const points: TrendDataPoint[] = [];
  const current = new Date(start + 'T12:00:00');
  const endDate = new Date(end + 'T12:00:00');

  while (current <= endDate) {
    const dateStr = fmtDate(current);
    points.push({
      date: dateStr,
      completed: completedMap.get(dateStr) ?? 0,
      created: createdMap.get(dateStr) ?? 0,
    });
    current.setDate(current.getDate() + 1);
  }

  return points;
}

export async function getSourceBreakdown(
  start: string,
  end: string,
): Promise<SourceBreakdownItem[]> {
  const rows = await (await insightsRepository()).sourceBreakdownIn(getRangeBounds(start, end));

  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return rows.map(r => ({
    source: r.source,
    count: Number(r.count),
    percentage: total > 0 ? Math.round((Number(r.count) / total) * 100) : 0,
  }));
}

async function getTaskAgeDistribution(
  repository: InsightsAnalyticsRepository,
): Promise<TaskAgeBucket[]> {
  const today = getLocalToday();
  const createdTimestamps = await repository.listOpenTaskCreatedTimestamps();

  return buildTaskAgeDistribution(
    createdTimestamps.map(createdAt => daysBetween(
      formatDateInLocalTimezone(new Date(parseStoredTimestamp(createdAt))),
      today,
    )),
  );
}

async function getPlanningFriction(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<PlanningFrictionInsights> {
  const eventRows = await repository.listPlanningFrictionEvents(
    [...planningFrictionEventTypes()],
    getRangeBounds(start, end),
  );

  const perTask = new Map<string, PlanningFrictionTask>();
  const listCounts = new Map<string, number>();
  let totalDaysDeferred = 0;
  let pushesInPeriod = 0;
  let missedCommitments = 0;
  let elapsedBlocks = 0;
  let overdueTransitions = 0;
  let snoozeExtensions = 0;

  for (const event of eventRows) {
    const isDueDatePush = event.eventType === 'due_date_pushed';
    const previousDate = isDueDatePush ? event.previousValue?.slice(0, 10) : null;
    const nextDate = isDueDatePush ? event.newValue?.slice(0, 10) : null;
    const deferredDays = previousDate && nextDate ? Math.max(0, daysBetween(previousDate, nextDate)) : 0;
    totalDaysDeferred += deferredDays;
    if (isDueDatePush) pushesInPeriod++;
    if (event.eventType === 'my_day_missed' || event.eventType === 'focus_missed') missedCommitments++;
    if (event.eventType === 'scheduled_block_elapsed') elapsedBlocks++;
    if (event.eventType === 'became_overdue') overdueTransitions++;
    if (event.eventType === 'snooze_extended') snoozeExtensions++;

    const current = perTask.get(event.taskId);
    if (current) {
      current.pushesInPeriod += isDueDatePush ? 1 : 0;
      current.daysDeferredInPeriod += deferredDays;
      current.signalsInPeriod += 1;
      current.missedCommitmentsInPeriod += (
        event.eventType === 'my_day_missed' || event.eventType === 'focus_missed'
      ) ? 1 : 0;
    } else {
      perTask.set(event.taskId, {
        id: event.taskId,
        title: event.title,
        dueDate: event.dueDate,
        pushCount: event.pushCount,
        pushesInPeriod: isDueDatePush ? 1 : 0,
        daysDeferredInPeriod: deferredDays,
        signalsInPeriod: 1,
        missedCommitmentsInPeriod: (
          event.eventType === 'my_day_missed' || event.eventType === 'focus_missed'
        ) ? 1 : 0,
      });
    }

    if (event.sourceListName) {
      listCounts.set(
        event.sourceListName,
        (listCounts.get(event.sourceListName) ?? 0) + 1,
      );
    }
  }

  const taskIds = [...perTask.keys()];
  const tagCounts = new Map<string, number>();
  if (taskIds.length > 0) {
    const tagRows = await repository.listTaskTagNames(taskIds);

    for (const tag of tagRows) {
      if (isSyntheticTag(tag.name)) continue;
      const taskSignals = perTask.get(tag.taskId)?.signalsInPeriod ?? 0;
      tagCounts.set(tag.name, (tagCounts.get(tag.name) ?? 0) + taskSignals);
    }
  }

  const topCategories = (counts: Map<string, number>): PlanningFrictionCategory[] => (
    [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 5)
  );

  return {
    signalsInPeriod: eventRows.length,
    affectedTaskCount: perTask.size,
    pushesInPeriod,
    pushedTaskCount: [...perTask.values()].filter(task => task.pushesInPeriod > 0).length,
    missedCommitments,
    elapsedBlocks,
    overdueTransitions,
    snoozeExtensions,
    totalDaysDeferred,
    averageDaysPerPush: pushesInPeriod > 0
      ? Math.round((totalDaysDeferred / pushesInPeriod) * 10) / 10
      : 0,
    topTasks: [...perTask.values()]
      .sort((a, b) => (
        b.signalsInPeriod - a.signalsInPeriod
        || b.missedCommitmentsInPeriod - a.missedCommitmentsInPeriod
        || b.pushesInPeriod - a.pushesInPeriod
        || b.daysDeferredInPeriod - a.daysDeferredInPeriod
        || a.title.localeCompare(b.title)
      ))
      .slice(0, 5),
    topLists: topCategories(listCounts),
    topTags: topCategories(tagCounts),
  };
}

async function getProjectActivity(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<ProjectActivityItem[]> {
  const range = getRangeBounds(start, end);
  const projects = await repository.listActiveProjects();
  if (projects.length === 0) return [];

  const results: ProjectActivityItem[] = [];

  // One query set per project, deliberately preserved: this is the existing
  // query profile, and collapsing it would be an optimization rather than
  // backend parity.
  for (const project of projects) {
    // Tasks in this project completed during the period
    const completed = await repository.countProjectTasksCompletedIn(project.id, range);

    // Open tasks in this project
    const open = await repository.countProjectOpenTasks(project.id);

    // Created in period (exclude subtasks/checklists — only top-level tasks)
    const created = await repository.countProjectTopLevelTasksCreatedIn(project.id, range);

    if (completed > 0 || open > 0) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        color: project.color,
        completed,
        open,
        delta: completed - created,
      });
    }
  }

  return results.sort((a, b) => b.completed - a.completed).slice(0, 8);
}

async function getRoutineHeatmap(
  repository: InsightsAnalyticsRepository,
  weekMonday: string,
  today: string,
): Promise<RoutineHeatmapEntry[]> {
  const activeRoutines = await repository.listActiveRoutines();

  if (activeRoutines.length === 0) return [];

  const weekEnd = new Date(weekMonday + 'T12:00:00');
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndStr = fmtDate(weekEnd);

  const completions = await repository.listRoutineCompletionsBetween({
    from: weekMonday,
    to: weekEndStr,
  });

  const completionMap = new Map<string, Set<string>>();
  for (const c of completions) {
    const key = c.routineId;
    if (!completionMap.has(key)) completionMap.set(key, new Set());
    completionMap.get(key)!.add(c.date);
  }

  const priorCompletions = await repository.listRoutineCompletionsInHalfOpenRange(
    daysAgo(weekMonday, 90),
    weekMonday,
  );

  const lastPriorCompletion = new Map<string, string>();
  for (const completion of priorCompletions) {
    const existing = lastPriorCompletion.get(completion.routineId);
    if (!existing || completion.date > existing) {
      lastPriorCompletion.set(completion.routineId, completion.date);
    }
  }

  return activeRoutines.map(routine => {
    const routineCompletionDates = completionMap.get(routine.id) ?? new Set();
    const days = buildRoutineHeatmapDays({
      weekMonday,
      today,
      cadenceType: routine.cadenceType,
      config: (routine.cadenceConfig || {}) as RoutineCadenceConfig,
      completionDates: [...routineCompletionDates],
      priorCompletionDate: lastPriorCompletion.get(routine.id),
    });

    return {
      routineId: routine.id,
      routineName: routine.name,
      icon: routine.icon,
      days,
    };
  });
}

async function getActivityHeatmap(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<ActivityHeatmapEntry[]> {
  const { dayStart } = getLocalDateBoundsISO(start);
  const { nextDayStart } = getLocalDateBoundsISO(end);
  const [completedTimestamps, routineRows] = await Promise.all([
    repository.listCompletedTimestampsIn({
      startInclusive: dayStart,
      endExclusive: nextDayStart,
    }),
    repository.countRoutineCompletionsByDate({ from: start, to: end }),
  ]);

  const tasksByDate = new Map<string, number>();
  for (const completedAt of completedTimestamps) {
    if (!completedAt) continue;
    const date = formatDateInLocalTimezone(new Date(parseStoredTimestamp(completedAt)));
    tasksByDate.set(date, (tasksByDate.get(date) ?? 0) + 1);
  }
  const routinesByDate = new Map(routineRows.map(row => [row.date, Number(row.count)]));
  const entries: ActivityHeatmapEntry[] = [];
  const current = new Date(start + 'T12:00:00');
  const endDate = new Date(end + 'T12:00:00');

  while (current <= endDate) {
    const date = fmtDate(current);
    entries.push({
      date,
      taskCompletions: tasksByDate.get(date) ?? 0,
      routineCompletions: routinesByDate.get(date) ?? 0,
    });
    current.setDate(current.getDate() + 1);
  }

  return entries;
}

async function getAvgTaskAge(
  repository: InsightsAnalyticsRepository,
  start: string,
  end: string,
): Promise<number> {
  const rows = await repository.listCompletionSpansIn(getRangeBounds(start, end));

  if (rows.length === 0) return 0;

  let totalDays = 0;
  for (const row of rows) {
    const created = parseStoredTimestamp(row.createdAt);
    const completed = parseStoredTimestamp(row.completedAt!);
    totalDays += (completed - created) / (1000 * 60 * 60 * 24);
  }

  return Math.round((totalDays / rows.length) * 10) / 10;
}

async function getStreak(repository: InsightsAnalyticsRepository): Promise<number> {
  const today = getLocalToday();
  const startDate = daysAgo(today, 90);
  const { dayStart } = getLocalDateBoundsISO(startDate);

  const completions = await repository.listCompletedTimestampsSince(dayStart);

  const completedDates = new Set(completions.flatMap(completedAt => (
    completedAt
      ? [formatDateInLocalTimezone(new Date(parseStoredTimestamp(completedAt)))]
      : []
  )));

  let streak = 0;
  const d = new Date(today + 'T12:00:00');

  for (let i = 0; i < 90; i++) {
    const dateStr = fmtDate(d);
    if (completedDates.has(dateStr)) {
      streak++;
    } else if (i === 0) {
      d.setDate(d.getDate() - 1);
      continue;
    } else {
      break;
    }
    d.setDate(d.getDate() - 1);
  }

  return streak;
}

function resolveTimeZone(requested?: string): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!requested || requested.length > 100) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: requested }).format();
    return requested;
  } catch {
    return fallback;
  }
}

function formatSourceLabel(source: string): string {
  return source
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

async function getDeliveryFilterOptions(
  repository: InsightsAnalyticsRepository,
): Promise<{
  projects: InsightsFilterOption[];
  sources: InsightsFilterOption[];
}> {
  const { projects, sources } = await repository.deliveryFilterOptions();

  return {
    projects,
    sources: sources.map(source => ({
      value: source,
      label: formatSourceLabel(source),
    })),
  };
}

async function getDeliveryRecords(
  repository: InsightsAnalyticsRepository,
  startDate: string,
  endDate: string,
  filters: InsightsFilters,
): Promise<DeliveryTaskRecord[]> {
  // One day of UTC padding on each side covers every valid local UTC offset.
  const paddedStart = `${addCalendarDays(startDate, -1)}T00:00:00.000Z`;
  const paddedEnd = `${addCalendarDays(endDate, 2)}T00:00:00.000Z`;

  const rows = await repository.listDeliveryRecords(
    { startInclusive: paddedStart, endExclusive: paddedEnd },
    { projectId: filters.projectId, source: filters.source },
  );

  return rows.map(row => ({
    ...row,
    completedAt: row.completedAt!,
  }));
}

export function computeInsightsSection(
  section: 'summary',
  period?: InsightsPeriod,
  options?: InsightsQueryOptions,
  now?: Date,
): Promise<InsightsSummarySection>;
export function computeInsightsSection(
  section: 'delivery',
  period?: InsightsPeriod,
  options?: InsightsQueryOptions,
  now?: Date,
): Promise<InsightsDeliverySection>;
export function computeInsightsSection(
  section: 'flow',
  period?: InsightsPeriod,
  options?: InsightsQueryOptions,
  now?: Date,
): Promise<InsightsFlowSection>;
export function computeInsightsSection(
  section: 'activity',
  period?: InsightsPeriod,
  options?: InsightsQueryOptions,
  now?: Date,
): Promise<InsightsActivitySection>;
export function computeInsightsSection(
  section: InsightsSection,
  period?: InsightsPeriod,
  options?: InsightsQueryOptions,
  now?: Date,
): Promise<InsightsSectionSnapshot>;
export async function computeInsightsSection(
  section: InsightsSection,
  period: InsightsPeriod = 7,
  options: InsightsQueryOptions = {},
  now = new Date(),
): Promise<InsightsSectionSnapshot> {
  const today = getLocalToday();
  const { periodStart: defaultPeriodStart } = getInclusivePeriodBoundaries(today, period);
  const periodStart = options.startDate ?? defaultPeriodStart;
  const periodEnd = options.endDate ?? today;
  const timeZone = resolveTimeZone(options.timeZone);

  if (section === 'summary') {
    const repository = await insightsRepository();
    const periodDays = daysBetween(periodStart, periodEnd) + 1;
    const prevPeriodEnd = daysAgo(periodStart, 1);
    const prevPeriodStart = daysAgo(prevPeriodEnd, periodDays - 1);
    const [
      completed,
      created,
      prevCompleted,
      prevCreated,
      avgAge,
      prevAvgAge,
      streak,
      trends,
      sourceBreakdown,
      taskAge,
      planningFriction,
    ] = await Promise.all([
      getCompletedInRange(repository, periodStart, periodEnd),
      getCreatedInRange(repository, periodStart, periodEnd),
      getCompletedInRange(repository, prevPeriodStart, prevPeriodEnd),
      getCreatedInRange(repository, prevPeriodStart, prevPeriodEnd),
      getAvgTaskAge(repository, periodStart, periodEnd),
      getAvgTaskAge(repository, prevPeriodStart, prevPeriodEnd),
      getStreak(repository),
      getCompletionTrends(repository, periodStart, periodEnd),
      getSourceBreakdown(periodStart, periodEnd),
      getTaskAgeDistribution(repository),
      getPlanningFriction(repository, periodStart, periodEnd),
    ]);

    return {
      section,
      period,
      periodStart,
      periodEnd,
      kpis: {
        completed: {
          label: 'Completed',
          value: completed,
          previousValue: prevCompleted,
          delta: prevCompleted > 0 ? Math.round(((completed - prevCompleted) / prevCompleted) * 100) : 0,
          unit: 'tasks',
        },
        created: {
          label: 'Created',
          value: created,
          previousValue: prevCreated,
          delta: prevCreated > 0 ? Math.round(((created - prevCreated) / prevCreated) * 100) : 0,
          unit: 'tasks',
        },
        netChange: {
          label: 'Net Change',
          value: completed - created,
          unit: 'tasks',
        },
        avgTaskAge: {
          label: 'Avg Task Age',
          value: avgAge,
          previousValue: prevAvgAge,
          delta: prevAvgAge > 0 ? Math.round(((avgAge - prevAvgAge) / prevAvgAge) * 100) : 0,
          unit: 'days',
        },
        streak: {
          label: 'Streak',
          value: streak,
          unit: 'days',
        },
      },
      trends,
      sourceBreakdown,
      taskAge,
      planningFriction,
    };
  }

  if (section === 'delivery') {
    const repository = await insightsRepository();
    const deliveryToday = dateInTimeZone(now.toISOString(), timeZone) ?? today;
    const deliveryStart = options.startDate ?? daysAgo(deliveryToday, period - 1);
    const deliveryEnd = options.endDate ?? deliveryToday;
    const interval = options.interval ?? (period === 90 ? 'month' : 'week');
    const [deliveryRecords, deliveryFilterOptions] = await Promise.all([
      getDeliveryRecords(repository, deliveryStart, deliveryEnd, options),
      getDeliveryFilterOptions(repository),
    ]);

    return {
      section,
      period,
      delivery: buildDeliveryMetrics(deliveryRecords, {
        startDate: deliveryStart,
        endDate: deliveryEnd,
        interval,
        timeZone,
      }),
      deliveryFilters: {
        interval,
        projectId: options.projectId ?? null,
        source: options.source ?? null,
        timeZone,
        ...deliveryFilterOptions,
      },
      deliverySemantics: {
        completion: 'Counts the current final completedAt timestamp only; reopened tasks are excluded until completed again.',
        intervals: interval === 'week'
          ? `Calendar weeks start Monday in ${timeZone}; partial boundary weeks are marked.`
          : `Calendar months use local dates in ${timeZone}; partial boundary months are marked.`,
        leadTime: `Elapsed timestamp duration from task creation to final completion in 24-hour days; offsetless source timestamps use ${timeZone}.`,
        exclusions: 'Cancelled tasks and done items closed as not planned or duplicate are excluded from delivery and lead-time metrics.',
        unsupportedMeasures: 'Task count is the only supported historical measure; tag and effort history are not available in the current query contract.',
      },
    };
  }

  if (section === 'flow') {
    if (options.includeFlow === false) {
      return { section, period, flow: null };
    }
    const flowStart = fromZonedTime(`${periodStart}T00:00:00`, timeZone).toISOString();
    const flowEnd = fromZonedTime(
      `${addCalendarDays(periodEnd, 1)}T00:00:00`,
      timeZone,
    ).toISOString();

    return {
      section,
      period,
      flow: await computeFlowInsights({
        start: flowStart,
        end: flowEnd,
        staleThresholdDays: options.staleThresholdDays,
        filters: options.flowFilters,
      }),
    };
  }

  const repository = await insightsRepository();
  const { today: activityToday, weekMonday } = getRoutineWeekContext(now, timeZone);
  const activityStart = fmtDate(addDays(subYears(new Date(activityToday + 'T12:00:00'), 1), 1));
  const [projectActivity, routineHeatmap, activityHeatmap] = await Promise.all([
    getProjectActivity(repository, periodStart, periodEnd),
    getRoutineHeatmap(repository, weekMonday, activityToday),
    getActivityHeatmap(repository, activityStart, activityToday),
  ]);

  return {
    section,
    period,
    projectActivity,
    routineHeatmap,
    activityHeatmap,
  };
}

// ─── Main Query ─────────────────────────────────────────────────────────────

export async function computeInsights(
  period: InsightsPeriod = 7,
  options: InsightsQueryOptions = {},
  now = new Date(),
): Promise<InsightsSnapshot> {
  const [summary, delivery, flow, activity] = await Promise.all([
    computeInsightsSection('summary', period, options, now),
    computeInsightsSection('delivery', period, options, now),
    computeInsightsSection('flow', period, options, now),
    computeInsightsSection('activity', period, options, now),
  ]);

  return {
    period,
    periodStart: summary.periodStart,
    periodEnd: summary.periodEnd,
    kpis: summary.kpis,
    trends: summary.trends,
    sourceBreakdown: summary.sourceBreakdown,
    taskAge: summary.taskAge,
    planningFriction: summary.planningFriction,
    projectActivity: activity.projectActivity,
    routineHeatmap: activity.routineHeatmap,
    delivery: delivery.delivery,
    deliveryFilters: delivery.deliveryFilters,
    deliverySemantics: delivery.deliverySemantics,
    activityHeatmap: activity.activityHeatmap,
    flow: flow.flow,
  };
}
