import db from '@/db';
import { notifications } from '@/db/schema';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

/**
 * GET /api/ai/context-triage
 * Returns triage queue summary for Houston's context awareness.
 */
export async function GET() {
  try {
    const unread = await db.select({
      id: notifications.id,
      level: notifications.level,
      category: notifications.category,
    }).from(notifications).where(notificationNeedsAttention());

    const criticalCount = unread.filter(n => n.level === 'critical' || n.level === 'urgent').length;
    const categories = [...new Set(unread.map(n => n.category).filter(Boolean))] as string[];

    return Response.json({
      unreadCount: unread.length,
      criticalCount,
      categories: categories.slice(0, 5),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Context triage fetch failed');
    return ApiErrors.internal('Failed to fetch triage context', error);
  }
}
