import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  deleteGlobalTaskDependency,
  GraphServiceError,
} from '@/lib/graph/service';
import { getStoredRelationshipMutationPolicies } from '@/lib/tasks/mutation-policy';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; relationshipId: string }> },
) {
  try {
    const { id, relationshipId } = await params;
    const mutations = await getStoredRelationshipMutationPolicies(id, relationshipId);
    if (!mutations) return ApiErrors.notFound('Relationship');
    const blocked = mutations.find((mutation) => mutation.policy.mutation === 'blocked');
    if (blocked) {
      return ApiErrors.forbidden(
        blocked.policy.reason ?? 'Relationships cannot be changed for this task source',
      );
    }
    await deleteGlobalTaskDependency({ taskId: id, dependencyId: relationshipId });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GraphServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return ApiErrors.internal('Failed to delete task relationship', error);
  }
}
