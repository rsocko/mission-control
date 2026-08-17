import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, triageItems } from '@/db/schema';
import { and, eq, lt, sql, notInArray } from 'drizzle-orm';
import { getLocalToday, getLocalDayBoundsISO } from '@/lib/utils/date';
import logger from '@/lib/logger';
import { timestampGte, timestampLt } from '@/lib/utils/sqlite-date';

/**
 * GET /api/mobile-dashboard
 *
 * Returns a compact stats payload for the mobile dashboard launchpad.
 * Focused on actionable present-state data:
 * - Today summary (current task status)
 * - Queue counts (what needs attention)
 * - Recent activity (momentum feedback)
 *
 * Analytics/trends (weekly charts, priority dist, streaks) belong in /api/stats
 * and are consumed by the /insights page instead.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const today = searchParams.get('today') || getLocalToday();

    const [todayStats, queues, recentActivity] = await Promise.all([
      computeTodayStats(today),
      computeQueueCounts(),
      computeRecentActivity(),
    ]);

    return NextResponse.json({
      today: todayStats,
      queues,
      recentActivity,
      computedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute mobile dashboard stats');
    return NextResponse.json(
      { error: 'Failed to compute mobile dashboard stats' },
      { status: 500 },
    );
  }
}

// ─── Today Summary ──────────────────────────────────────────────────────────

async function computeTodayStats(today: string) {
  const { todayStart, tomorrowStart } = getLocalDayBoundsISO();

  const [totalOpenRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(notInArray(tasks.status, ['done', 'cancelled']));

  const [completedTodayRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.status, 'done'), timestampGte(tasks.completedAt, todayStart), timestampLt(tasks.completedAt, tomorrowStart)));

  const [inProgressRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'in_progress'));

  const [overdueRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(notInArray(tasks.status, ['done', 'cancelled']), lt(tasks.dueDate, today)));

  const totalOpen = Number(totalOpenRow?.count ?? 0);
  const completedToday = Number(completedTodayRow?.count ?? 0);
  const inProgress = Number(inProgressRow?.count ?? 0);
  const overdue = Number(overdueRow?.count ?? 0);
  const total = completedToday + inProgress + (totalOpen - inProgress);
  const completionPct = total > 0 ? Math.round((completedToday / (completedToday + totalOpen)) * 100) : 0;

  return { totalOpen, completedToday, inProgress, overdue, completionPct };
}

// ─── Queue Counts ───────────────────────────────────────────────────────────

async function computeQueueCounts() {
  const [triageRow] = await db.select({ count: sql<number>`count(*)` })
    .from(triageItems)
    .where(eq(triageItems.status, 'pending'));

  const [sortRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(
      notInArray(tasks.status, ['done', 'cancelled']),
      sql`(${tasks.priority} IS NULL OR ${tasks.priority} = '' OR ${tasks.priority} = 'none')`,
    ));

  const today = getLocalToday();
  const [overdueRow] = await db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(notInArray(tasks.status, ['done', 'cancelled']), lt(tasks.dueDate, today)));

  return {
    triage: Number(triageRow?.count ?? 0),
    sort: Number(sortRow?.count ?? 0),
    overdue: Number(overdueRow?.count ?? 0),
  };
}

// ─── Recent Activity ────────────────────────────────────────────────────────

async function computeRecentActivity() {
  // Get the 5 most recently completed tasks
  const recentCompleted = await db.select({
    id: tasks.id,
    title: tasks.title,
    completedAt: tasks.completedAt,
  })
    .from(tasks)
    .where(eq(tasks.status, 'done'))
    .orderBy(sql`${tasks.completedAt} DESC`)
    .limit(5);

  return recentCompleted.map((t) => ({
    id: t.id,
    title: t.title,
    completedAt: t.completedAt,
    type: 'completed' as const,
  }));
}
