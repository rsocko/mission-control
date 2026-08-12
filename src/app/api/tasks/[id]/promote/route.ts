import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';

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
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));

    if (!task) {
      return ApiErrors.notFound('Task');
    }

    if (!task.isChecklistItem || !task.parentId) {
      return NextResponse.json(
        { error: 'Task is not a subtask' },
        { status: 400 },
      );
    }

    await db
      .update(tasks)
      .set({
        parentId: null,
        depth: 0,
        isChecklistItem: false,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id));

    logger.info({ taskId: id, previousParentId: task.parentId }, 'Subtask promoted to task');

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to promote subtask', error);
  }
}
