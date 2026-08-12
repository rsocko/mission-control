import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  createGlobalTaskDependency,
  getTaskRelationships,
  GraphServiceError,
} from '@/lib/graph/service';
import { getStoredTaskMutationPolicy } from '@/lib/tasks/mutation-policy';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await getTaskRelationships(id);
    if (!result) return ApiErrors.notFound('Task');
    return NextResponse.json(result);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch task relationships', error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as {
      relatedTaskId?: unknown;
      type?: unknown;
      direction?: unknown;
    } | null;
    if (
      !body
      || typeof body.relatedTaskId !== 'string'
      || (body.type !== 'blocks' && body.type !== 'related')
      || (
        body.type === 'blocks'
        && body.direction !== 'incoming'
        && body.direction !== 'outgoing'
      )
    ) {
      return ApiErrors.badRequest(
        'relatedTaskId, a valid type, and a direction for blocking relationships are required',
      );
    }

    const sourceTaskId = body.type === 'blocks' && body.direction === 'incoming'
      ? body.relatedTaskId
      : id;
    const targetTaskId = body.type === 'blocks' && body.direction === 'incoming'
      ? id
      : body.relatedTaskId;
    const policies = await Promise.all([
      getStoredTaskMutationPolicy(sourceTaskId, 'dependencies'),
      getStoredTaskMutationPolicy(targetTaskId, 'dependencies'),
    ]);
    if (policies.some((entry) => entry === null)) return ApiErrors.notFound('Task');
    const blocked = policies.find((entry) => entry?.policy.mutation === 'blocked');
    if (blocked) {
      return ApiErrors.forbidden(
        blocked.policy.reason ?? 'Relationships cannot be changed for this task source',
      );
    }
    const dependency = await createGlobalTaskDependency({
      sourceTaskId,
      targetTaskId,
      type: body.type,
    });
    return NextResponse.json({ dependency }, { status: 201 });
  } catch (error) {
    if (error instanceof GraphServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return ApiErrors.internal('Failed to create task relationship', error);
  }
}
