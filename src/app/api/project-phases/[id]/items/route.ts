import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  findProjectPhaseItemTaskId,
  listProjectPhaseItems,
  placeTasksInProjectPhase,
  ProjectHierarchyServiceError,
  removeTasksFromProjectPhase,
  updateProjectPhaseItem,
} from '@/lib/projects/hierarchy-service';
import type { ProjectHierarchyCommand } from '@/lib/projects/hierarchy-types';

type PhaseItemUpdates = Extract<
  ProjectHierarchyCommand,
  { type: 'update_phase_item' }
>['updates'];

function hierarchyErrorResponse(error: ProjectHierarchyServiceError) {
  return NextResponse.json({
    error: error.message,
    code: error.code,
    current: error.current,
  }, { status: error.status });
}

function hierarchyItem(
  hierarchy: Awaited<ReturnType<typeof placeTasksInProjectPhase>>['hierarchy'],
  phaseId: string,
  taskId: string,
) {
  return hierarchy.phaseItemsByPhase[phaseId]?.find((item) => item.taskId === taskId);
}

/**
 * GET /api/project-phases/[id]/items — List items in a phase
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const items = await listProjectPhaseItems(id);
    return NextResponse.json({ items });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch phase items', error);
  }
}

/**
 * POST /api/project-phases/[id]/items — Add a task to a phase
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const body = await request.json();
    const { taskId, sortOrder, estimatedEffortHours, isProposed, proposalType } = body;

    if (typeof taskId !== 'string' || !taskId.trim()) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }
    if (
      sortOrder !== undefined
      && (!Number.isInteger(sortOrder) || sortOrder < 0)
    ) {
      return NextResponse.json({ error: 'sortOrder must be a non-negative integer' }, { status: 400 });
    }
    if (
      estimatedEffortHours !== undefined
      && estimatedEffortHours !== null
      && (typeof estimatedEffortHours !== 'number' || estimatedEffortHours < 0)
    ) {
      return NextResponse.json({ error: 'estimatedEffortHours must be a non-negative number or null' }, { status: 400 });
    }
    if (isProposed !== undefined && typeof isProposed !== 'boolean') {
      return NextResponse.json({ error: 'isProposed must be a boolean' }, { status: 400 });
    }
    if (
      proposalType !== undefined
      && proposalType !== null
      && typeof proposalType !== 'string'
    ) {
      return NextResponse.json({ error: 'proposalType must be a string or null' }, { status: 400 });
    }

    const result = await placeTasksInProjectPhase({
      phaseId,
      taskIds: [taskId],
      toIndex: sortOrder ?? 0,
      preserveExistingPosition: sortOrder === undefined,
      newItem: {
        estimatedEffortHours: estimatedEffortHours ?? null,
        isProposed: isProposed ?? false,
        proposalType: proposalType ?? null,
      },
      actor: { type: 'user' },
    });
    return NextResponse.json({
      item: hierarchyItem(result.hierarchy, phaseId, taskId),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) return hierarchyErrorResponse(error);
    return ApiErrors.internal('Failed to add phase item', error);
  }
}

/**
 * PATCH /api/project-phases/[id]/items — Update a phase item (by item_id query param)
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('item_id');
    if (!itemId) {
      return NextResponse.json({ error: 'item_id query param is required' }, { status: 400 });
    }

    const body = await request.json();
    const hasSortOrder = Object.prototype.hasOwnProperty.call(body, 'sortOrder');
    const allowedMetadataFields = [
      'estimatedEffortHours',
      'isProposed',
      'proposalType',
    ] as const;
    const updates: PhaseItemUpdates = {};
    for (const field of allowedMetadataFields) {
      if (field in body) updates[field] = body[field];
    }
    if (!hasSortOrder && Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }
    if (
      hasSortOrder
      && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0)
    ) {
      return NextResponse.json({ error: 'sortOrder must be a non-negative integer' }, { status: 400 });
    }
    if (
      body.estimatedEffortHours !== undefined
      && body.estimatedEffortHours !== null
      && (typeof body.estimatedEffortHours !== 'number' || body.estimatedEffortHours < 0)
    ) {
      return NextResponse.json({ error: 'estimatedEffortHours must be a non-negative number or null' }, { status: 400 });
    }
    if (body.isProposed !== undefined && typeof body.isProposed !== 'boolean') {
      return NextResponse.json({ error: 'isProposed must be a boolean' }, { status: 400 });
    }
    if (
      body.proposalType !== undefined
      && body.proposalType !== null
      && typeof body.proposalType !== 'string'
    ) {
      return NextResponse.json({ error: 'proposalType must be a string or null' }, { status: 400 });
    }

    const existingTaskId = await findProjectPhaseItemTaskId(phaseId, itemId);
    if (!existingTaskId) return ApiErrors.notFound('Phase item');

    const result = await updateProjectPhaseItem({
      phaseId,
      taskId: existingTaskId,
      toIndex: hasSortOrder ? body.sortOrder : undefined,
      updates,
      actor: { type: 'user' },
    });
    return NextResponse.json({
      item: hierarchyItem(result.hierarchy, phaseId, existingTaskId),
    });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) return hierarchyErrorResponse(error);
    return ApiErrors.internal('Failed to update phase item', error);
  }
}

/**
 * DELETE /api/project-phases/[id]/items — Remove a task from a phase (by taskId query param)
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: phaseId } = await params;
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('task_id');
    if (!taskId) {
      return NextResponse.json({ error: 'task_id query param is required' }, { status: 400 });
    }

    await removeTasksFromProjectPhase({
      phaseId,
      taskIds: [taskId],
      actor: { type: 'user' },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) return hierarchyErrorResponse(error);
    return ApiErrors.internal('Failed to remove phase item', error);
  }
}
