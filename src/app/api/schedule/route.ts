import { NextResponse } from 'next/server';
import db from '@/db';
import { taskSchedules, tasks } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/schedule — Get scheduled tasks for a date range
 * Query params: date (required), endDate (optional, defaults to date)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  const endDate = searchParams.get('endDate') || date;

  try {
    const scheduled = await db.select({
      taskId: taskSchedules.taskId,
      scheduledDate: taskSchedules.scheduledDate,
      scheduledTime: taskSchedules.scheduledTime,
      estimatedDuration: taskSchedules.estimatedDuration,
      isTimeBlocked: taskSchedules.isTimeBlocked,
      recurrence: taskSchedules.recurrence,
      // Task details
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      connectorType: tasks.connectorType,
      sourceListName: tasks.sourceListName,
    })
      .from(taskSchedules)
      .innerJoin(tasks, eq(taskSchedules.taskId, tasks.id))
      .where(
        and(
          eq(taskSchedules.scheduledDate, date),
        )
      )
      .orderBy(taskSchedules.scheduledTime);

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

    // Upsert schedule
    const existing = await db.select().from(taskSchedules).where(eq(taskSchedules.taskId, taskId));

    if (existing.length > 0) {
      await db.update(taskSchedules).set({
        scheduledDate: date,
        scheduledTime: time || null,
        estimatedDuration: duration || null,
        isTimeBlocked: isTimeBlocked || false,
        recurrence: recurrence || null,
      }).where(eq(taskSchedules.taskId, taskId));
    } else {
      await db.insert(taskSchedules).values({
        taskId,
        scheduledDate: date,
        scheduledTime: time || null,
        estimatedDuration: duration || null,
        isTimeBlocked: isTimeBlocked || false,
        recurrence: recurrence || null,
      });
    }

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
    await db.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId));
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove schedule', error);
  }
}
