import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR,
  notificationQueryValidationError,
  parseNotificationQuery,
} from '@/lib/notifications/query';
import { legacyStateFromLifecycle } from '@/lib/notifications/lifecycle';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import type { NotificationState } from '@/types';
import type { RestoreSnapshot } from '@/db/persistence/notification-web';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryError = notificationQueryValidationError(searchParams);
  if (queryError) return ApiErrors.badRequest(queryError);
  const query = parseNotificationQuery(searchParams);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 200);
  const cursor = searchParams.get('cursor');

  try {
    const web = await getNotificationWebPersistence();

    const recoveryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    web.recoverStaleActions(recoveryCutoff);

    const result = await web.queryNotifications({ query, limit, cursor });

    if (query.merchant && result.items.length === 0 && result.matchingCount === 0) {
      return ApiErrors.badRequest(UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR);
    }

    const actionsByNotification = new Map<string, typeof result.actions>();
    for (const action of result.actions) {
      const existing = actionsByNotification.get(action.notificationId) || [];
      existing.push(action);
      actionsByNotification.set(action.notificationId, existing);
    }

    const hydratedItems = result.items.map(item => ({
      ...item,
      state: legacyStateFromLifecycle(item),
      actions: actionsByNotification.get(item.id) || [],
    }));

    return NextResponse.json({
      notifications: hydratedItems,
      stats: result.stats,
      facets: result.facets,
      matchingCount: result.matchingCount,
      hasMore: result.hasMore,
      cursor: result.cursor,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch notifications', error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const web = await getNotificationWebPersistence();

    if (Array.isArray(body.restore)) {
      const snapshots = body.restore as Array<Record<string, unknown>>;
      if (snapshots.length === 0 || snapshots.length > 500) {
        return ApiErrors.badRequest('restore must contain between 1 and 500 notifications');
      }
      const validReadStates = new Set(['unread', 'read']);
      const validDispositions = new Set(['inbox', 'handled', 'dismissed']);
      if (snapshots.some(snapshot =>
        typeof snapshot.id !== 'string'
        || !validReadStates.has(String(snapshot.readState))
        || !validDispositions.has(String(snapshot.disposition))
      )) {
        return ApiErrors.badRequest('Invalid notification restore snapshot');
      }

      const nullableString = (value: unknown) => typeof value === 'string' ? value : null;
      const restored: RestoreSnapshot[] = snapshots.map(snapshot => ({
        id: String(snapshot.id),
        readState: String(snapshot.readState) as 'unread' | 'read',
        disposition: String(snapshot.disposition) as 'inbox' | 'handled' | 'dismissed',
        readAt: nullableString(snapshot.readAt),
        handledAt: nullableString(snapshot.handledAt),
        dismissedAt: nullableString(snapshot.dismissedAt),
        archivedAt: nullableString(snapshot.archivedAt),
        handledSourceActivityAt: nullableString(snapshot.handledSourceActivityAt),
        handledSourceActivityKey: nullableString(snapshot.handledSourceActivityKey),
      }));

      const { updatedCount } = await web.restoreSnapshots(restored);
      return NextResponse.json({ success: true, updatedCount });
    }

    const ids = Array.isArray(body.ids) ? body.ids : [];
    const newState = body.state as string | undefined;

    const VALID_STATES = ['unread', 'read', 'dismissed', 'resolved', 'archived'];
    if (!ids.length || !newState) {
      return ApiErrors.badRequest('ids and state are required');
    }
    if (!VALID_STATES.includes(newState)) {
      return ApiErrors.badRequest(`Invalid state. Must be one of: ${VALID_STATES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const { updatedCount } = await web.mutateStates(ids, newState as NotificationState, now);
    return NextResponse.json({ success: true, updatedCount });
  } catch (error) {
    return ApiErrors.internal('Failed to update notifications', error);
  }
}
