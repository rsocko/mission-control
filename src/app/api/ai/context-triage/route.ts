import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';

/**
 * GET /api/ai/context-triage
 * Returns triage queue summary for Houston's context awareness.
 */
export async function GET() {
  try {
    const summary = await (await getAIWorkflowPersistence()).context.getTriageContext(
      new Date().toISOString(),
    );
    return Response.json(summary);
  } catch (error) {
    aiLogger.error({ err: error }, 'Context triage fetch failed');
    return ApiErrors.internal('Failed to fetch triage context', error);
  }
}
