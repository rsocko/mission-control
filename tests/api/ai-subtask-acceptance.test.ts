import { describe, expect, it, vi, beforeEach } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
};
const mockGetCapabilities = vi.fn();
const mockIsConnectorEnabled = vi.fn();
const mockInsertValues = vi.fn();
const mockGetConnector = vi.fn((): {
  type?: string;
  createSubTask?: (...args: unknown[]) => unknown;
  reorderSubTasks?: (...args: unknown[]) => unknown;
} => ({ createSubTask: vi.fn() }));
const mockInitializeConnector = vi.fn();
const mockLogWriteThrough = vi.fn();
const mockGetTask = vi.fn();
const mockGetSubtaskProposalSnapshot = vi.fn();
const mockListSubtasks = vi.fn();
const mockGetSubtaskOrderState = vi.fn();
const mockReorderSubtasks = vi.fn();
const mockCreateSubtask = vi.fn();
const mockAcceptSubtaskProposal = vi.fn();
const mockCompleteSubtaskWriteThrough = vi.fn();

vi.mock('crypto', () => {
  const createHash = () => {
    let input = '';
    return {
      update(value: string) {
        input = value;
        return this;
      },
      digest() {
        if (input.includes('2026-07-30T13:00:00.000Z')) return 'b'.repeat(64);
        if (input.includes('Proposed step')) return 'c'.repeat(64);
        return 'a'.repeat(64);
      },
    };
  };
  const randomUUID = () => 'f1176433-0535-4914-aac5-1f79dca24971';
  return {
    createHash,
    randomUUID,
    default: { createHash, randomUUID },
  };
});
vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: (callback: (tx: typeof mockDb) => unknown) => callback(mockDb),
}));
vi.mock('@/db/schema', () => ({
  hubProjects: { id: 'project_id', name: 'project_name' },
  tags: { id: 'tag_id', name: 'tag_name' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  tasks: {
    id: 'id',
    title: 'title',
    status: 'status',
    effort: 'effort',
    parentId: 'parent_id',
  },
}));
vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: mockGetCapabilities,
  isConnectorEnabled: mockIsConnectorEnabled,
}));
vi.mock('@/lib/connectors/registry-runtime', () => ({
  getConnectorRegistry: () => ({
    getConnector: mockGetConnector,
    replaceConnector: mockInitializeConnector,
  }),
}));
vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));
vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectors: { get: vi.fn().mockResolvedValue(null) },
    execution: { support: { assertConfigSupported: vi.fn() } },
  }),
}));
vi.mock('@/lib/sync/write-through-log', () => ({
  logWriteThrough: mockLogWriteThrough,
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const taskVersion = '2026-07-30T12:00:00.000Z';
const contextVersion = 'a'.repeat(64);
const proposalId = '3d188f4c-7eca-4d17-8cbe-601cc9d6a898';

function request(body: Record<string, unknown>, method = 'POST') {
  return new Request('https://mc.example/api/tasks/parent/subtasks', {
    method,
    headers: {
      'Content-Type': 'application/json',
      authorization: 'Bearer acceptance-test-token',
    },
    body: JSON.stringify(body),
  });
}

function parentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'parent',
    title: 'Parent',
    sourceId: 'local:parent',
    connectorType: 'local',
    connectorInstanceId: 'local',
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'none',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: taskVersion,
    updatedAt: taskVersion,
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: null,
    depth: 0,
    isChecklistItem: false,
    sourceListId: null,
    sourceListName: null,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: 'synced',
    lastSyncedAt: taskVersion,
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: null,
    isBulkImport: false,
    ...overrides,
  };
}

function mockParentTask(overrides: Record<string, unknown> = {}) {
  const parent = parentTask(overrides);
  mockGetTask.mockImplementation(async (taskId: string) => taskId === 'parent' ? parent : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReset();
  delete process.env.MC_PUBLIC_DEMO;
  process.env.MC_API_KEY = 'acceptance-test-token';
  mockIsConnectorEnabled.mockResolvedValue(true);
  mockGetCapabilities.mockResolvedValue({ write: true });
  mockInsertValues.mockReturnValue({ run: vi.fn() });
  mockDb.insert.mockReturnValue({ values: mockInsertValues });
  mockParentTask();
  mockGetSubtaskProposalSnapshot.mockResolvedValue({
    parentUpdatedAt: taskVersion,
    tagNames: [],
    projectNames: [],
    subtaskTitles: [],
  });
  mockListSubtasks.mockResolvedValue([]);
  mockGetSubtaskOrderState.mockResolvedValue({ revision: 0, subtasks: [] });
  mockReorderSubtasks.mockResolvedValue({ kind: 'reordered', revision: 1 });
  mockGetConnector.mockReturnValue({ createSubTask: vi.fn() });
  mockCreateSubtask.mockResolvedValue({ kind: 'created' });
  mockAcceptSubtaskProposal.mockResolvedValue({
    kind: 'created',
    snapshot: {
      parentUpdatedAt: taskVersion,
      tagNames: [],
      projectNames: [],
      subtaskTitles: ['Proposed step'],
    },
  });
  registerFakeTaskCorePersistence({
    ancillary: {
      getTask: mockGetTask,
      getSubtaskProposalSnapshot: mockGetSubtaskProposalSnapshot,
      listSubtasks: mockListSubtasks,
      getSubtaskOrderState: mockGetSubtaskOrderState,
      reorderSubtasks: mockReorderSubtasks,
      createSubtask: mockCreateSubtask,
      acceptSubtaskProposal: mockAcceptSubtaskProposal,
      completeSubtaskWriteThrough: mockCompleteSubtaskWriteThrough,
    },
  });
});

describe('subtask reorder route', () => {
    it('persists a complete local order with revision fencing', async () => {
      const subtasks = [
        {
          id: 'child-a',
          title: 'A',
          status: 'todo',
          sourceId: 'local:child-a',
          connectorType: 'local',
          priority: 'none',
          effort: null,
          parentId: 'parent',
          siblingOrder: 0,
        },
        {
          id: 'child-b',
          title: 'B',
          status: 'todo',
          sourceId: 'local:child-b',
          connectorType: 'local',
          priority: 'none',
          effort: null,
          parentId: 'parent',
          siblingOrder: 1,
        },
      ];
      mockGetSubtaskOrderState.mockResolvedValue({ revision: 3, subtasks });
      mockReorderSubtasks.mockResolvedValue({ kind: 'reordered', revision: 4 });

      const { PATCH } = await import('@/app/api/tasks/[id]/subtasks/route');
      const response = await PATCH(request({
        orderedChildIds: ['child-b', 'child-a'],
        expectedRevision: 3,
      }, 'PATCH'), { params: Promise.resolve({ id: 'parent' }) });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        revision: 4,
        writeBack: 'local-only',
      });
      expect(mockReorderSubtasks).toHaveBeenCalledWith({
        parentTaskId: 'parent',
        orderedChildIds: ['child-b', 'child-a'],
        expectedRevision: 3,
      });
    });

    it('returns the current order after a stale request', async () => {
      mockGetSubtaskOrderState.mockResolvedValue({ revision: 5, subtasks: [] });
      mockReorderSubtasks.mockResolvedValue({
        kind: 'revision-conflict',
        currentRevision: 5,
      });

      const { PATCH } = await import('@/app/api/tasks/[id]/subtasks/route');
      const response = await PATCH(request({
        orderedChildIds: [],
        expectedRevision: 4,
      }, 'PATCH'), { params: Promise.resolve({ id: 'parent' }) });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        revision: 5,
        subtasks: [],
      });
    });

    it('returns the current sibling set when membership changed', async () => {
      const currentSubtasks = [{
        id: 'new-child',
        title: 'New',
        status: 'todo',
        sourceId: 'local:new-child',
        connectorType: 'local',
        priority: 'none',
        effort: null,
        parentId: 'parent',
        siblingOrder: 0,
      }];
      mockGetSubtaskOrderState
        .mockResolvedValueOnce({ revision: 3, subtasks: [] })
        .mockResolvedValueOnce({ revision: 3, subtasks: currentSubtasks });
      mockReorderSubtasks.mockResolvedValue({ kind: 'invalid-children' });

      const { PATCH } = await import('@/app/api/tasks/[id]/subtasks/route');
      const response = await PATCH(request({
        orderedChildIds: [],
        expectedRevision: 3,
      }, 'PATCH'), { params: Promise.resolve({ id: 'parent' }) });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        revision: 3,
        subtasks: currentSubtasks,
      });
    });

    it('restores local order when source write-through fails', async () => {
      const subtasks = [
        {
          id: 'child-a',
          title: 'A',
          status: 'todo',
          sourceId: 'remote:a',
          connectorType: 'test-remote',
          priority: 'none',
          effort: null,
          parentId: 'parent',
          siblingOrder: 0,
        },
        {
          id: 'child-b',
          title: 'B',
          status: 'todo',
          sourceId: 'remote:b',
          connectorType: 'test-remote',
          priority: 'none',
          effort: null,
          parentId: 'parent',
          siblingOrder: 1,
        },
      ];
      mockParentTask({
        sourceId: 'remote:parent',
        connectorType: 'test-remote',
        connectorInstanceId: 'test-remote',
      });
      mockGetCapabilities.mockResolvedValue({
        write: true,
        subtaskOrderWrite: true,
      });
      mockGetSubtaskOrderState.mockResolvedValue({ revision: 3, subtasks });
      mockReorderSubtasks
        .mockResolvedValueOnce({ kind: 'reordered', revision: 4 })
        .mockResolvedValueOnce({ kind: 'reordered', revision: 5 });
      mockGetConnector.mockReturnValue({
        type: 'test-remote',
        reorderSubTasks: vi.fn().mockRejectedValue(new Error('source unavailable')),
      });

      const { PATCH } = await import('@/app/api/tasks/[id]/subtasks/route');
      const response = await PATCH(request({
        orderedChildIds: ['child-b', 'child-a'],
        expectedRevision: 3,
      }, 'PATCH'), { params: Promise.resolve({ id: 'parent' }) });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        revision: 5,
        subtasks,
      });
      expect(mockReorderSubtasks).toHaveBeenNthCalledWith(2, {
        parentTaskId: 'parent',
        orderedChildIds: ['child-a', 'child-b'],
        expectedRevision: 4,
      });
    });
  });

describe('AI proposal acceptance through the subtask route', () => {
  it('rejects a proposal when the parent task changed', async () => {
    mockParentTask({
      updatedAt: '2026-07-30T13:00:00.000Z',
    });
    mockGetSubtaskProposalSnapshot.mockResolvedValue({
      parentUpdatedAt: '2026-07-30T13:00:00.000Z',
      tagNames: [],
      projectNames: [],
      subtaskTitles: [],
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('changed') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns a previously accepted proposal without inserting again', async () => {
    const accepted = parentTask({
      id: proposalId,
      title: 'Proposed step',
      effort: 2,
      parentId: 'parent',
      depth: 1,
      isChecklistItem: true,
    });
    mockGetTask.mockImplementation(async (taskId: string) => {
      if (taskId === 'parent') return parentTask();
      if (taskId === proposalId) return accepted;
      return null;
    });
    mockGetSubtaskProposalSnapshot.mockResolvedValue({
      parentUpdatedAt: taskVersion,
      tagNames: [],
      projectNames: [],
      subtaskTitles: ['Proposed step'],
    });
    mockListSubtasks.mockResolvedValue([{
      id: proposalId,
      title: 'Proposed step',
      status: 'todo',
      sourceId: proposalId,
      connectorType: 'local',
      priority: 'none',
      effort: 2,
      parentId: 'parent',
    }]);

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      effort: 2,
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ duplicate: true }));
    expect(mockAcceptSubtaskProposal).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('blocks acceptance for a read-only connector', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: false,
      taskFieldProfile: {
        dependencies: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockParentTask({
      sourceId: 'remote:parent',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('disabled') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('blocks acceptance when connector subtask support is disabled', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: true,
      subtasks: false,
      taskFieldProfile: {
        dependencies: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockParentTask({
      sourceId: 'remote:parent',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('does not support') }));
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('atomically inserts a current proposal with its idempotency ID', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({
      title: 'Proposed step',
      effort: 2,
      proposalId,
      expectedContextVersion: contextVersion,
    }), { params: Promise.resolve({ id: 'parent' }) });

    expect(response.status).toBe(200);
    expect(mockAcceptSubtaskProposal).toHaveBeenCalledWith({
      expected: expect.objectContaining({ parentUpdatedAt: taskVersion }),
      task: expect.objectContaining({
        id: proposalId,
        parentId: 'parent',
        title: 'Proposed step',
        effort: 2,
      }),
    });
  });

  it('creates remote-shaped subtasks locally without connector access in public demo mode', async () => {
    process.env.MC_PUBLIC_DEMO = 'true';
    mockParentTask({
      sourceId: 'remote:parent',
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      sourceListId: 'repo',
      sourceListName: 'Repository',
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({ title: 'Demo-only subtask' }), {
      params: Promise.resolve({ id: 'parent' }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateSubtask).toHaveBeenCalledWith({
      task: expect.objectContaining({
        title: 'Demo-only subtask',
        syncStatus: 'synced',
      }),
    });
    expect(mockIsConnectorEnabled).not.toHaveBeenCalled();
    expect(mockGetCapabilities).not.toHaveBeenCalled();
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockInitializeConnector).not.toHaveBeenCalled();
    expect(mockLogWriteThrough).not.toHaveBeenCalled();
  });

  it('creates Scout subtasks locally without connector mutation or pending push state', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: false,
      subtasks: false,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    });
    mockParentTask({
      title: 'Scout parent',
      sourceId: 'scout:email:item-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
      sourceListId: 'scout:email-actions',
      sourceListName: 'Email Actions',
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({ title: 'Local Scout subtask' }), {
      params: Promise.resolve({ id: 'parent' }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateSubtask).toHaveBeenCalledWith({
      task: expect.objectContaining({
        title: 'Local Scout subtask',
        syncStatus: 'synced',
      }),
    });
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockInitializeConnector).not.toHaveBeenCalled();
    expect(mockLogWriteThrough).not.toHaveBeenCalled();
  });

  it('persists local intent before source creation and guarded completion', async () => {
    const order: string[] = [];
    const createRemoteSubtask = vi.fn(async () => {
      order.push('source');
      return { sourceId: 'todo-list:remote-child', metadata: { etag: 'v1' } };
    });
    mockGetCapabilities.mockResolvedValue({
      write: true,
      subtasks: true,
      taskFieldProfile: {
        dependencies: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockParentTask({
      sourceId: 'todo-list:parent',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceListId: 'todo-list',
      sourceListName: 'Tasks',
    });
    mockGetConnector.mockReturnValue({
      type: 'microsoft-todo',
      createSubTask: createRemoteSubtask,
    });
    mockCreateSubtask.mockImplementationOnce(async () => {
      order.push('local');
      return { kind: 'created' };
    });
    mockCompleteSubtaskWriteThrough.mockImplementationOnce(async () => {
      order.push('complete');
      return true;
    });

    const { POST } = await import('@/app/api/tasks/[id]/subtasks/route');
    const response = await POST(request({ title: 'Write-through child' }), {
      params: Promise.resolve({ id: 'parent' }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockCompleteSubtaskWriteThrough).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedSyncStatus: 'pending_push',
          sourceId: 'todo-list:remote-child',
        }),
      );
    });
    expect(order).toEqual(['local', 'source', 'complete']);
  });
});
