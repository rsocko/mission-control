import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { ApiErrors } from '@/lib/api-error';
import { getNotificationBadgeState, type NavigationCounts } from '@/lib/navigation/badges';
import { getLocalToday } from '@/lib/utils/date';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { buildTaskFilterSpec } from '@/lib/tasks/core/filter-spec';

function isValidDateParameter(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export async function GET(request: Request) {
  const requestedDate = new URL(request.url).searchParams.get('date');
  if (requestedDate && !isValidDateParameter(requestedDate)) {
    return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');
  }

  try {
    const now = new Date().toISOString();
    const today = requestedDate || getLocalToday();
    const [{ dailyPlanning }, taskCore] = await Promise.all([
      getWorkerPersistenceRepositories(),
      getTaskCorePersistence(),
    ]);
    if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
    const repository = dailyPlanning.navigation;
    const inboxSpec = buildTaskFilterSpec(new URLSearchParams({
      quickFilter: 'inbox',
      openOnly: 'true',
      parentOnly: 'true',
    }), {
      clock: { today, weekFromNow: today, recentCutoff: now },
    });
    const [counts, pendingInboxTasks] = await Promise.all([
      repository.counts({ date: today, now }),
      taskCore.queries.countTasks(
        inboxSpec,
        { includeQuickFilter: true, availableAt: now },
      ),
    ]);

    const notificationBadge = getNotificationBadgeState({
      attention: counts.notifications.attention,
      urgent: counts.notifications.urgent,
      actionNeeded: counts.notifications.actionNeeded,
      headsUp: counts.notifications.headsUp,
      fyi: counts.notifications.fyi,
    });
    const response: NavigationCounts = {
      myDay: counts.myDay,
      notifications: notificationBadge.count,
      triage: counts.triage + pendingInboxTasks,
      quickSort: counts.quickSort,
      reconciliation: counts.reconciliation,
      overdue: counts.overdue,
      unreadNotifications: counts.notifications.unread,
      notificationTone: notificationBadge.tone,
    };

    return NextResponse.json(response);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch navigation counts', error);
  }
}
