import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

/**
 * GET /api/priority-log — View priority sync events
 * Query params: taskId (optional), limit (default 50)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const requestedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(requestedLimit || 50, 1), 200);

  try {
    const events = await (await getTaskCorePersistence()).priorityEntities.listPrioritySyncLog({
      taskId: taskId ?? undefined,
      limit,
    });

    return NextResponse.json({ events });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch priority log', error);
  }
}
