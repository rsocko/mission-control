import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskByRetentionIdentity } from '@/lib/tasks/local-task-lifecycle';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const connectorId = url.searchParams.get('connectorId');
  const sourceId = url.searchParams.get('sourceId');
  if (!connectorId || !sourceId) {
    return ApiErrors.badRequest('connectorId and sourceId are required');
  }

  const task = await getTaskByRetentionIdentity({
    connectorId,
    taskSourceId: sourceId,
  });

  return NextResponse.json({ taskId: task?.id ?? null });
}
