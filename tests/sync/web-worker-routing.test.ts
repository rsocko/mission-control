import { describe, expect, it, vi } from 'vitest';

const queueMocks = vi.hoisted(() => {
  const job = {
    id: 'job-1',
    connectorId: 'github-1',
    full: false,
    source: 'api',
    status: 'queued',
  };
  const result = {
    connectorId: 'github-1',
    success: true,
    tasksAdded: 1,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [],
    syncedAt: '2026-08-03T00:00:00.000Z',
  };
  return {
    job,
    result,
    enqueueSyncJob: vi.fn(() => job),
    registerSyncSchedule: vi.fn(),
    unregisterSyncSchedule: vi.fn(),
    isDurableSyncMode: vi.fn(() => true),
    waitForSyncJob: vi.fn(async () => result),
  };
});

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => ({ all: vi.fn(() => []) })),
      })),
    })),
  },
}));
vi.mock('@/db/schema', () => ({
  syncLog: {},
  notifications: {},
  notificationActions: {},
  connectorConfigs: {},
  sourceLists: {},
  hubProjects: {},
  taskProjects: {},
  tasks: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
  like: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) },
}));
vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn(() => {
      throw new Error('web process attempted local connector execution');
    }),
    getAllConnectors: vi.fn(() => []),
  },
}));
vi.mock('@/lib/public-demo', () => ({ isPublicDemoMode: vi.fn(() => false) }));
vi.mock('@/lib/events', () => ({ emitEvent: vi.fn() }));
vi.mock('@/lib/sync/events', () => ({
  syncEventBus: { emitSyncEvent: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  syncLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@/lib/utils/source-list-display-name', () => ({
  resolveSourceListDisplayName: vi.fn(),
}));
vi.mock('@/lib/sync/push-manager', () => ({ pushPendingChanges: vi.fn() }));
vi.mock('@/lib/sync/pull-manager', () => ({ upsertTasks: vi.fn() }));
vi.mock('@/lib/sync/task-dependency-manager', () => ({
  getResumableDependencyReconciliations: vi.fn(() => []),
  recordDependencyReconciliationResumeOutcome: vi.fn(),
  reconcileTaskDependencies: vi.fn(),
}));
vi.mock('@/lib/sync/maintenance-lock', () => ({
  assertConnectorMaintenanceUnlocked: vi.fn(),
}));
vi.mock('@/lib/sync/list-manager', () => ({
  upsertSourceLists: vi.fn(),
  autoAssignFolderGroups: vi.fn(),
}));
vi.mock('@/lib/sync/search-indexer', () => ({
  indexAlertForSearch: vi.fn(),
  warmUpSearchAfterSync: vi.fn(),
}));
vi.mock('@/lib/notifications/levels', () => ({
  normalizeNotificationLevel: vi.fn(),
}));
vi.mock('@/lib/notifications', () => ({
  createNotificationsInTransaction: vi.fn(),
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));
vi.mock('@/lib/sync/job-queue', () => ({
  countRemainingSyncJobs: vi.fn(() => 0),
  enqueueSyncJob: queueMocks.enqueueSyncJob,
  getActiveSyncJobConnectorIds: vi.fn(() => []),
  getLatestDurableSyncResult: vi.fn(),
  getSyncSchedules: vi.fn(() => []),
  getSyncDurationBudgetMs: vi.fn(() => 300_000),
  getSyncQueueMetrics: vi.fn(() => ({ queued: 0, running: 0 })),
  isDurableSyncMode: queueMocks.isDurableSyncMode,
  markSyncScheduleEnqueued: vi.fn(),
  registerSyncSchedule: queueMocks.registerSyncSchedule,
  unregisterSyncSchedule: queueMocks.unregisterSyncSchedule,
  waitForSyncJob: queueMocks.waitForSyncJob,
}));

describe('web sync routing in durable mode', () => {
  it('queues and waits for worker execution without loading a connector locally', async () => {
    const { SyncScheduler } = await import('@/lib/sync');
    const scheduler = new SyncScheduler();

    const result = await scheduler.requestSync('github-1', { source: 'api' });

    expect(queueMocks.enqueueSyncJob).toHaveBeenCalledWith('github-1', {
      full: undefined,
      source: 'api',
    });
    expect(queueMocks.waitForSyncJob).toHaveBeenCalledWith(
      queueMocks.job,
      { signal: undefined },
    );
    expect(result).toEqual(queueMocks.result);
  });

  it('keeps durable scheduling in the persisted schedule table', async () => {
    const { SyncScheduler } = await import('@/lib/sync');
    const scheduler = new SyncScheduler();

    scheduler.schedule({
      id: 'github-1',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 10,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
    });

    expect(queueMocks.registerSyncSchedule).toHaveBeenCalledWith('github-1', 10);
    expect(queueMocks.unregisterSyncSchedule).not.toHaveBeenCalled();
  });

  it('replaces and removes active cron jobs in inline mode', async () => {
    queueMocks.isDurableSyncMode.mockReturnValue(false);
    const cron = (await import('node-cron')).default;
    const { SyncScheduler } = await import('@/lib/sync');
    const scheduler = new SyncScheduler();
    const config = {
      id: 'github-inline',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'poll' as const,
      pollIntervalMinutes: 10,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
    };

    scheduler.schedule(config);
    const task = vi.mocked(cron.schedule).mock.results.at(-1)?.value;
    scheduler.schedule({ ...config, enabled: false });

    expect(task?.stop).toHaveBeenCalled();
    expect(queueMocks.unregisterSyncSchedule).toHaveBeenCalledWith('github-inline');
    queueMocks.isDurableSyncMode.mockReturnValue(true);
  });
});
