/**
 * Tests for bulk import detection during initial connector sync.
 *
 * When a connector syncs for the first time (no existing tasks in the DB),
 * all imported tasks should be flagged with isBulkImport = true so the
 * insights "created" metric excludes them from trend/KPI counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { TaskItem } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExistingTasks: unknown[] = [];
const mockConcurrentTasks: Array<Record<string, unknown>> = [];
const insertedValues: unknown[] = [];
const mockUpdateSets: unknown[] = [];
let selectCallCount = 0;

type AwaitableTagRows = unknown[] & {
  where: ReturnType<typeof vi.fn>;
  then: PromiseLike<unknown[]>['then'];
};

vi.mock('@/db', () => {
  const updateWhereFn = vi.fn();
  return {
    default: {
      select: vi.fn(() => {
        const callNum = ++selectCallCount;
        return {
          from: vi.fn(() => {
            if (callNum === 1) {
              return { where: vi.fn(() => [...mockExistingTasks]) };
            }
            if (callNum === 2) {
              return { where: vi.fn(() => []) };
            }
            if (callNum === 4) {
              return { where: vi.fn(() => [...mockConcurrentTasks]) };
            }
            const tagsResult = [] as unknown as AwaitableTagRows;
            tagsResult.where = vi.fn(() => []);
            tagsResult.then = (onFulfilled, onRejected) => Promise.resolve([] as unknown[]).then(onFulfilled, onRejected);
            return tagsResult;
          }),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn((data: unknown) => {
          mockUpdateSets.push(data);
          return { where: updateWhereFn };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((vals: unknown) => {
          const rows = Array.isArray(vals) ? vals : [vals];
          if (Array.isArray(vals)) {
            insertedValues.push(...vals);
          } else {
            insertedValues.push(vals);
          }
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(() => rows.filter((row) =>
                !mockConcurrentTasks.some(existing =>
                  existing.sourceId === (row as Record<string, unknown>).sourceId
                )
              )),
            })),
          };
        }),
      })),
      delete: vi.fn(() => ({ where: vi.fn() })),
    },
  };
});

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', sourceId: 'sourceId', connectorInstanceId: 'connectorInstanceId', status: 'status', depth: 'depth', syncStatus: 'syncStatus' },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId' },
  taskSchedules: { taskId: 'taskId' },
  myDayItems: { taskId: 'taskId' },
  myDayExclusions: { taskId: 'taskId' },
  focusItems: { taskId: 'taskId' },
  weeklyOneThing: { taskId: 'taskId' },
  prioritySyncLog: { taskId: 'taskId' },
  quickSortLog: { taskId: 'taskId' },
  quickSortOperations: { taskId: 'taskId' },
  taskLinkedSources: { taskId: 'taskId' },
  taskAttachments: { taskId: 'taskId' },
  projectPhaseItems: { taskId: 'taskId' },
  taskHistoryEvents: { taskId: 'taskId' },
  taskDependencies: { taskId: 'taskId', dependsOnTaskId: 'dependsOnTaskId' },
  notifications: { relatedTaskId: 'relatedTaskId' },
  syncDeletionSnapshots: {
    sourceId: 'sourceId',
    connectorId: 'connectorId',
    reason: 'reason',
  },
  tags: { id: 'id', slug: 'slug', type: 'type' },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(async () => null),
}));

vi.mock('@/lib/logger', () => ({
  syncLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/sync/events', () => ({
  syncEventBus: { emitSyncEvent: vi.fn() },
}));

vi.mock('@/lib/sync/search-indexer', () => ({
  indexTasksForSearchBatch: vi.fn(async () => {}),
}));

vi.mock('@/lib/sync/deletion-detector', () => ({
  detectDeletions: vi.fn(async () => ({ removed: 0, localOnlyProtected: 0 })),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    connectors: { get: vi.fn(async () => null) },
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
        updateTaskSourceId: vi.fn(async () => true),
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
          insertedValues.push(...candidates.map(({ task }) => task));
          const insertedIds = new Set<string>();
          const records = candidates.map(({ task }) => {
            const concurrent = mockConcurrentTasks.find(
              (existing) => existing.sourceId === task.sourceId,
            );
            if (concurrent) return concurrent;
            insertedIds.add(task.id as string);
            mockExistingTasks.push(task);
            return task;
          });
          return { insertedIds, records };
        }),
        findBySourceIds: vi.fn(async (_connectorId: string, sourceIds: string[]) =>
          mockConcurrentTasks.filter((task) => sourceIds.includes(task.sourceId as string))),
        applyRemoteUpdate: vi.fn(async (input: {
          taskId: string;
          values: Record<string, unknown>;
        }) => {
          mockUpdateSets.push(input.values);
          const task = [...mockExistingTasks, ...mockConcurrentTasks].find(
            (candidate) => (candidate as { id: string }).id === input.taskId,
          ) as Record<string, unknown> | undefined;
          if (task) Object.assign(task, input.values);
          return true;
        }),
        replaceSourceTags: vi.fn(async () => undefined),
        listChecklistItems: vi.fn(async () => []),
        correctParents: vi.fn(async () => undefined),
        listChildren: vi.fn(async () => []),
        listTasks: vi.fn(async () => [...mockExistingTasks]),
      },
    },
  })),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  like: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
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
import { indexTasksForSearchBatch } from '@/lib/sync/search-indexer';

describe('pull-manager bulk import detection', () => {
  const connectorId = 'test-conn-1';
  const mockConnector = {
    type: 'microsoft-todo',
    displayName: 'Microsoft To Do',
    fetchTasks: vi.fn(async function* () { yield []; }),
    fetchNotifications: vi.fn(),
    fetchSourceLists: vi.fn(),
  } as unknown as IConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistingTasks.length = 0;
    mockConcurrentTasks.length = 0;
    insertedValues.length = 0;
    mockUpdateSets.length = 0;
    selectCallCount = 0;
  });

  function makeRemoteTask(overrides: Partial<TaskItem> = {}): TaskItem {
    const task: TaskItem = {
      id: 'remote-1',
      sourceId: 'task-source-1',
      connectorType: 'microsoft-todo',
      connectorInstanceId: connectorId,
      title: 'Test task',
      description: undefined,
      status: 'todo',
      priority: 'none',
      dueDate: undefined,
      createdAt: '2026-07-14T10:00:00Z',
      updatedAt: '2026-07-14T10:00:00Z',
      completedAt: undefined,
      parentId: undefined,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'list-1',
      sourceListName: 'Tasks',
      hubProjectIds: [],
      assignee: undefined,
      metadata: {},
      tags: [],
      syncStatus: 'synced',
      lastSyncedAt: '2026-07-14T10:00:00Z',
    };
    return { ...task, ...overrides };
  }

  function makeExistingTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'existing-task-1',
      sourceId: 'task-source-existing',
      connectorType: 'microsoft-todo',
      connectorInstanceId: connectorId,
      title: 'Existing task',
      status: 'todo',
      createdAt: '2026-07-10T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
      lastSyncedAt: '2026-07-10T00:00:00Z',
      syncStatus: 'synced',
      ...overrides,
    };
  }

  it('flags tasks as bulk import on initial sync (no existing tasks)', async () => {
    // No existing tasks → initial sync
    const remoteTasks = [
      makeRemoteTask({ sourceId: 'task-1', id: 'r1' }),
      makeRemoteTask({ sourceId: 'task-2', id: 'r2', title: 'Another task' }),
    ];

    const result = await upsertTasks(connectorId, mockConnector, remoteTasks);

    expect(result.added).toBe(2);
    expect(insertedValues.length).toBe(2);
    for (const inserted of insertedValues) {
      expect((inserted as Record<string, unknown>).isBulkImport).toBe(true);
    }
  });

  it('does NOT flag tasks as bulk import on incremental sync', async () => {
    // Has existing tasks in same source list → incremental sync
    mockExistingTasks.push(makeExistingTask({ sourceListId: 'list-1' }));

    const remoteTasks = [
      makeRemoteTask({ sourceId: 'task-new-1', id: 'r1', sourceListId: 'list-1' }),
    ];

    const result = await upsertTasks(connectorId, mockConnector, remoteTasks);

    expect(result.added).toBe(1);
    expect(insertedValues.length).toBe(1);
    expect((insertedValues[0] as Record<string, unknown>).isBulkImport).toBe(false);
  });

  it('flags tasks as bulk import when a NEW source list is added to existing connector', async () => {
    // Connector has existing tasks in list-1, but list-2 is new
    mockExistingTasks.push(makeExistingTask({ sourceListId: 'list-1' }));

    const remoteTasks = [
      // Task from existing list → NOT bulk import
      makeRemoteTask({ sourceId: 'task-existing-list', id: 'r1', sourceListId: 'list-1' }),
      // Tasks from new list → bulk import
      makeRemoteTask({ sourceId: 'task-new-list-1', id: 'r2', sourceListId: 'list-2' }),
      makeRemoteTask({ sourceId: 'task-new-list-2', id: 'r3', sourceListId: 'list-2', title: 'Another new list task' }),
    ];

    const result = await upsertTasks(connectorId, mockConnector, remoteTasks);

    expect(result.added).toBe(3);
    expect(insertedValues.length).toBe(3);

    const bySourceId = new Map(
      insertedValues.map((v) => [(v as Record<string, unknown>).sourceId, v as Record<string, unknown>])
    );
    // Existing list task → not bulk
    expect(bySourceId.get('task-existing-list')?.isBulkImport).toBe(false);
    // New list tasks → bulk import
    expect(bySourceId.get('task-new-list-1')?.isBulkImport).toBe(true);
    expect(bySourceId.get('task-new-list-2')?.isBulkImport).toBe(true);
  });

  it('reconciles a row concurrently inserted by My Day without aborting the batch', async () => {
    mockExistingTasks.push(makeExistingTask({ sourceListId: 'list-1' }));
    mockConcurrentTasks.push(makeExistingTask({
      id: 'my-day-row',
      sourceId: 'task-race',
      sourceListId: 'list-1',
      metadata: '{}',
      lastSyncedAt: '2026-07-14T09:59:00Z',
    }));

    const result = await upsertTasks(connectorId, mockConnector, [
      makeRemoteTask({
        id: 'remote-race',
        sourceId: 'task-race',
        metadata: { recurrence: 'daily' },
      }),
      makeRemoteTask({
        id: 'remote-new',
        sourceId: 'task-new',
        title: 'Unrelated new task',
      }),
    ]);

    expect(result).toEqual(expect.objectContaining({ added: 1, updated: 1 }));
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      metadata: { recurrence: 'daily' },
    }));
  });

  it('hydrates an existing minimal My Day row even when its sync timestamp is newer', async () => {
    mockExistingTasks.push(makeExistingTask({
      id: 'my-day-row',
      sourceId: 'task-source-1',
      metadata: '{}',
      lastSyncedAt: '2026-07-14T11:00:00Z',
    }));

    const result = await upsertTasks(connectorId, mockConnector, [
      makeRemoteTask({
        updatedAt: '2026-07-14T10:00:00Z',
        metadata: { recurrence: 'daily', recurrenceIdentity: 'daily-pattern' },
      }),
    ]);

    expect(result.updated).toBe(1);
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      metadata: { recurrence: 'daily', recurrenceIdentity: 'daily-pattern' },
    }));
  });

  it('deduplicates across streamed pages while preserving parent and newest-version precedence', async () => {
    async function* pages() {
      yield [makeRemoteTask({
        id: 'top-level-version',
        sourceId: 'duplicate-task',
        title: 'Top-level newest',
        updatedAt: '2026-07-14T12:00:00Z',
      })];
      yield [
        makeRemoteTask({
          id: 'parent-version-old',
          sourceId: 'duplicate-task',
          title: 'Parent context older',
          parentId: 'parent-temp-id',
          updatedAt: '2026-07-14T10:00:00Z',
        }),
        makeRemoteTask({
          id: 'page-two-only',
          sourceId: 'page-two-only',
          title: 'Second page unique task',
        }),
      ];
      yield [makeRemoteTask({
        id: 'parent-version-new',
        sourceId: 'duplicate-task',
        title: 'Parent context newest',
        parentId: 'parent-temp-id',
        updatedAt: '2026-07-14T11:00:00Z',
      })];
    }

    const result = await upsertTasks(connectorId, mockConnector, pages(), true);

    expect(result).toEqual(expect.objectContaining({
      added: 2,
      updated: 0,
      parentTasksAdded: 1,
      subtasksAdded: 1,
    }));
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      title: 'Parent context newest',
      parentId: 'parent-temp-id',
    }));
    expect(result.remoteSourceIds).toEqual(new Set(['duplicate-task', 'page-two-only']));
    expect(detectDeletions).toHaveBeenCalledWith(
      connectorId,
      new Set(['duplicate-task', 'page-two-only']),
      true,
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({
        identityRuntime: undefined,
        inaccessibleSourceListIds: expect.any(Set),
      }),
    );
  });

  it('settles and closes a rejected prefetch when current-page processing fails', async () => {
    let generatorClosed = false;
    async function* pages() {
      try {
        yield [makeRemoteTask({ sourceId: 'first-page' })];
        throw new Error('prefetched page failed');
      } finally {
        generatorClosed = true;
      }
    }
    vi.mocked(indexTasksForSearchBatch).mockRejectedValueOnce(new Error('current page failed'));

    await expect(upsertTasks(connectorId, mockConnector, pages()))
      .rejects.toThrow('current page failed');
    expect(generatorClosed).toBe(true);
  });
});
