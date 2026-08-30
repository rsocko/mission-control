/**
 * Tests for the push-manager terminal status override.
 *
 * When a task is locally "in_progress" but the remote issue is already closed,
 * the push-manager should detect the terminal remote state from the updateTask
 * response and apply it locally. This prevents tasks from being stuck as
 * "in_progress" indefinitely when the upstream issue was closed before or
 * between syncs and the incremental pull's `since` filter skips it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { TaskItem } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPendingTasks: unknown[] = [];
const mockUpdateSets: Array<{ data: unknown; id: string }> = [];
let mockCapabilities: import('@/types').ConnectorCapabilities | null = null;
const {
  mockCompleteTaskPush,
  mockDelete,
  mockFailTaskPush,
  mockLoadClaimedTask,
} = vi.hoisted(() => ({
  mockCompleteTaskPush: vi.fn((
    _taskId: string,
    _leaseToken: string,
    _sourceId: string,
    _metadata?: unknown,
    _localUpdates?: Record<string, unknown>,
  ) => {
    void [_taskId, _leaseToken, _sourceId, _metadata, _localUpdates];
    return Promise.resolve(true);
  }),
  mockDelete: vi.fn(() => ({ where: vi.fn() })),
  mockFailTaskPush: vi.fn((
    _taskId: string,
    _leaseToken: string,
    _syncStatus: string,
    _pushRetryCount?: number,
  ) => {
    void [_taskId, _leaseToken, _syncStatus, _pushRetryCount];
    return Promise.resolve(true);
  }),
  mockLoadClaimedTask: vi.fn(),
}));

vi.mock('@/db', () => {
  const updateWhereFn = vi.fn(() => {
    // Capture the task id from the condition for assertion
  });
  const updateSetFn = vi.fn((data: unknown) => {
    mockUpdateSets.push({ data, id: '' });
    return { where: updateWhereFn };
  });
  return {
    default: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => [...mockPendingTasks]),
        })),
      })),
      update: vi.fn(() => ({ set: updateSetFn })),
      delete: mockDelete,
    },
  };
});

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', sourceId: 'sourceId', connectorInstanceId: 'connectorInstanceId', syncStatus: 'syncStatus', isChecklistItem: 'isChecklistItem' },
  taskTags: { taskId: 'taskId' },
  taskProjects: { taskId: 'taskId' },
  myDayItems: { taskId: 'taskId' },
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    connectors: {
      get: vi.fn(async () => mockCapabilities
        ? { capabilities: mockCapabilities }
        : null),
    },
    execution: {
      support: { assertConnectorSupported: vi.fn() },
      pushes: {
        listCandidates: vi.fn(async () => [...mockPendingTasks]),
        listSourceIds: vi.fn(async (ids: string[]) => mockPendingTasks
          .filter((task) => ids.includes((task as { id: string }).id))
          .map((task) => ({
            id: (task as { id: string }).id,
            sourceId: (task as { sourceId: string }).sourceId,
          })).concat(
            mockPendingTasks.some((task) => ids.includes((task as { id: string }).id))
              ? []
              : mockPendingTasks.slice(0, 1).map((task) => ({
                  id: ids[0],
                  sourceId: (task as { sourceId: string }).sourceId,
                })),
          )),
        markSynced: vi.fn(async (id: string, _now: string, data: unknown = {}) => {
          mockUpdateSets.push({ data: { ...(data as object), syncStatus: 'synced' }, id });
          return true;
        }),
        markFailure: vi.fn(async (id: string, syncStatus: string, pushRetryCount: number) => {
          mockUpdateSets.push({ data: { syncStatus, pushRetryCount }, id });
          return true;
        }),
      },
    },
  })),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: string, val: string) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  like: vi.fn((col: string, val: string) => ({ col, val })),
  not: vi.fn((condition: unknown) => ({ not: condition })),
  inArray: vi.fn((col: string, vals: unknown[]) => ({ col, vals })),
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => Promise.resolve(mockCapabilities)),
}));

vi.mock('@/lib/logger', () => ({
  syncLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('@/lib/sync/push-lease', () => ({
  claimTaskForPush: vi.fn(() => Promise.resolve('lease-token')),
  completeTaskPush: mockCompleteTaskPush,
  failTaskPush: mockFailTaskPush,
  heartbeatTaskPush: vi.fn(() => Promise.resolve('renewed-lease-token')),
  loadClaimedTaskForPush: mockLoadClaimedTask,
  releaseTaskPush: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/external-identities', () => {
  class GitHubWriteFenceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class GitHubUnknownWriteOutcomeError extends Error {}
  return {
    authorizeGitHubWrite: vi.fn(() => ({
      leaseId: 'write-lease',
      token: 'write-token',
      targets: [],
    })),
    assertGitHubWriteCycleCurrent: vi.fn(),
    beginGitHubWriteCycle: vi.fn(() => 'write-cycle'),
    blockGitHubWrite: vi.fn(),
    confirmGitHubWriteDispatch: vi.fn(),
    finalizeGitHubWrite: vi.fn(),
    finishGitHubWriteCycle: vi.fn(() => true),
    GitHubUnknownWriteOutcomeError,
    GitHubWriteFenceError,
    hasSucceededGitHubWrite: vi.fn(() => false),
    persistExternalIdentityBatch: vi.fn(),
    quarantineUnknownGitHubWrite: vi.fn(),
    verifyGitHubWritePreflight: vi.fn(),
  };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import { pushPendingChanges } from '@/lib/sync/push-manager';

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('push-manager terminal status override', () => {
  beforeEach(() => {
    mockPendingTasks.length = 0;
    mockUpdateSets.length = 0;
    mockCapabilities = null;
    vi.clearAllMocks();
    mockCompleteTaskPush.mockImplementation((
      taskId: string,
      _leaseToken: string,
      _sourceId: string,
      _metadata?: unknown,
      localUpdates?: Record<string, unknown>,
    ) => {
      mockUpdateSets.push({
        data: { ...(localUpdates ?? {}), syncStatus: 'synced' },
        id: taskId,
      });
      return Promise.resolve(true);
    });
    mockFailTaskPush.mockImplementation((
      taskId: string,
      _leaseToken: string,
      syncStatus: string,
      pushRetryCount?: number,
    ) => {
      mockUpdateSets.push({
        data: { syncStatus, pushRetryCount },
        id: taskId,
      });
      return Promise.resolve(true);
    });
    mockLoadClaimedTask.mockImplementation((taskId: string) =>
      Promise.resolve(mockPendingTasks.find(
        (task) => (task as { id: string }).id === taskId,
      ) ?? null));
  });

  it('retries creation for create-only connectors without update support', async () => {
    mockCapabilities = {
      read: true,
      write: false,
      taskCreate: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: false,
      tags: false,
      tagWriteBack: false,
    };
    mockPendingTasks.push({
      id: 'task-create-only',
      sourceId: 'local:task-create-only',
      title: 'Create remotely',
      description: '',
      status: 'todo',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'custom-rest-create-only',
      metadata: '{}',
      pushRetryCount: 0,
    });
    const createTask = vi.fn().mockResolvedValue({
      sourceId: 'remote-1',
      metadata: {},
    });
    const connector = {
      type: 'custom-rest',
      createTask,
    } as Partial<IConnector>;

    const result = await pushPendingChanges(
      'custom-rest-create-only',
      connector as IConnector,
    );

    expect(result).toMatchObject({ pushed: 1, errors: [] });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Create remotely',
    }));
  });

  it('does not auto-delete a retained task when a user-triggered retry returns 404', async () => {
    mockPendingTasks.push({
      id: 'task-retained',
      sourceId: 'source-404',
      title: 'Retained task',
      description: '',
      status: 'todo',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'connector-1',
      metadata: '{}',
      pushRetryCount: 0,
    });

    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn().mockRejectedValue(new Error('404 not found')),
    };

    const result = await pushPendingChanges(
      'connector-1',
      mockConnector as IConnector,
      [],
      ['task-retained'],
      { deleteGhostsOnNotFound: false },
    );

    expect(result.errors).toHaveLength(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpdateSets.at(-1)?.data).toMatchObject({ syncStatus: 'push_error' });
  });

  it('preserves an explicit description clear in the remote update payload', async () => {
    mockPendingTasks.push({
      id: 'task-clear-description',
      sourceId: 'remote-42',
      title: 'Clear the body',
      description: null,
      status: 'todo',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'connector-1',
      metadata: '{}',
      pushRetryCount: 0,
    });
    const updateTask = vi.fn().mockResolvedValue({
      sourceId: 'remote-42',
      status: 'todo',
    });

    await pushPendingChanges('connector-1', {
      type: 'custom-rest',
      updateTask,
    } as Partial<IConnector> as IConnector);

    expect(updateTask).toHaveBeenCalledWith('remote-42', expect.objectContaining({
      description: '',
    }));
  });

  it.each([
    ['update', 'todo', { updateTask: vi.fn().mockResolvedValue({ status: 'todo' }) }],
    ['complete', 'done', { completeTask: vi.fn().mockResolvedValue(undefined) }],
    ['delete', 'cancelled', { deleteTask: vi.fn().mockResolvedValue(undefined) }],
  ] as const)(
    'uses the exact claimed task version when finalizing a GitHub %s',
    async (_operation, status, mutation) => {
      const updatedAt = `2026-08-10T20:00:0${mockPendingTasks.length}.000Z`;
      mockPendingTasks.push({
        id: `github-${status}`,
        sourceId: `acme/app:${status}`,
        sourceListId: 'repo-list',
        title: `GitHub ${status}`,
        description: '',
        status,
        priority: 'none',
        effort: null,
        dueDate: null,
        syncStatus: 'pending_push',
        isChecklistItem: false,
        parentId: null,
        connectorInstanceId: 'github-1',
        metadata: '{}',
        pushRetryCount: 0,
        updatedAt,
      });
      const connector = {
        type: 'github-issues',
        ...mutation,
        preflightWriteRoute: vi.fn().mockResolvedValue({ targets: {} }),
        runAuthorizedWrite: vi.fn(async (
          _authorization: unknown,
          write: () => Promise<unknown>,
        ) => write()),
      } as unknown as Partial<IConnector> as IConnector;

      await pushPendingChanges('github-1', connector, [], undefined, {
        identityMode: { modeRevision: 1 },
        connectorOperationLeaseHeld: true,
      });

      expect(mockCompleteTaskPush).toHaveBeenCalledWith(
        `github-${status}`,
        'lease-token',
        `acme/app:${status}`,
        undefined,
        undefined,
        updatedAt,
      );
    },
  );

  it('updates remote checklist items whose connector IDs are numeric', async () => {
    mockPendingTasks.push({
      id: 'local-row-id',
      sourceId: '43',
      title: 'Remote numeric subtask',
      description: '',
      status: 'todo',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: true,
      parentId: 'parent-row-id',
      connectorInstanceId: 'connector-1',
      metadata: '{}',
      pushRetryCount: 0,
    });
    const mockConnector: Partial<IConnector> = {
      updateSubTask: vi.fn().mockResolvedValue(undefined),
    };

    const result = await pushPendingChanges('connector-1', mockConnector as IConnector);

    expect(result.pushed).toBe(1);
    expect(mockConnector.updateSubTask).toHaveBeenCalledWith('43', '43', {
      title: 'Remote numeric subtask',
      status: 'todo',
    });
  });

  it('retains an orphaned locally-created subtask without pushing or deleting it', async () => {
    mockPendingTasks.push({
      id: 'local-subtask-id',
      sourceId: 'local-subtask-id',
      title: 'Orphaned local subtask',
      description: '',
      status: 'todo',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: true,
      parentId: null,
      connectorInstanceId: 'connector-1',
      metadata: '{}',
      pushRetryCount: 0,
    });
    const audit: import('@/lib/sync').SyncAuditEntry[] = [];
    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn(),
    };

    const result = await pushPendingChanges('connector-1', mockConnector as IConnector, audit);

    expect(result).toMatchObject({ pushed: 0, errors: [] });
    expect(mockConnector.updateTask).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(audit).toContainEqual(expect.objectContaining({
      action: 'protected',
      taskId: 'local-subtask-id',
    }));
  });

  it('applies terminal remote status when local task is in_progress but remote is done', async () => {
    mockPendingTasks.push({
      id: 'task-1',
      sourceId: 'octo-org/ideation:850',
      title: 'Test task',
      description: 'A task',
      status: 'in_progress',
      priority: 'medium',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'github-1',
      metadata: '{}',
    });

    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn().mockResolvedValue({
        sourceId: 'octo-org/ideation:850',
        status: 'done',
        completedAt: '2026-07-26T03:27:33Z',
      } as Partial<TaskItem>),
    };

    const result = await pushPendingChanges('github-1', mockConnector as IConnector);

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
    // Should have updated with terminal status
    expect(mockUpdateSets.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = mockUpdateSets[mockUpdateSets.length - 1].data as Record<string, unknown>;
    expect(lastUpdate.status).toBe('done');
    expect(lastUpdate.syncStatus).toBe('synced');
    expect(lastUpdate.completedAt).toBe('2026-07-26T03:27:33Z');
  });

  it('does not override local status when remote is also non-terminal', async () => {
    mockPendingTasks.push({
      id: 'task-2',
      sourceId: 'octo-org/ideation:900',
      title: 'Open task',
      description: '',
      status: 'in_progress',
      priority: 'low',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'github-1',
      metadata: '{}',
    });

    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn().mockResolvedValue({
        sourceId: 'octo-org/ideation:900',
        status: 'todo',
      } as Partial<TaskItem>),
    };

    const result = await pushPendingChanges('github-1', mockConnector as IConnector);

    expect(result.pushed).toBe(1);
    const lastUpdate = mockUpdateSets[mockUpdateSets.length - 1].data as Record<string, unknown>;
    // Should NOT have overridden status — just marked synced
    expect(lastUpdate.status).toBeUndefined();
    expect(lastUpdate.syncStatus).toBe('synced');
  });

  it('does not override when local is already terminal', async () => {
    mockPendingTasks.push({
      id: 'task-3',
      sourceId: 'octo-org/ideation:901',
      title: 'Done task being re-pushed',
      description: '',
      status: 'done',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'github-1',
      metadata: '{}',
    });

    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn().mockResolvedValue({
        sourceId: 'octo-org/ideation:901',
        status: 'done',
        completedAt: '2026-07-20T00:00:00Z',
      } as Partial<TaskItem>),
      completeTask: vi.fn().mockResolvedValue(undefined),
    };

    const result = await pushPendingChanges('github-1', mockConnector as IConnector);

    expect(result.pushed).toBe(1);
    const lastUpdate = mockUpdateSets[mockUpdateSets.length - 1].data as Record<string, unknown>;
    // Should NOT have written status — already terminal locally
    expect(lastUpdate.status).toBeUndefined();
    expect(lastUpdate.syncStatus).toBe('synced');
  });

  it('handles null/undefined response from updateTask gracefully', async () => {
    mockPendingTasks.push({
      id: 'task-4',
      sourceId: 'octo-org/ideation:902',
      title: 'Task with null response',
      description: '',
      status: 'in_progress',
      priority: 'none',
      effort: null,
      dueDate: null,
      syncStatus: 'pending_push',
      isChecklistItem: false,
      parentId: null,
      connectorInstanceId: 'github-1',
      metadata: '{}',
    });

    const mockConnector: Partial<IConnector> = {
      updateTask: vi.fn().mockResolvedValue(null),
    };

    const result = await pushPendingChanges('github-1', mockConnector as IConnector);

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);
    const lastUpdate = mockUpdateSets[mockUpdateSets.length - 1].data as Record<string, unknown>;
    expect(lastUpdate.status).toBeUndefined();
    expect(lastUpdate.syncStatus).toBe('synced');
  });
});
