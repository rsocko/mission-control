import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectResults: unknown[][] = [];
const updates: unknown[] = [];
let currentDetails: unknown[] = [];
const mockGetTask = vi.fn();
const mockConvertToLocal = vi.fn();
const mockDeleteLocal = vi.fn();
const mockPushPending = vi.fn();
const mockGetCapabilities = vi.fn();
const mockInitializeConnector = vi.fn();
const mockRunExclusive = vi.fn(async (_connectorId: string, operation: () => Promise<unknown>) => operation());
const connector: {
  updateTask: ReturnType<typeof vi.fn>;
  deleteTask?: ReturnType<typeof vi.fn>;
  createTask?: ReturnType<typeof vi.fn>;
  createSubTask?: ReturnType<typeof vi.fn>;
} = { updateTask: vi.fn() };

function takeNextDataRow(): Record<string, unknown> | undefined {
  while (selectResults.length > 0) {
    const rows = selectResults.shift() as Array<Record<string, unknown>>;
    const row = rows.find((candidate) => !('details' in candidate));
    if (row) return row;
  }
  return undefined;
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => selectResults.shift() || []),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((data: unknown) => {
        updates.push(data);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              currentDetails = (data as { details: unknown[] }).details;
              return [{ id: 'log-1' }];
            }),
          })),
        };
      }),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  syncLog: { id: 'syncLog.id', connectorId: 'syncLog.connectorId', details: 'syncLog.details' },
  tasks: { id: 'tasks.id', syncStatus: 'tasks.syncStatus' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: string, value: string) => ({ column, value })),
  and: vi.fn((...conditions: unknown[]) => conditions),
}));

vi.mock('@/lib/tasks/local-task-lifecycle', () => ({
  getTaskByRetentionIdentity: (...args: unknown[]) => mockGetTask(...args),
  convertTaskTreeToLocal: (...args: unknown[]) => mockConvertToLocal(...args),
  deleteTaskTreeLocally: (...args: unknown[]) => mockDeleteLocal(...args),
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: (...args: unknown[]) => mockGetCapabilities(...args),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: vi.fn(() => connector) },
}));

vi.mock('@/lib/sync/index', () => ({
  syncScheduler: {
    initializeConnectorFromDb: (...args: unknown[]) => mockInitializeConnector(...args),
    runExclusiveConnectorOperation: (...args: [string, () => Promise<unknown>]) => mockRunExclusive(...args),
  },
}));

vi.mock('@/lib/sync/push-manager', () => ({
  pushPendingChanges: (...args: unknown[]) => mockPushPending(...args),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    connectors: {
      get: vi.fn(async () => {
        const capabilities = await mockGetCapabilities();
        return capabilities ? { capabilities } : null;
      }),
    },
    execution: {
      support: {
        assertConnectorSupported: vi.fn(),
      },
      retention: {
        getDetail: vi.fn(async () => {
          const rows = selectResults.shift() as Array<{
            connectorId: string;
            syncedAt?: string;
            details: unknown[];
          }> | undefined;
          const row = rows?.[0];
          if (!row) return null;
          currentDetails = row.details;
          const detail = currentDetails[0];
          return detail
            ? {
                connectorId: row.connectorId,
                syncedAt: row.syncedAt,
                detail,
              }
            : null;
        }),
        claim: vi.fn(async (input: {
          action: string;
          claimId: string;
          now: string;
          leaseExpiresAt: string;
        }) => {
          const detail = currentDetails[0] as Record<string, unknown> & {
            resolution?: {
              action: string;
              status: string;
              resolvedAt: string;
              leaseExpiresAt?: string;
            };
          };
          const resolution = detail?.resolution;
          if (
            resolution?.status === 'succeeded'
            || (resolution?.status === 'indeterminate' && input.action === 'retry_push')
            || (
              resolution?.status === 'in_progress'
              && Date.parse(resolution.leaseExpiresAt ?? resolution.resolvedAt) > Date.now()
            )
          ) {
            return {
              status: 'unchanged',
              record: { connectorId: 'connector-1', syncedAt: undefined, detail },
            };
          }
          const recoveringStaleClaim = resolution?.status === 'in_progress';
          const claimed = {
            ...detail,
            resolution: {
              action: input.action,
              status: 'in_progress',
              resolvedAt: input.now,
              message: 'Resolution is in progress.',
              claimId: input.claimId,
              leaseExpiresAt: input.leaseExpiresAt,
            },
          };
          currentDetails[0] = claimed;
          updates.push({ details: [...currentDetails] });
          return {
            status: 'claimed',
            record: { connectorId: 'connector-1', syncedAt: undefined, detail: claimed },
            recoveringStaleClaim,
          };
        }),
        renew: vi.fn(async () => true),
        finalize: vi.fn(async (input: { resolution: unknown }) => {
          const detail = currentDetails[0] as Record<string, unknown>;
          currentDetails[0] = { ...detail, resolution: input.resolution };
          updates.push({ details: [...currentDetails] });
          return true;
        }),
        findTask: (...args: unknown[]) => mockGetTask(...args),
        getTask: vi.fn(async () => takeNextDataRow() ?? mockGetTask()),
        convertTaskTreeToLocal: vi.fn(async (taskId: string, archive: boolean) => {
          mockConvertToLocal(taskId, archive ? 'archive_local' : 'keep_local');
        }),
        deleteTaskTree: vi.fn(async (taskId: string) => {
          mockDeleteLocal(taskId);
        }),
      },
      pushes: {
        listSourceIds: vi.fn(async () => {
          const row = takeNextDataRow();
          return row ? [row] : [];
        }),
      },
      deletions: {
        markPendingPush: vi.fn(async () => {
          updates.push({ syncStatus: 'pending_push', pushRetryCount: 0 });
          return true;
        }),
      },
    },
  })),
}));

import { resolveRetainedItems } from '@/lib/sync/retention-resolution';

const retainedDetail = {
  action: 'protected' as const,
  taskId: 'task-1',
  taskTitle: 'Retained task',
  taskSourceId: 'source-1',
  reason: 'Completed/cancelled task retained locally (status: done)',
};

describe('retained sync resolution', () => {
  beforeEach(() => {
    selectResults.length = 0;
    updates.length = 0;
    currentDetails = [];
    vi.clearAllMocks();
    delete connector.deleteTask;
    delete connector.createTask;
    delete connector.createSubTask;
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'source-1',
      connectorInstanceId: 'connector-1',
      status: 'done',
    });
    mockGetCapabilities.mockResolvedValue({ write: true, delete: true });
    mockPushPending.mockResolvedValue({ pushed: 1, errors: [] });
  });

  it('archives a retained task and records the successful resolution', async () => {
    selectResults.push([{ connectorId: 'connector-1', details: [retainedDetail] }]);
    currentDetails = [retainedDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'archive_local',
      confirmed: true,
    }]);

    expect(result.success).toBe(true);
    expect(mockConvertToLocal).toHaveBeenCalledWith('task-1', 'archive_local');
    expect(updates.at(-1)).toMatchObject({
      details: [expect.objectContaining({
        resolution: expect.objectContaining({
          action: 'archive_local',
          status: 'succeeded',
        }),
      })],
    });
  });

  it('returns an idempotent success when the same resolution already succeeded', async () => {
    selectResults.push([{
      connectorId: 'connector-1',
      details: [{
        ...retainedDetail,
        resolution: {
          action: 'archive_local',
          status: 'succeeded',
          resolvedAt: '2026-08-03T00:00:00.000Z',
          message: 'Already archived',
        },
      }],
    }]);

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'archive_local',
      confirmed: true,
    }]);

    expect(result).toMatchObject({
      success: true,
      idempotent: true,
      message: 'Already archived',
      syncStatus: 'synced',
    });
    expect(mockConvertToLocal).not.toHaveBeenCalled();
  });

  it('keeps a retained task local after explicit confirmation', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'keep_local',
      confirmed: true,
    }]);

    expect(result).toMatchObject({ success: true, syncStatus: 'synced' });
    expect(mockConvertToLocal).toHaveBeenCalledWith('task-1', 'keep_local');
  });

  it('discards local changes only after explicit confirmation', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'discard_local_changes',
      confirmed: true,
    }]);

    expect(result).toMatchObject({ success: true, syncStatus: 'deleted' });
    expect(mockDeleteLocal).toHaveBeenCalledWith('task-1');
  });

  it('rejects local discard without explicit confirmation', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'discard_local_changes',
      confirmed: false,
    }]);

    expect(result).toMatchObject({
      success: false,
      message: 'Explicit confirmation is required for this resolution',
    });
    expect(mockDeleteLocal).not.toHaveBeenCalled();
  });

  it('blocks retry when connector writes are disabled and records the failure', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'source-1',
      connectorInstanceId: 'connector-1',
      status: 'todo',
    });
    mockGetCapabilities.mockResolvedValue({ write: false, delete: false });
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({ success: false, message: 'Write is disabled for this connector' });
    expect(mockPushPending).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      details: [expect.objectContaining({
        resolution: expect.objectContaining({ status: 'failed' }),
      })],
    });
  });

  it('retries only the selected task', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'source-1',
      connectorInstanceId: 'connector-1',
      status: 'todo',
    });
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ id: 'task-1', syncStatus: 'synced' }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({ success: true, syncStatus: 'synced' });
    expect(mockPushPending).toHaveBeenCalledWith(
      'connector-1',
      connector,
      expect.any(Array),
      ['task-1'],
      { deleteGhostsOnNotFound: false },
    );
    expect(updates.find((update) =>
      (update as { syncStatus?: string }).syncStatus === 'pending_push'
    )).toEqual({
      syncStatus: 'pending_push',
      pushRetryCount: 0,
    });
    expect(mockRunExclusive).toHaveBeenCalledWith('connector-1', expect.any(Function));
  });

  it('uses write capability when a cancelled task is updated instead of deleted', async () => {
    const pendingDetail = {
      ...retainedDetail,
      reason: 'Has pending local changes (push_error)',
    };
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'source-1',
      connectorInstanceId: 'connector-1',
      status: 'cancelled',
    });
    mockGetCapabilities.mockResolvedValue({ write: true, delete: false });
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ id: 'task-1', syncStatus: 'synced' }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({ success: true });
    expect(mockPushPending).toHaveBeenCalled();
  });

  it('blocks a local task retry when task creation is disabled', async () => {
    const pendingDetail = {
      ...retainedDetail,
      taskSourceId: 'local:task-1',
      reason: 'Local-only task not yet pushed to remote',
    };
    connector.createTask = vi.fn();
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'local:task-1',
      connectorInstanceId: 'connector-1',
      status: 'todo',
      isChecklistItem: false,
    });
    mockGetCapabilities.mockResolvedValue({ write: true, taskCreate: false, delete: true });
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({
      success: false,
      message: 'Task creation is disabled for this connector',
    });
    expect(mockPushPending).not.toHaveBeenCalled();
  });

  it('uses task creation capability when a cancelled local task must be created', async () => {
    const pendingDetail = {
      ...retainedDetail,
      taskSourceId: 'local:task-1',
      reason: 'Local-only task not yet pushed to remote',
    };
    connector.deleteTask = vi.fn();
    connector.createTask = vi.fn();
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'local:task-1',
      connectorInstanceId: 'connector-1',
      status: 'cancelled',
      isChecklistItem: false,
    });
    mockGetCapabilities.mockResolvedValue({ write: false, taskCreate: true, delete: false });
    selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
    currentDetails = [pendingDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ id: 'task-1', syncStatus: 'synced' }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({ success: true });
    expect(mockPushPending).toHaveBeenCalled();
  });

  it('reclaims an expired resolution lease', async () => {
    const staleDetail = {
      ...retainedDetail,
      resolution: {
        action: 'archive_local' as const,
        status: 'in_progress' as const,
        resolvedAt: '2026-08-03T00:00:00.000Z',
        leaseExpiresAt: '2026-08-03T00:05:00.000Z',
        claimId: 'stale-claim',
        message: 'Resolution is in progress.',
      },
    };
    selectResults.push([{ connectorId: 'connector-1', details: [staleDetail] }]);
    currentDetails = [staleDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'archive_local',
      confirmed: true,
    }]);

    expect(result).toMatchObject({ success: true });
    expect(mockConvertToLocal).toHaveBeenCalledWith('task-1', 'archive_local');
  });

  it('blocks a stale history action after the task changes', async () => {
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'source-1',
      connectorInstanceId: 'connector-1',
      status: 'done',
      updatedAt: '2026-08-03T01:00:00.000Z',
    });
    selectResults.push([{
      connectorId: 'connector-1',
      syncedAt: '2026-08-03T00:00:00.000Z',
      details: [retainedDetail],
    }]);
    currentDetails = [retainedDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'delete_local',
      confirmed: true,
    }]);

    expect(result).toMatchObject({
      success: false,
      message: expect.stringContaining('task changed after this sync-history entry'),
    });
    expect(mockDeleteLocal).not.toHaveBeenCalled();
  });

  it('blocks retry after an interrupted create with an unknown upstream outcome', async () => {
    const staleDetail = {
      ...retainedDetail,
      taskSourceId: 'local:task-1',
      reason: 'Local-only task not yet pushed to remote',
      resolution: {
        action: 'retry_push' as const,
        status: 'in_progress' as const,
        resolvedAt: '2026-08-03T00:00:00.000Z',
        leaseExpiresAt: '2026-08-03T00:05:00.000Z',
        claimId: 'stale-claim',
        message: 'Resolution is in progress.',
      },
    };
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      sourceId: 'local:task-1',
      connectorInstanceId: 'connector-1',
      status: 'todo',
      syncStatus: 'pending_push',
      isChecklistItem: false,
    });
    selectResults.push([{ connectorId: 'connector-1', details: [staleDetail] }]);
    currentDetails = [staleDetail];
    selectResults.push(
      [{ details: currentDetails }],
      [{ details: currentDetails }],
    );

    const [result] = await resolveRetainedItems([{
      syncLogId: 'log-1',
      detailIndex: 0,
      resolution: 'retry_push',
      confirmed: false,
    }]);

    expect(result).toMatchObject({
      success: false,
      message: expect.stringContaining('outcome is unknown'),
    });
    expect(mockPushPending).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      details: [expect.objectContaining({
        resolution: expect.objectContaining({ status: 'indeterminate' }),
      })],
    });
  });

  it('marks a failed create attempt indeterminate to prevent duplicate retries', async () => {
      const pendingDetail = {
        ...retainedDetail,
        taskSourceId: 'local:task-1',
        reason: 'Local-only task not yet pushed to remote',
      };
      connector.createTask = vi.fn();
      mockGetTask.mockResolvedValue({
        id: 'task-1',
        sourceId: 'local:task-1',
        connectorInstanceId: 'connector-1',
        status: 'todo',
        syncStatus: 'push_error',
        isChecklistItem: false,
      });
      mockPushPending.mockResolvedValue({
        pushed: 0,
        errors: ['Create timed out after the upstream request'],
      });
      selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
      currentDetails = [pendingDetail];
      selectResults.push(
        [{ details: currentDetails }],
        [{ id: 'task-1', syncStatus: 'push_error' }],
        [{ details: currentDetails }],
      );

      const [result] = await resolveRetainedItems([{
        syncLogId: 'log-1',
        detailIndex: 0,
        resolution: 'retry_push',
        confirmed: false,
      }]);

      expect(result).toMatchObject({
        success: false,
        resolutionStatus: 'indeterminate',
        message: expect.stringContaining('blocked to avoid creating a duplicate'),
    });
  });

  it('keeps a subtask retryable when its parent has not been created upstream', async () => {
      const pendingDetail = {
        ...retainedDetail,
        taskSourceId: 'task-1',
        reason: 'Locally-created subtask escalated to pending_push for next cycle',
      };
      connector.createSubTask = vi.fn();
      mockGetTask.mockResolvedValue({
        id: 'task-1',
        sourceId: 'task-1',
        connectorInstanceId: 'connector-1',
        status: 'todo',
        syncStatus: 'pending_push',
        isChecklistItem: true,
        parentId: 'parent-1',
      });
      selectResults.push([{ connectorId: 'connector-1', details: [pendingDetail] }]);
      currentDetails = [pendingDetail];
      selectResults.push(
        [{ details: currentDetails }],
        [{ sourceId: 'local:parent-1' }],
        [{ details: currentDetails }],
      );

      const [result] = await resolveRetainedItems([{
        syncLogId: 'log-1',
        detailIndex: 0,
        resolution: 'retry_push',
        confirmed: false,
      }]);

      expect(result).toMatchObject({
        success: false,
        resolutionStatus: 'failed',
        message: expect.stringContaining('parent task must be created upstream'),
      });
      expect(mockPushPending).not.toHaveBeenCalled();
  });
});
