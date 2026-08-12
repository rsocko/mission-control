/**
 * Insights Query Layer — period-based aggregate queries for /insights page
 * and dashboard progress rollup widgets.
 *
 * Shares the stats engine's date helpers and DB access. Provides:
 * - Completion trends (daily time series)
 * - Source breakdown (connector_type grouping)
 * - Task age distribution
 * - Project velocity
 * - Period KPIs with delta comparisons
 */

import db from '@/db';
import { tasks, routines, routineCompletions, taskProjects } from '@/db/schema';
import { and, eq, gte, lt, lte, sql, notInArray, isNotNull } from 'drizzle-orm';
import { hubProjects } from '@/db/schema';
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
} from '@/lib/utils/date';
import { computeFlowInsights, type FlowInsightsResult } from '@/lib/stats/flow-query';
import type { FlowFilters } from '@/lib/stats/flow';
import { buildTaskAgeDistribution, type TaskAgeBucket } from './task-age';
import {
  buildRoutineHeatmapDays,
  type RoutineCadenceConfig,
} from './routine-heatmap';

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

function getToday(): string {
  return fmtDate(new Date());
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Query Functions ────────────────────────────────────────────────────────

async function getCompletedInRange(start: string, end: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, start + 'T00:00:00.000Z'),
      lt(tasks.completedAt, end + 'T23:59:59.999Z'),
    ));
  return Number(row?.count ?? 0);
}

async function getCreatedInRange(start: string, end: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      eq(tasks.depth, 0),
      eq(tasks.isChecklistItem, false),
      gte(tasks.createdAt, start + 'T00:00:00.000Z'),
      lt(tasks.createdAt, end + 'T23:59:59.999Z'),
    ));
  return Number(row?.count ?? 0);
}

async function getCompletionTrends(start: string, end: string): Promise<TrendDataPoint[]> {
  const completedRows = await db.select({
    date: sql<string>`date(${tasks.completedAt})`,
    count: sql<number>`count(*)`,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, start + 'T00:00:00.000Z'),
      lt(tasks.completedAt, end + 'T23:59:59.999Z'),
    ))
    .groupBy(sql`date(${tasks.completedAt})`);

  const createdRows = await db.select({
    date: sql<string>`date(${tasks.createdAt})`,
    count: sql<number>`count(*)`,
  })
    .from(tasks)
    .where(and(
      eq(tasks.depth, 0),
      eq(tasks.isChecklistItem, false),
      gte(tasks.createdAt, start + 'T00:00:00.000Z'),
      lt(tasks.createdAt, end + 'T23:59:59.999Z'),
    ))
    .groupBy(sql`date(${tasks.createdAt})`);

  const completedMap = new Map(completedRows.map(r => [r.date, Number(r.count)]));
  const createdMap = new Map(createdRows.map(r => [r.date, Number(r.count)]));

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

export async function getSourceBreakdown(start: string, end: string): Promise<SourceBreakdownItem[]> {
  const rows = await db.select({
    source: tasks.connectorType,
    count: sql<number>`count(*)`,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, start + 'T00:00:00.000Z'),
      lt(tasks.completedAt, end + 'T23:59:59.999Z'),
    ))
    .groupBy(tasks.connectorType)
    .orderBy(sql`count(*) DESC`);

  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return rows.map(r => ({
    source: r.source,
    count: Number(r.count),
    percentage: total > 0 ? Math.round((Number(r.count) / total) * 100) : 0,
  }));
}

async function getTaskAgeDistribution(): Promise<TaskAgeBucket[]> {
  const today = getToday();
  const openTasks = await db.select({
    createdAt: tasks.createdAt,
  })
    .from(tasks)
    .where(notInArray(tasks.status, ['done', 'cancelled']));

  return buildTaskAgeDistribution(
    openTasks.map(task => daysBetween(task.createdAt.slice(0, 10), today)),
  );
}

async function getProjectActivity(start: string, end: string): Promise<ProjectActivityItem[]> {
  const projects = await db.select().from(hubProjects).where(eq(hubProjects.status, 'active'));
  if (projects.length === 0) return [];

  const results: ProjectActivityItem[] = [];

  for (const project of projects) {
    // Tasks in this project completed during the period
    const completedRows = await db.select({ count: sql<number>`count(*)` })
      .from(taskProjects)
      .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
      .where(and(
        eq(taskProjects.projectId, project.id),
        eq(tasks.status, 'done'),
        gte(tasks.completedAt, start + 'T00:00:00.000Z'),
        lt(tasks.completedAt, end + 'T23:59:59.999Z'),
      ));

    // Open tasks in this project
    const openRows = await db.select({ count: sql<number>`count(*)` })
      .from(taskProjects)
      .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
      .where(and(
        eq(taskProjects.projectId, project.id),
        notInArray(tasks.status, ['done', 'cancelled']),
      ));

    // Created in period (exclude subtasks/checklists — only top-level tasks)
    const createdRows = await db.select({ count: sql<number>`count(*)` })
      .from(taskProjects)
      .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
      .where(and(
        eq(taskProjects.projectId, project.id),
        eq(tasks.depth, 0),
        eq(tasks.isChecklistItem, false),
        gte(tasks.createdAt, start + 'T00:00:00.000Z'),
        lt(tasks.createdAt, end + 'T23:59:59.999Z'),
      ));

    const completed = Number(completedRows[0]?.count ?? 0);
    const open = Number(openRows[0]?.count ?? 0);
    const created = Number(createdRows[0]?.count ?? 0);

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

async function getRoutineHeatmap(weekMonday: string): Promise<RoutineHeatmapEntry[]> {
  const activeRoutines = await db.select()
    .from(routines)
    .where(and(eq(routines.isActive, true), eq(routines.isArchived, false)));

  if (activeRoutines.length === 0) return [];

  const weekEnd = new Date(weekMonday + 'T12:00:00');
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndStr = fmtDate(weekEnd);

  const completions = await db.select()
    .from(routineCompletions)
    .where(and(gte(routineCompletions.date, weekMonday), lte(routineCompletions.date, weekEndStr)));

  const completionMap = new Map<string, Set<string>>();
  for (const c of completions) {
    const key = c.routineId;
    if (!completionMap.has(key)) completionMap.set(key, new Set());
    completionMap.get(key)!.add(c.date);
  }

  const priorCompletions = await db.select()
    .from(routineCompletions)
    .where(and(
      gte(routineCompletions.date, daysAgo(weekMonday, 90)),
      lt(routineCompletions.date, weekMonday),
    ));

  const lastPriorCompletion = new Map<string, string>();
  for (const completion of priorCompletions) {
    const existing = lastPriorCompletion.get(completion.routineId);
    if (!existing || completion.date > existing) {
      lastPriorCompletion.set(completion.routineId, completion.date);
    }
  }

  const today = getToday();
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

async function getActivityHeatmap(start: string, end: string): Promise<ActivityHeatmapEntry[]> {
  const { dayStart } = getLocalDateBoundsISO(start);
  const { nextDayStart } = getLocalDateBoundsISO(end);
  const [taskRows, routineRows] = await Promise.all([
    db.select({
      completedAt: tasks.completedAt,
    })
      .from(tasks)
      .where(and(
        eq(tasks.status, 'done'),
        gte(tasks.completedAt, dayStart),
        lt(tasks.completedAt, nextDayStart),
      )),
    db.select({
      date: routineCompletions.date,
      count: sql<number>`count(*)`,
    })
      .from(routineCompletions)
      .where(and(
        gte(routineCompletions.date, start),
        lte(routineCompletions.date, end),
      ))
      .groupBy(routineCompletions.date),
  ]);

  const tasksByDate = new Map<string, number>();
  for (const row of taskRows) {
    if (!row.completedAt) continue;
    const date = formatDateInLocalTimezone(new Date(row.completedAt));
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

async function getAvgTaskAge(start: string, end: string): Promise<number> {
  const rows = await db.select({
    createdAt: tasks.createdAt,
    completedAt: tasks.completedAt,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(tasks.completedAt, start + 'T00:00:00.000Z'),
      lt(tasks.completedAt, end + 'T23:59:59.999Z'),
    ));

  if (rows.length === 0) return 0;

  let totalDays = 0;
  for (const row of rows) {
    const created = new Date(row.createdAt).getTime();
    const completed = new Date(row.completedAt!).getTime();
    totalDays += (completed - created) / (1000 * 60 * 60 * 24);
  }

  return Math.round((totalDays / rows.length) * 10) / 10;
}

async function getStreak(): Promise<number> {
  const today = getToday();
  const startDate = daysAgo(today, 90);

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

async function getDeliveryFilterOptions(): Promise<{
  projects: InsightsFilterOption[];
  sources: InsightsFilterOption[];
}> {
  const [projectRows, sourceRows] = await Promise.all([
    db.select({
      value: hubProjects.id,
      label: hubProjects.name,
    })
      .from(hubProjects)
      .where(eq(hubProjects.hidden, false))
      .orderBy(hubProjects.name),
    db.selectDistinct({ value: tasks.connectorType })
      .from(tasks)
      .orderBy(tasks.connectorType),
  ]);

  return {
    projects: projectRows,
    sources: sourceRows.map(row => ({
      value: row.value,
      label: formatSourceLabel(row.value),
    })),
  };
}

async function getDeliveryRecords(
  startDate: string,
  endDate: string,
  filters: InsightsFilters,
): Promise<DeliveryTaskRecord[]> {
  // One day of UTC padding on each side covers every valid local UTC offset.
  const paddedStart = `${addCalendarDays(startDate, -1)}T00:00:00.000Z`;
  const paddedEnd = `${addCalendarDays(endDate, 2)}T00:00:00.000Z`;
  const conditions = [
    eq(tasks.status, 'done'),
    isNotNull(tasks.completedAt),
    gte(tasks.completedAt, paddedStart),
    lt(tasks.completedAt, paddedEnd),
  ];
  if (filters.source) conditions.push(eq(tasks.connectorType, filters.source));

  const selection = {
    id: tasks.id,
    title: tasks.title,
    createdAt: tasks.createdAt,
    completedAt: tasks.completedAt,
    source: tasks.connectorType,
    statusReason: tasks.statusReason,
  };

  const rows = filters.projectId
    ? await db.selectDistinct(selection)
      .from(tasks)
      .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
      .where(and(...conditions, eq(taskProjects.projectId, filters.projectId)))
    : await db.select(selection)
      .from(tasks)
      .where(and(...conditions));

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
  const today = getToday();
  const { periodStart: defaultPeriodStart } = getInclusivePeriodBoundaries(today, period);
  const periodStart = options.startDate ?? defaultPeriodStart;
  const periodEnd = options.endDate ?? today;
  const timeZone = resolveTimeZone(options.timeZone);

  if (section === 'summary') {
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
    ] = await Promise.all([
      getCompletedInRange(periodStart, periodEnd),
      getCreatedInRange(periodStart, periodEnd),
      getCompletedInRange(prevPeriodStart, prevPeriodEnd),
      getCreatedInRange(prevPeriodStart, prevPeriodEnd),
      getAvgTaskAge(periodStart, periodEnd),
      getAvgTaskAge(prevPeriodStart, prevPeriodEnd),
      getStreak(),
      getCompletionTrends(periodStart, periodEnd),
      getSourceBreakdown(periodStart, periodEnd),
      getTaskAgeDistribution(),
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
    };
  }

  if (section === 'delivery') {
    const deliveryToday = dateInTimeZone(now.toISOString(), timeZone) ?? today;
    const deliveryStart = options.startDate ?? daysAgo(deliveryToday, period - 1);
    const deliveryEnd = options.endDate ?? deliveryToday;
    const interval = options.interval ?? (period === 90 ? 'month' : 'week');
    const [deliveryRecords, deliveryFilterOptions] = await Promise.all([
      getDeliveryRecords(deliveryStart, deliveryEnd, options),
      getDeliveryFilterOptions(),
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

  const activityToday = getLocalToday();
  const activityStart = fmtDate(addDays(subYears(new Date(activityToday + 'T12:00:00'), 1), 1));
  const todayDate = new Date(today + 'T12:00:00');
  const dayOfWeek = todayDate.getDay();
  const monday = new Date(todayDate);
  monday.setDate(monday.getDate() + (dayOfWeek === 0 ? -6 : 1 - dayOfWeek));
  const [projectActivity, routineHeatmap, activityHeatmap] = await Promise.all([
    getProjectActivity(periodStart, periodEnd),
    getRoutineHeatmap(fmtDate(monday)),
    getActivityHeatmap(activityStart, activityToday),
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
    projectActivity: activity.projectActivity,
    routineHeatmap: activity.routineHeatmap,
    delivery: delivery.delivery,
    deliveryFilters: delivery.deliveryFilters,
    deliverySemantics: delivery.deliverySemantics,
    activityHeatmap: activity.activityHeatmap,
    flow: flow.flow,
  };
}
