/**
 * Tests that hydrateLastSyncResults correctly excludes write-through entries
 * from the sync baseline. Write-through entries (durationMs === 0) should not
 * advance the `since` parameter, otherwise issues closed between the last real
 * sync and the write-through time will be permanently missed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSyncLogRows: Array<{
  connectorId: string;
  syncedAt: string;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  notificationsAdded: number;
  success: boolean;
  durationMs: number | null;
}> = [];

vi.mock('@/db', () => {
  return {
    default: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              all: vi.fn(() => [...mockSyncLogRows]),
            })),
          })),
          orderBy: vi.fn(() => ({
            all: vi.fn(() => [...mockSyncLogRows]),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn() })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
      delete: vi.fn(() => ({ where: vi.fn() })),
    },
  };
});

vi.mock('@/db/schema', () => ({
  syncLog: { connectorId: 'connector_id', syncedAt: 'synced_at', success: 'success', durationMs: 'duration_ms' },
  notifications: {},
  notificationActions: {},
  connectorConfigs: { id: 'id', enabled: 'enabled', deletedAt: 'deleted_at' },
  sourceLists: {},
  hubProjects: {},
  taskProjects: {},
  tasks: {},
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
  connectorRegistry: { getConnector: vi.fn(), getAllConnectors: vi.fn(() => []) },
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
  upsertTasks: vi.fn(() => Promise.resolve({ added: 0, updated: 0, removed: 0, localOnlyProtected: 0, parentTasksAdded: 0, subtasksAdded: 0 })),
}));

vi.mock('@/lib/sync/list-manager', () => ({
  upsertSourceLists: vi.fn(),
  autoAssignFolderGroups: vi.fn(),
}));

vi.mock('@/lib/sync/search-indexer', () => ({
  indexAlertForSearch: vi.fn(),
  warmUpSearchAfterSync: vi.fn(() => Promise.resolve()),
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

// ─── Import after mocks ─────────────────────────────────────────────────────

import { SyncExecutionPipeline, SyncQueue } from '@/lib/sync';

describe('hydrateLastSyncResults write-through filtering', () => {
  beforeEach(() => {
    mockSyncLogRows.length = 0;
    vi.clearAllMocks();
  });

  it('excludes write-through entries (durationMs=0) from hydration baseline', async () => {
    // Write-through entry (most recent) — should be excluded
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T10:00:00Z',
      tasksAdded: 0,
      tasksUpdated: 1,
      tasksRemoved: 0,
      notificationsAdded: 0,
      success: true,
      durationMs: 0,
    });

    // Real sync entry (older) — should be the baseline
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T08:00:00Z',
      tasksAdded: 3,
      tasksUpdated: 2,
      tasksRemoved: 0,
      notificationsAdded: 0,
      success: true,
      durationMs: 4500,
    });

    const scheduler = new SyncExecutionPipeline();
    // Wait for hydration to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const result = scheduler.getLastResult('github-1');
    expect(result).toBeDefined();
    // Should use the real sync time (08:00), NOT the write-through time (10:00)
    expect(result!.syncedAt).toBe('2026-07-27T08:00:00Z');
  });

  it('uses real sync entry even when multiple write-throughs are more recent', async () => {
    // Multiple write-throughs
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T12:00:00Z',
      tasksAdded: 0, tasksUpdated: 1, tasksRemoved: 0, notificationsAdded: 0,
      success: true, durationMs: 0,
    });
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T11:00:00Z',
      tasksAdded: 0, tasksUpdated: 1, tasksRemoved: 0, notificationsAdded: 0,
      success: true, durationMs: 0,
    });
    // Real sync
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T06:00:00Z',
      tasksAdded: 5, tasksUpdated: 3, tasksRemoved: 0, notificationsAdded: 1,
      success: true, durationMs: 8200,
    });

    const scheduler = new SyncExecutionPipeline();
    await new Promise(resolve => setTimeout(resolve, 50));

    const result = scheduler.getLastResult('github-1');
    expect(result).toBeDefined();
    expect(result!.syncedAt).toBe('2026-07-27T06:00:00Z');
  });

  it('still uses failed sync entries appropriately (skips them)', async () => {
    // Failed sync (most recent real)
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T09:00:00Z',
      tasksAdded: 0, tasksUpdated: 0, tasksRemoved: 0, notificationsAdded: 0,
      success: false, durationMs: 1200,
    });
    // Successful real sync
    mockSyncLogRows.push({
      connectorId: 'github-1',
      syncedAt: '2026-07-27T07:00:00Z',
      tasksAdded: 2, tasksUpdated: 1, tasksRemoved: 0, notificationsAdded: 0,
      success: true, durationMs: 5000,
    });

    const scheduler = new SyncExecutionPipeline();
    await new Promise(resolve => setTimeout(resolve, 50));

    const result = scheduler.getLastResult('github-1');
    expect(result).toBeDefined();
    expect(result!.syncedAt).toBe('2026-07-27T07:00:00Z');
  });

  it('deduplicates sync requests already waiting in the queue', async () => {
    const queue = new SyncQueue(
      () => new Promise(() => undefined),
      () => false,
    );
    void queue.enqueueSync('active-connector');
    void queue.enqueueSync('github-1');
    queue.queueFollowUpSync('github-1');
    const duplicate = await queue.enqueueSync('github-1');

    expect(duplicate.errors).toEqual(['Sync already queued']);
    expect(Reflect.get(queue, 'queue')).toHaveLength(1);
    expect(Reflect.get(queue, 'queue')[0].options).toEqual({ full: true });
  });
});
