import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';

async function scheduleRepository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.schedule;
}

/**
 * GET /api/schedule — Get scheduled tasks for a date range
 * Query params: date (required), endDate (optional, defaults to date)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();

  try {
    const scheduled = await (await scheduleRepository()).listForDate(date);

    // Group into time-blocked vs unscheduled-time
    const timeBlocked = scheduled.filter(s => s.isTimeBlocked && s.scheduledTime);
    const unblocked = scheduled.filter(s => !s.isTimeBlocked || !s.scheduledTime);

    // Calculate total scheduled minutes
    const totalMinutes = scheduled.reduce((sum, s) => sum + (s.estimatedDuration || 30), 0);

    return NextResponse.json({
      date,
      scheduled,
      timeBlocked,
      unblocked,
      stats: {
        totalTasks: scheduled.length,
        totalMinutes,
        blockedMinutes: timeBlocked.reduce((sum, s) => sum + (s.estimatedDuration || 30), 0),
      },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch schedule', error);
  }
}

/**
 * POST /api/schedule — Schedule a task (time-block or just assign to date)
 * Body: { taskId, date, time?, duration?, isTimeBlocked? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, date, time, duration, isTimeBlocked, recurrence } = body;

    if (!taskId || !date) {
      return ApiErrors.badRequest('taskId and date are required');
    }

    await (await scheduleRepository()).upsert({
      taskId,
      scheduledDate: date,
      scheduledTime: time || null,
      estimatedDuration: duration || null,
      isTimeBlocked: isTimeBlocked || false,
      recurrence: recurrence || null,
    });

    return NextResponse.json({ success: true, taskId, date, time });
  } catch (error) {
    return ApiErrors.internal('Failed to schedule task', error);
  }
}

/**
 * DELETE /api/schedule — Remove a task's schedule
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');

  if (!taskId) {
    return ApiErrors.badRequest('taskId is required');
  }

  try {
    await (await scheduleRepository()).remove(taskId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove schedule', error);
  }
}
