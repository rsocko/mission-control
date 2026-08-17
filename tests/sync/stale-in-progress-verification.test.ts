/**
 * Tests for the stale in_progress task verification phase.
 *
 * During incremental syncs, tasks closed on the remote before the `since`
 * cutoff are never returned by the API — creating a permanent stuck state.
 * This verification phase individually checks local `in_progress` tasks
 * that weren't in the pull results against the remote, correcting any
 * that are actually closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { TaskItem, ConnectorCapabilities } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSyncLogRows: unknown[] = [];
const mockInProgressTasks: Array<{ id: string; sourceId: string; status: string; completedAt: string | null }> = [];
const mockUpdateSets: Array<{ data: unknown; id: string }> = [];
let mockConnectorInstance: Partial<IConnector> | null = null;

vi.mock('@/db', () => {
  const updateWhereFn = vi.fn();
  const updateSetFn = vi.fn((data: unknown) => {
    mockUpdateSets.push({ data, id: '' });
    return { where: updateWhereFn };
  });
  const database = {
    select: vi.fn((fields?: unknown) => ({
      from: vi.fn(() => {
        // Return different data based on what's being queried
        return {
          where: vi.fn((condition: unknown) => {
            // For sync_log hydration
            if (!fields) {
              const rows = [] as unknown[] & {
                limit: ReturnType<typeof vi.fn>;
              };
              rows.limit = vi.fn(async () => mockConnectorInstance
                ? [{
                    id: mockConnectorInstance.id,
                    type: mockConnectorInstance.type,
                    name: mockConnectorInstance.displayName,
                    enabled: true,
                    syncMode: 'manual',
                    pollIntervalMinutes: null,
                    capabilities: JSON.stringify(mockConnectorInstance.capabilities ?? {}),
                    credentials: '{}',
                    settings: '{}',
                    syncedLists: '[]',
                  }]
                : []);
              return rows;
            }
            // Check if this is the in_progress task query
            if (Array.isArray(condition) && JSON.stringify(condition).includes('in_progress')) {
              return [...mockInProgressTasks];
            }
            return [];
          }),
          orderBy: vi.fn(() => ({
            all: vi.fn(() => [...mockSyncLogRows]),
          })),
          all: vi.fn(() => [...mockSyncLogRows]),
        };
      }),
    })),
    update: vi.fn(() => ({ set: updateSetFn })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
    transaction: vi.fn((callback: (transaction: object) => unknown) => callback({})),
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
  syncLog: { connectorId: 'connector_id', syncedAt: 'synced_at', success: 'success', durationMs: 'duration_ms' },
  notifications: {},
  notificationActions: {},
  connectorConfigs: { id: 'id', enabled: 'enabled', deletedAt: 'deleted_at' },
  sourceLists: { connectorInstanceId: 'connector_instance_id', sourceId: 'source_id', name: 'name', userDisplayName: 'user_display_name', type: 'type' },
  hubProjects: {},
  taskProjects: {},
  tasks: { id: 'id', sourceId: 'source_id', connectorInstanceId: 'connector_instance_id', status: 'status', completedAt: 'completed_at', syncStatus: 'sync_status', lastSyncedAt: 'last_synced_at', sourceListId: 'source_list_id' },
}));

vi.mock('@/lib/sync/github-hierarchy-reconciliation', () => ({
  readGitHubHierarchyObservation: () => ({ kind: 'not-issue' }),
  mergeGitHubHierarchyObservation: () => true,
  reconcileGitHubTaskHierarchy: vi.fn(async () => ({ applied: false, updated: 0 })),
}));

vi.mock('@/lib/sync/maintenance-lock', () => ({
  assertConnectorMaintenanceUnlocked: vi.fn(),
}));

vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
  runWithConnectorOperationLease: vi.fn(
    async (_id: string, _operation: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...a: unknown[]) => a),
  and: vi.fn((...a: unknown[]) => a),
  isNull: vi.fn((a: unknown) => a),
  inArray: vi.fn((...a: unknown[]) => a),
  like: vi.fn((...a: unknown[]) => a),
  desc: vi.fn((a: unknown) => a),
  sql: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) },
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn(() => mockConnectorInstance),
    getAllConnectors: vi.fn(() => []),
    replaceConnector: vi.fn(() => mockConnectorInstance),
  },
}));

vi.mock('@/lib/external-identities', () => ({
  GITHUB_IDENTITY_MODE: 'stable',
  GitHubStableIdentityRuntime: class {
    modeSnapshot = {
      connectorInstanceId: 'stale-verify',
      effectiveMode: 'stable',
      modeRevision: 1,
      capturedAt: '2026-07-27T00:00:00.000Z',
    };
    markNetworkPage() {}
    markBlocked() {}
    assertCurrentMode() {}
    assertDecisionsCurrent() {}
    hasResolvedStableLocalId() { return false; }
    resolveBatch() { return []; }
    resolveDeduplicatedBatch() { return []; }
    applyResolvedBatch() { return []; }
    resolveLinkedSourceBatch() { return []; }
    complete() {}
  },
  getGitHubIdentityModeSnapshot: vi.fn((connectorInstanceId: string) => ({
    connectorInstanceId,
    effectiveMode: 'stable',
    modeRevision: 1,
    capturedAt: '2026-07-27T00:00:00.000Z',
  })),
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/sync/events', () => ({
  syncEventBus: { emitSyncEvent: vi.fn() },
}));

vi.mock('@/lib/sync/push-manager', () => ({
  pushPendingChanges: vi.fn(() => Promise.resolve({ pushed: 0, errors: [] })),
}));

vi.mock('@/lib/sync/pull-manager', () => ({
  upsertTasks: vi.fn(async (_connectorId, _connector, pages) => {
    const remoteSourceIds = new Set<string>();
    for await (const page of pages) {
      for (const task of page) remoteSourceIds.add(task.sourceId);
    }
    return { added: 0, updated: 0, removed: 0, localOnlyProtected: 0, parentTasksAdded: 0, subtasksAdded: 0, remoteSourceIds };
  }),
}));

vi.mock('@/lib/sync/list-manager', () => ({
  upsertSourceLists: vi.fn(),
  autoAssignFolderGroups: vi.fn(),
}));

vi.mock('@/lib/sync/search-indexer', () => ({
  indexAlertForSearch: vi.fn(),
  warmUpSearchAfterSync: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/notifications', () => ({
  createNotificationsInTransaction: vi.fn(() => []),
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/lib/utils/source-list-display-name', () => ({
  resolveSourceListDisplayName: vi.fn((l: { name: string }) => l.name),
}));

vi.mock('@/lib/logger', () => ({
  syncLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  let counter = 0;
  return {
    ...actual,
    randomUUID: () => `uuid-${++counter}`,
  };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import { SyncExecutionPipeline } from '@/lib/sync';
import { syncLogger } from '@/lib/logger';

describe('stale in_progress verification', () => {
  beforeEach(() => {
    mockSyncLogRows.length = 0;
    mockInProgressTasks.length = 0;
    mockUpdateSets.length = 0;
    mockConnectorInstance = null;
    vi.clearAllMocks();
  });

  it('corrects an in_progress task when remote shows done', async () => {
    // Setup: a real sync happened, establishing a baseline
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T06:00:00Z',
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 0,
      success: true,
      durationMs: 3000,
    });

    // There's a stuck in_progress task
    mockInProgressTasks.push({
      id: 'task-850',
      sourceId: 'octo-org/ideation:850',
      status: 'in_progress',
      completedAt: null,
    });

    // Connector returns the issue as closed
    mockConnectorInstance = {
      id: 'github-1',
      type: 'github-issues',
      displayName: 'GitHub Issues',
      capabilities: { read: true, write: true, sync: true } as ConnectorCapabilities,
      fetchTasks: vi.fn(async function* () { yield []; }), // No tasks returned by incremental fetch
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue({
        sourceId: 'octo-org/ideation:850',
        status: 'done',
        completedAt: '2026-07-25T15:00:00Z',
      } as Partial<TaskItem>),
    };

    const scheduler = new SyncExecutionPipeline();
    await new Promise(resolve => setTimeout(resolve, 50)); // let hydration complete

    const result = await scheduler.runSyncLocally('github-1');

    expect(result.success, result.errors.join('; ')).toBe(true);
    expect(result.tasksUpdated).toBeGreaterThanOrEqual(1);

    // Verify updateTask was called for the stuck task
    expect(mockConnectorInstance.updateTask).toHaveBeenCalledWith('octo-org/ideation:850', {});

    // Verify the DB was updated with terminal status
    const terminalUpdate = mockUpdateSets.find(
      (u) => (u.data as Record<string, unknown>).status === 'done'
    );
    expect(terminalUpdate).toBeDefined();
    expect((terminalUpdate!.data as Record<string, unknown>).completedAt).toBe('2026-07-25T15:00:00Z');
    expect(syncLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'github-1',
        phase: 'stale-task-verification',
        durationMs: expect.any(Number),
        success: true,
      }),
      'Sync phase completed',
    );
  });

  it('does not modify in_progress tasks that are still open on remote', async () => {
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T06:00:00Z',
      tasksAdded: 0, tasksUpdated: 0, tasksRemoved: 0, notificationsAdded: 0,
      success: true, durationMs: 3000,
    });

    mockInProgressTasks.push({
      id: 'task-900',
      sourceId: 'octo-org/ideation:900',
      status: 'in_progress',
      completedAt: null,
    });

    mockConnectorInstance = {
      id: 'github-1',
      type: 'github-issues',
      displayName: 'GitHub Issues',
      capabilities: { read: true, write: true, sync: true } as ConnectorCapabilities,
      fetchTasks: vi.fn(async function* () { yield []; }),
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn().mockResolvedValue({
        sourceId: 'octo-org/ideation:900',
        status: 'todo', // Still open
      } as Partial<TaskItem>),
    };

    const scheduler = new SyncExecutionPipeline();
    await new Promise(resolve => setTimeout(resolve, 50));

    const result = await scheduler.runSyncLocally('github-1');

    expect(result.success, result.errors.join('; ')).toBe(true);
    // Should NOT have updated the task's status
    const statusUpdate = mockUpdateSets.find(
      (u) => (u.data as Record<string, unknown>).status === 'done' ||
             (u.data as Record<string, unknown>).status === 'cancelled'
    );
    expect(statusUpdate).toBeUndefined();
  });

  it('skips verification for tasks already included in pull results', async () => {
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T06:00:00Z',
      tasksAdded: 0, tasksUpdated: 0, tasksRemoved: 0, notificationsAdded: 0,
      success: true, durationMs: 3000,
    });

    mockInProgressTasks.push({
      id: 'task-851',
      sourceId: 'octo-org/ideation:851',
      status: 'in_progress',
      completedAt: null,
    });

    // The incremental fetch DOES include this task (it was recently updated)
    const fetchedTask: TaskItem = {
      id: 'remote-851',
      sourceId: 'octo-org/ideation:851',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Active issue',
      status: 'done',
      priority: 'medium',
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-27T07:00:00Z',
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'octo-org/ideation',
      sourceListName: 'octo-org/ideation',
      hubProjectIds: [],
      tags: [],
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: '2026-07-27T07:00:00Z',
    };

    mockConnectorInstance = {
      id: 'github-1',
      type: 'github-issues',
      displayName: 'GitHub Issues',
      capabilities: { read: true, write: true, sync: true } as ConnectorCapabilities,
      fetchTasks: vi.fn(async function* () { yield [fetchedTask]; }),
      fetchNotifications: vi.fn().mockResolvedValue([]),
      fetchSourceLists: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn(),
    };

    const scheduler = new SyncExecutionPipeline();
    await new Promise(resolve => setTimeout(resolve, 50));

    await scheduler.runSyncLocally('github-1');

    // updateTask should NOT be called for verification — task was already in pull results
    expect(mockConnectorInstance.updateTask).not.toHaveBeenCalled();
  });
});
