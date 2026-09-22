import { getLocalToday } from '@/lib/utils/date';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';

/**
 * GET /api/ai/context-tasks
 * Returns overdue, today, and in-progress tasks for Houston's context awareness.
 */
export async function GET() {
  try {
    const allTasks = await (await getAIWorkflowPersistence()).context.listTaskContext();

    const today = getLocalToday();
    const open = allTasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');

    const overdue = open
      .filter(t => t.dueDate && t.dueDate < today)
      .slice(0, 10);

    const todayTasks = open
      .filter(t => t.dueDate === today)
      .slice(0, 10);

    const inProgress = open
      .filter(t => t.status === 'in_progress')
      .slice(0, 10);

    return Response.json({ overdue, today: todayTasks, inProgress });
  } catch (error) {
    aiLogger.error({ err: error }, 'Context tasks fetch failed');
    return ApiErrors.internal('Failed to fetch context tasks', error);
  }
}
