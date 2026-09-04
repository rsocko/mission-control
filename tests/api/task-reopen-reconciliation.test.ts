import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorCapabilities } from '@/types';
import type { TaskCoreTaskRow, TaskMutationRequest } from '@/lib/tasks/core/contracts';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const connectorState = vi.hoisted(() => ({
  capabilities: {
    read: true,
    write: false,
    delete: false,
    sync: true,
    taskSourceModel: 'ingested',
    statusWriteBack: 'pull',
  } as ConnectorCapabilities,
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => connectorState.capabilities),
  isConnectorEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/connectors/runtime', () => ({ getOrInitializeConnector: vi.fn() }));
vi.mock('@/lib/search/fts', () => ({
  indexTask: vi.fn(async () => undefined),
  removeTaskFromIndex: vi.fn(async () => undefined),
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: vi.fn(async () => undefined),
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rules', () => ({ evaluateRulesForTasks: vi.fn(async () => undefined) }));
vi.mock('@/lib/sync/write-through-log', () => ({ logWriteThrough: vi.fn() }));
vi.mock('@/lib/priority', () => ({ resolveOutboundPriority: vi.fn() }));
vi.mock('@/lib/utils/date', () => ({ getLocalToday: vi.fn(() => '2026-08-05') }));
vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
  getTimezone: vi.fn(() => 'UTC'),
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const task = {
  id: 'task-1',
  title: 'Scout task',
  status: 'done',
  completedAt: '2026-08-05T12:00:00.000Z',
  statusReason: null,
  priority: 'medium',
  sourceId: 'scout:planner:task-1',
  connectorType: 'scout',
  connectorInstanceId: 'scout-default',
  updatedAt: '2026-08-05T12:00:00.000Z',
  metadata: {},
  localDisposition: 'active',
  isChecklistItem: false,
  planningHorizon: null,
  dueDate: null,
  reminderAt: null,
  reminderRelative: null,
  reminderDueTime: null,
  lastSyncedAt: '2026-08-05T12:00:00.000Z',
} as unknown as TaskCoreTaskRow;

function request(body: Record<string, unknown>) {
  return new Request('https://mc.example/api/tasks/task-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('task reopen reconciliation persistence', () => {
  let currentTask: TaskCoreTaskRow;
  let mutation: TaskMutationRequest | undefined;

  beforeEach(() => {
    currentTask = { ...task };
    mutation = undefined;
    connectorState.capabilities = {
      read: true,
      write: false,
      delete: false,
      sync: true,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    };
    registerFakeTaskCorePersistence({
      mutations: {
        getTaskWriteContext: async () => ({
          task: currentTask,
          schedule: null,
          tagIds: [],
          tagNamesById: {},
          fieldStates: [],
          wasAutoCompletedByReconciliation: true,
        }),
        mutateTask: async (request) => {
          mutation = request;
          currentTask = { ...currentTask, ...request.patch, updatedAt: request.now };
          return { kind: 'committed', task: currentTask, recurrenceNextTaskId: null };
        },
      },
    });
  });

  it('moves reopen suppression into the atomic mutation', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(request({ status: 'todo' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    expect(response.status).toBe(200);
    expect(mutation).toMatchObject({
      suppressAutoCompletionAfterReopen: true,
      supersedePendingReconciliation: false,
    });
  });

  it('does not suppress a task that remains terminal', async () => {
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(request({ status: 'cancelled' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    expect(response.status).toBe(200);
    expect(mutation?.suppressAutoCompletionAfterReopen).toBe(false);
  });

  it('atomically supersedes pending suggestions on a terminal transition', async () => {
    currentTask = { ...currentTask, status: 'todo', completedAt: null };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(request({ status: 'done' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    expect(response.status).toBe(200);
    expect(mutation).toMatchObject({
      expectedStatusForTerminalTransition: 'todo',
      supersedePendingReconciliation: true,
    });
    expect(mutation?.events).toEqual([
      expect.objectContaining({ type: 'task.completed' }),
    ]);
  });

  it('rejects unsupported source statuses before mutation', async () => {
    connectorState.capabilities = {
      ...connectorState.capabilities,
      write: true,
      taskSourceModel: 'remote-managed',
      statusWriteBack: 'direct',
      supportedTaskStatuses: ['todo', 'done', 'cancelled'],
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(request({ status: 'in_progress' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    expect(response.status).toBe(422);
    expect(mutation).toBeUndefined();
  });

  it('rejects a mixed request before mutating when any field is blocked', async () => {
    connectorState.capabilities = {
      ...connectorState.capabilities,
      taskSourceModel: 'remote-mirror',
      statusWriteBack: 'none',
    };
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(request({
      effort: 3,
      title: 'Blocked source title',
    }), { params: Promise.resolve({ id: currentTask.id }) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      blockedFields: {
        title: expect.stringContaining('upstream task source'),
      },
    });
    expect(mutation).toBeUndefined();
  });

  it('returns the stable recurrence successor id on repeated completion', async () => {
    currentTask = {
      ...currentTask,
      sourceId: 'local:task-1',
      connectorType: 'local',
      connectorInstanceId: 'local',
      status: 'todo',
      completedAt: null,
      dueDate: '2026-08-05',
    };
    const requests: TaskMutationRequest[] = [];
    registerFakeTaskCorePersistence({
      mutations: {
        getTaskWriteContext: async () => ({
          task: currentTask,
          schedule: {
            taskId: currentTask.id,
            scheduledDate: '2026-08-05',
            scheduledTime: null,
            estimatedDuration: null,
            isTimeBlocked: false,
            recurrence: 'FREQ=DAILY',
            recurrenceMode: 'completion',
          },
          tagIds: [],
          tagNamesById: {},
          fieldStates: [],
          wasAutoCompletedByReconciliation: false,
        }),
        mutateTask: async (mutationRequest) => {
          requests.push(mutationRequest);
          currentTask = {
            ...currentTask,
            ...mutationRequest.patch,
            updatedAt: mutationRequest.now,
          };
          return {
            kind: 'committed',
            task: currentTask,
            recurrenceNextTaskId: 'next-occurrence',
          };
        },
      },
    });
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const first = await PATCH(request({ status: 'done' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    const repeated = await PATCH(request({ status: 'done' }), {
      params: Promise.resolve({ id: currentTask.id }),
    });
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      recurrenceNextTaskId: 'next-occurrence',
    });
    await expect(repeated.json()).resolves.toMatchObject({
      recurrenceNextTaskId: 'next-occurrence',
    });
    expect(requests[0].recurrenceSuccessor).toBeDefined();
    expect(requests[1].recurrenceSuccessor).toBeDefined();
  });
});
