import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import db, { runTransaction } from '@/db';
import { quickSortLog, quickSortOperations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { PATCH as patchTask } from '@/app/api/tasks/[id]/route';
import {
  captureQuickSortTask,
  QUICK_SORT_MODES,
  type QuickSortMode,
} from '@/lib/quick-sort/operations';

interface ApplyOperationBody {
  operationId?: string;
  taskId?: string;
  mode?: string;
  action?: string;
  label?: string;
  contextKey?: string;
  queueIndex?: number;
  patch?: Record<string, unknown>;
  logModes?: string[];
  aiAccepted?: boolean;
}

function operationResponse(operation: typeof quickSortOperations.$inferSelect) {
  return {
    operation: {
      id: operation.id,
      taskId: operation.taskId,
      mode: operation.mode,
      label: operation.label,
      contextKey: operation.contextKey,
      queueIndex: operation.queueIndex,
      aiAccepted: operation.aiAccepted,
      state: operation.state,
    },
  };
}

function isQuickSortMode(value: string | undefined): value is QuickSortMode {
  return value !== undefined && QUICK_SORT_MODES.some((mode) => mode === value);
}

function isQuickSortAction(
  value: string | undefined,
): value is 'applied' | 'suggestion_accepted' | 'skipped' {
  return value === 'applied' || value === 'suggestion_accepted' || value === 'skipped';
}

export async function POST(request: Request) {
  let body: ApplyOperationBody;
  try {
    body = await request.json() as ApplyOperationBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    operationId,
    taskId,
    mode,
    action,
    label,
    contextKey,
    queueIndex,
    patch,
    aiAccepted = false,
  } = body;
  if (
    !operationId
    || !taskId
    || !isQuickSortMode(mode)
    || !isQuickSortAction(action)
    || !label
    || !contextKey
    || typeof queueIndex !== 'number'
    || !Number.isInteger(queueIndex)
    || queueIndex < 0
    || !patch
    || typeof patch !== 'object'
    || Array.isArray(patch)
    || Object.keys(patch).length === 0
  ) {
    return NextResponse.json({ error: 'Invalid Quick Sort operation' }, { status: 400 });
  }

  const existing = await db.select()
    .from(quickSortOperations)
    .where(eq(quickSortOperations.id, operationId))
    .get();
  if (existing) {
    if (existing.taskId !== taskId || existing.contextKey !== contextKey) {
      return NextResponse.json({ error: 'Operation ID is already in use' }, { status: 409 });
    }
    if (existing.state === 'applied' || existing.state === 'undone') {
      return NextResponse.json(operationResponse(existing));
    }
    return NextResponse.json({ error: 'Operation is still being applied' }, { status: 409 });
  }

  const before = await captureQuickSortTask(taskId);
  if (!before) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const now = new Date().toISOString();
  await db.insert(quickSortOperations).values({
    id: operationId,
    taskId,
    mode,
    action,
    label,
    contextKey,
    queueIndex,
    beforeSnapshot: { ...before, originalPatch: patch },
    afterSnapshot: before,
    state: 'applying',
    aiAccepted,
    createdAt: now,
  });

  const patchResponse = await patchTask(
    new Request(new URL(`/api/tasks/${taskId}`, request.url), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-expected-task-updated-at': before.updatedAt,
      },
      body: JSON.stringify(patch),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
  if (!patchResponse.ok) {
    await db.delete(quickSortOperations).where(eq(quickSortOperations.id, operationId));
    return new NextResponse(await patchResponse.text(), {
      status: patchResponse.status,
      headers: { 'Content-Type': patchResponse.headers.get('Content-Type') ?? 'application/json' },
    });
  }

  const after = await captureQuickSortTask(taskId);
  if (!after) {
    await db.delete(quickSortOperations).where(eq(quickSortOperations.id, operationId));
    return NextResponse.json({ error: 'Task disappeared after update' }, { status: 409 });
  }
  const requestedLogModes = body.logModes?.filter(isQuickSortMode) ?? [mode];
  const logModes = [...new Set(
    requestedLogModes.length > 0 ? requestedLogModes : [mode],
  )];
  runTransaction((tx) => {
    tx.update(quickSortOperations).set({
      afterSnapshot: after,
      state: 'applied',
    }).where(eq(quickSortOperations.id, operationId)).run();
    tx.insert(quickSortLog).values(logModes.map((logMode) => ({
      id: randomUUID(),
      taskId,
      operationId,
      mode: logMode,
      action,
      triagedAt: now,
    }))).run();
  });

  const applied = await db.select()
    .from(quickSortOperations)
    .where(eq(quickSortOperations.id, operationId))
    .get();
  return NextResponse.json(operationResponse(applied!));
}
