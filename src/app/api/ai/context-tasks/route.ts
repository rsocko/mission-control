import db from '@/db';
import { tasks } from '@/db/schema';
import { getLocalToday } from '@/lib/utils/date';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/ai/context-tasks
 * Returns overdue, today, and in-progress tasks for Houston's context awareness.
 */
export async function GET() {
  try {
    const allTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
    }).from(tasks);

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
