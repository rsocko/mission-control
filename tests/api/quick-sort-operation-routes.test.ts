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
  discardApplyingOperation: vi.fn(),
  finalizeOperation: vi.fn(),
  claimUndo: vi.fn(),
  releaseUndo: vi.fn(),
  finalizeUndo: vi.fn(),
  patchTask: vi.fn(async (
    _request: Request,
    _context: { params: Promise<{ id: string }> },
  ) => Response.json({ success: true })),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    quickSort: {
      getOperation: mocks.getOperation,
      captureTask: mocks.captureTask,
      reserveOperation: mocks.reserveOperation,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperation.mockResolvedValue(operation);
  mocks.captureTask.mockResolvedValue(snapshot);
  mocks.reserveOperation.mockResolvedValue({
    kind: 'reserved',
    operation: { ...operation, state: 'applying' },
  });
  mocks.discardApplyingOperation.mockResolvedValue(true);
  mocks.finalizeOperation.mockResolvedValue(operation);
  mocks.claimUndo.mockResolvedValue(true);
  mocks.releaseUndo.mockResolvedValue(true);
  mocks.finalizeUndo.mockResolvedValue(true);
  mocks.patchTask.mockResolvedValue(Response.json({ success: true }));
});

describe('Quick Sort operation apply route', () => {
  it('reserves before delegating mutation through the task PATCH revision CAS', async () => {
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
    await expect(patchRequest.json()).resolves.toEqual({ priority: 'high' });
    expect(mocks.reserveOperation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.patchTask.mock.invocationCallOrder[0]);
    expect(mocks.patchTask.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.finalizeOperation.mock.invocationCallOrder[0]);
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
});
