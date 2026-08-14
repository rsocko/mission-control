/**
 * Capability Enforcement Tests — Issue #148
 *
 * Verifies that API routes respect connector capability flags (write, delete)
 * and block all mutations when a connector is disabled.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { ConnectorCapabilities } from '@/types';

// ─── Controllable mocks ────────────────────────────────────────────────────

let mockCapabilities: ConnectorCapabilities | null = null;
let mockEnabled = true;
let mockFieldStates: Record<string, unknown>[] = [];
let mockUpdates: Record<string, unknown>[] = [];
let mockInsertedValues: unknown[] = [];
let mockSelectCall = 0;
let mockTransactionMetadata: unknown;
const connectorMocks = vi.hoisted(() => ({
  getConnector: vi.fn(),
}));
const localTaskLifecycleMocks = vi.hoisted(() => ({
  deleteTaskLocally: vi.fn(),
}));
let mockTagLinks: Array<{ tagId: string }> = [];
let mockTags: Array<{ id: string; name: string }> = [];
let mockPersistedUpdates: Record<string, unknown>[] = [];
let patchTask: typeof import('@/app/api/tasks/[id]/route')['PATCH'];

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => Promise.resolve(mockCapabilities)),
  isConnectorEnabled: vi.fn(() => Promise.resolve(mockEnabled)),
}));

// Stub task returned by db.select() — overridden per test
let mockTask: Record<string, unknown> | null = null;

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

// db.select() should return mockTask when available
vi.mock('@/db', () => ({
  default: {
    select: vi.fn((selection?: Record<string, unknown>) => {
      if (selection?.tagId) return chainable(mockTagLinks);
      if (selection?.name) return chainable(mockTags);
      mockSelectCall += 1;
      return chainable(mockSelectCall === 1
        ? (mockTask ? [mockTask] : [])
        : []);
    }),
    insert: vi.fn(() => chainable([])),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        mockUpdates.push(values);
        mockPersistedUpdates.push(values);
        return chainable(undefined);
      }),
    })),
    delete: vi.fn(() => chainable(undefined)),
  },
  runTransaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => mockFieldStates),
          get: vi.fn(() => selection?.metadata && mockTask
            ? {
                metadata: mockTransactionMetadata !== undefined
                  ? mockTransactionMetadata
                  : mockTask.metadata,
              }
            : undefined),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        mockInsertedValues.push(values);
        return chainable([]);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        mockUpdates.push(values);
        return chainable(undefined);
      }),
    })),
    delete: vi.fn(() => chainable(undefined)),
  })),
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', status: 'status', priority: 'priority', dueDate: 'dueDate', connectorType: 'connectorType', sourceId: 'sourceId', parentId: 'parentId', assignee: 'assignee', kanbanColumn: 'kanbanColumn', connectorInstanceId: 'connectorInstanceId', metadata: 'metadata' },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId', projectId: 'projectId' },
  taskSchedules: { taskId: 'taskId' },
  taskFieldStates: { taskId: 'taskId', fieldName: 'fieldName' },
  myDayItems: { taskId: 'taskId' },
  tags: { id: 'id', name: 'name' },
  sourceLists: {},
  connectorConfigs: { id: 'id', type: 'type', enabled: 'enabled', settings: 'settings', deletedAt: 'deletedAt', capabilities: 'capabilities' },
  prioritySyncLog: {},
  syncLog: {},
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: connectorMocks.getConnector,
    getAllConnectors: vi.fn(() => []),
  },
}));

vi.mock('@/lib/tasks/local-task-lifecycle', () => localTaskLifecycleMocks);

vi.mock('@/lib/connectors/scout/reconciliation-service', () => ({
  suppressAutoCompletionAfterReopen: vi.fn(),
  supersedePendingReconciliationSuggestions: vi.fn(),
  wasTaskAutoCompletedByReconciliation: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    runSync: vi.fn(() => Promise.resolve({ success: true, connectorId: 'test', errors: [] })),
    runAll: vi.fn(() => Promise.resolve([])),
    getStatus: vi.fn(() => ({})),
    isSyncing: vi.fn(() => false),
    getActiveSyncs: vi.fn(() => []),
    initializeConnectorFromDb: vi.fn(),
  },
}));

vi.mock('@/lib/priority', () => ({
  resolveOutboundPriority: vi.fn(() => ({ shouldWrite: false, event: null })),
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-17'),
  getLocalDaysFromNow: vi.fn(() => '2026-07-24'),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  syncLogger: { info: vi.fn(), error: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

const REMOTE_TASK = {
  id: 'task-1',
  title: 'Remote Task',
  status: 'todo',
  localDisposition: 'active',
  priority: 'medium',
  sourceId: 'ms-todo:abc123',
  connectorType: 'microsoft-todo',
  connectorInstanceId: 'ms-todo-inst-1',
  sourceListId: 'list-1',
  description: null,
  dueDate: null,
  completedAt: null,
  statusReason: null,
  lastSyncedAt: '2026-08-01T00:00:00.000Z',
  isChecklistItem: false,
  parentId: null,
  metadata: '{}',
};

const WRITABLE_CAPS: ConnectorCapabilities = {
  read: true, write: true, delete: true, sync: true,
  subtasks: true, lists: true, tags: true, tagWriteBack: true,
};

const READ_ONLY_CAPS: ConnectorCapabilities = {
  read: true, write: false, delete: false, sync: true,
  subtasks: false, lists: false, tags: true, tagWriteBack: false,
};

const NO_DELETE_CAPS: ConnectorCapabilities = {
  read: true, write: true, delete: false, sync: true,
  subtasks: true, lists: true, tags: true, tagWriteBack: true,
};

function patchRequest(taskId: string, body: Record<string, unknown>) {
  return new Request(`http://localhost:3099/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'X-MC-API-Key': 'test-api-key',
    },
  });
}

function deleteRequest(taskId: string) {
  return new Request(`http://localhost:3099/api/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ({ PATCH: patchTask } = await import('@/app/api/tasks/[id]/route'));
}, 30_000);

beforeEach(() => {
  process.env.MC_API_KEY = 'test-api-key';
  mockTask = { ...REMOTE_TASK };
  mockCapabilities = { ...WRITABLE_CAPS };
  mockEnabled = true;
  mockFieldStates = [];
  mockUpdates = [];
  mockInsertedValues = [];
  mockSelectCall = 0;
  mockTransactionMetadata = undefined;
  connectorMocks.getConnector.mockReset();
  localTaskLifecycleMocks.deleteTaskLocally.mockReset();
  mockTagLinks = [];
  mockTags = [];
  mockPersistedUpdates = [];
});

describe('PATCH /api/tasks/[id] — capability enforcement', () => {
  it('allows writes when connector has write capability', async () => {
    const res = await patchTask(
      patchRequest('task-1', { title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).not.toBe(403);
  });

  it('writes full tag PATCH changes through to the source', async () => {
    mockTagLinks = [{ tagId: 'tag-old' }];
    mockTags = [
      { id: 'tag-old', name: 'Old label' },
      { id: 'tag-new', name: 'New label' },
    ];
    const addTagToTask = vi.fn(() => Promise.resolve());
    const removeTagFromTask = vi.fn(() => Promise.resolve());
    const { connectorRegistry } = await import('@/lib/connectors');
    (connectorRegistry.getConnector as ReturnType<typeof vi.fn>).mockReturnValue({
      addTagToTask,
      removeTagFromTask,
    });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { tags: ['tag-new'] }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({
      fields: { tags: { mode: 'write-through', persisted: true } },
    });
    await vi.waitFor(() => {
      expect(addTagToTask).toHaveBeenCalledWith('ms-todo:abc123', 'New label');
      expect(removeTagFromTask).toHaveBeenCalledWith('ms-todo:abc123', 'Old label');
    });
  });

  it('keeps tag PATCHes pending when source write-back fails', async () => {
    mockTagLinks = [];
    mockTags = [{ id: 'tag-new', name: 'New label' }];
    const addTagToTask = vi.fn(() => Promise.reject(new Error('source unavailable')));
    const { connectorRegistry } = await import('@/lib/connectors');
    (connectorRegistry.getConnector as ReturnType<typeof vi.fn>).mockReturnValue({
      addTagToTask,
      removeTagFromTask: vi.fn(() => Promise.resolve()),
    });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { tags: ['tag-new'] }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockPersistedUpdates).toContainEqual({ syncStatus: 'pending_push' });
    });
    expect(mockPersistedUpdates).not.toContainEqual(expect.objectContaining({ syncStatus: 'synced' }));
  });

  it('rejects writes when connector write capability is false', async () => {
    mockCapabilities = { ...READ_ONLY_CAPS };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'legacy-read-only',
      connectorInstanceId: 'legacy-read-only-1',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.blockedFields.title).toContain('upstream');
  });

  it('allows Scout status changes through its pull-based write-back channel', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    mockTask = {
      ...REMOTE_TASK,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { status: 'done' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(200);
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('allows ordinary Scout edits locally without a connector call', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    mockTask = {
      ...REMOTE_TASK,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { status: 'done', title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(200);
    const { connectorRegistry } = await import('@/lib/connectors');
    expect(connectorRegistry.getConnector).not.toHaveBeenCalled();
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
  });

  it('persists every main Scout field group without direct write-back or retry state', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
      pullWriteBackWhenDisabled: true,
    };
    mockTask = {
      ...REMOTE_TASK,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', {
        title: 'Local title',
        description: 'Local description',
        status: 'in_progress',
        statusReason: 'duplicate',
        priority: 'medium',
        dueDate: '2026-08-20',
        effort: 4,
        estimatedDuration: 45,
        recurrence: 'FREQ=WEEKLY',
        reminderAt: '2026-08-19T13:00:00.000Z',
        snoozedUntil: '2026-08-06T13:00:00.000Z',
        microStatus: 'waiting',
        tags: ['tag-1'],
        kanbanColumn: 'doing',
        kanbanOrder: 2,
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({
      title: 'Local title',
      description: 'Local description',
      status: 'in_progress',
      priority: 'medium',
      dueDate: '2026-08-20',
      effort: 4,
      reminderAt: '2026-08-19T13:00:00.000Z',
      snoozedUntil: '2026-08-06T13:00:00.000Z',
      microStatus: 'waiting',
      kanbanColumn: 'doing',
      kanbanOrder: 2,
    });
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('rejects writes when connector is disabled', async () => {
    mockEnabled = false;
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.blockedFields.title).toContain('disabled');
  });

  it('allows local-only task edits even when connector is disabled', async () => {
    mockEnabled = false;
    mockTask = { ...REMOTE_TASK, sourceId: 'local:abc', connectorType: 'local' };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).not.toBe(403);
  });

  it('allows MC-local fields while a remote connector is disabled', async () => {
    mockEnabled = false;
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { effort: 3 }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
  });

  it('rejects mixed local and blocked fields without running the transaction', async () => {
    mockEnabled = false;
    const { runTransaction } = await import('@/db');
    const transaction = runTransaction as ReturnType<typeof vi.fn>;
    transaction.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', {
        title: 'Blocked',
        estimatedDuration: 30,
        tags: ['tag-1'],
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'persists remote-mirror disposition locally without connector or queue state when enabled=%s',
    async (enabled) => {
      mockEnabled = enabled;
      mockCapabilities = {
        ...READ_ONLY_CAPS,
        taskSourceModel: 'remote-mirror',
        taskFieldProfile: {
          status: { authority: 'source', writeBack: 'none' },
          localDisposition: { authority: 'local', writeBack: 'none' },
        },
      };
      mockTask = {
        ...REMOTE_TASK,
        connectorType: 'custom-rest',
        connectorInstanceId: 'custom-rest-read-only',
      };
      const { connectorRegistry } = await import('@/lib/connectors');
      const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
      getConnector.mockClear();
      const { PATCH } = await import('@/app/api/tasks/[id]/route');

      const res = await PATCH(
        patchRequest('task-1', { localDisposition: 'handled' }),
        { params: Promise.resolve({ id: 'task-1' }) },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        fields: {
          localDisposition: { mode: 'local', persisted: true },
        },
      });
      expect(mockUpdates[0]).toMatchObject({ localDisposition: 'handled' });
      expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
      expect(getConnector).not.toHaveBeenCalled();
    },
  );

  it('rejects mixed mirror disposition and source status atomically', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'remote-mirror',
    };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-read-only',
    };
    const { runTransaction } = await import('@/db');
    const transaction = runTransaction as ReturnType<typeof vi.fn>;
    transaction.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { localDisposition: 'handled', status: 'done' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(403);
    expect((await res.json()).blockedFields.status).toContain('upstream');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects local disposition for writable source models', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { localDisposition: 'handled' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(403);
    expect((await res.json()).blockedFields.localDisposition).toContain('read-only remote mirrors');
    expect(mockUpdates).toEqual([]);
  });

  it('allows a transitioned source model to restore a preserved disposition to active', async () => {
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-writable',
      localDisposition: 'handled',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { localDisposition: 'active' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({ localDisposition: 'active' });
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('rejects metadata before loading or mutating the task', async () => {
    const database = (await import('@/db')).default;
    const select = database.select as ReturnType<typeof vi.fn>;
    select.mockClear();
    const { runTransaction } = await import('@/db');
    const transaction = runTransaction as ReturnType<typeof vi.fn>;
    transaction.mockClear();
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { metadata: { sourceId: 'replacement' } }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(400);
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('marks writable connector changes pending for immediate write-through', async () => {
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockReturnValueOnce({ updateTask: vi.fn(() => Promise.resolve({})) });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { title: 'Updated' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({
      title: 'Updated',
      syncStatus: 'pending_push',
      pushRetryCount: 0,
    });
    expect(getConnector).toHaveBeenCalledWith('ms-todo-inst-1');
  });

  it('falls back to updateTask when a connector has no completion method', async () => {
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-writable',
    };
    mockCapabilities = {
      ...WRITABLE_CAPS,
      taskSourceModel: 'remote-managed',
      statusWriteBack: 'direct',
      taskFieldProfile: {
        status: { authority: 'source', writeBack: 'direct' },
        statusReason: { authority: 'source', writeBack: 'direct' },
      },
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    const updateTask = vi.fn(() => Promise.resolve({}));
    getConnector.mockReset();
    getConnector.mockReturnValue({ updateTask });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { status: 'done' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith('ms-todo:abc123', {
        status: 'done',
        statusReason: 'completed',
      });
    });
  });

  it('preserves source-read-only status reasons during status write-through', async () => {
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'document-intelligence',
      connectorInstanceId: 'document-intelligence-primary',
      statusReason: 'source-review-required',
    };
    mockCapabilities = {
      ...WRITABLE_CAPS,
      taskSourceModel: 'remote-managed',
      statusWriteBack: 'direct',
      taskFieldProfile: {
        status: { authority: 'source', writeBack: 'direct' },
        statusReason: { authority: 'source', writeBack: 'none' },
      },
    };
    const updateTask = vi.fn(() => Promise.resolve({}));
    connectorMocks.getConnector.mockReset();
    connectorMocks.getConnector.mockReturnValue({ updateTask });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');

    const res = await PATCH(
      patchRequest('task-1', { status: 'done' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({
      status: 'done',
      statusReason: 'source-review-required',
    });
    await vi.waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith('ms-todo:abc123', {
        status: 'done',
      });
    });
  });

  it('removes migrated recurrence metadata when the typed recurrence is cleared', async () => {
    mockTask = {
      ...REMOTE_TASK,
      metadata: JSON.stringify({
        recurrence: 'weekly',
        mcOwned: { pinned: true },
      }),
    };
    mockTransactionMetadata = JSON.stringify({
      recurrence: 'weekly',
      mcOwned: { pinned: true },
      scout: { sourceThreadId: 'newer-provenance' },
    });
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockReturnValueOnce({ updateTask: vi.fn(() => Promise.resolve({})) });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { recurrence: null }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({
      metadata: JSON.stringify({
        mcOwned: { pinned: true },
        scout: { sourceThreadId: 'newer-provenance' },
      }),
    });
  });

  it('preserves GitHub issue write-through behavior', async () => {
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'github-issues',
      connectorInstanceId: 'github-inst-1',
      sourceId: 'owner/repo#123',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    const updateTask = vi.fn(() => Promise.resolve({}));
    getConnector.mockReset();
    getConnector.mockReturnValue({ updateTask });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const res = await PATCH(
      patchRequest('task-1', { title: 'Updated issue', status: 'in_progress' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(mockUpdates[0]).toMatchObject({
      title: 'Updated issue',
      status: 'in_progress',
      syncStatus: 'pending_push',
    });
    await vi.waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith('owner/repo#123', expect.objectContaining({
        title: 'Updated issue',
        status: 'in_progress',
      }));
    });
  });

  it('creates and clears Scout overrides against the source snapshot', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    mockTask = {
      ...REMOTE_TASK,
      title: 'Source title',
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
      lastSyncedAt: '2026-08-01T00:00:00.000Z',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const created = await PATCH(
      patchRequest('task-1', { title: 'Local title' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(created.status).toBe(200);
    expect(mockInsertedValues.flat()).toContainEqual(expect.objectContaining({
      fieldName: 'title',
      sourceValue: '"Source title"',
      locallyOverridden: true,
    }));

    mockSelectCall = 0;
    mockInsertedValues = [];
    mockFieldStates = [{
      taskId: 'task-1',
      fieldName: 'title',
      sourceValue: '"Source title"',
      locallyOverridden: true,
      sourceObservedAt: '2026-08-01T00:00:00.000Z',
      localEditedAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
    }];
    const cleared = await PATCH(
      patchRequest('task-1', { title: 'Source title' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(cleared.status).toBe(200);
    expect(mockInsertedValues.flat()).toContainEqual(expect.objectContaining({
      fieldName: 'title',
      locallyOverridden: false,
    }));
  });
});

describe('DELETE /api/tasks/[id] — capability enforcement', () => {
  it('dismisses remote mirrors locally without connector delete or queue state', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'remote-mirror',
    };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-read-only',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockClear();
    const { DELETE } = await import('@/app/api/tasks/[id]/route');

    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      action: 'dismissed',
      writeBack: 'none',
    });
    expect(mockUpdates[0]).toMatchObject({ localDisposition: 'dismissed' });
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('dismisses a remote mirror even when its connector advertises delete', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      delete: true,
      taskSourceModel: 'remote-mirror',
    };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-delete-only',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    const deleteTask = vi.fn(() => Promise.resolve());
    getConnector.mockReset();
    getConnector.mockReturnValue({ deleteTask });
    const { DELETE } = await import('@/app/api/tasks/[id]/route');

    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'dismissed', writeBack: 'none' });
    expect(deleteTask).not.toHaveBeenCalled();
    expect(mockUpdates[0]).toMatchObject({ localDisposition: 'dismissed' });
  });

  it('does not infer delete support from a method when capability is false', async () => {
    mockCapabilities = {
      ...NO_DELETE_CAPS,
      taskSourceModel: 'remote-managed',
    };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-update-only',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    const deleteTask = vi.fn();
    getConnector.mockReturnValue({ deleteTask });
    const { DELETE } = await import('@/app/api/tasks/[id]/route');

    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(403);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('blocks mutations for historical tasks from notification-only connectors', async () => {
    mockCapabilities = {
      ...WRITABLE_CAPS,
      notificationOnly: true,
      taskCreate: false,
      taskSourceModel: 'remote-mirror',
    };
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'monarch-money',
      connectorInstanceId: 'monarch-legacy',
    };
    const { PATCH, DELETE } = await import('@/app/api/tasks/[id]/route');

    const patch = await PATCH(
      patchRequest('task-1', { effort: 3 }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(patch.status).toBe(403);
    expect((await patch.json()).blockedFields.effort).toContain('notification-only');

    mockSelectCall = 0;
    const deletion = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(deletion.status).toBe(403);
  });

  it('blocks orphaned notification-only tasks without connector capabilities', async () => {
    mockCapabilities = null;
    mockEnabled = false;
    mockTask = {
      ...REMOTE_TASK,
      connectorType: 'monarch-money',
      connectorInstanceId: 'deleted-monarch',
    };
    const { PATCH, DELETE } = await import('@/app/api/tasks/[id]/route');

    const patch = await PATCH(
      patchRequest('task-1', { localDisposition: 'dismissed' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(patch.status).toBe(403);
    expect((await patch.json()).blockedFields.localDisposition).toContain('notification-only');

    mockSelectCall = 0;
    const deletion = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(deletion.status).toBe(403);
    expect(mockUpdates).toEqual([]);
  });

  it('cancels Scout tasks locally for the pull status feed', async () => {
    mockCapabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
      pullWriteBackWhenDisabled: true,
    };
    mockEnabled = false;
    mockTask = {
      ...REMOTE_TASK,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { connectorRegistry } = await import('@/lib/connectors');
    const getConnector = connectorRegistry.getConnector as ReturnType<typeof vi.fn>;
    getConnector.mockClear();
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      action: 'cancelled',
      writeBack: 'pull-write-back',
    });
    expect(mockUpdates[0]).toMatchObject({
      status: 'cancelled',
      statusReason: 'not_planned',
    });
    expect(mockUpdates[0]).not.toHaveProperty('syncStatus', 'pending_push');
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('allows deletes when connector has delete capability', async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    connectorMocks.getConnector.mockReturnValue({ deleteTask });
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).not.toBe(403);
    await vi.waitFor(() => {
      expect(deleteTask).toHaveBeenCalledWith('ms-todo:abc123');
      expect(localTaskLifecycleMocks.deleteTaskLocally).toHaveBeenCalledWith('task-1');
    });
  });

  it('uses the comprehensive local lifecycle for MC-owned task deletion', async () => {
    mockTask = {
      ...REMOTE_TASK,
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
    };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');

    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, action: 'deleted' });
    expect(localTaskLifecycleMocks.deleteTaskLocally).toHaveBeenCalledWith('task-1');
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('rejects deletes when connector delete capability is false', async () => {
    mockCapabilities = { ...NO_DELETE_CAPS };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('does not support removing');
  });

  it('allows undo-close when delete is false but connector supports closeTaskWithReason', async () => {
    mockCapabilities = { ...NO_DELETE_CAPS, close: true };
    const { connectorRegistry } = await import('@/lib/connectors');
    (connectorRegistry.getConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      closeTaskWithReason: vi.fn(),
    });
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('closed');
    expect(body.connectorType).toBe('microsoft-todo');
  });

  it('rejects deletes when connector is disabled', async () => {
    mockEnabled = false;
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const res = await DELETE(
      deleteRequest('task-1'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });
});
