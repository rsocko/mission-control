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
import {
  assignTasksToProject,
  ProjectHierarchyServiceError,
} from '@/lib/projects/hierarchy-service';

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
  assignment?: {
    projectId?: string;
    phaseId?: string | null;
  };
}

const MAX_REVISION_REBASE_ATTEMPTS = 3;
const APPLYING_OPERATION_STALE_MS = 60_000;

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

function snapshotValueMatches(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  }
  return left === right;
}

function patchMatchesSnapshot(
  snapshot: TaskQuickSortOperation['afterSnapshot'],
  patch: Record<string, unknown>,
) {
  return Object.entries(patch).every(([field, value]) => {
    if (field === 'tags') return snapshotValueMatches(snapshot.tagIds, value);
    if (field === 'projectAssignment') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const assignment = value as { projectId?: unknown; phaseId?: unknown };
      if (
        typeof assignment.projectId !== 'string'
        || !snapshot.projectIds?.includes(assignment.projectId)
      ) return false;
      return typeof assignment.phaseId !== 'string'
        || snapshot.phaseIds?.includes(assignment.phaseId) === true;
    }
    return snapshotValueMatches(
      snapshot[field as keyof TaskQuickSortOperation['afterSnapshot']],
      value,
    );
  });
}

function patchFieldsUnchanged(
  current: TaskQuickSortOperation['afterSnapshot'],
  operation: TaskQuickSortOperation,
) {
  const patch = operation.beforeSnapshot.originalPatch;
  return Object.keys(patch).every((field) => {
    if (field === 'tags') {
      return snapshotValueMatches(current.tagIds, operation.beforeSnapshot.tagIds);
    }
    if (field === 'projectAssignment') {
      return snapshotValueMatches(current.projectIds, operation.beforeSnapshot.projectIds)
        && snapshotValueMatches(current.phaseIds, operation.beforeSnapshot.phaseIds);
    }
    return snapshotValueMatches(
      current[field as keyof TaskQuickSortOperation['afterSnapshot']],
      operation.beforeSnapshot[field as keyof TaskQuickSortOperation['afterSnapshot']],
    );
  });
}

async function recoverApplyingOperation(
  operation: TaskQuickSortOperation,
  taskId: string,
  contextKey: string,
): Promise<Response | null> {
  if (operation.taskId !== taskId || operation.contextKey !== contextKey) {
    return NextResponse.json({ error: 'Operation ID is already in use' }, { status: 409 });
  }
  const quickSort = (await getTaskCorePersistence()).quickSort;
  const current = await captureQuickSortTask(taskId);
  if (!current) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (patchMatchesSnapshot(current, operation.beforeSnapshot.originalPatch)) {
    const recovered = await quickSort.finalizeOperation(operation.id, current, [{
      id: randomUUID(),
      taskId,
      operationId: operation.id,
      mode: operation.mode,
      action: operation.action,
      triagedAt: new Date().toISOString(),
    }]);
    if (recovered) return NextResponse.json(operationResponse(recovered));
    const replay = await quickSort.getOperation(operation.id);
    return replay
      ? replayOperation(replay, taskId, contextKey)
      : NextResponse.json({ error: 'Operation recovery failed' }, { status: 409 });
  }
  const createdAt = Date.parse(operation.createdAt);
  if (
    Number.isFinite(createdAt)
    && Date.now() - createdAt >= APPLYING_OPERATION_STALE_MS
  ) {
    await quickSort.discardApplyingOperation(operation.id);
    if (patchFieldsUnchanged(current, operation)) return null;
    return NextResponse.json({
      error: 'Task changed while recovering this Quick Sort operation',
      code: 'TASK_REVISION_CONFLICT',
    }, { status: 409 });
  }
  return NextResponse.json({ error: 'Operation is still being applied' }, { status: 409 });
}

function patchTaskAtVersion(
  request: Request,
  taskId: string,
  patch: Record<string, unknown>,
  updatedAt: string,
) {
  return patchTask(
    new Request(new URL(`/api/tasks/${taskId}`, request.url), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-expected-task-updated-at': updatedAt,
      },
      body: JSON.stringify(patch),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

async function isTaskRevisionConflict(response: Response) {
  if (response.status !== 409) return false;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return body?.code === 'TASK_REVISION_CONFLICT';
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
    assignment,
    aiAccepted = false,
  } = body;
  const hasPatch = Boolean(
    patch
    && typeof patch === 'object'
    && !Array.isArray(patch)
    && Object.keys(patch).length > 0,
  );
  const hasAssignment = Boolean(
    assignment
    && typeof assignment.projectId === 'string'
    && assignment.projectId.trim()
    && (assignment.phaseId === undefined
      || assignment.phaseId === null
      || typeof assignment.phaseId === 'string'),
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
    || (mutatesTask && !hasPatch && !hasAssignment)
    || (hasPatch && hasAssignment)
    || (hasAssignment && mode !== 'no_project')
  ) {
    return NextResponse.json({ error: 'Invalid Quick Sort operation' }, { status: 400 });
  }

  const quickSort = (await getTaskCorePersistence()).quickSort;
  const existing = await quickSort.getOperation(operationId);
  if (existing) {
    if (existing.state === 'applying') {
      const recoveryResponse = await recoverApplyingOperation(existing, taskId, contextKey);
      if (recoveryResponse) return recoveryResponse;
    } else {
      return replayOperation(existing, taskId, contextKey);
    }
  }

  let before = await captureQuickSortTask(taskId);
  if (!before) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const originalPatch = hasAssignment
    ? { projectAssignment: assignment }
    : mutatesTask ? patch : {};
  const now = new Date().toISOString();
  const reservation = await quickSort.reserveOperation({
    id: operationId,
    taskId,
    mode,
    action,
    label,
    contextKey,
    queueIndex,
    beforeSnapshot: {
      ...before,
      originalPatch,
    },
    afterSnapshot: before,
    aiAccepted,
    createdAt: now,
  });
  if (reservation.kind === 'existing') {
    return replayOperation(reservation.operation, taskId, contextKey);
  }

  let after = before;
  if (hasAssignment) {
    try {
      await assignTasksToProject({
        projectId: assignment!.projectId!,
        taskIds: [taskId],
        phaseId: assignment!.phaseId,
        actor: { type: 'user' },
      });
    } catch (error) {
      await quickSort.discardApplyingOperation(operationId);
      if (error instanceof ProjectHierarchyServiceError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status },
        );
      }
      throw error;
    }
    const capturedAfter = await captureQuickSortTask(taskId);
    if (!capturedAfter) {
      await quickSort.discardApplyingOperation(operationId);
      return NextResponse.json({ error: 'Task disappeared after update' }, { status: 409 });
    }
    after = capturedAfter;
  } else if (mutatesTask) {
    let patchResponse = await patchTaskAtVersion(request, taskId, patch!, before.updatedAt);
    let rebaseAttempts = 0;
    while (
      rebaseAttempts < MAX_REVISION_REBASE_ATTEMPTS
      && await isTaskRevisionConflict(patchResponse)
    ) {
      const rebasedBefore = await captureQuickSortTask(taskId);
      if (!rebasedBefore) {
        await quickSort.discardApplyingOperation(operationId);
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      const rebased = await quickSort.rebaseApplyingOperation(operationId, {
        ...rebasedBefore,
        originalPatch,
      });
      if (!rebased) {
        return NextResponse.json({ error: 'Operation is still being applied' }, { status: 409 });
      }
      before = rebasedBefore;
      rebaseAttempts++;
      patchResponse = await patchTaskAtVersion(request, taskId, patch!, before.updatedAt);
    }
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
