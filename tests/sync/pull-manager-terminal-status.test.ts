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
import type { TaskItem } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExistingTasks: unknown[] = [];
const mockUpdateSets: unknown[] = [];
let selectCallCount = 0;

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
  return {
    default: {
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
    },
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
    selectCallCount = 0;
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
        metadata: JSON.stringify({ recurrence: 'daily', graphId: 'remote-1' }),
      }),
    );
  });

  it('hydrates a legacy synthetic GitHub child into its canonical task row', async () => {
    mockExistingTasks.push(makeExistingTask({
      id: 'stable-child-id',
      sourceId: 'org/repo:42',
      title: 'Synthetic title',
      description: null,
      metadata: JSON.stringify({ issueNumber: 42, nodeId: 'I_42' }),
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
      metadata: JSON.stringify({
        issueNumber: 42,
        nodeId: 'I_42',
        url: 'https://github.com/org/repo/issues/42',
        githubParent: null,
      }),
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
});
