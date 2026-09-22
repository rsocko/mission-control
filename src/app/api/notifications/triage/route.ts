import { classifyNotificationItems } from '@/lib/ai/features/notification-classifier';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

/**
 * GET /api/notifications/triage
 * 
 * AI-powered notification triage — analyzes unread notifications and
 * recommends level adjustments based on context.
 */
export async function GET() {
  try {
    const persistence = await getNotificationWebPersistence();
    const unread = await persistence.listNotificationsForClassification(20);
    const result = await classifyNotificationItems(unread);
    return Response.json(result);
  } catch (error) {
    aiLogger.error({ err: error }, 'Notification triage request failed');
    return ApiErrors.internal('Failed', error);
  }
}
