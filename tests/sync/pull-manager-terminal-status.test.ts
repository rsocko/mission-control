/**
 * Tests for terminal status sync propagation fix.
 *
 * When a GitHub issue is closed externally while its MC task is "in_progress",
 * the sync should always apply the terminal status (done/cancelled) regardless
 * of timestamp comparisons. This prevents a race where the push-manager
 * advances lastSyncedAt past the remote's closure timestamp.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { ConnectorCapabilities, TaskItem } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExistingTasks: unknown[] = [];
const mockUpdateSets: unknown[] = [];
const mockIdentityWrites: unknown[] = [];
let selectCallCount = 0;
let mockCapabilities: ConnectorCapabilities | null = null;
let mockConcurrentInsertRecord: Record<string, unknown> | null = null;

type AwaitableTagRows = unknown[] & {
  where: ReturnType<typeof vi.fn>;
  then: PromiseLike<unknown[]>['then'];
};

vi.mock('@/db', () => {
  const updateWhereFn = vi.fn();
  const updateSetFn = vi.fn((data: unknown) => {
    mockUpdateSets.push(data);
    return { where: updateWhereFn };
  });
  const database = {
    select: vi.fn(() => {
      const callNum = ++selectCallCount;
      return {
        from: vi.fn(() => {
          if (callNum === 1) {
            // First select: existing tasks (has .where)
            return { where: vi.fn(() => [...mockExistingTasks]) };
          }
          // Second select: tags (NO .where — returns array directly as thenable)
          const tagsResult = [] as unknown as AwaitableTagRows;
          // Make it thenable (awaitable) since it's used with await without .where()
          tagsResult.where = vi.fn(() => []);
          tagsResult.then = (onFulfilled, onRejected) => Promise.resolve([] as unknown[]).then(onFulfilled, onRejected);
          return tagsResult;
        }),
      };
    }),
    update: vi.fn(() => ({ set: updateSetFn })),
    insert: vi.fn(() => ({ values: vi.fn() })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  };
  return {
    default: database,
    sqlite: {
      prepare: vi.fn(() => ({
        all: vi.fn(() => []),
      })),
    },
    runTransaction: vi.fn((callback: (tx: typeof database) => unknown) => callback(database)),
  };
});

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', sourceId: 'sourceId', connectorInstanceId: 'connectorInstanceId' },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId' },
  myDayItems: { taskId: 'taskId' },
  tags: { id: 'id', slug: 'slug', type: 'type' },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => mockCapabilities),
}));

vi.mock('@/lib/logger', () => ({
  syncLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/sync/events', () => ({
  syncEventBus: { emitSyncEvent: vi.fn() },
}));

vi.mock('@/lib/external-identities/primary-identity', () => ({
  persistGitHubPrimaryIdentityBatch: vi.fn(async (writes: unknown[]) => {
    mockIdentityWrites.push(...writes);
    return writes.map(() => ({ state: 'bound' }));
  }),
}));

vi.mock('@/lib/sync/github-hierarchy-reconciliation', () => ({
  readGitHubHierarchyObservation: (task: TaskItem) => {
    if (task.connectorType !== 'github-issues') return { kind: 'not-issue' };
    if (!Object.prototype.hasOwnProperty.call(task.metadata, 'githubParent')) {
      return {
        kind: 'incomplete',
        reasonCode: 'sub_issue_graphql_evidence_unavailable',
      };
    }
    return {
      kind: 'complete',
      observation: {
        childSourceId: task.sourceId,
        childIdentityEvidence: task.externalIdentity,
        parent: task.metadata.githubParent,
        parentIdentityEvidence: task.githubParentIdentity,
      },
    };
  },
  mergeGitHubHierarchyObservation: (
    observations: Map<string, unknown>,
    observation: { childSourceId: string },
  ) => {
    observations.set(observation.childSourceId, observation);
    return true;
  },
  reconcileGitHubTaskHierarchy: vi.fn(async () => ({ applied: false, updated: 0 })),
}));

vi.mock('@/lib/sync/search-indexer', () => ({
  indexTasksForSearchBatch: vi.fn(async () => {}),
}));

vi.mock('@/lib/sync/deletion-detector', () => ({
  detectDeletions: vi.fn(async () => ({ removed: 0, localOnlyProtected: 0 })),
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
      pulls: {
        loadSnapshot: vi.fn(async () => ({
          tasks: [...mockExistingTasks],
          tags: [],
          archivedRecurringDuplicateSourceIds: [],
          linkedSources: [],
        })),
        updateLinkedSourceLocator: vi.fn(async () => undefined),
        updateTaskSourceId: vi.fn(async (taskId: string, sourceId: string) => {
          const task = mockExistingTasks.find(
            (candidate) => (candidate as { id: string }).id === taskId,
          ) as Record<string, unknown> | undefined;
          if (task) task.sourceId = sourceId;
          return Boolean(task);
        }),
        adoptLocalTask: vi.fn(async (input: {
          taskId: string;
          remoteSourceId: string;
          hasLocalEdits: boolean;
          now: string;
        }) => {
          const task = mockExistingTasks.find(
            (candidate) => (candidate as { id: string }).id === input.taskId,
          ) as Record<string, unknown> | undefined;
          if (!task) return null;
          Object.assign(task, {
            sourceId: input.remoteSourceId,
            syncStatus: input.hasLocalEdits ? 'pending_push' : 'synced',
            lastSyncedAt: input.now,
          });
          return task;
        }),
        insertBatch: vi.fn(async (candidates: Array<{
          task: Record<string, unknown>;
        }>) => {
          if (mockConcurrentInsertRecord) {
            mockExistingTasks.push(mockConcurrentInsertRecord);
            return {
              insertedIds: new Set<string>(),
              records: [mockConcurrentInsertRecord],
            };
          }
          const insertedIds = new Set<string>();
          for (const candidate of candidates) {
            mockExistingTasks.push(candidate.task);
            insertedIds.add(candidate.task.id as string);
          }
          return { insertedIds, records: candidates.map(({ task }) => task) };
        }),
        findBySourceIds: vi.fn(async (_connectorId: string, sourceIds: string[]) =>
          mockExistingTasks.filter((candidate) =>
            sourceIds.includes((candidate as { sourceId: string }).sourceId))),
        applyRemoteUpdate: vi.fn(async (input: {
          taskId: string;
          expectedSyncStatus: string;
          values: Record<string, unknown>;
        }) => {
          const task = mockExistingTasks.find(
            (candidate) => (candidate as { id: string }).id === input.taskId,
          ) as Record<string, unknown> | undefined;
          if (!task || task.syncStatus !== input.expectedSyncStatus) return false;
          Object.assign(task, input.values);
          mockUpdateSets.push(input.values);
          return true;
        }),
        replaceSourceTags: vi.fn(async () => undefined),
        listChecklistItems: vi.fn(async () => mockExistingTasks
          .filter((task) => (task as { isChecklistItem?: boolean }).isChecklistItem)
          .map((task) => ({
            id: (task as { id: string }).id,
            sourceId: (task as { sourceId: string }).sourceId,
            parentId: (task as { parentId?: string | null }).parentId ?? null,
          }))),
        correctParents: vi.fn(async (corrections: Array<{ taskId: string; parentId: string }>) => {
          for (const correction of corrections) {
            const task = mockExistingTasks.find(
              (candidate) => (candidate as { id: string }).id === correction.taskId,
            ) as Record<string, unknown> | undefined;
            if (task) task.parentId = correction.parentId;
          }
        }),
        listChildren: vi.fn(async (taskId: string) => mockExistingTasks
          .filter((task) => (task as { parentId?: string }).parentId === taskId)
          .map((task) => (task as { id: string }).id)),
        listTasks: vi.fn(async () => [...mockExistingTasks]),
      },
    },
  })),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  let counter = 0;
  return {
    ...actual,
    randomUUID: () => `uuid-${++counter}`,
  };
});

import { upsertTasks } from '@/lib/sync/pull-manager';
import { detectDeletions } from '@/lib/sync/deletion-detector';

describe('pull-manager terminal status sync', () => {
  const connectorId = 'gh-conn-1';
  const mockConnector = {
    type: 'github-issues',
    displayName: 'GitHub Issues',
    fetchTasks: vi.fn(async function* () { yield []; }),
    fetchNotifications: vi.fn(),
    fetchSourceLists: vi.fn(),
  } as unknown as IConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistingTasks.length = 0;
    mockUpdateSets.length = 0;
    mockIdentityWrites.length = 0;
    selectCallCount = 0;
    mockCapabilities = null;
    mockConcurrentInsertRecord = null;
  });

  function makeExistingTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1',
      sourceId: 'org/repo:42',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Fix bug',
      description: undefined,
      status: 'in_progress',
      localDisposition: 'handled',
      microStatus: null,
      statusReason: null,
      priority: 'medium',
      effort: null,
      dueDate: null,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-25T12:00:00Z',
      completedAt: null,
      parentId: null,
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'org/repo',
      sourceListName: 'org/repo',
      assignee: null,
      metadata: '{}',
      syncStatus: 'synced',
      lastSyncedAt: '2026-07-25T12:00:00Z',
      kanbanColumn: null,
      kanbanOrder: null,
      snoozedUntil: null,
      pushRetryCount: 0,
      ...overrides,
    };
  }

  function makeRemoteTask(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'remote-1',
      sourceId: 'org/repo:42',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Fix bug',
      description: undefined,
      status: 'done',
      microStatus: undefined,
      statusReason: 'completed',
      priority: 'medium',
      effort: undefined,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-25T10:00:00Z',
      completedAt: '2026-07-25T10:00:00Z',
      parentId: undefined,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'org/repo',
      sourceListName: 'org/repo',
      hubProjectIds: [],
      tags: [],
      metadata: { issueNumber: 42 },
      syncStatus: 'synced',
      lastSyncedAt: '2026-07-25T10:00:00Z',
      ...overrides,
    };
  }

  it('forces remote "done" even when lastSyncedAt is newer than remote updatedAt', async () => {
    // Push-manager advanced lastSyncedAt to T4=12:00, but issue was closed at T3=10:00
    mockExistingTasks.push(makeExistingTask({
      status: 'in_progress',
      lastSyncedAt: '2026-07-25T12:00:00Z', // Advanced by push-manager
      updatedAt: '2026-07-25T12:00:00Z',
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'done',
        updatedAt: '2026-07-25T10:00:00Z', // OLDER than lastSyncedAt
      })],
      false,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'done' }),
    );
    expect(mockUpdateSets.every((update) =>
      !(update && typeof update === 'object' && 'localDisposition' in update),
    )).toBe(true);
  });

  it('preserves MC-local snoozes when a connector omits the field', async () => {
    mockExistingTasks.push(makeExistingTask({
      snoozedUntil: '2026-08-23T12:00:00Z',
    }));
    mockCapabilities = {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: true,
      tags: true,
      tagWriteBack: false,
      taskFieldProfile: {
        snoozedUntil: { authority: 'local', writeBack: 'none' },
      },
    };

    await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask()],
      false,
      [],
    );

    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      snoozedUntil: '2026-08-23T12:00:00Z',
    }));
  });

  it('preserves MC-local status context when the source omits it', async () => {
    mockExistingTasks.push(makeExistingTask({
      microStatus: 'waiting',
      statusReason: 'Waiting for a reply',
    }));
    mockCapabilities = {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: true,
      tags: true,
      tagWriteBack: false,
      taskFieldProfile: {
        microStatus: { authority: 'local', writeBack: 'none' },
        statusReason: { authority: 'local', writeBack: 'none' },
      },
    };

    await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({ microStatus: undefined, statusReason: undefined })],
      false,
      [],
    );

    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      microStatus: 'waiting',
      statusReason: 'Waiting for a reply',
    }));
  });

  it('forces remote "cancelled" when local is in_progress', async () => {
    mockExistingTasks.push(makeExistingTask({
      status: 'in_progress',
      lastSyncedAt: '2026-07-25T12:00:00Z',
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'cancelled',
        updatedAt: '2026-07-25T09:00:00Z',
      })],
      false,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('reconciles terminal OWL outcomes and preserves disposition metadata', async () => {
    const owlConnectorId = 'owl-1';
    const owlConnector = {
      ...mockConnector,
      type: 'document-intelligence',
      displayName: 'OWL',
    } as unknown as IConnector;
    mockCapabilities = {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: true,
      tags: true,
      tagWriteBack: false,
      supportedTaskStatuses: ['todo', 'done', 'cancelled'],
      taskAbsenceMeansDeleted: false,
    };
    mockExistingTasks.push(makeExistingTask({
      connectorType: 'document-intelligence',
      connectorInstanceId: owlConnectorId,
      sourceId: 'owl-action-1',
      status: 'todo',
      lastSyncedAt: '2026-08-21T12:00:00Z',
    }));

    const result = await upsertTasks(
      owlConnectorId,
      owlConnector,
      [makeRemoteTask({
        connectorType: 'document-intelligence',
        connectorInstanceId: owlConnectorId,
        sourceId: 'owl-action-1',
        status: 'cancelled',
        updatedAt: '2026-08-21T10:00:00Z',
        metadata: {
          owlStatus: 'not_an_action',
          owlDisposition: 'not_an_action',
        },
      })],
      true,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      status: 'cancelled',
      metadata: expect.objectContaining({ owlDisposition: 'not_an_action' }),
    }));
    expect(detectDeletions).not.toHaveBeenCalled();
  });

  it('accepts a remote-mirror transition from in_progress back to todo', async () => {
    const customRestConnector = {
      ...mockConnector,
      type: 'custom-rest',
      displayName: 'Custom REST',
    } as unknown as IConnector;
    mockExistingTasks.push(makeExistingTask({
      connectorType: 'custom-rest',
      connectorInstanceId: 'custom-rest-read-only',
      sourceId: 'custom:42',
      status: 'in_progress',
      lastSyncedAt: '2026-07-25T08:00:00Z',
    }));

    const result = await upsertTasks(
      'custom-rest-read-only',
      customRestConnector,
      [makeRemoteTask({
        connectorType: 'custom-rest',
        connectorInstanceId: 'custom-rest-read-only',
        sourceId: 'custom:42',
        status: 'todo',
        updatedAt: '2026-07-25T10:00:00Z',
      })],
      false,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'todo' }),
    );
  });

  it('does NOT force-sync when statuses already match', async () => {
    mockExistingTasks.push(makeExistingTask({
      status: 'done',
      lastSyncedAt: '2026-07-25T12:00:00Z',
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'done',
        updatedAt: '2026-07-25T09:00:00Z', // Older, but status matches
      })],
      false,
      [],
    );

    expect(result.updated).toBe(0);
  });

  it('forces terminal sync even when task is pending_push', async () => {
    mockExistingTasks.push(makeExistingTask({
      status: 'in_progress',
      syncStatus: 'pending_push',
      lastSyncedAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-24T00:00:00Z',
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'done',
        updatedAt: '2026-07-23T00:00:00Z', // Older than local updatedAt
      })],
      false,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(
      expect.objectContaining({ status: 'done' }),
    );
  });

  it('does NOT overwrite pending_push task with non-terminal remote state (#1692)', async () => {
    // User changed priority locally (pending_push), sync pull should not revert it
    mockExistingTasks.push(makeExistingTask({
      status: 'in_progress',
      priority: 'high', // User just changed this
      syncStatus: 'pending_push',
      lastSyncedAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-25T14:00:00Z', // Very recent local edit
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'todo', // Non-terminal — should NOT overwrite
        priority: 'medium', // Old remote priority
        updatedAt: '2026-07-25T13:00:00Z', // Newer than lastSyncedAt but older than local edit
      })],
      false,
      [],
    );

    // Should skip the update entirely — local pending_push wins
    expect(result.updated).toBe(0);
    expect(mockUpdateSets).not.toContainEqual(
      expect.objectContaining({ priority: 'medium' }),
    );
  });

  it('merges remote recurrence metadata into an existing minimal task row', async () => {
    mockExistingTasks.push(makeExistingTask({
      status: 'todo',
      metadata: '{}',
      lastSyncedAt: '2026-07-20T00:00:00Z',
    }));

    await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'todo',
        updatedAt: '2026-07-25T13:00:00Z',
        metadata: { recurrence: 'daily', graphId: 'remote-1' },
      })],
      false,
      [],
    );

    expect(mockUpdateSets).toContainEqual(
      expect.objectContaining({
        metadata: { recurrence: 'daily', graphId: 'remote-1' },
      }),
    );
  });

  it('hydrates a legacy synthetic GitHub child into its canonical task row', async () => {
    mockExistingTasks.push(makeExistingTask({
      id: 'stable-child-id',
      sourceId: 'org/repo:42',
      title: 'Synthetic title',
      description: null,
      metadata: { issueNumber: 42, nodeId: 'I_42' },
      lastSyncedAt: '2026-07-25T12:00:00Z',
    }));

    const result = await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        id: 'new-temporary-id',
        title: 'Canonical title',
        description: 'Canonical body',
        updatedAt: '2026-07-25T10:00:00Z',
        metadata: {
          issueNumber: 42,
          nodeId: 'I_42',
          url: 'https://github.com/org/repo/issues/42',
          githubParent: null,
        },
      })],
      false,
      [],
    );

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      title: 'Canonical title',
      description: 'Canonical body',
      metadata: {
        issueNumber: 42,
        nodeId: 'I_42',
        url: 'https://github.com/org/repo/issues/42',
        githubParent: null,
      },
    }));
  });

  it('preserves GitHub hierarchy fields until reconciliation completes', async () => {
    mockExistingTasks.push(makeExistingTask({
      parentId: 'stable-parent',
      depth: 2,
      lastSyncedAt: '2026-07-20T00:00:00Z',
    }));

    await upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        updatedAt: '2026-07-25T13:00:00Z',
        depth: 0,
        metadata: {
          issueNumber: 42,
          githubParent: null,
        },
      })],
      false,
      [],
    );

    const update = mockUpdateSets.find((candidate) => (
      candidate && typeof candidate === 'object' && 'title' in candidate
    ));
    expect(update).not.toHaveProperty('parentId');
    expect(update).not.toHaveProperty('depth');
  });

  it('persists identity after a concurrent task insert is reconciled', async () => {
    const concurrentTask = makeExistingTask({
      id: 'concurrent-task',
      sourceId: 'org/repo:42',
      status: 'todo',
    });
    mockConcurrentInsertRecord = concurrentTask;
    const identityRuntime = {
      modeSnapshot: {
        connectorInstanceId: connectorId,
        effectiveMode: 'stable',
        modeRevision: 1,
        capturedAt: '2026-08-30T00:00:00.000Z',
      },
      syncKind: 'incremental',
      markNetworkPage: vi.fn(),
      markBlocked: vi.fn(),
      assertDecisionsCurrent: vi.fn(async () => {}),
      resolveLinkedSourceBatch: vi.fn(async () => []),
      resolveBatch: vi.fn(async () => [{
        candidateKey: 'org/repo:42',
        surface: 'task',
        appliedSource: 'stable',
        outcome: 'resolved',
        selectedLocalId: 'concurrent-task',
        selectedAction: 'update',
      }]),
    };

    await expect(upsertTasks(
      connectorId,
      mockConnector,
      [makeRemoteTask({
        status: 'todo',
        externalIdentity: {
          entity: {
            identity: {
              provider: 'github',
              hostKey: 'github.com',
              entityType: 'issue',
              stableId: 'I_42',
            },
            locator: {
              owner: 'org',
              repository: 'repo',
              issueNumber: 42,
            },
            observationSource: 'graphql',
            observedAt: '2026-08-30T00:00:00.000Z',
          },
        },
      })],
      false,
      [],
      undefined,
      identityRuntime as unknown as import(
        '@/lib/external-identities/stable-identity-runtime'
      ).GitHubStableIdentityRuntime,
    )).resolves.toMatchObject({ added: 0, updated: 1 });

    expect(mockIdentityWrites).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({
        localId: 'concurrent-task',
        legacyIdentity: 'org/repo:42',
      }),
    }));
  });
});
