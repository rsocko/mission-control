import { NextResponse } from 'next/server';
import db from '@/db';
import { weeklyOneThing, tasks, myDayItems } from '@/db/schema';
import { eq, and, ne, sql } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * Get the Monday of the week for a given YYYY-MM-DD date.
 */
function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const PRIORITY_SCORES: Record<string, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
  none: 5,
};

/**
 * Score a task for "one thing" selection.
 * Criteria: highest priority + nearest due date + most blocked downstream potential.
 */
function scoreTask(task: {
  priority: string;
  dueDate: string | null;
  updatedAt: string;
  status: string;
}, isInMyDay: boolean, now: Date): number {
  let score = 0;

  // Priority weight (highest impact)
  score += PRIORITY_SCORES[task.priority] || 5;

  // Due date proximity (strong signal for "one thing")
  if (task.dueDate) {
    const dueDateStr = task.dueDate.split('T')[0];
    const dueDate = new Date(dueDateStr + 'T12:00:00');
    const daysUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / 86400000);

    if (daysUntilDue < 0) {
      // Overdue — very strong signal
      score += 90 + Math.min(Math.abs(daysUntilDue) * 5, 50);
    } else if (daysUntilDue === 0) {
      score += 80;
    } else if (daysUntilDue <= 2) {
      score += 60;
    } else if (daysUntilDue <= 7) {
      score += 30;
    }
  }

  // In My Day boost
  if (isInMyDay) {
    score += 25;
  }

  // In-progress tasks get a boost (momentum)
  if (task.status === 'in_progress') {
    score += 20;
  }

  // Recently updated boost
  const updatedDaysAgo = Math.floor((now.getTime() - new Date(task.updatedAt).getTime()) / 86400000);
  if (updatedDaysAgo <= 1) score += 10;
  else if (updatedDaysAgo <= 3) score += 5;

  return score;
}

/** Fetch subtask progress for a parent task */
async function getSubtaskProgress(taskId: string): Promise<{ total: number; done: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
    })
    .from(tasks)
    .where(eq(tasks.parentId, taskId));
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

/**
 * GET /api/one-thing — Get the "one thing" for this week.
 * Returns the manually overridden task if set, otherwise auto-selects.
 * Query params: ?date=YYYY-MM-DD (optional, defaults to today)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  const weekMonday = getWeekMonday(date);

  try {
    // Check for existing manual override or previously selected one-thing
    const [existing] = await db.select({
      id: weeklyOneThing.id,
      taskId: weeklyOneThing.taskId,
      weekMonday: weeklyOneThing.weekMonday,
      isManualOverride: weeklyOneThing.isManualOverride,
      completedAt: weeklyOneThing.completedAt,
      createdAt: weeklyOneThing.createdAt,
      // Task fields
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      connectorType: tasks.connectorType,
      sourceListName: tasks.sourceListName,
    })
      .from(weeklyOneThing)
      .innerJoin(tasks, eq(weeklyOneThing.taskId, tasks.id))
      .where(eq(weeklyOneThing.weekMonday, weekMonday))
      .limit(1);

    if (existing) {
      // If the task is now done and we haven't recorded completion, update it
      const justCompleted = existing.status === 'done' && !existing.completedAt;
      if (justCompleted) {
        await db.update(weeklyOneThing)
          .set({ completedAt: new Date().toISOString() })
          .where(eq(weeklyOneThing.id, existing.id));
      }

      // Fetch subtask progress
      const subtaskProgress = await getSubtaskProgress(existing.taskId);

      return NextResponse.json({
        oneThing: {
          ...existing,
          completedAt: justCompleted ? new Date().toISOString() : existing.completedAt,
          justCompleted,
          subtaskTotal: subtaskProgress.total,
          subtaskDone: subtaskProgress.done,
        },
        weekMonday,
        source: existing.isManualOverride ? 'manual' : 'auto',
      });
    }

    // No existing selection — auto-select the best candidate
    const openTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      connectorType: tasks.connectorType,
      sourceListName: tasks.sourceListName,
      updatedAt: tasks.updatedAt,
      depth: tasks.depth,
    })
      .from(tasks)
      .where(
        and(
          ne(tasks.status, 'done'),
          ne(tasks.status, 'cancelled'),
          eq(tasks.depth, 0),
        )
      )
      .limit(200);

    if (openTasks.length === 0) {
      return NextResponse.json({ oneThing: null, weekMonday, source: 'none' });
    }

    // Get My Day task IDs for scoring boost
    const myDayRows = await db.select({ taskId: myDayItems.taskId })
      .from(myDayItems)
      .where(eq(myDayItems.date, date));
    const myDayTaskIds = new Set(myDayRows.map(r => r.taskId));

    const now = new Date();
    const scored = openTasks
      .map(t => ({ ...t, score: scoreTask(t, myDayTaskIds.has(t.id), now) }))
      .sort((a, b) => b.score - a.score);

    const topTask = scored[0];

    // Persist the auto-selection so it's stable for the week
    const id = `ot-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(weeklyOneThing).values({
      id,
      taskId: topTask.id,
      weekMonday,
      isManualOverride: false,
      createdAt: new Date().toISOString(),
    });

    // Fetch subtask progress
    const subtaskProgress = await getSubtaskProgress(topTask.id);

    return NextResponse.json({
      oneThing: {
        id,
        taskId: topTask.id,
        weekMonday,
        isManualOverride: false,
        completedAt: null,
        createdAt: new Date().toISOString(),
        title: topTask.title,
        status: topTask.status,
        priority: topTask.priority,
        dueDate: topTask.dueDate,
        connectorType: topTask.connectorType,
        sourceListName: topTask.sourceListName,
        justCompleted: false,
        subtaskTotal: subtaskProgress.total,
        subtaskDone: subtaskProgress.done,
      },
      weekMonday,
      source: 'auto',
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch one thing');
    return ApiErrors.internal('Failed to get one thing', error);
  }
}

/**
 * POST /api/one-thing — Manually override the "one thing" for this week.
 * Body: { taskId: string, date?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId } = body;
    const date = body.date || getLocalToday();
    const weekMonday = getWeekMonday(date);

    if (!taskId) {
      return ApiErrors.badRequest('taskId is required');
    }

    // Verify task exists
    const [task] = await db.select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!task) {
      return ApiErrors.notFound('Task');
    }

    // Delete any existing one-thing for this week
    await db.delete(weeklyOneThing).where(eq(weeklyOneThing.weekMonday, weekMonday));

    // Insert the new manual override
    const id = `ot-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(weeklyOneThing).values({
      id,
      taskId,
      weekMonday,
      isManualOverride: true,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ id, taskId, weekMonday }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to set one thing', error);
  }
}

/**
 * DELETE /api/one-thing — Clear the manual override (reverts to auto-selection next load).
 * Query params: ?date=YYYY-MM-DD (optional)
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  const weekMonday = getWeekMonday(date);

  try {
    await db.delete(weeklyOneThing).where(eq(weeklyOneThing.weekMonday, weekMonday));
    return NextResponse.json({ success: true, weekMonday });
  } catch (error) {
    return ApiErrors.internal('Failed to clear one thing', error);
  }
}
