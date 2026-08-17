import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  executeTaskMove,
  type ExecuteTaskMoveInput,
} from '@/lib/tasks/task-move-service';

export async function POST(request: Request) {
  try {
    const input = await request.json() as ExecuteTaskMoveInput;
    const result = await executeTaskMove({
      strategy: 'write-through',
      input,
      traceId: request.headers.get('x-trace-id') ?? undefined,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return ApiErrors.internal(
      'Failed to execute task move',
      error,
      request.headers.get('x-trace-id') ?? undefined,
    );
  }
}
