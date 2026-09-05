import { NextResponse } from 'next/server';
import { PATCH as patchTask } from '@/app/api/tasks/[id]/route';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import {
  buildUndoPatch,
  captureQuickSortTask,
  snapshotsMatch,
} from '@/lib/quick-sort/operations';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const quickSort = (await getTaskCorePersistence()).quickSort;
  const operation = await quickSort.getOperation(id);
  if (!operation) return NextResponse.json({ error: 'Undo operation not found' }, { status: 404 });
  if (operation.state === 'undone') {
    return NextResponse.json({ operationId: id, taskId: operation.taskId, undone: true });
  }
  if (operation.state !== 'applied') {
    return NextResponse.json({ error: 'Undo operation is already in progress' }, { status: 409 });
  }

  const before = operation.beforeSnapshot;
  const hasTaskPatch = Object.keys(before.originalPatch).length > 0;
  if (hasTaskPatch) {
    const current = await captureQuickSortTask(operation.taskId);
    if (!current || !snapshotsMatch(current, operation.afterSnapshot)) {
      return NextResponse.json({
        error: 'This task changed after the Quick Sort action. Undo was not applied.',
        code: 'UNDO_CONFLICT',
      }, { status: 409 });
    }
  }

  const claimed = await quickSort.claimUndo(id);
  if (!claimed) {
    return NextResponse.json({ error: 'Undo operation is already in progress' }, { status: 409 });
  }

  if (hasTaskPatch) {
    const undoPatch = buildUndoPatch(before, before.originalPatch);
    const patchResponse = await patchTask(
      new Request(new URL(`/api/tasks/${operation.taskId}`, request.url), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-expected-task-updated-at': operation.afterSnapshot.updatedAt,
        },
        body: JSON.stringify(undoPatch),
      }),
      { params: Promise.resolve({ id: operation.taskId }) },
    );
    if (!patchResponse.ok) {
      await quickSort.releaseUndo(id);
      return new NextResponse(await patchResponse.text(), {
        status: patchResponse.status,
        headers: { 'Content-Type': patchResponse.headers.get('Content-Type') ?? 'application/json' },
      });
    }
  }

  const undoneAt = new Date().toISOString();
  if (!await quickSort.finalizeUndo(id, undoneAt)) {
    return NextResponse.json({ error: 'Undo operation is already in progress' }, { status: 409 });
  }
  return NextResponse.json({ operationId: id, taskId: operation.taskId, undone: true });
}
