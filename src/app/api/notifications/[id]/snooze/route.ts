import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import { queueCompanionActionMutation } from '@/lib/connectors/rymessage/companion-action-service';
import { stableCompanionOperationId } from '@/lib/connectors/rymessage/action-contract';

function record(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * POST /api/notifications/:id/snooze
 * 
 * Snoozes inbox work without changing read or disposition state.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const duration = body.duration as string; // e.g., '1h', '4h', '1d', '3d', '1w'
    const until = body.until as string | undefined; // ISO date override

    // Calculate snooze target
    let snoozeUntil: Date;

    if (until) {
      snoozeUntil = new Date(until);
      if (Number.isNaN(snoozeUntil.getTime())) {
        return ApiErrors.badRequest('until must be a valid ISO date');
      }
    } else {
      const now = new Date();
      switch (duration) {
        case '30m': snoozeUntil = new Date(now.getTime() + 30 * 60 * 1000); break;
        case '1h': snoozeUntil = new Date(now.getTime() + 60 * 60 * 1000); break;
        case '2h': snoozeUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000); break;
        case '4h': snoozeUntil = new Date(now.getTime() + 4 * 60 * 60 * 1000); break;
        case '1d': snoozeUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000); break;
        case '3d': snoozeUntil = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); break;
        case '1w': snoozeUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); break;
        default:
          return ApiErrors.badRequest('Invalid duration. Use: 30m, 1h, 2h, 4h, 1d, 3d, 1w');
      }
    }

    const web = await getNotificationWebPersistence();
    const snoozeAt = snoozeUntil.toISOString();
    const notification = await web.findNotificationForAction(id);
    if (!notification) {
      return ApiErrors.notFound('Notification');
    }
    if (notification.connectorType === 'rymessage') {
      const metadata = record(notification.metadata);
      const actionId = typeof metadata.actionId === 'string' ? metadata.actionId : '';
      const revision = Number(metadata.revision);
      const lifecycleRevision = Number(metadata.lifecycleRevision);
      if (
        !actionId
        || !notification.connectorInstanceId
        || !Number.isSafeInteger(revision)
      ) {
        return ApiErrors.conflict('RyMessage action identity is incomplete');
      }
      await queueCompanionActionMutation(notification.connectorInstanceId, {
        operationId: stableCompanionOperationId(
          `rymessage:snoozed:${notification.connectorInstanceId}:${actionId}:${revision}:${snoozeAt}`,
        ),
        actionId,
        baseRevision: revision,
        expectedFieldRevisions: {
          lifecycle: Number.isSafeInteger(lifecycleRevision)
            ? lifecycleRevision
            : revision,
        },
        mutation: {
          kind: 'action.lifecycle',
          state: 'snoozed',
          snoozedUntil: snoozeAt,
        },
      });
    }
    const found = await web.snoozeNotification(id, snoozeAt);

    if (!found) {
      return ApiErrors.notFound('Notification');
    }

    return NextResponse.json({
      success: true,
      snoozedUntil: snoozeAt,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to snooze notification', error);
  }
}
