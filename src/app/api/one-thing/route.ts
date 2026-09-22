import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

const CANDIDATE_LIMIT = 200;

async function oneThingRepository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.oneThing;
}

type OneThingRepository = Awaited<ReturnType<typeof oneThingRepository>>;
type ExistingOneThing = NonNullable<Awaited<ReturnType<OneThingRepository['getForWeek']>>>;

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

/** Shapes the response for an already-selected weekly one thing. */
async function respondWithExisting(existing: ExistingOneThing, weekMonday: string) {
  const repository = await oneThingRepository();

  // If the task is now done and we haven't recorded completion, update it
  const justCompleted = existing.status === 'done' && !existing.completedAt;
  const completedAt = justCompleted ? new Date().toISOString() : existing.completedAt;
  if (justCompleted) {
    await repository.markCompleted({ id: existing.id, completedAt: completedAt! });
  }

  // Fetch subtask progress
  const subtaskProgress = await repository.subtaskProgress(existing.taskId);

  return NextResponse.json({
    oneThing: {
      ...existing,
      completedAt,
      justCompleted,
      subtaskTotal: subtaskProgress.total,
      subtaskDone: subtaskProgress.done,
    },
    weekMonday,
    source: existing.isManualOverride ? 'manual' : 'auto',
  });
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
    const repository = await oneThingRepository();

    // Check for existing manual override or previously selected one-thing
    const existing = await repository.getForWeek(weekMonday);
    if (existing) return respondWithExisting(existing, weekMonday);

    // No existing selection — auto-select the best candidate
    const openTasks = await repository.listCandidates(CANDIDATE_LIMIT);

    if (openTasks.length === 0) {
      return NextResponse.json({ oneThing: null, weekMonday, source: 'none' });
    }

    // Get My Day task IDs for scoring boost
    const myDayTaskIds = new Set(await repository.listMyDayTaskIds(date));

    const now = new Date();
    const scored = openTasks
      .map(t => ({ ...t, score: scoreTask(t, myDayTaskIds.has(t.id), now) }))
      .sort((a, b) => b.score - a.score);

    const topTask = scored[0];

    // Persist the auto-selection so it's stable for the week. The write is
    // serialized on the week namespace, so a concurrent manual or auto choice
    // is never duplicated or overwritten.
    const id = `ot-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const selection = await repository.selectAuto({
      id,
      taskId: topTask.id,
      weekMonday,
      createdAt,
    });

    if (selection.outcome === 'existing') {
      const raced = await repository.getForWeek(weekMonday);
      return raced
        ? respondWithExisting(raced, weekMonday)
        : NextResponse.json({ oneThing: null, weekMonday, source: 'none' });
    }

    // Fetch subtask progress
    const subtaskProgress = await repository.subtaskProgress(topTask.id);

    return NextResponse.json({
      oneThing: {
        id,
        taskId: topTask.id,
        weekMonday,
        isManualOverride: false,
        completedAt: null,
        createdAt,
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

    // Task existence, the replacement of any prior selection and the new
    // manual insert are one serialized unit inside persistence.
    const id = `ot-${crypto.randomUUID().slice(0, 8)}`;
    const result = await (await oneThingRepository()).selectManual({
      id,
      taskId,
      weekMonday,
      createdAt: new Date().toISOString(),
    });

    if (result.outcome === 'task-not-found') {
      return ApiErrors.notFound('Task');
    }

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
    await (await oneThingRepository()).clearForWeek(weekMonday);
    return NextResponse.json({ success: true, weekMonday });
  } catch (error) {
    return ApiErrors.internal('Failed to clear one thing', error);
  }
}
