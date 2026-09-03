/**
 * The write-through move installs its remote compensation closure *before* it
 * persists the created task's external identity. Identity persistence is a
 * durable write that can fail (or the process can be interrupted), and the
 * remote GitHub issue already exists at that point — so a failure there has to
 * roll the remote creation back and leave no local destination behind.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';

const CREATED_SOURCE_ID = 'acme/repo-b:42';

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(async () => {}),
  persistCreatedTaskIdentity: vi.fn(async () => {}),
  reconcileTransferIdentity: vi.fn(async () => {}),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn((id: string) => (id === 'target-connector'
      ? {
          type: 'github-issues',
          createTask: mocks.createTask,
          deleteTask: mocks.deleteTask,
        }
      : undefined)),
    createConnector: vi.fn(),
  },
}));

vi.mock('@/lib/connectors/transfer-identity', () => ({
  persistCreatedTaskIdentity: mocks.persistCreatedTaskIdentity,
  reconcileTransferIdentity: mocks.reconcileTransferIdentity,
}));

vi.mock('@/lib/external-identities/github-write-fence', () => {
  // The real fence needs identity/write-fence persistence; this suite is about
  // compensation ordering, so the fence only has to run the write. The error
  // classes are re-declared here because the module under test compares
  // against *these* bindings, so `instanceof` stays consistent.
  class GitHubWriteFenceError extends Error {}
  class GitHubUnknownWriteOutcomeError extends Error {}
  return {
    GitHubWriteFenceError,
    GitHubUnknownWriteOutcomeError,
    executeFencedGitHubSourceMutation: vi.fn(
      async (options: { write: () => Promise<unknown> }) => options.write(),
    ),
    executeFencedGitHubTaskMutation: vi.fn(
      async (options: { write: () => Promise<unknown> }) => options.write(),
    ),
  };
});

vi.mock('@/lib/persistence/runtime', () => ({
  registerCorePersistenceRepositories: vi.fn(),
  getCorePersistenceRepositories: () => coreRepositories,
  getCorePersistenceRepositoriesForBackend: async () => coreRepositories,
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  connectorLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

const coreRepositories = {
  connectors: {
    get: async (id: string) => (id === 'target-connector'
      ? {
          id: 'target-connector',
          type: 'github-issues',
          name: 'GitHub',
          enabled: true,
          capabilities: { read: true, write: true, taskCreate: true },
          credentials: {},
          settings: {},
          syncedLists: ['acme/repo-b'],
        }
      : null),
  },
};

const sourceTask = {
  id: 'task-1',
  sourceId: 'local:task-1',
  connectorType: 'local',
  connectorInstanceId: 'local',
  title: 'Move me',
  description: 'body',
  status: 'todo',
  localDisposition: 'active',
  priority: 'none',
  planningHorizon: null,
  dueDate: null,
  pushCount: 0,
  createdAt: '2026-08-14T12:00:00.000Z',
  updatedAt: '2026-08-14T12:00:00.000Z',
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
  lastSyncedAt: '2026-08-14T12:00:00.000Z',
  pushRetryCount: 0,
  kanbanColumn: null,
  kanbanOrder: null,
  effort: null,
};

const discardMaterializedDestination = vi.fn(async (_taskId: string) => {});
const materializeDestination = vi.fn(async () => {});
const releaseTaskMoveClaim = vi.fn(async () => {});
const finalizeMove = vi.fn(async () => ({ kind: 'finalized' as const }));

function registerMoves(): void {
  registerTaskCorePersistence({
    writeThroughMoves: {
      getTask: async () => ({ ...sourceTask }),
      findTargetListBySourceId: async () => ({
        id: 'target-list-row',
        name: 'Repo B',
        sourceId: 'acme/repo-b',
      }),
      listTaskTagRefs: async () => [],
      listChildTasks: async () => [],
      listAttachmentMetadata: async () => [],
      getTaskSchedule: async () => null,
      listAttachmentContents: async () => [],
      claimTaskMove: async () => true,
      releaseTaskMoveClaim,
      discardMaterializedDestination,
      materializeDestination,
      finalizeMove,
      recordSourceSyncIntent: async () => {},
      recordSourceCopyProvenance: async () => {},
    },
  } as unknown as TaskCorePersistence);
}

const moveInput = {
  taskId: 'task-1',
  targetConnectorInstanceId: 'target-connector',
  targetSourceListId: 'acme/repo-b',
  sourceAction: 'move' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTask.mockResolvedValue({
    sourceId: CREATED_SOURCE_ID,
    title: 'Move me',
    metadata: { issueNumber: 42 },
    externalIdentity: {
      entity: {
        identity: { stableId: 'I_created' },
        locator: { webUrl: 'https://github.com/acme/repo-b/issues/42' },
      },
    },
  });
  mocks.deleteTask.mockResolvedValue(undefined);
  mocks.persistCreatedTaskIdentity.mockResolvedValue(undefined);
  registerMoves();
});

afterAll(() => {
  clearTaskCorePersistence();
});

describe('write-through move compensation around created-identity persistence', () => {
  it('compensates the remote creation and leaves no local destination when identity persistence fails', async () => {
    mocks.persistCreatedTaskIdentity.mockRejectedValue(new Error('identity write failed'));
    const { executeWriteThroughTaskMove } = await import('@/lib/tasks/task-move-write-through');

    const result = await executeWriteThroughTaskMove(moveInput);

    expect(result.status).toBe(500);
    expect(result.body).toEqual(expect.objectContaining({
      error: 'Failed to execute task move',
    }));
    // The remote issue existed before the identity write was attempted, so it
    // must be deleted rather than orphaned.
    expect(mocks.deleteTask).toHaveBeenCalledWith(CREATED_SOURCE_ID);
    // …and the compensation must also clear any destination row for the
    // successor id the move reserved.
    expect(discardMaterializedDestination).toHaveBeenCalledTimes(1);
    expect(materializeDestination).not.toHaveBeenCalled();
    expect(releaseTaskMoveClaim).toHaveBeenCalledTimes(1);
  });

  it('still completes the move when identity persistence succeeds', async () => {
    const { executeWriteThroughTaskMove } = await import('@/lib/tasks/task-move-write-through');

    const result = await executeWriteThroughTaskMove(moveInput);

    expect(result.status).toBe(201);
    expect(mocks.persistCreatedTaskIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTask).not.toHaveBeenCalled();
    expect(discardMaterializedDestination).not.toHaveBeenCalled();
    expect(materializeDestination).toHaveBeenCalledTimes(1);
    expect(finalizeMove).toHaveBeenCalledTimes(1);
  });
});
