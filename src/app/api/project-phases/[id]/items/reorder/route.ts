import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  ProjectHierarchyServiceError,
  reorderTasksInProjectPhase,
} from '@/lib/projects/hierarchy-service';

/**
 * PUT /api/project-phases/[id]/items/reorder — Bulk-update item sortOrder within a phase.
 * Body: { orderedTaskIds: string[] }
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const body = await request.json();
    const orderedTaskIds: unknown = body.orderedTaskIds;

    if (
      !Array.isArray(orderedTaskIds)
      || orderedTaskIds.length === 0
      || orderedTaskIds.some((taskId) => typeof taskId !== 'string' || !taskId.trim())
      || new Set(orderedTaskIds).size !== orderedTaskIds.length
    ) {
      return NextResponse.json({ error: 'orderedTaskIds must be a non-empty array' }, { status: 400 });
    }

    const result = await reorderTasksInProjectPhase({
      phaseId,
      orderedTaskIds,
      actor: { type: 'user' },
    });
    return NextResponse.json({
      items: result.hierarchy.phaseItemsByPhase[phaseId] ?? [],
    });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        current: error.current,
      }, { status: error.status });
    }
    return ApiErrors.internal('Failed to reorder phase items', error);
  }
}
