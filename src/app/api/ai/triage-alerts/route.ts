import { triageNotifications } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/ai/triage-alerts — Legacy route, forwards to notification triage.
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
