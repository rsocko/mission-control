import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  createTaskDependency,
  GraphServiceError,
} from '@/lib/graph/service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: projectId } = await params;
    const body = await request.json().catch(() => null) as {
      sourceTaskId?: unknown;
      targetTaskId?: unknown;
      type?: unknown;
    } | null;

    if (
      !body
      || typeof body.sourceTaskId !== 'string'
      || typeof body.targetTaskId !== 'string'
      || (body.type !== 'blocks' && body.type !== 'related')
    ) {
      return ApiErrors.badRequest('sourceTaskId, targetTaskId, and a valid type are required');
    }

    const dependency = await createTaskDependency({
      projectId,
      sourceTaskId: body.sourceTaskId,
      targetTaskId: body.targetTaskId,
      type: body.type,
    });
    return NextResponse.json({ dependency }, { status: 201 });
  } catch (error) {
    if (error instanceof GraphServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return ApiErrors.internal('Failed to create task dependency', error);
  }
}
