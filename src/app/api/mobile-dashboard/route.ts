import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday, getLocalDayBoundsISO } from '@/lib/utils/date';
import logger from '@/lib/logger';

const RECENT_ACTIVITY_LIMIT = 5;

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
    const { todayStart, tomorrowStart } = getLocalDayBoundsISO();

    const { dailyPlanning } = await getWorkerPersistenceRepositories();
    if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
    const repository = dailyPlanning.dashboard;
    const snapshot = await repository.snapshot({
      overdueBefore: today,
      queueOverdueBefore: getLocalToday(),
      completedFrom: todayStart,
      completedTo: tomorrowStart,
      recentActivityLimit: RECENT_ACTIVITY_LIMIT,
    });

    const { totalOpen, completedToday, inProgress, overdue } = snapshot;
    const total = completedToday + inProgress + (totalOpen - inProgress);
    const completionPct = total > 0
      ? Math.round((completedToday / (completedToday + totalOpen)) * 100)
      : 0;

    return NextResponse.json({
      today: { totalOpen, completedToday, inProgress, overdue, completionPct },
      queues: snapshot.queues,
      recentActivity: snapshot.recentActivity.map((task) => ({
        id: task.id,
        title: task.title,
        completedAt: task.completedAt,
        type: 'completed' as const,
      })),
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
