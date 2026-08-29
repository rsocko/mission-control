import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  currentTask,
  connectorCapabilities,
  suppressAutoCompletionAfterReopen,
  supersedePendingReconciliationSuggestions,
  wasTaskAutoCompletedByReconciliation,
} = vi.hoisted(() => ({
  currentTask: {
    id: 'task-1',
    title: 'Scout task',
    status: 'done',
    completedAt: '2026-08-05T12:00:00.000Z',
    statusReason: null,
    priority: 'medium',
    sourceId: 'scout:planner:task-1',
    connectorType: 'scout',
    connectorInstanceId: 'scout-default',
  },
  connectorCapabilities: {
    write: false,
    taskSourceModel: 'ingested',
    statusWriteBack: 'pull',
    supportedTaskStatuses: undefined as import('@/types').TaskStatus[] | undefined,
  },
  suppressAutoCompletionAfterReopen: vi.fn(),
  supersedePendingReconciliationSuggestions: vi.fn(),
  wasTaskAutoCompletedByReconciliation: vi.fn(),
}));

const transaction = {
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ run: vi.fn(() => ({ changes: 1 })) })),
    })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(() => ({ run: vi.fn() })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({ run: vi.fn() })),
  })),
};

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [currentTask]),
      })),
    })),
  },
  runTransaction: vi.fn((callback: (tx: typeof transaction) => void) => callback(transaction)),
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id' },
  taskTags: { taskId: 'taskId' },
  taskProjects: {},
  taskDependencies: {},
  taskSchedules: {},
  taskFieldStates: { taskId: 'taskId', fieldName: 'fieldName' },
  myDayItems: {},
  prioritySyncLog: {},
}));

vi.mock('@/lib/connectors/scout/reconciliation-service', () => ({
  suppressAutoCompletionAfterReopen,
  supersedePendingReconciliationSuggestions,
  wasTaskAutoCompletedByReconciliation,
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => connectorCapabilities),
  isConnectorEnabled: vi.fn(async () => true),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: vi.fn() },
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {},
  logWriteThrough: vi.fn(),
}));

vi.mock('@/lib/events', () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/priority', () => ({ resolveOutboundPriority: vi.fn() }));
vi.mock('@/lib/utils/date', () => ({ getLocalToday: vi.fn(() => '2026-08-05') }));
vi.mock('@/lib/utils/deep-links', () => ({ buildDeepLinkUrl: vi.fn() }));
vi.mock('@/lib/mode', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { PATCH } from '@/app/api/tasks/[id]/route';

describe('task reopen reconciliation suppression', () => {
  beforeEach(() => {
    suppressAutoCompletionAfterReopen.mockReset();
    supersedePendingReconciliationSuggestions.mockReset();
    wasTaskAutoCompletedByReconciliation.mockReset();
    wasTaskAutoCompletedByReconciliation.mockResolvedValue(true);
    currentTask.status = 'done';
    connectorCapabilities.write = false;
    connectorCapabilities.taskSourceModel = 'ingested';
    connectorCapabilities.statusWriteBack = 'pull';
    connectorCapabilities.supportedTaskStatuses = undefined;
    transaction.update.mockClear();
  });

  it('durably suppresses future auto-completion when an auto-completed task is reopened', async () => {
    const response = await PATCH(new Request('https://mc.example/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'todo' }),
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    expect(wasTaskAutoCompletedByReconciliation).toHaveBeenCalledWith('task-1');
    expect(suppressAutoCompletionAfterReopen).toHaveBeenCalledWith(
      transaction,
      'task-1',
      expect.any(String),
    );
  });

  it('does not suppress a task that remains terminal', async () => {
    const response = await PATCH(new Request('https://mc.example/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    expect(wasTaskAutoCompletedByReconciliation).not.toHaveBeenCalled();
    expect(suppressAutoCompletionAfterReopen).not.toHaveBeenCalled();
  });

  it('supersedes pending reconciliation suggestions when a task becomes terminal', async () => {
    currentTask.status = 'todo';

    const response = await PATCH(new Request('https://mc.example/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    expect(supersedePendingReconciliationSuggestions).toHaveBeenCalledWith(
      transaction,
      'task-1',
      expect.any(String),
    );
  });

  it('rejects a mixed request before updating when any field is blocked', async () => {
    connectorCapabilities.taskSourceModel = 'remote-mirror';
    connectorCapabilities.statusWriteBack = 'none';

    const response = await PATCH(new Request('https://mc.example/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({
        effort: 3,
        title: 'Blocked source title',
      }),
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Some fields cannot be changed for this task source',
      blockedFields: {
        title: expect.stringContaining('upstream task source'),
      },
    });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('rejects lifecycle values the source cannot represent before updating locally', async () => {
    currentTask.connectorType = 'document-intelligence';
    currentTask.connectorInstanceId = 'owl-1';
    currentTask.sourceId = 'owl-action-1';
    connectorCapabilities.write = true;
    connectorCapabilities.taskSourceModel = 'remote-managed';
    connectorCapabilities.statusWriteBack = 'direct';
    connectorCapabilities.supportedTaskStatuses = ['todo', 'done', 'cancelled'];

    const response = await PATCH(new Request('https://mc.example/api/tasks/task-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: 'This task source does not support status "in_progress"',
    });
    expect(transaction.update).not.toHaveBeenCalled();
  });
});
