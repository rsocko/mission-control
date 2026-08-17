import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { quickSortLog, quickSortOperations } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { PATCH as patchTask } from '@/app/api/tasks/[id]/route';
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
  const operation = await db.select()
    .from(quickSortOperations)
    .where(eq(quickSortOperations.id, id))
    .get();
  if (!operation) return NextResponse.json({ error: 'Undo operation not found' }, { status: 404 });
  if (operation.state === 'undone') {
    return NextResponse.json({ operationId: id, taskId: operation.taskId, undone: true });
  }
  if (operation.state !== 'applied') {
    return NextResponse.json({ error: 'Undo operation is already in progress' }, { status: 409 });
  }

  const current = await captureQuickSortTask(operation.taskId);
  const expected = operation.afterSnapshot;
  if (!current || !snapshotsMatch(current, expected)) {
    return NextResponse.json({
      error: 'This task changed after the Quick Sort action. Undo was not applied.',
      code: 'UNDO_CONFLICT',
    }, { status: 409 });
  }

  const claimed = await db.update(quickSortOperations)
    .set({ state: 'undoing' })
    .where(and(
      eq(quickSortOperations.id, id),
      eq(quickSortOperations.state, 'applied'),
      isNull(quickSortOperations.undoneAt),
    ))
    .returning({ id: quickSortOperations.id })
    .get();
  if (!claimed) {
    return NextResponse.json({ error: 'Undo operation is already in progress' }, { status: 409 });
  }

  const before = operation.beforeSnapshot;
  const undoPatch = buildUndoPatch(before, before.originalPatch);
  const patchResponse = await patchTask(
    new Request(new URL(`/api/tasks/${operation.taskId}`, request.url), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-expected-task-updated-at': expected.updatedAt,
      },
      body: JSON.stringify(undoPatch),
    }),
    { params: Promise.resolve({ id: operation.taskId }) },
  );
  if (!patchResponse.ok) {
    await db.update(quickSortOperations)
      .set({ state: 'applied' })
      .where(eq(quickSortOperations.id, id));
    return new NextResponse(await patchResponse.text(), {
      status: patchResponse.status,
      headers: { 'Content-Type': patchResponse.headers.get('Content-Type') ?? 'application/json' },
    });
  }

  const undoneAt = new Date().toISOString();
  runTransaction((tx) => {
    tx.update(quickSortOperations).set({
      state: 'undone',
      undoneAt,
    }).where(eq(quickSortOperations.id, id)).run();
    tx.update(quickSortLog).set({ reversedAt: undoneAt })
      .where(eq(quickSortLog.operationId, id))
      .run();
  });
  return NextResponse.json({ operationId: id, taskId: operation.taskId, undone: true });
}
