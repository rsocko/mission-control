import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications } from '@/db/schema';
import { and, inArray, sql } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import {
  dismissNotificationsAndEnqueueWritebacks,
  mutateNotificationsAndEnqueueWritebacks,
  wakeNotificationWritebackDispatcher,
  type NotificationMutationResult,
} from '@/lib/notifications/notification-writeback';
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
import {
  notificationMerchantMetadataCondition,
  notificationWhere,
} from '@/lib/notifications/query-server';

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
    if (allMatching && parsedQuery.merchant) {
      const knownMerchant = await db.select({ id: notifications.id })
        .from(notifications)
        .where(and(
          sql`${notifications.connectorInstanceId} NOT IN (
            SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
          )`,
          notificationMerchantMetadataCondition(parsedQuery.merchant),
        ))
        .limit(1);
      if (knownMerchant.length === 0) {
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

    const selection = {
      id: notifications.id,
      readState: notifications.readState,
      disposition: notifications.disposition,
      sourceState: notifications.sourceState,
      mutedAt: notifications.mutedAt,
    };
    const selectedRows = allMatching
      ? await db.select(selection)
          .from(notifications)
          .where(notificationWhere(parsedQuery))
          .limit(MAX_NOTIFICATION_BULK_IDS + 1)
      : await db.select(selection)
          .from(notifications)
          .where(and(
            inArray(notifications.id, requestedIds),
            sql`${notifications.connectorInstanceId} NOT IN (
              SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
            )`,
          ))
          .limit(MAX_NOTIFICATION_BULK_IDS);

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
          const result = await db.update(notifications)
            .set({
              readState: 'read',
              readAt: now,
              state: sql`CASE
                WHEN ${notifications.disposition} = 'dismissed' THEN 'dismissed'
                WHEN ${notifications.sourceState} IN ('resolved', 'deleted') THEN 'resolved'
                WHEN ${notifications.disposition} = 'handled' THEN 'archived'
                ELSE 'read'
              END`,
            })
            .where(inArray(notifications.id, ids));
          return response(result.changes);
        }
        return writebackResponse(response, mutateNotificationsAndEnqueueWritebacks(
          ids,
          'mark_read',
          now,
        ));
      }

      case 'mark_unread': {
        const result = await db.update(notifications)
          .set({
            readState: 'unread',
            readAt: null,
            state: sql`CASE
              WHEN ${notifications.disposition} = 'dismissed' THEN 'dismissed'
              WHEN ${notifications.sourceState} IN ('resolved', 'deleted') THEN 'resolved'
              WHEN ${notifications.disposition} = 'handled' THEN 'archived'
              ELSE 'unread'
            END`,
          })
          .where(inArray(notifications.id, ids));
        return response(result.changes);
      }

      case 'dismiss': {
        const result = isDemoMode()
          ? {
              updatedCount: (await db.update(notifications)
                .set({
                  state: 'dismissed',
                  readState: 'read',
                  disposition: 'dismissed',
                  readAt: now,
                  dismissedAt: now,
                })
                .where(inArray(notifications.id, ids))).changes,
              queuedCount: 0,
            }
          : dismissNotificationsAndEnqueueWritebacks(ids, now);
        if (result.queuedCount > 0) wakeNotificationWritebackDispatcher();
        return response(result.updatedCount, result.queuedCount);
      }

      case 'handle':
      case 'archive': {
        if (isDemoMode()) {
          const result = await db.update(notifications)
            .set({
              state: sql`CASE
                WHEN ${notifications.sourceState} IN ('resolved', 'deleted') THEN 'resolved'
                ELSE 'archived'
              END`,
              disposition: 'handled',
              handledAt: now,
              archivedAt: now,
              handledSourceActivityAt: notifications.lastSourceActivityAt,
              handledSourceActivityKey: notifications.lastSourceActivityKey,
            })
            .where(inArray(notifications.id, ids));
          return response(result.changes);
        }
        return writebackResponse(response, mutateNotificationsAndEnqueueWritebacks(
          ids,
          'mark_done',
          now,
        ));
      }

      case 'mute':
      case 'unmute':
        return writebackResponse(response, mutateNotificationsAndEnqueueWritebacks(
          ids,
          action,
          now,
        ));
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
) {
  if (result.queuedCount > 0) wakeNotificationWritebackDispatcher();
  return response(result.updatedCount, result.queuedCount, result.results);
}
