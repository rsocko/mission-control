import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  assignTasksToProject,
  ProjectHierarchyServiceError,
  removeTasksFromProject,
} from '@/lib/projects/hierarchy-service';

function hierarchyErrorResponse(error: ProjectHierarchyServiceError) {
  return NextResponse.json({
    error: error.message,
    code: error.code,
    current: error.current,
  }, { status: error.code === 'PHASE_NOT_IN_PROJECT' ? 400 : error.status });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const body = await request.json();
    const { taskId, phaseId } = body;
    const hasPhaseSelection = Object.prototype.hasOwnProperty.call(body, 'phaseId');

    if (typeof taskId !== 'string' || !taskId.trim()) {
      return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
    }
    if (hasPhaseSelection && phaseId !== null && typeof phaseId !== 'string') {
      return NextResponse.json({ error: 'phaseId must be a string or null' }, { status: 400 });
    }

    await assignTasksToProject({
      projectId,
      taskIds: [taskId],
      phaseId: hasPhaseSelection ? phaseId : undefined,
      actor: { type: 'user' },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) return hierarchyErrorResponse(error);
    return ApiErrors.internal('Failed to assign task', error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { taskId } = await request.json();

    if (typeof taskId !== 'string' || !taskId.trim()) {
      return NextResponse.json({ error: 'Task id is required' }, { status: 400 });
    }

    await removeTasksFromProject({
      projectId,
      taskIds: [taskId],
      actor: { type: 'user' },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectHierarchyServiceError) return hierarchyErrorResponse(error);
    return ApiErrors.internal('Failed to unassign task', error);
  }
}
