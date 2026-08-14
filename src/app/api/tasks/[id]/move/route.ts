import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  executeTaskMove,
  type DeferredTaskMoveInput,
} from '@/lib/tasks/task-move-service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, input] = await Promise.all([
      params,
      request.json() as Promise<DeferredTaskMoveInput>,
    ]);
    const result = await executeTaskMove({
      strategy: 'pending-sync',
      taskId: id,
      input,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return ApiErrors.internal('Failed to move task', error);
  }
}
