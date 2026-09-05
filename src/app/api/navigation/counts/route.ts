import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { ApiErrors } from '@/lib/api-error';
import { getNotificationBadgeState, type NavigationCounts } from '@/lib/navigation/badges';
import { getLocalToday } from '@/lib/utils/date';

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
    const { dailyPlanning } = await getWorkerPersistenceRepositories();
    if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
    const repository = dailyPlanning.navigation;
    const counts = await repository.counts({ date: today, now });

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
      triage: counts.triage,
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
