import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import type { NotificationLevel } from '@/types';
import {
  isNotificationUnread,
} from '@/lib/notifications/lifecycle';
import { notificationIsInInbox } from '@/lib/notifications/lifecycle-sql';

function mapSeverityToLevel(severity: string): NotificationLevel | null {
  switch (severity) {
    case 'critical':
      return 'urgent';
    case 'high':
      return 'action_needed';
    case 'medium':
      return 'heads_up';
    case 'low':
      return 'fyi';
    case 'info':
      return 'digest';
    case 'urgent':
    case 'action_needed':
    case 'heads_up':
    case 'fyi':
    case 'digest':
      return severity;
    default:
      return null;
  }
}

function mapLevelToSeverity(level: string): string {
  switch (level) {
    case 'urgent':
      return 'critical';
    case 'action_needed':
      return 'high';
    case 'heads_up':
      return 'medium';
    case 'fyi':
      return 'low';
    case 'digest':
    default:
      return 'info';
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const severity = searchParams.get('severity');
  const dismissed = searchParams.get('dismissed');
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    const conditions = [eq(notifications.category, 'finance')];

    if (type) {
      conditions.push(eq(notifications.templateKey, type));
    }
    if (severity) {
      const mappedLevel = mapSeverityToLevel(severity);
      if (mappedLevel) {
        conditions.push(eq(notifications.level, mappedLevel));
      }
    }
    if (dismissed === 'false') {
      conditions.push(notificationIsInInbox());
    }

    const result = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.receivedAt))
      .limit(limit);

    return NextResponse.json({
      notifications: result.map((notification) => ({
        ...notification,
        severity: mapLevelToSeverity(notification.level),
        category: notification.templateKey || notification.category,
        isRead: !isNotificationUnread(notification),
        actionUrl: notification.navigationTarget,
      })),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch finance notifications', error);
  }
}
