import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

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
