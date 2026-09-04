import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '@/types';
import type { TaskCoreTaskRow, TaskMutationRequest } from '@/lib/tasks/core/contracts';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn(),
  claim: vi.fn(),
  load: vi.fn(),
  heartbeat: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/connectors/runtime', () => ({
  getOrInitializeConnector: vi.fn(async () => ({ updateTask: mocks.updateTask })),
}));
vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => ({
    read: true,
    write: true,
    delete: true,
    sync: true,
    taskSourceModel: 'remote-managed',
    statusWriteBack: 'direct',
  })),
  isConnectorEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/sync/push-lease', () => ({
  claimTaskForPush: mocks.claim,
  loadClaimedTaskForPush: mocks.load,
  heartbeatTaskPush: mocks.heartbeat,
  completeTaskPush: mocks.complete,
  releaseTaskPush: mocks.release,
  failTaskPush: vi.fn(),
}));
vi.mock('@/lib/search/fts', () => ({
  indexTask: vi.fn(async () => undefined),
  removeTaskFromIndex: vi.fn(async () => undefined),
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: vi.fn(async () => undefined),
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rules', () => ({ evaluateRulesForTasks: vi.fn(async () => undefined) }));
vi.mock('@/lib/sync/write-through-log', () => ({ logWriteThrough: vi.fn(async () => undefined) }));
vi.mock('@/lib/priority', () => ({
  resolveOutboundPriority: vi.fn(() => ({ shouldWrite: false, event: null })),
}));
vi.mock('@/lib/utils/date', () => ({ getLocalToday: vi.fn(() => '2026-07-27') }));
vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
  getTimezone: vi.fn(() => 'UTC'),
}));
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const BASE_TASK = {
  id: 'task-1',
  sourceId: 'octo-org/ideation:850',
  connectorType: 'custom-rest',
  connectorInstanceId: 'custom-rest-1',
  title: 'Fix dashboard layout',
  description: null,
  status: 'todo',
  priority: 'medium',
  localDisposition: 'active',
  planningHorizon: null,
  dueDate: null,
  completedAt: null,
  statusReason: null,
  isChecklistItem: false,
  parentId: null,
  metadata: {},
  syncStatus: 'synced',
  lastSyncedAt: '2026-07-26T00:00:00Z',
  updatedAt: '2026-07-26T00:00:00Z',
  reminderAt: null,
  reminderRelative: null,
  reminderDueTime: null,
} as unknown as TaskCoreTaskRow;

function patch(status: string) {
  return new Request('http://localhost/api/tasks/task-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

describe('write-through terminal status detection', () => {
  let task: TaskCoreTaskRow;

  beforeEach(() => {
    task = { ...BASE_TASK };
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue('lease-1');
    mocks.heartbeat.mockResolvedValue('lease-2');
    mocks.complete.mockResolvedValue(true);
    mocks.release.mockResolvedValue(true);
    mocks.load.mockImplementation(async () => task);
    registerFakeTaskCorePersistence({
      mutations: {
        getTaskWriteContext: async () => ({
          task,
          schedule: null,
          tagIds: [],
          tagNamesById: {},
          fieldStates: [],
          wasAutoCompletedByReconciliation: false,
        }),
        mutateTask: async (request: TaskMutationRequest) => {
          task = { ...task, ...request.patch, updatedAt: request.now };
          return { kind: 'committed', task, recurrenceNextTaskId: null };
        },
      },
    });
  });

  it('passes a discovered terminal remote status to version-fenced completion', async () => {
    mocks.updateTask.mockResolvedValue({
      status: 'done',
      completedAt: '2026-07-26T18:00:00Z',
    } satisfies Partial<TaskItem>);
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(patch('in_progress'), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    expect(mocks.complete).toHaveBeenCalledWith(
      task.id,
      'lease-2',
      task.sourceId,
      undefined,
      { status: 'done', completedAt: '2026-07-26T18:00:00Z' },
      task.updatedAt,
    );
  });

  it('does not replace an explicit cancellation with the normalized remote status', async () => {
    mocks.updateTask.mockResolvedValue({
      status: 'done',
      completedAt: '2026-08-09T15:00:00Z',
    } satisfies Partial<TaskItem>);
    const { PATCH } = await import('@/app/api/tasks/[id]/route');
    const response = await PATCH(patch('cancelled'), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalled());
    expect(mocks.complete.mock.calls.at(-1)?.[4]).toBeUndefined();
  });
});
