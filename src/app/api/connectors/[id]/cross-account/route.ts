import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiErrors } from '@/lib/api-error';
import { getCrossAccountTaskMoveService } from '@/lib/tasks/cross-account-route-service';

const requestSchema = z.object({
  taskId: z.string().min(1),
  targetInstanceId: z.string().min(1),
  action: z.string().min(1),
  targetListId: z.string().min(1).optional(),
});

/**
 * POST /api/connectors/[id]/cross-account — Copy/move a task between accounts
 * Body: { taskId, targetInstanceId, action: 'copy' | 'move', targetListId? }
 * 
 * This enables moving tasks from Personal → Work (or vice versa) via Graph API.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sourceInstanceId } = await params;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'taskId, targetInstanceId, and action are required' },
      { status: 400 }
    );
  }
  const { action } = parsed.data;
  if (action !== 'copy' && action !== 'move') {
    return NextResponse.json(
      { error: 'action must be "copy" or "move"' },
      { status: 400 },
    );
  }

  try {
    const result = await getCrossAccountTaskMoveService().execute(
      sourceInstanceId,
      { ...parsed.data, action },
      request.headers.get('x-trace-id') ?? undefined,
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return ApiErrors.internal(
      'Operation failed',
      error,
      request.headers.get('x-trace-id') ?? undefined,
    );
  }
}
