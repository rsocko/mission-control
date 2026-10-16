import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskQuickSortOperation } from '@/lib/tasks/core/contracts';
import type { QuickSortTaskSnapshot } from '@/types/quick-sort';

const snapshot: QuickSortTaskSnapshot = {
  updatedAt: '2026-08-16T12:00:00.000Z',
  status: 'todo',
  statusReason: null,
  localDisposition: 'active',
  priority: 'none',
  planningHorizon: null,
  dueDate: null,
  completedAt: null,
  microStatus: null,
  snoozedUntil: null,
  reminderAt: null,
  effort: null,
  tagIds: [],
};

const operation: TaskQuickSortOperation = {
  id: 'operation-1',
  taskId: 'task-1',
  mode: 'no_priority',
  action: 'applied',
  label: 'Set priority',
  contextKey: 'queue:no-priority',
  queueIndex: 0,
  beforeSnapshot: { ...snapshot, originalPatch: { priority: 'none' } },
  afterSnapshot: snapshot,
  state: 'applied',
  aiAccepted: false,
  createdAt: '2026-08-16T12:00:00.000Z',
  undoneAt: null,
};

const mocks = vi.hoisted(() => ({
  getOperation: vi.fn(),
  captureTask: vi.fn(),
  reserveOperation: vi.fn(),
  rebaseApplyingOperation: vi.fn(),
  discardApplyingOperation: vi.fn(),
  finalizeOperation: vi.fn(),
  claimUndo: vi.fn(),
  releaseUndo: vi.fn(),
  finalizeUndo: vi.fn(),
  assignTasksToProject: vi.fn(),
  removeTasksFromProject: vi.fn(),
  patchTask: vi.fn(async () => Response.json({ success: true })),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    quickSort: {
      getOperation: mocks.getOperation,
      captureTask: mocks.captureTask,
      reserveOperation: mocks.reserveOperation,
      rebaseApplyingOperation: mocks.rebaseApplyingOperation,
      discardApplyingOperation: mocks.discardApplyingOperation,
      finalizeOperation: mocks.finalizeOperation,
      claimUndo: mocks.claimUndo,
      releaseUndo: mocks.releaseUndo,
      finalizeUndo: mocks.finalizeUndo,
    },
  }),
}));

vi.mock('@/app/api/tasks/[id]/route', () => ({
  PATCH: mocks.patchTask,
}));

vi.mock('@/lib/projects/hierarchy-service', () => ({
  assignTasksToProject: mocks.assignTasksToProject,
  removeTasksFromProject: mocks.removeTasksFromProject,
  ProjectHierarchyServiceError: class ProjectHierarchyServiceError extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperation.mockResolvedValue(operation);
  mocks.captureTask.mockResolvedValue(snapshot);
  mocks.reserveOperation.mockResolvedValue({
    kind: 'reserved',
    operation: { ...operation, state: 'applying' },
  });
  mocks.rebaseApplyingOperation.mockResolvedValue(true);
  mocks.discardApplyingOperation.mockResolvedValue(true);
  mocks.finalizeOperation.mockResolvedValue(operation);
  mocks.claimUndo.mockResolvedValue(true);
  mocks.releaseUndo.mockResolvedValue(true);
  mocks.finalizeUndo.mockResolvedValue(true);
  mocks.patchTask.mockResolvedValue(Response.json({ success: true }));
  mocks.assignTasksToProject.mockResolvedValue({ success: true });
  mocks.removeTasksFromProject.mockResolvedValue({ success: true });
});

describe('Quick Sort operation apply route', () => {
  it('finalizes a replay when the task mutation landed before a crash', async () => {
    const after = {
      ...snapshot,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'high',
    };
    const applying = {
      ...operation,
      state: 'applying' as const,
      beforeSnapshot: { ...snapshot, originalPatch: { priority: 'high' } },
      afterSnapshot: snapshot,
    };
    mocks.getOperation.mockResolvedValue(applying);
    mocks.captureTask.mockResolvedValue(after);
    mocks.finalizeOperation.mockResolvedValue({
      ...applying,
      state: 'applied',
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.patchTask).not.toHaveBeenCalled();
    expect(mocks.finalizeOperation).toHaveBeenCalledWith(
      operation.id,
      after,
      [expect.objectContaining({ operationId: operation.id, mode: operation.mode })],
    );
  });

  it('resumes a stale applying operation when its target fields are unchanged', async () => {
    const applying = {
      ...operation,
      state: 'applying' as const,
      createdAt: '2000-01-01T00:00:00.000Z',
      beforeSnapshot: { ...snapshot, originalPatch: { priority: 'high' } },
      afterSnapshot: snapshot,
    };
    const after = {
      ...snapshot,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'high',
    };
    mocks.getOperation.mockResolvedValue(applying);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(after);
    mocks.finalizeOperation.mockResolvedValue({
      ...applying,
      state: 'applied',
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.discardApplyingOperation).toHaveBeenCalledWith(operation.id);
    expect(mocks.reserveOperation).toHaveBeenCalled();
    expect(mocks.patchTask).toHaveBeenCalledTimes(1);
  });

  it('rejects stale operation recovery over a newer edit to the target field', async () => {
    const applying = {
      ...operation,
      state: 'applying' as const,
      createdAt: '2000-01-01T00:00:00.000Z',
      beforeSnapshot: { ...snapshot, originalPatch: { priority: 'high' } },
      afterSnapshot: snapshot,
    };
    mocks.getOperation.mockResolvedValue(applying);
    mocks.captureTask.mockResolvedValue({
      ...snapshot,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'critical',
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TASK_REVISION_CONFLICT',
    });
    expect(mocks.discardApplyingOperation).toHaveBeenCalledWith(operation.id);
    expect(mocks.patchTask).not.toHaveBeenCalled();
  });

  it('reserves before delegating mutation through the task PATCH field-aware CAS', async () => {
    const after = {
      ...snapshot,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'high',
    };
    mocks.getOperation.mockResolvedValue(null);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(after);
    mocks.finalizeOperation.mockResolvedValue({ ...operation, afterSnapshot: after });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    const [patchRequest] = mocks.patchTask.mock.calls[0];
    expect(patchRequest.headers.get('x-expected-task-updated-at')).toBe(snapshot.updatedAt);
    expect(patchRequest.headers.get('x-retry-task-revision-conflicts')).toBe('true');
    await expect(patchRequest.json()).resolves.toEqual({ priority: 'high' });
    expect(mocks.reserveOperation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.patchTask.mock.invocationCallOrder[0]);
    expect(mocks.patchTask.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.finalizeOperation.mock.invocationCallOrder[0]);
  });

  it('rebases and retries when sync advances the task revision', async () => {
    const synced = {
      ...snapshot,
      updatedAt: '2026-08-16T12:00:30.000Z',
      dueDate: '2026-08-20T12:00:00.000Z',
    };
    const after = {
      ...synced,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'high',
    };
    mocks.getOperation.mockResolvedValue(null);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(synced)
      .mockResolvedValueOnce(after);
    mocks.patchTask
      .mockResolvedValueOnce(Response.json({
        error: 'Task changed before this update could be applied',
        code: 'TASK_REVISION_CONFLICT',
      }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    mocks.finalizeOperation.mockResolvedValue({
      ...operation,
      beforeSnapshot: { ...synced, originalPatch: { priority: 'high' } },
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.patchTask).toHaveBeenCalledTimes(2);
    const [firstRequest] = mocks.patchTask.mock.calls[0];
    const [retryRequest] = mocks.patchTask.mock.calls[1];
    expect(firstRequest.headers.get('x-expected-task-updated-at')).toBe(snapshot.updatedAt);
    expect(retryRequest.headers.get('x-expected-task-updated-at')).toBe(synced.updatedAt);
    expect(firstRequest.headers.get('x-retry-task-revision-conflicts')).toBe('true');
    expect(retryRequest.headers.get('x-retry-task-revision-conflicts')).toBe('true');
    expect(mocks.rebaseApplyingOperation).toHaveBeenCalledWith(operation.id, {
      ...synced,
      originalPatch: { priority: 'high' },
    });
    expect(mocks.discardApplyingOperation).not.toHaveBeenCalled();
  });

  it('rebases repeatedly when overlapping syncs advance the task revision', async () => {
    const firstSync = {
      ...snapshot,
      updatedAt: '2026-08-16T12:00:20.000Z',
      dueDate: '2026-08-20T12:00:00.000Z',
    };
    const secondSync = {
      ...firstSync,
      updatedAt: '2026-08-16T12:00:40.000Z',
      status: 'done' as const,
      completedAt: '2026-08-16T12:00:35.000Z',
    };
    const after = {
      ...secondSync,
      updatedAt: '2026-08-16T12:01:00.000Z',
      priority: 'high',
    };
    const conflict = () => Response.json({
      error: 'Task changed before this update could be applied',
      code: 'TASK_REVISION_CONFLICT',
    }, { status: 409 });
    mocks.getOperation.mockResolvedValue(null);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(firstSync)
      .mockResolvedValueOnce(secondSync)
      .mockResolvedValueOnce(after);
    mocks.patchTask
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(Response.json({ success: true }));
    mocks.finalizeOperation.mockResolvedValue({
      ...operation,
      beforeSnapshot: { ...secondSync, originalPatch: { priority: 'high' } },
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.patchTask).toHaveBeenCalledTimes(3);
    expect(mocks.rebaseApplyingOperation).toHaveBeenNthCalledWith(1, operation.id, {
      ...firstSync,
      originalPatch: { priority: 'high' },
    });
    expect(mocks.rebaseApplyingOperation).toHaveBeenNthCalledWith(2, operation.id, {
      ...secondSync,
      originalPatch: { priority: 'high' },
    });
    expect(mocks.discardApplyingOperation).not.toHaveBeenCalled();
  });

  it('waits out a longer sync burst before applying the Quick Sort update', async () => {
    const horizonOperation = {
      ...operation,
      mode: 'no_planning_horizon' as const,
      label: 'Set horizon',
      beforeSnapshot: { ...snapshot, originalPatch: { planningHorizon: 'soon' } },
    };
    const revisions = Array.from({ length: 4 }, (_, index) => ({
      ...snapshot,
      updatedAt: `2026-08-16T12:00:${String((index + 1) * 10).padStart(2, '0')}.000Z`,
      dueDate: `2026-08-${20 + index}T12:00:00.000Z`,
    }));
    const after = {
      ...revisions.at(-1)!,
      updatedAt: '2026-08-16T12:01:00.000Z',
      planningHorizon: 'soon' as const,
    };
    const conflict = () => Response.json({
      error: 'Task changed before this update could be applied',
      code: 'TASK_REVISION_CONFLICT',
    }, { status: 409 });
    mocks.getOperation.mockResolvedValue(null);
    mocks.reserveOperation.mockResolvedValue({
      kind: 'reserved',
      operation: { ...horizonOperation, state: 'applying' },
    });
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(revisions[0])
      .mockResolvedValueOnce(revisions[1])
      .mockResolvedValueOnce(revisions[2])
      .mockResolvedValueOnce(revisions[3])
      .mockResolvedValueOnce(after);
    mocks.patchTask
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(Response.json({ success: true }));
    mocks.finalizeOperation.mockResolvedValue({
      ...horizonOperation,
      beforeSnapshot: { ...revisions[3], originalPatch: { planningHorizon: 'soon' } },
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: horizonOperation.id,
          taskId: horizonOperation.taskId,
          mode: horizonOperation.mode,
          action: horizonOperation.action,
          label: horizonOperation.label,
          contextKey: horizonOperation.contextKey,
          queueIndex: horizonOperation.queueIndex,
          patch: { planningHorizon: 'soon' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.patchTask).toHaveBeenCalledTimes(5);
    expect(mocks.rebaseApplyingOperation).toHaveBeenCalledTimes(4);
    expect(mocks.discardApplyingOperation).not.toHaveBeenCalled();
  });

  it('does not rebase over a concurrent edit to the target field', async () => {
    const effortOperation = {
      ...operation,
      mode: 'no_effort' as const,
      label: 'Set effort',
      beforeSnapshot: { ...snapshot, originalPatch: { effort: 3 } },
    };
    const conflict = Response.json({
      error: 'Task changed in a field included in this update',
      code: 'TASK_REVISION_CONFLICT',
    }, { status: 409 });
    mocks.getOperation.mockResolvedValue(null);
    mocks.reserveOperation.mockResolvedValue({
      kind: 'reserved',
      operation: { ...effortOperation, state: 'applying' },
    });
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        updatedAt: '2026-08-16T12:00:30.000Z',
        effort: 5,
      });
    mocks.patchTask.mockResolvedValueOnce(conflict);
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: effortOperation.id,
          taskId: effortOperation.taskId,
          mode: effortOperation.mode,
          action: effortOperation.action,
          label: effortOperation.label,
          contextKey: effortOperation.contextKey,
          queueIndex: effortOperation.queueIndex,
          patch: { effort: 3 },
        }),
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Task changed in a field included in this update',
      code: 'TASK_REVISION_CONFLICT',
    });
    expect(mocks.patchTask).toHaveBeenCalledTimes(1);
    expect(mocks.rebaseApplyingOperation).not.toHaveBeenCalled();
    expect(mocks.discardApplyingOperation).toHaveBeenCalledWith(effortOperation.id);
  });

  it('stops rebasing after the bounded retry window', async () => {
    const conflict = () => Response.json({
      error: 'Task changed before this update could be applied',
      code: 'TASK_REVISION_CONFLICT',
    }, { status: 409 });
    mocks.getOperation.mockResolvedValue(null);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:00:10.000Z' })
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:00:20.000Z' })
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:00:30.000Z' })
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:00:40.000Z' })
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:00:50.000Z' })
      .mockResolvedValueOnce({ ...snapshot, updatedAt: '2026-08-16T12:01:00.000Z' });
    mocks.patchTask
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(conflict());
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: operation.mode,
          action: operation.action,
          label: operation.label,
          contextKey: operation.contextKey,
          queueIndex: operation.queueIndex,
          patch: { priority: 'high' },
        }),
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TASK_REVISION_CONFLICT',
    });
    expect(mocks.patchTask).toHaveBeenCalledTimes(7);
    expect(mocks.rebaseApplyingOperation).toHaveBeenCalledTimes(6);
    expect(mocks.discardApplyingOperation).toHaveBeenCalledWith(operation.id);
  });

  it('assigns a project and phase as an undoable Quick Sort operation', async () => {
    const after = {
      ...snapshot,
      projectIds: ['project-1'],
      phaseIds: ['phase-1'],
    };
    mocks.getOperation.mockResolvedValue(null);
    mocks.captureTask
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(after);
    mocks.finalizeOperation.mockResolvedValue({
      ...operation,
      mode: 'no_project',
      afterSnapshot: after,
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/route');

    const response = await POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: operation.id,
          taskId: operation.taskId,
          mode: 'no_project',
          action: operation.action,
          label: 'Assign project',
          contextKey: 'queue:no-project',
          queueIndex: operation.queueIndex,
          patch: {},
          assignment: { projectId: 'project-1', phaseId: 'phase-1' },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.assignTasksToProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-1'],
      phaseId: 'phase-1',
      actor: { type: 'user' },
    });
    expect(mocks.patchTask).not.toHaveBeenCalled();
    expect(mocks.reserveOperation).toHaveBeenCalledWith(expect.objectContaining({
      beforeSnapshot: expect.objectContaining({
        originalPatch: {
          projectAssignment: { projectId: 'project-1', phaseId: 'phase-1' },
        },
      }),
    }));
  });
});

describe('Quick Sort operation undo route', () => {
  it('rejects undo when the task revision changed after the operation', async () => {
    mocks.captureTask.mockResolvedValue({
      ...snapshot,
      updatedAt: '2026-08-16T12:01:00.000Z',
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/[id]/undo/route');

    const response = await POST(
      new Request('http://localhost/api/tasks/quick-sort/operations/operation-1/undo', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: operation.id }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNDO_CONFLICT' });
    expect(mocks.claimUndo).not.toHaveBeenCalled();
  });

  it('allows only one concurrent request to claim the undo', async () => {
    let claimed = false;
    mocks.claimUndo.mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/[id]/undo/route');
    const invoke = () => POST(
      new Request('http://localhost/api/tasks/quick-sort/operations/operation-1/undo', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: operation.id }) },
    );

    const responses = await Promise.all([invoke(), invoke()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(mocks.finalizeUndo).toHaveBeenCalledTimes(1);
  });

  it('replays a completed undo without claiming or patching again', async () => {
    mocks.getOperation.mockResolvedValue({
      ...operation,
      state: 'undone',
      undoneAt: '2026-08-16T12:02:00.000Z',
    });
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/[id]/undo/route');

    const response = await POST(
      new Request('http://localhost/api/tasks/quick-sort/operations/operation-1/undo', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: operation.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operationId: operation.id,
      taskId: operation.taskId,
      undone: true,
    });
    expect(mocks.claimUndo).not.toHaveBeenCalled();
    expect(mocks.patchTask).not.toHaveBeenCalled();
  });

  it('undoes a project assignment through the hierarchy service', async () => {
    const projectOperation: TaskQuickSortOperation = {
      ...operation,
      mode: 'no_project',
      beforeSnapshot: {
        ...snapshot,
        originalPatch: {
          projectAssignment: { projectId: 'project-1', phaseId: 'phase-1' },
        },
      },
      afterSnapshot: {
        ...snapshot,
        projectIds: ['project-1'],
        phaseIds: ['phase-1'],
      },
    };
    mocks.getOperation.mockResolvedValue(projectOperation);
    mocks.captureTask.mockResolvedValue(projectOperation.afterSnapshot);
    const { POST } = await import('@/app/api/tasks/quick-sort/operations/[id]/undo/route');

    const response = await POST(
      new Request('http://localhost/api/tasks/quick-sort/operations/operation-1/undo', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: operation.id }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.removeTasksFromProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-1'],
      actor: { type: 'user' },
    });
    expect(mocks.patchTask).not.toHaveBeenCalled();
  });
});
