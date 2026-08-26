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
    enqueueSyncJob: vi.fn(() => Promise.resolve(job)),
    registerSyncSchedule: vi.fn(() => Promise.resolve()),
    unregisterSyncSchedule: vi.fn(() => Promise.resolve()),
    markSyncScheduleEnqueued: vi.fn(() => Promise.resolve()),
    isDurableSyncMode: vi.fn(() => true),
    waitForSyncJob: vi.fn(async () => result),
  };
});

vi.mock('@/db', () => ({
  sqlite: {
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
  },
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
  assertConnectorMaintenanceUnlockedAsync: vi.fn(() => Promise.resolve()),
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
  isDurableSyncMode: queueMocks.isDurableSyncMode,
  waitForSyncJob: queueMocks.waitForSyncJob,
  getSyncDurationBudgetMs: vi.fn(() => 300_000),
  getSyncJobRepository: () => Promise.resolve({
    enqueue: queueMocks.enqueueSyncJob,
    registerSchedule: queueMocks.registerSyncSchedule,
    unregisterSchedule: queueMocks.unregisterSyncSchedule,
    markScheduleEnqueued: queueMocks.markSyncScheduleEnqueued,
    getActiveConnectorIds: vi.fn(() => Promise.resolve([])),
    getSchedules: vi.fn(() => Promise.resolve([])),
    getMetrics: vi.fn(() => Promise.resolve({ queued: 0, running: 0 })),
    getLatestResult: vi.fn(() => Promise.resolve(undefined)),
  }),
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
    const { SyncCronScheduler } = await import('@/lib/sync');
    const scheduler = new SyncCronScheduler(
      vi.fn(),
      vi.fn(() => Promise.resolve(undefined)),
      vi.fn(() => Promise.resolve([])),
    );

    await scheduler.schedule({
      id: 'github-1',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 10,
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: false,
        tags: false,
        tagWriteBack: false,
      },
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
    const { SyncCronScheduler } = await import('@/lib/sync');
    const scheduler = new SyncCronScheduler(
      vi.fn(),
      vi.fn(() => Promise.resolve(undefined)),
      vi.fn(() => Promise.resolve([])),
    );
    const config = {
      id: 'github-inline',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'poll' as const,
      pollIntervalMinutes: 10,
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: {},
      settings: {},
      syncedLists: [],
    };

    await scheduler.schedule(config);
    const task = vi.mocked(cron.schedule).mock.results.at(-1)?.value;
    await scheduler.schedule({ ...config, enabled: false });

    expect(task?.stop).toHaveBeenCalled();
    expect(queueMocks.unregisterSyncSchedule).toHaveBeenCalledWith('github-inline');
    queueMocks.isDurableSyncMode.mockReturnValue(true);
  });
});
