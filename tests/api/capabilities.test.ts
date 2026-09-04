import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorCapabilities } from '@/types';
import type {
  TaskFieldStateMutation,
  TaskCoreTaskRow,
  TaskCreateInput,
  TaskMutationRequest,
  TaskRemovalRepository,
  TaskScheduleRow,
} from '@/lib/tasks/core/contracts';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const connectorMocks = vi.hoisted(() => ({
  capabilities: null as ConnectorCapabilities | null,
  enabled: true,
  connector: null as Record<string, unknown> | null,
  getConnector: vi.fn(),
}));
const leaseMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  load: vi.fn(),
  heartbeat: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  fail: vi.fn(),
}));
const searchMocks = vi.hoisted(() => ({
  index: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  semanticUpsert: vi.fn(async () => undefined),
  semanticDelete: vi.fn(async () => undefined),
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => connectorMocks.capabilities),
  isConnectorEnabled: vi.fn(async () => connectorMocks.enabled),
}));
vi.mock('@/lib/connectors/runtime', () => ({
  getOrInitializeConnector: connectorMocks.getConnector,
}));
vi.mock('@/lib/sync/push-lease', () => ({
  claimTaskForPush: leaseMocks.claim,
  loadClaimedTaskForPush: leaseMocks.load,
  heartbeatTaskPush: leaseMocks.heartbeat,
  completeTaskPush: leaseMocks.complete,
  releaseTaskPush: leaseMocks.release,
  failTaskPush: leaseMocks.fail,
}));
vi.mock('@/lib/search/fts', () => ({
  indexTask: searchMocks.index,
  removeTaskFromIndex: searchMocks.remove,
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: searchMocks.semanticDelete,
  publishSemanticEntityUpsert: searchMocks.semanticUpsert,
}));
vi.mock('@/lib/external-identities', () => {
  class GitHubUnknownWriteOutcomeError extends Error {}
  return {
    GitHubUnknownWriteOutcomeError,
    executeFencedGitHubTaskMutation: vi.fn(
      async ({ write }: { write: () => Promise<unknown> }) => write(),
    ),
  };
});
vi.mock('@/lib/rules', () => ({ evaluateRulesForTasks: vi.fn(async () => undefined) }));
vi.mock('@/lib/sync/write-through-log', () => ({ logWriteThrough: vi.fn(async () => undefined) }));
vi.mock('@/lib/connectors/transfer-identity', () => ({
  persistCreatedTaskIdentity: vi.fn(async () => undefined),
}));
vi.mock('@/lib/priority', () => ({
  resolveOutboundPriority: vi.fn(() => ({ shouldWrite: false, event: null })),
}));
vi.mock('@/lib/mode', () => ({
  getTimezone: vi.fn(() => 'America/New_York'),
  isDemoMode: vi.fn(() => false),
}));
vi.mock('@/lib/utils/date', () => ({ getLocalToday: vi.fn(() => '2026-07-17') }));
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const WRITABLE_CAPS: ConnectorCapabilities = {
  read: true, write: true, delete: true, sync: true,
  subtasks: true, lists: true, tags: true, tagWriteBack: true,
};
const READ_ONLY_CAPS: ConnectorCapabilities = {
  read: true, write: false, delete: false, sync: true,
  subtasks: false, lists: false, tags: true, tagWriteBack: false,
};
const NO_DELETE_CAPS: ConnectorCapabilities = {
  ...WRITABLE_CAPS,
  delete: false,
};

const REMOTE_TASK: TaskCoreTaskRow = {
  id: 'task-1',
  sourceId: 'ms-todo:abc123',
  connectorType: 'microsoft-todo',
  connectorInstanceId: 'ms-todo-inst-1',
  title: 'Remote task',
  description: null,
  status: 'todo',
  localDisposition: 'active',
  priority: 'medium',
  planningHorizon: null,
  dueDate: null,
  pushCount: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  completedAt: null,
  recurrenceGeneratedFromTaskId: null,
  parentId: null,
  depth: 0,
  isChecklistItem: false,
  sourceListId: 'list-1',
  sourceListName: 'Tasks',
  assignee: null,
  microStatus: null,
  statusReason: null,
  metadata: {},
  syncStatus: 'synced',
  lastSyncedAt: '2026-08-01T00:00:00.000Z',
  pushRetryCount: 0,
  kanbanColumn: null,
  kanbanOrder: null,
  snoozedUntil: null,
  reminderAt: null,
  reminderRelative: null,
  reminderDueTime: null,
  effort: null,
  isBulkImport: false,
};

function patchRequest(body: Record<string, unknown>) {
  return new Request('http://localhost:3099/api/tasks/task-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function deleteRequest() {
  return new Request('http://localhost:3099/api/tasks/task-1', { method: 'DELETE' });
}

const contextFor = (
  task: TaskCoreTaskRow,
  schedule: TaskScheduleRow | null = null,
  fieldStates: TaskFieldStateMutation[] = [],
  wasAutoCompletedByReconciliation = false,
) => ({
  task,
  schedule,
  tagIds: ['tag-old'],
  tagNamesById: { 'tag-old': 'Old label', 'tag-new': 'New label' },
  fieldStates,
  wasAutoCompletedByReconciliation,
});

describe('task route capability enforcement', () => {
  let task: TaskCoreTaskRow;
  let schedule: TaskScheduleRow | null;
  let fieldStates: TaskFieldStateMutation[];
  let wasAutoCompletedByReconciliation: boolean;
  let mutations: TaskMutationRequest[];
  let removals: Array<{ mode: string; expectedUpdatedAt: string }>;
  let getWriteContext: ReturnType<typeof vi.fn>;
  let mutateTask: ReturnType<typeof vi.fn>;
  let getRemovalContext: ReturnType<typeof vi.fn>;
  let applyTaskRemoval: ReturnType<typeof vi.fn>;
  let finalizeTaskRemoval: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    task = { ...REMOTE_TASK };
    schedule = null;
    fieldStates = [];
    wasAutoCompletedByReconciliation = false;
    mutations = [];
    removals = [];
    connectorMocks.capabilities = { ...WRITABLE_CAPS };
    connectorMocks.enabled = true;
    connectorMocks.connector = { updateTask: vi.fn(async () => ({})) };
    connectorMocks.getConnector.mockReset();
    connectorMocks.getConnector.mockImplementation(async () => connectorMocks.connector);
    for (const mock of Object.values(leaseMocks)) mock.mockReset();
    leaseMocks.claim.mockResolvedValue('lease-1');
    leaseMocks.heartbeat.mockResolvedValue('lease-2');
    leaseMocks.complete.mockResolvedValue(true);
    leaseMocks.release.mockResolvedValue(true);
    leaseMocks.load.mockImplementation(async () => task);
    for (const mock of Object.values(searchMocks)) mock.mockClear();
    getWriteContext = vi.fn(async () => contextFor(
      task,
      schedule,
      fieldStates,
      wasAutoCompletedByReconciliation,
    ));
    mutateTask = vi.fn(async (request: TaskMutationRequest) => {
      mutations.push(request);
      task = { ...task, ...request.patch, updatedAt: request.now };
      return { kind: 'committed' as const, task, recurrenceNextTaskId: null };
    });
    getRemovalContext = vi.fn(async () => ({ task }));
    applyTaskRemoval = vi.fn(async (
      request: Parameters<TaskRemovalRepository['applyTaskRemoval']>[0],
    ) => {
      removals.push(request);
      const pending = request.mode === 'remote-cancel-intent';
      if (pending) task = { ...task, syncStatus: 'pending_push', updatedAt: request.now };
      return {
        kind: 'committed' as const,
        action: pending ? 'pending-remote' as const : request.mode === 'mirror-dismiss'
          ? 'dismissed' as const : request.mode === 'ingested-cancel'
            ? 'cancelled' as const : 'deleted' as const,
        taskVersion: pending ? request.now : null,
      };
    });
    finalizeTaskRemoval = vi.fn(async () => ({
      kind: 'committed' as const,
      action: 'deleted' as const,
      taskVersion: null,
    }));
    registerFakeTaskCorePersistence({
      mutations: {
        getTaskWriteContext: getWriteContext,
        mutateTask,
      },
      removals: {
        getTaskRemovalContext: getRemovalContext,
        applyTaskRemoval,
        finalizeRemoteTaskRemoval: finalizeTaskRemoval,
      },
    });
  });

  it('commits writable fields as pending before starting fenced write-through', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Updated' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({
      title: 'Updated',
      syncStatus: 'pending_push',
      pushRetryCount: 0,
    });

    it.each([
      ['unavailable', null],
      ['deferred', {
        type: 'microsoft-todo',
        writeDelivery: 'deferred',
        createTask: vi.fn(),
      }],
      ['ordinary failure', {
        type: 'microsoft-todo',
        writeDelivery: 'immediate',
        createTask: vi.fn(async () => {
          throw new Error('source unavailable');
        }),
      }],
    ])('leaves remote creation pending after %s connector handling', async (_label, connector) => {
      registerFakeTaskCorePersistence({
        creates: {
          resolveTaskCreateTarget: vi.fn(async () => ({
            kind: 'resolved' as const,
            connectorInstanceId: task.connectorInstanceId,
            capabilities: WRITABLE_CAPS,
            settings: {},
          })),
          createTask: vi.fn(async (input: TaskCreateInput) => ({
            kind: 'committed' as const,
            task: input.task,
            sourceTagNames: [],
          })),
        },
      });
      connectorMocks.getConnector.mockResolvedValue(connector);

      const { POST } = await import('@/app/api/tasks/route');
      const response = await POST(new Request('http://localhost:3099/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Remote task',
          connectorType: task.connectorType,
          connectorInstanceId: task.connectorInstanceId,
        }),
        headers: { 'Content-Type': 'application/json' },
      }));

      expect(response.status).toBe(201);
      await vi.waitFor(() => {
        expect(leaseMocks.release).toHaveBeenCalledWith(
          expect.any(String),
          'lease-1',
          'pending_push',
          expect.any(String),
        );
      });
      expect(leaseMocks.fail).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(leaseMocks.claim).toHaveBeenCalledWith(task.id));
  });

  it('blocks source writes without invoking the mutation repository', async () => {
    connectorMocks.capabilities = { ...READ_ONLY_CAPS };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Blocked' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(403);
    expect(mutations).toEqual([]);
  });

  it('allows writes when connector has write capability', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Allowed' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutateTask).toHaveBeenCalledOnce();
  });

  it('allows ingested changes locally without a connector call', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    task = { ...task, connectorType: 'scout', connectorInstanceId: 'scout-primary' };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Local title', status: 'done' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ title: 'Local title', status: 'done' });
    expect(mutations[0].patch).not.toHaveProperty('syncStatus', 'pending_push');
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('allows Scout status changes through its pull-based write-back channel', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    task = {
      ...task,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ status: 'done' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ status: 'done' });
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('persists every main Scout field group without direct write-back', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
      pullWriteBackWhenDisabled: true,
    };
    task = {
      ...task,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(patchRequest({
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
      tags: ['tag-new'],
      kanbanColumn: 'doing',
      kanbanOrder: 2,
    }), { params: Promise.resolve({ id: task.id }) });
    expect(response.status).toBe(200);
    expect(mutations[0]).toMatchObject({
      patch: {
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
      },
      schedulePatch: expect.objectContaining({
        estimatedDuration: 45,
        recurrence: 'FREQ=WEEKLY',
      }),
      replaceTagIds: ['tag-new'],
    });
    expect(mutations[0].patch).not.toHaveProperty('syncStatus', 'pending_push');
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('uses context tag names for source tag write-through', async () => {
    const addTagToTask = vi.fn(async () => undefined);
    const removeTagFromTask = vi.fn(async () => undefined);
    connectorMocks.connector = { addTagToTask, removeTagFromTask };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ tags: ['tag-new'] }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].replaceTagIds).toEqual(['tag-new']);
    await vi.waitFor(() => {
      expect(addTagToTask).toHaveBeenCalledWith(task.sourceId, 'New label');
      expect(removeTagFromTask).toHaveBeenCalledWith(task.sourceId, 'Old label');
    });
  });

  it('keeps tag PATCHes pending when source write-back fails', async () => {
    connectorMocks.connector = {
      addTagToTask: vi.fn(async () => {
        throw new Error('source unavailable');
      }),
      removeTagFromTask: vi.fn(async () => undefined),
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ tags: ['tag-new'] }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ syncStatus: 'pending_push' });
    await vi.waitFor(() => expect(leaseMocks.release).toHaveBeenCalledWith(
      task.id,
      'lease-2',
      'pending_push',
      task.updatedAt,
    ));
    expect(leaseMocks.complete).not.toHaveBeenCalled();
  });

  it('releases ordinary write-through failures for durable retry', async () => {
    connectorMocks.connector = {
      updateTask: vi.fn(async () => {
        throw new Error('source unavailable');
      }),
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Retry me' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(leaseMocks.release).toHaveBeenCalledWith(
      task.id,
      'lease-2',
      'pending_push',
      task.updatedAt,
    ));
    expect(leaseMocks.complete).not.toHaveBeenCalled();
  });

  it('rejects writes when the connector is disabled', async () => {
    connectorMocks.enabled = false;
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Blocked' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
  });

  it('allows local-only task edits when connector state is disabled', async () => {
    connectorMocks.enabled = false;
    task = {
      ...task,
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Local edit' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ title: 'Local edit' });
  });

  it('allows MC-local fields while a remote connector is disabled', async () => {
    connectorMocks.enabled = false;
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ effort: 3 }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ effort: 3 });
    expect(mutations[0].patch).not.toHaveProperty('syncStatus');
  });

  it('rejects mixed local and blocked fields without mutating', async () => {
    connectorMocks.enabled = false;
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Blocked', estimatedDuration: 30, tags: ['tag-new'] }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'persists remote-mirror disposition locally without source I/O when enabled=%s',
    async (enabled) => {
      connectorMocks.enabled = enabled;
      connectorMocks.capabilities = {
        ...READ_ONLY_CAPS,
        taskSourceModel: 'remote-mirror',
        taskFieldProfile: {
          status: { authority: 'source', writeBack: 'none' },
          localDisposition: { authority: 'local', writeBack: 'none' },
        },
      };
      task = {
        ...task,
        connectorType: 'custom-rest',
        connectorInstanceId: 'custom-rest-read-only',
      };
      const { PATCH } = await import('@/app/api/tasks/[id]/route');
      const response = await PATCH(
        patchRequest({ localDisposition: 'handled' }),
        { params: Promise.resolve({ id: task.id }) },
      );
      expect(response.status).toBe(200);
      expect(mutations[0].patch).toMatchObject({ localDisposition: 'handled' });
      expect(connectorMocks.getConnector).not.toHaveBeenCalled();
    },
  );

  it('rejects mixed mirror disposition and source status atomically', async () => {
    connectorMocks.capabilities = { ...READ_ONLY_CAPS, taskSourceModel: 'remote-mirror' };
    task = {
      ...task,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-read-only',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ localDisposition: 'handled', status: 'done' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
  });

  it('rejects local disposition for writable source models', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ localDisposition: 'handled' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
  });

  it('allows a transitioned source model to restore disposition to active', async () => {
    task = {
      ...task,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-writable',
      localDisposition: 'handled',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ localDisposition: 'active' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({ localDisposition: 'active' });
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('rejects metadata before reading or mutating the task', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ metadata: { sourceId: 'replacement' } }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(400);
    expect(getWriteContext).not.toHaveBeenCalled();
    expect(mutateTask).not.toHaveBeenCalled();
  });

  it('falls back to updateTask when a connector has no completion method', async () => {
    const updateTask = vi.fn(async () => ({}));
    connectorMocks.connector = { updateTask };
    task = {
      ...task,
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-writable',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ status: 'done' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalledWith(task.sourceId, {
      status: 'done',
      statusReason: 'completed',
    }));
  });

  it('preserves source-read-only status reasons during status write-through', async () => {
    task = {
      ...task,
      connectorType: 'document-intelligence',
      connectorInstanceId: 'document-intelligence-primary',
      statusReason: 'source-review-required',
    };
    connectorMocks.capabilities = {
      ...WRITABLE_CAPS,
      taskSourceModel: 'remote-managed',
      statusWriteBack: 'direct',
      taskFieldProfile: {
        status: { authority: 'source', writeBack: 'direct' },
        statusReason: { authority: 'source', writeBack: 'none' },
      },
    };
    const updateTask = vi.fn(async () => ({}));
    connectorMocks.connector = { updateTask };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ status: 'done' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch).toMatchObject({
      status: 'done',
      statusReason: 'source-review-required',
    });
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalledWith(
      task.sourceId,
      { status: 'done' },
    ));
  });

  it('removes migrated recurrence metadata when typed recurrence is cleared', async () => {
    task = {
      ...task,
      metadata: {
        recurrence: 'weekly',
        mcOwned: { pinned: true },
        scout: { sourceThreadId: 'newer-provenance' },
      },
    };
    schedule = {
      taskId: task.id,
      scheduledDate: '2026-08-01',
      scheduledTime: null,
      estimatedDuration: null,
      isTimeBlocked: false,
      recurrence: 'weekly',
      recurrenceMode: 'schedule',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ recurrence: null }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(mutations[0].patch.metadata).toEqual({
      mcOwned: { pinned: true },
      scout: { sourceThreadId: 'newer-provenance' },
    });
    expect(mutations[0].schedulePatch).toMatchObject({
      recurrence: null,
      recurrenceMode: 'schedule',
    });
  });

  it('preserves GitHub issue write-through behavior', async () => {
    task = {
      ...task,
      connectorType: 'github-issues',
      connectorInstanceId: 'github-inst-1',
      sourceId: 'owner/repo#123',
    };
    const updateTask = vi.fn(async () => ({}));
    connectorMocks.connector = { type: 'github-issues', updateTask };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ title: 'Updated issue', status: 'in_progress' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalledWith(
      task.sourceId,
      expect.objectContaining({ title: 'Updated issue', status: 'in_progress' }),
    ));
  });

  it('creates and clears Scout overrides against the source snapshot', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    task = {
      ...task,
      title: 'Source title',
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const created = await PATCH(
      patchRequest({ title: 'Local title' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(created.status).toBe(200);
    expect(mutations[0].fieldStates).toContainEqual(expect.objectContaining({
      fieldName: 'title',
      sourceValue: '"Source title"',
      locallyOverridden: true,
      action: 'created',
    }));

    fieldStates = [{
      fieldName: 'title',
      sourceValue: '"Source title"',
      locallyOverridden: true,
      sourceObservedAt: task.lastSyncedAt,
      localEditedAt: task.updatedAt,
      updatedAt: task.updatedAt,
    }];
    const cleared = await PATCH(
      patchRequest({ title: 'Source title' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(cleared.status).toBe(200);
    expect(mutations[1].fieldStates).toContainEqual(expect.objectContaining({
      fieldName: 'title',
      locallyOverridden: false,
      action: 'cleared',
    }));
  });

  it('maps optimistic revision conflicts to 409', async () => {
    registerFakeTaskCorePersistence({
      mutations: {
        getTaskWriteContext: async () => contextFor(task),
        mutateTask: async () => ({
          kind: 'revision-conflict',
          currentUpdatedAt: '2026-08-02T00:00:00.000Z',
        }),
      },
    });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(
      patchRequest({ effort: 3 }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(409);
  });

  it('dismisses remote mirrors atomically without source I/O', async () => {
    connectorMocks.capabilities = { ...READ_ONLY_CAPS, taskSourceModel: 'remote-mirror' };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(
      new Request('http://localhost:3099/api/tasks/task-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'dismissed', writeBack: 'none' });
    expect(removals[0].mode).toBe('mirror-dismiss');
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('dismisses a remote mirror even when its connector advertises delete', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      delete: true,
      taskSourceModel: 'remote-mirror',
    };
    const deleteTask = vi.fn(async () => undefined);
    connectorMocks.connector = { deleteTask };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    expect(removals[0].mode).toBe('mirror-dismiss');
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('does not infer delete support from a method when capability is false', async () => {
    connectorMocks.capabilities = {
      ...NO_DELETE_CAPS,
      taskSourceModel: 'remote-managed',
    };
    const deleteTask = vi.fn(async () => undefined);
    connectorMocks.connector = { deleteTask };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(403);
    expect(applyTaskRemoval).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('blocks historical notification-only tasks from PATCH and DELETE', async () => {
    connectorMocks.capabilities = {
      ...WRITABLE_CAPS,
      notificationOnly: true,
      taskCreate: false,
      taskSourceModel: 'remote-mirror',
    };
    task = {
      ...task,
      connectorType: 'monarch-money',
      connectorInstanceId: 'monarch-legacy',
    };
    const { PATCH, DELETE } = await import('@/app/api/tasks/[id]/route');
    const patch = await PATCH(
      patchRequest({ effort: 3 }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(patch.status).toBe(403);
    const deletion = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(deletion.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
    expect(applyTaskRemoval).not.toHaveBeenCalled();
  });

  it('blocks orphaned notification-only tasks without connector capabilities', async () => {
    connectorMocks.capabilities = null;
    connectorMocks.enabled = false;
    task = {
      ...task,
      connectorType: 'monarch-money',
      connectorInstanceId: 'deleted-monarch',
    };
    const { PATCH, DELETE } = await import('@/app/api/tasks/[id]/route');
    const patch = await PATCH(
      patchRequest({ localDisposition: 'dismissed' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(patch.status).toBe(403);
    const deletion = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(deletion.status).toBe(403);
    expect(mutateTask).not.toHaveBeenCalled();
    expect(applyTaskRemoval).not.toHaveBeenCalled();
  });

  it('cancels Scout tasks locally for the pull status feed', async () => {
    connectorMocks.capabilities = {
      ...READ_ONLY_CAPS,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
      pullWriteBackWhenDisabled: true,
    };
    connectorMocks.enabled = false;
    task = {
      ...task,
      sourceId: 'scout:email:message-1',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
    };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'cancelled',
      writeBack: 'pull-write-back',
    });
    expect(removals[0].mode).toBe('ingested-cancel');
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('uses atomic local graph deletion for MC-owned tasks', async () => {
    task = {
      ...task,
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
    };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, action: 'deleted' });
    expect(removals[0].mode).toBe('local-delete');
    expect(searchMocks.remove).toHaveBeenCalledWith(task.id);
    expect(searchMocks.semanticDelete).toHaveBeenCalledWith('task', task.id);
    expect(connectorMocks.getConnector).not.toHaveBeenCalled();
  });

  it('rejects deletes when connector delete capability is false', async () => {
    connectorMocks.capabilities = { ...NO_DELETE_CAPS };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(403);
    expect(applyTaskRemoval).not.toHaveBeenCalled();
  });

  it('uses upstream close when delete is false but close is supported', async () => {
    connectorMocks.capabilities = { ...NO_DELETE_CAPS, close: true };
    const closeTaskWithReason = vi.fn(async () => undefined);
    connectorMocks.connector = { closeTaskWithReason };
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'closed' });
    await vi.waitFor(() => expect(closeTaskWithReason).toHaveBeenCalledWith(
      task.sourceId,
      'not_planned',
    ));
  });

  it('rejects deletes when connector is disabled', async () => {
    connectorMocks.enabled = false;
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(403);
    expect(applyTaskRemoval).not.toHaveBeenCalled();
  });

  it('publishes pending remote deletion and fences finalization with its version', async () => {
    const deleteTask = vi.fn(async () => undefined);
    connectorMocks.connector = { deleteTask };
    const finalize = vi.fn(async () => ({
      kind: 'committed' as const,
      action: 'deleted' as const,
      taskVersion: null,
    }));
    registerFakeTaskCorePersistence({
      removals: {
        getTaskRemovalContext: async () => ({ task }),
        applyTaskRemoval: async (request) => {
          task = { ...task, syncStatus: 'pending_push', updatedAt: request.now };
          return { kind: 'committed', action: 'pending-remote', taskVersion: request.now };
        },
        finalizeRemoteTaskRemoval: finalize,
      },
    });
    leaseMocks.load.mockImplementation(async () => task);
    const { DELETE } = await import('@/app/api/tasks/[id]/route');
    const response = await DELETE(
      new Request('http://localhost:3099/api/tasks/task-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(response.status).toBe(200);
    expect(searchMocks.semanticUpsert).toHaveBeenCalledWith('task', task.id);
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledWith({
      taskId: task.id,
      leaseToken: 'lease-2',
      expectedUpdatedAt: task.updatedAt,
    }));
    expect(deleteTask).toHaveBeenCalledWith(task.sourceId);
    await vi.waitFor(() => {
      expect(searchMocks.remove).toHaveBeenCalledWith(task.id);
      expect(searchMocks.semanticDelete).toHaveBeenCalledWith('task', task.id);
    });
  });
});
