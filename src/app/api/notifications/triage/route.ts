import { triageNotifications } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/notifications/triage
 * 
 * AI-powered notification triage — analyzes unread notifications and
 * recommends level adjustments based on context.
 */
export async function GET() {
  try {
    const result = await triageNotifications();
    return Response.json(result);
  } catch (error) {
    aiLogger.error({ err: error }, 'Notification triage request failed');
    return ApiErrors.internal('Failed', error);
  }
}
