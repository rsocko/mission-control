import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

/**
 * POST /api/tasks/[id]/promote — Promote a subtask (checklist item) to a standalone task.
 *
 * Clears the parentId, depth, and isChecklistItem flag so the task appears as a
 * top-level task in its source list.  The change is local-only; the remote source
 * is not modified (source-side parent relationship, if any, stays in place and will
 * be ignored by the pull-manager which does not overwrite parentId/isChecklistItem
 * during incremental updates).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const { ancillary } = await getTaskCorePersistence();
    const task = await ancillary.getTask(id);

    if (!task) {
      return ApiErrors.notFound('Task');
    }

    if (!task.isChecklistItem || !task.parentId) {
      return NextResponse.json(
        { error: 'Task is not a subtask' },
        { status: 400 },
      );
    }

    const outcome = await ancillary.promoteSubtask({
      taskId: id,
      expectedUpdatedAt: task.updatedAt,
      now: new Date().toISOString(),
    });
    if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
    if (outcome.kind === 'not-subtask') {
      return NextResponse.json({ error: 'Task is not a subtask' }, { status: 400 });
    }
    if (outcome.kind === 'revision-conflict') {
      return NextResponse.json(
        { error: 'Task changed while it was being promoted' },
        { status: 409 },
      );
    }

    logger.info({ taskId: id, previousParentId: outcome.previousParentId }, 'Subtask promoted to task');

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to promote subtask', error);
  }
}
