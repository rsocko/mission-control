import { NextResponse } from 'next/server';
import db from '@/db';
import { prioritySyncLog } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/priority-log — View priority sync events
 * Query params: taskId (optional), limit (default 50)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    const query = taskId
      ? db.select().from(prioritySyncLog).where(eq(prioritySyncLog.taskId, taskId)).orderBy(desc(prioritySyncLog.timestamp)).limit(limit)
      : db.select().from(prioritySyncLog).orderBy(desc(prioritySyncLog.timestamp)).limit(limit);

    const events = await query;

    return NextResponse.json({ events });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch priority log', error);
  }
}
