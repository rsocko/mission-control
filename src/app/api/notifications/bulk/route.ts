import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import type { NotificationMutationResult } from '@/db/persistence/notification-web';
import {
  createNotificationBulkOutcome,
  MAX_NOTIFICATION_BULK_IDS,
  normalizeNotificationBulkIds,
} from '@/lib/notifications/bulk';
import {
  notificationQueryValidationError,
  parseNotificationQuery,
  UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR,
} from '@/lib/notifications/query';

type BulkAction =
  | 'mark_read'
  | 'mark_unread'
  | 'dismiss'
  | 'handle'
  | 'archive'
  | 'mute'
  | 'unmute';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const allMatching = body.scope === 'all_matching' || body.all === true;
    let requestedIds: string[];
    try {
      requestedIds = normalizeNotificationBulkIds(body.ids);
    } catch (error) {
      return ApiErrors.badRequest(error instanceof Error ? error.message : 'Invalid notification IDs');
    }
    const action = body.action as BulkAction;
    const submittedQuery = body.query && typeof body.query === 'object'
      ? body.query as Record<string, unknown>
      : {};
    const queryError = allMatching && body.all !== true
      ? notificationQueryValidationError(submittedQuery)
      : null;
    if (queryError) return ApiErrors.badRequest(queryError);
    const parsedQuery = body.all === true
      ? parseNotificationQuery({ state: 'unread' })
      : parseNotificationQuery(submittedQuery);

    const web = await getNotificationWebPersistence();

    if (allMatching && parsedQuery.merchant) {
      const exists = await web.validateMerchantExists(parsedQuery.merchant);
      if (!exists) {
        return ApiErrors.badRequest(UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR);
      }
    }

    if ((!requestedIds.length && !allMatching) || !action) {
      return ApiErrors.badRequest('ids or an all_matching scope, and action are required');
    }
    if (![
      'mark_read',
      'mark_unread',
      'dismiss',
      'handle',
      'archive',
      'mute',
      'unmute',
    ].includes(action)) {
      return ApiErrors.badRequest(`Unknown action: ${action}`);
    }

    const selectedRows = allMatching
      ? await web.selectForBulkByQuery(parsedQuery, MAX_NOTIFICATION_BULK_IDS + 1)
      : await web.selectForBulkByIds(requestedIds, MAX_NOTIFICATION_BULK_IDS);

    if (selectedRows.length > MAX_NOTIFICATION_BULK_IDS) {
      return ApiErrors.badRequest(
        `This view matches more than the ${MAX_NOTIFICATION_BULK_IDS} notification bulk limit`,
      );
    }

    const requestedCount = allMatching ? selectedRows.length : requestedIds.length;
    const ids = selectedRows.filter((row) => {
      switch (action) {
        case 'mark_read':
          return row.readState !== 'read';
        case 'mark_unread':
          return row.readState !== 'unread';
        case 'dismiss':
          return row.disposition !== 'dismissed';
        case 'handle':
        case 'archive':
          return row.disposition !== 'handled';
        case 'mute':
          return row.mutedAt == null;
        case 'unmute':
          return row.mutedAt != null;
      }
    }).map((row) => row.id);
    const now = new Date().toISOString();

    const response = (
      updatedCount: number,
      queuedCount = 0,
      results?: NotificationMutationResult['results'],
    ) => {
      const outcome = createNotificationBulkOutcome({
        requestedCount,
        acceptedCount: updatedCount,
        queuedCount,
      });
      return NextResponse.json({
        success: true,
        action,
        scope: allMatching ? 'all_matching' : 'visible_page',
        requestedCount,
        updatedCount,
        ...outcome,
        outcome,
        ...(results ? { results } : {}),
        writeback: {
          status: queuedCount > 0 ? 'pending' : 'not_required',
          queuedCount,
        },
      });
    };

    if (ids.length === 0) return response(0);

    switch (action) {
      case 'mark_read': {
        if (isDemoMode()) {
          const changes = await web.bulkMarkReadDemo(ids, now);
          return response(changes);
        }
        return writebackResponse(response, web.mutateNotificationsAndEnqueueWritebacks(
          ids,
          'mark_read',
          now,
        ), web);
      }

      case 'mark_unread': {
        const changes = await web.bulkMarkUnread(ids, now);
        return response(changes);
      }

      case 'dismiss': {
        const result = isDemoMode()
          ? { updatedCount: await web.bulkDismissDemo(ids, now), queuedCount: 0 }
          : web.dismissNotificationsAndEnqueueWritebacks(ids, now);
        if (result.queuedCount > 0) web.wakeWritebackDispatcher();
        return response(result.updatedCount, result.queuedCount);
      }

      case 'handle':
      case 'archive': {
        if (isDemoMode()) {
          const changes = await web.bulkHandleDemo(ids, now);
          return response(changes);
        }
        return writebackResponse(response, web.mutateNotificationsAndEnqueueWritebacks(
          ids,
          'mark_done',
          now,
        ), web);
      }

      case 'mute':
      case 'unmute':
        return writebackResponse(response, web.mutateNotificationsAndEnqueueWritebacks(
          ids,
          action,
          now,
        ), web);
    }
  } catch (error) {
    return ApiErrors.internal('Failed to execute bulk action', error);
  }
}

function writebackResponse(
  response: (
    updatedCount: number,
    queuedCount?: number,
    results?: NotificationMutationResult['results'],
  ) => NextResponse,
  result: NotificationMutationResult,
  web: Awaited<ReturnType<typeof getNotificationWebPersistence>>,
) {
  if (result.queuedCount > 0) web.wakeWritebackDispatcher();
  return response(result.updatedCount, result.queuedCount, result.results);
}
