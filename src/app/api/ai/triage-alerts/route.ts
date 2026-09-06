import {
  classifyNotificationItems,
  type NotificationClassificationInput,
} from '@/lib/ai/features/notification-classifier';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/ai/triage-alerts — Legacy route, forwards to notification triage.
 */
export async function GET() {
  try {
    const unread: NotificationClassificationInput[] =
      await (await getAIWorkflowPersistence()).notifications.listForClassification(
        new Date().toISOString(),
        20,
      );
    const result = await classifyNotificationItems(unread);
    return Response.json(result);
  } catch (error) {
    aiLogger.error({ err: error }, 'Notification triage request failed');
    return ApiErrors.internal('Failed', error);
  }
}
