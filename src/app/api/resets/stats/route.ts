import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, routines, routineCompletions, focusItems, energyCheckins } from '@/db/schema';
import { and, gte, lte, eq, not, inArray } from 'drizzle-orm';
import {
  formatDateInLocalTimezone,
  getLocalDateBoundsISO,
  getLocalToday,
  parseStoredTimestamp,
} from '@/lib/utils/date';
import logger from '@/lib/logger';
import { resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';
import { timestampGte, timestampLt } from '@/lib/utils/sqlite-date';

function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDateLocal(d);
}

function getWeekSunday(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return formatDateLocal(d);
}

function getMonthStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getMonthEnd(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setMonth(d.getMonth() + 1, 0); // last day of current month
  return formatDateLocal(d);
}

const STALE_THRESHOLD_DAYS = 14;

function calendarDaysBetween(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

/**
 * GET /api/resets/stats — Compute stats for a weekly or monthly reset
 * Query params:
 *   ?type=weekly|monthly (required)
 *   ?periodStart=YYYY-MM-DD (optional, defaults to current week/month)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'weekly';
  const today = getLocalToday();

  let periodStart: string;
  let periodEnd: string;

  if (type === 'monthly') {
    periodStart = searchParams.get('periodStart') || getMonthStart(today);
    periodEnd = getMonthEnd(periodStart);
  } else {
    periodStart = searchParams.get('periodStart') || getWeekMonday(today);
    periodEnd = getWeekSunday(periodStart);
  }

  try {
    const { dayStart: periodStartIso } = getLocalDateBoundsISO(periodStart);
    const { nextDayStart: periodEndExclusiveIso } = getLocalDateBoundsISO(periodEnd);

    // 1. Tasks completed in period
    const completedTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      completedAt: tasks.completedAt,
    })
      .from(tasks)
      .where(and(
        eq(tasks.status, 'done'),
        timestampGte(tasks.completedAt, periodStartIso),
        timestampLt(tasks.completedAt, periodEndExclusiveIso),
      ));

    // 2. Tasks created in period
    const createdTasks = await db.select({ id: tasks.id })
      .from(tasks)
      .where(and(
        timestampGte(tasks.createdAt, periodStartIso),
        timestampLt(tasks.createdAt, periodEndExclusiveIso),
      ));

    // 3. Carried forward (open tasks that existed before period end)
    const carriedForward = await db.select({ id: tasks.id })
      .from(tasks)
      .where(and(
        not(inArray(tasks.status, ['done', 'cancelled'])),
        timestampLt(tasks.createdAt, periodEndExclusiveIso),
      ));

    // 4. Routine completion rate
    const activeRoutines = await db.select({ id: routines.id, cadenceType: routines.cadenceType })
      .from(routines)
      .where(and(eq(routines.isActive, true), eq(routines.isArchived, false)));

    const periodCompletions = await db.select({
      routineId: routineCompletions.routineId,
      date: routineCompletions.date,
    })
      .from(routineCompletions)
      .where(and(
        gte(routineCompletions.date, periodStart),
        lte(routineCompletions.date, periodEnd),
      ));

    // Simple routine % = unique routine-days completed / (active daily routines × days in period)
    const daysInPeriod = Math.ceil((new Date(periodEnd + 'T12:00:00').getTime() - new Date(periodStart + 'T12:00:00').getTime()) / 86400000) + 1;
    const dailyRoutineCount = activeRoutines.filter(r => r.cadenceType === 'daily').length;
    const expectedCompletions = dailyRoutineCount * daysInPeriod;
    const dailyCompletions = periodCompletions.filter(c =>
      activeRoutines.some(r => r.id === c.routineId && r.cadenceType === 'daily'),
    );
    const routinePercentage = expectedCompletions > 0
      ? Math.round((dailyCompletions.length / expectedCompletions) * 100)
      : 0;

    // 5. Focus 3 hit rate (days where all 3 slots were filled)
    const focusDays = await db.select({
      date: focusItems.date,
      slot: focusItems.slot,
    })
      .from(focusItems)
      .where(and(
        eq(focusItems.scope, 'today'),
        gte(focusItems.date, periodStart),
        lte(focusItems.date, periodEnd),
      ));

    const focusByDay = new Map<string, Set<number>>();
    for (const f of focusDays) {
      if (!focusByDay.has(f.date)) focusByDay.set(f.date, new Set());
      focusByDay.get(f.date)!.add(f.slot);
    }
    // Count work days (Mon-Fri) in period
    const workDays: string[] = [];
    const cursor = new Date(periodStart + 'T12:00:00');
    const endDate = new Date(periodEnd + 'T12:00:00');
    while (cursor <= endDate) {
      const dow = cursor.getDay();
      if (dow >= 1 && dow <= 5) workDays.push(formatDateLocal(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    const focusHitDays = workDays.filter(d => (focusByDay.get(d)?.size ?? 0) >= 3).length;
    const focusHitRate = `${focusHitDays}/${workDays.length} days`;

    // 6. Stale tasks (>14 days since last update, still open)
    const staleThreshold = new Date(today + 'T12:00:00');
    staleThreshold.setDate(staleThreshold.getDate() - STALE_THRESHOLD_DAYS);
    const staleThresholdStr = formatDateLocal(staleThreshold);
    const { nextDayStart: staleThresholdExclusiveIso } = getLocalDateBoundsISO(staleThresholdStr);

    const staleTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      updatedAt: tasks.updatedAt,
      status: tasks.status,
      priority: tasks.priority,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    })
      .from(tasks)
      .where(and(
        not(inArray(tasks.status, ['done', 'cancelled'])),
        timestampLt(tasks.updatedAt, staleThresholdExclusiveIso),
      ))
      .limit(50);
    const staleTaskPolicies = await resolveTaskEditPolicies(staleTasks);

    // 7. Energy data for period
    const energyData = await db.select()
      .from(energyCheckins)
      .where(and(
        gte(energyCheckins.date, periodStart),
        lte(energyCheckins.date, periodEnd),
      ));

    // 8. Incomplete Focus 3 items (tasks that were in Focus 3 but not completed)
    const allFocusItemsInPeriod = await db.select({
      taskId: focusItems.taskId,
      date: focusItems.date,
      slot: focusItems.slot,
    })
      .from(focusItems)
      .where(and(
        eq(focusItems.scope, 'today'),
        gte(focusItems.date, periodStart),
        lte(focusItems.date, periodEnd),
      ));

    // Get unique task IDs from focus items
    const focusTaskIds = [...new Set(allFocusItemsInPeriod.map(f => f.taskId))];
    const incompleteFocusTasks: Array<{ id: string; title: string; timesInFocus: number }> = [];
    if (focusTaskIds.length > 0) {
      const focusTasks = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.id, focusTaskIds));

      for (const t of focusTasks) {
        if (t.status !== 'done' && t.status !== 'cancelled') {
          const count = allFocusItemsInPeriod.filter(f => f.taskId === t.id).length;
          incompleteFocusTasks.push({ id: t.id, title: t.title, timesInFocus: count });
        }
      }
    }

    // 9. For monthly: week-by-week breakdown
    let weeklyBreakdown: Array<{ weekStart: string; weekEnd: string; completed: number; routinePercent: number }> | undefined;
    if (type === 'monthly') {
      weeklyBreakdown = [];
      // Start from the Monday on or before the month start
      const monthStartDate = new Date(periodStart + 'T12:00:00');
      const monthEndDate = new Date(periodEnd + 'T12:00:00');
      const weekCursor = new Date(monthStartDate);
      const dow = weekCursor.getDay();
      // Roll back to Monday (if month starts mid-week, include that partial week)
      const daysBack = dow === 0 ? 6 : dow - 1;
      weekCursor.setDate(weekCursor.getDate() - daysBack);

      while (weekCursor <= monthEndDate) {
        const wStart = formatDateLocal(weekCursor);
        const wEndDate = new Date(weekCursor);
        wEndDate.setDate(wEndDate.getDate() + 6);
        const wEnd = formatDateLocal(wEndDate);
        const boundedWeekStart = wStart < periodStart ? periodStart : wStart;
        const boundedWeekEnd = wEnd > periodEnd ? periodEnd : wEnd;
        const { dayStart: weekStartIso } = getLocalDateBoundsISO(boundedWeekStart);
        const { nextDayStart: weekEndExclusiveIso } = getLocalDateBoundsISO(boundedWeekEnd);

        const wCompleted = completedTasks.filter(t =>
          t.completedAt
          && parseStoredTimestamp(t.completedAt) >= Date.parse(weekStartIso)
          && parseStoredTimestamp(t.completedAt) < Date.parse(weekEndExclusiveIso),
        ).length;

        const wRoutineCompletions = periodCompletions.filter(c =>
          c.date >= wStart && c.date <= wEnd &&
          activeRoutines.some(r => r.id === c.routineId && r.cadenceType === 'daily'),
        );
        const wExpected = dailyRoutineCount * 7;
        const wRoutinePercent = wExpected > 0 ? Math.round((wRoutineCompletions.length / wExpected) * 100) : 0;

        weeklyBreakdown.push({
          weekStart: wStart,
          weekEnd: wEnd,
          completed: wCompleted,
          routinePercent: wRoutinePercent,
        });

        weekCursor.setDate(weekCursor.getDate() + 7);
      }
    }

    const stats = {
      type,
      periodStart,
      periodEnd,
      tasksCompleted: completedTasks.length,
      tasksCreated: createdTasks.length,
      tasksCarriedForward: carriedForward.length,
      routinePercentage,
      focusHitRate,
      focusHitDays,
      totalWorkDays: workDays.length,
      staleTasks: staleTasks.map(t => ({
        id: t.id,
        title: t.title,
        daysSinceUpdate: calendarDaysBetween(
          formatDateInLocalTimezone(new Date(parseStoredTimestamp(t.updatedAt))),
          today,
        ),
        status: t.status,
        priority: t.priority,
        editPolicy: staleTaskPolicies.get(t.id),
      })),
      energyData: energyData.map(e => ({ date: e.date, level: e.level })),
      incompleteFocusTasks,
      weeklyBreakdown,
    };

    return NextResponse.json(stats);
  } catch (error) {
    logger.error({ err: error }, 'Reset stats error');
    return NextResponse.json(
      { error: 'Failed to compute reset stats' },
      { status: 500 },
    );
  }
}
