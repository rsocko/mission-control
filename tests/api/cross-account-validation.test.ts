import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqliteTouched: vi.fn(),
  getTask: vi.fn(),
  findDefaultTargetList: vi.fn(),
  getConnector: vi.fn(),
  executeWriteThroughTaskMove: vi.fn(),
}));

vi.mock('@/db', () => {
  mocks.sqliteTouched();
  throw new Error('POISONED: cross-account route must not import SQLite');
});
vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    writeThroughMoves: {
      getTask: mocks.getTask,
      findDefaultTargetList: mocks.findDefaultTargetList,
    },
  }),
}));
vi.mock('@/lib/tasks/task-move-write-through', () => ({
  executeWriteThroughTaskMove: mocks.executeWriteThroughTaskMove,
}));
vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: async () => ({
    connectors: { get: mocks.getConnector },
  }),
}));

import { executeCrossAccountTaskMove } from '@/lib/tasks/task-move-service';
import {
  _resetCrossAccountTaskMoveServiceForTests,
  registerCrossAccountTaskMoveService,
} from '@/lib/tasks/cross-account-route-service';
import { POST } from '@/app/api/connectors/[id]/cross-account/route';

const BASE = 'http://localhost:3099/api/connectors/source-1/cross-account';

function request(body: unknown, traceId?: string) {
  return new Request(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(traceId ? { 'x-trace-id': traceId } : {}),
    },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: 'source-1' }) };

describe('POST /api/connectors/[id]/cross-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCrossAccountTaskMoveServiceForTests();
    registerCrossAccountTaskMoveService({
      execute: executeCrossAccountTaskMove,
    });
    mocks.getTask.mockResolvedValue({
      id: 'task-1',
      connectorInstanceId: 'source-1',
    });
    mocks.findDefaultTargetList.mockResolvedValue({
      id: 'target-list-row',
      name: 'Tasks',
      sourceId: 'target-list',
    });
    mocks.getConnector.mockResolvedValue({
      id: 'target-1',
      type: 'microsoft-todo',
    });
    mocks.executeWriteThroughTaskMove.mockResolvedValue({
      status: 201,
      body: {
        newTaskId: 'task-2',
        newSourceId: 'target-list:remote-2',
        sourceAction: 'copy',
        warnings: [],
      },
    });
  });

  it.each([
    { targetInstanceId: 'target-1', action: 'copy' },
    { taskId: 'task-1', action: 'copy' },
    { taskId: 'task-1', targetInstanceId: 'target-1' },
  ])('rejects invalid input without touching persistence', async (body) => {
    const response = await POST(request(body), context);

    expect(response.status).toBe(400);
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it('preserves the invalid-action error contract', async () => {
    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      action: 'delete',
    }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'action must be "copy" or "move"',
    });
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it('rejects a task owned by another source connector', async () => {
    mocks.getTask.mockResolvedValue({
      id: 'task-1',
      connectorInstanceId: 'source-other',
    });

    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      targetListId: 'target-list',
      action: 'move',
    }), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Task not found for this connector',
    });
    expect(mocks.executeWriteThroughTaskMove).not.toHaveBeenCalled();
  });

  it('uses the persisted default list and delegates to the canonical move workflow', async () => {
    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      action: 'copy',
    }, 'trace-cross-account'), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      action: 'copy',
      sourceTaskId: 'task-1',
      targetTaskId: 'task-2',
      targetRemoteId: 'remote-2',
      targetInstance: 'target-1',
      warnings: [],
    });
    expect(mocks.findDefaultTargetList).toHaveBeenCalledWith('target-1');
    expect(mocks.executeWriteThroughTaskMove).toHaveBeenCalledWith({
      taskId: 'task-1',
      targetConnectorInstanceId: 'target-1',
      targetSourceListId: 'target-list',
      sourceAction: 'copy',
      expectedSourceConnectorInstanceId: 'source-1',
      addCrossReference: false,
    }, 'trace-cross-account');
    expect(mocks.sqliteTouched).not.toHaveBeenCalled();
  });

  it('preserves an explicit target list and canonical conflict response', async () => {
    mocks.executeWriteThroughTaskMove.mockResolvedValue({
      status: 409,
      body: {
        error: 'This task is already being moved',
        code: 'TASK_MOVE_IN_PROGRESS',
      },
    });

    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      targetListId: 'explicit-list',
      action: 'move',
    }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'This task is already being moved',
      code: 'TASK_MOVE_IN_PROGRESS',
    });
    expect(mocks.findDefaultTargetList).not.toHaveBeenCalled();
    expect(mocks.executeWriteThroughTaskMove).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSourceListId: 'explicit-list',
        sourceAction: 'move',
      }),
      undefined,
    );
  });

  it('preserves target-connector validation before default-list resolution', async () => {
    mocks.getConnector.mockResolvedValue(null);

    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'missing-target',
      action: 'copy',
    }), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Target connector not found' });
    expect(mocks.findDefaultTargetList).not.toHaveBeenCalled();
    expect(mocks.executeWriteThroughTaskMove).not.toHaveBeenCalled();
  });

  it('preserves the redacted upstream failure response', async () => {
    mocks.executeWriteThroughTaskMove.mockResolvedValue({
      status: 502,
      body: {
        error: 'Failed to create in target. The external service returned an error.',
      },
    });

    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      targetListId: 'target-list',
      action: 'copy',
    }), context);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Failed to create in target. The external service returned an error.',
    });
  });

  it('fails before any remote effect when no destination list is persisted', async () => {
    mocks.findDefaultTargetList.mockResolvedValue(null);

    const response = await POST(request({
      taskId: 'task-1',
      targetInstanceId: 'target-1',
      action: 'copy',
    }), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No target list available' });
    expect(mocks.executeWriteThroughTaskMove).not.toHaveBeenCalled();
  });
});
