import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { PATCH as patchTask } from '@/app/api/tasks/[id]/route';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  TaskQuickSortAction,
  TaskQuickSortOperation,
} from '@/lib/tasks/core/contracts';
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

function operationResponse(operation: TaskQuickSortOperation) {
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
): value is TaskQuickSortAction {
  return value === 'applied' || value === 'suggestion_accepted' || value === 'skipped';
}

function replayOperation(
  operation: TaskQuickSortOperation,
  taskId: string,
  contextKey: string,
) {
  if (operation.taskId !== taskId || operation.contextKey !== contextKey) {
    return NextResponse.json({ error: 'Operation ID is already in use' }, { status: 409 });
  }
  if (operation.state === 'applied' || operation.state === 'undone') {
    return NextResponse.json(operationResponse(operation));
  }
  return NextResponse.json({ error: 'Operation is still being applied' }, { status: 409 });
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
  const hasPatch = Boolean(
    patch
    && typeof patch === 'object'
    && !Array.isArray(patch)
    && Object.keys(patch).length > 0,
  );
  const mutatesTask = action !== 'skipped';
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
    || (mutatesTask && !hasPatch)
  ) {
    return NextResponse.json({ error: 'Invalid Quick Sort operation' }, { status: 400 });
  }

  const quickSort = (await getTaskCorePersistence()).quickSort;
  const existing = await quickSort.getOperation(operationId);
  if (existing) {
    return replayOperation(existing, taskId, contextKey);
  }

  const before = await captureQuickSortTask(taskId);
  if (!before) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const now = new Date().toISOString();
  const reservation = await quickSort.reserveOperation({
    id: operationId,
    taskId,
    mode,
    action,
    label,
    contextKey,
    queueIndex,
    beforeSnapshot: { ...before, originalPatch: mutatesTask ? patch : {} },
    afterSnapshot: before,
    aiAccepted,
    createdAt: now,
  });
  if (reservation.kind === 'existing') {
    return replayOperation(reservation.operation, taskId, contextKey);
  }

  let after = before;
  if (mutatesTask) {
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
      await quickSort.discardApplyingOperation(operationId);
      return new NextResponse(await patchResponse.text(), {
        status: patchResponse.status,
        headers: { 'Content-Type': patchResponse.headers.get('Content-Type') ?? 'application/json' },
      });
    }

    const capturedAfter = await captureQuickSortTask(taskId);
    if (!capturedAfter) {
      await quickSort.discardApplyingOperation(operationId);
      return NextResponse.json({ error: 'Task disappeared after update' }, { status: 409 });
    }
    after = capturedAfter;
  }
  const requestedLogModes = body.logModes?.filter(isQuickSortMode) ?? [mode];
  const logModes = [...new Set(
    requestedLogModes.length > 0 ? requestedLogModes : [mode],
  )];
  const applied = await quickSort.finalizeOperation(
    operationId,
    after,
    logModes.map((logMode) => ({
      id: randomUUID(),
      taskId,
      operationId,
      mode: logMode,
      action,
      triagedAt: now,
    })),
  );
  if (!applied) {
    return NextResponse.json({ error: 'Operation is still being applied' }, { status: 409 });
  }
  return NextResponse.json(operationResponse(applied));
}
