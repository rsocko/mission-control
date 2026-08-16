import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConnector } from '@/lib/connectors';
import type { ConnectorConfig } from '@/types';

const mocks = vi.hoisted(() => ({
  cronSchedule: vi.fn(),
  getConnector: vi.fn(),
  getResumeCandidates: vi.fn(),
  reconcileDependencies: vi.fn(),
  recordResumeOutcome: vi.fn(),
  getDependencyHealth: vi.fn(),
  beginDependencyGeneration: vi.fn(),
  createTargetedCollection: vi.fn(),
  reconcileTargetedDependencies: vi.fn(),
  dependencyPollConfigs: [] as typeof persistedConfig[],
  replaceConnector: vi.fn(),
  runWithLease: vi.fn(),
  syncInfo: vi.fn(),
  syncWarn: vi.fn(),
  staleConnector: {
    fetchSourceLists: vi.fn(),
    fetchTasks: vi.fn(),
  },
  upsertSourceLists: vi.fn(),
  upsertTasks: vi.fn(),
  readHierarchyObservation: vi.fn((task: { sourceId: string }) => ({
    kind: 'complete',
    observation: { childSourceId: task.sourceId, parent: null },
  })),
  reconcileHierarchy: vi.fn(),
  identityMode: 'legacy' as 'legacy' | 'comparison',
  identityRuntime: {
    markNetworkPage: vi.fn(),
    markIneligible: vi.fn(),
    complete: vi.fn(),
  },
}));

const persistedConfig = {
  id: 'github-1',
  type: 'github-issues',
  name: 'GitHub',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: JSON.stringify({ read: true, sync: true, lists: true }),
  credentials: JSON.stringify({ token: 'test-token' }),
  settings: JSON.stringify({ repos: ['octo/existing', 'octo/new'] }),
  syncedLists: JSON.stringify(['octo/existing', 'octo/new']),
  deletedAt: null,
};

vi.mock('@/db', () => ({
  default: {
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if (
            selection
            && typeof selection === 'object'
            && Object.prototype.hasOwnProperty.call(selection, 'capabilities')
          ) {
            return Promise.resolve(mocks.dependencyPollConfigs);
          }
          return selection === undefined
            ? { limit: vi.fn(async () => [persistedConfig]) }
            : Promise.resolve([]);
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  },
  runTransaction: vi.fn((callback: (tx: unknown) => unknown) => callback({
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ run: vi.fn() })),
    })),
  })),
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: {
    id: 'id',
    type: 'type',
    enabled: 'enabled',
    capabilities: 'capabilities',
    deletedAt: 'deletedAt',
  },
  syncLog: {},
  notifications: {},
  notificationActions: {},
  sourceLists: {
    sourceId: 'sourceId',
    name: 'name',
    userDisplayName: 'userDisplayName',
    connectorInstanceId: 'connectorInstanceId',
    type: 'type',
  },
  hubProjects: {},
  taskProjects: {},
  tasks: {
    id: 'id',
    sourceId: 'sourceId',
    connectorInstanceId: 'connectorInstanceId',
    sourceListId: 'sourceListId',
  },
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: mocks.getConnector,
    replaceConnector: mocks.replaceConnector,
    getAllConnectors: vi.fn(() => []),
  },
}));

vi.mock('@/lib/sync/push-manager', () => ({
  pushPendingChanges: vi.fn(async () => ({ pushed: 0, errors: [] })),
}));
vi.mock('@/lib/sync/pull-manager', () => ({ upsertTasks: mocks.upsertTasks }));
vi.mock('@/lib/sync/list-manager', () => ({
  upsertSourceLists: mocks.upsertSourceLists,
  autoAssignFolderGroups: vi.fn(async () => undefined),
}));
vi.mock('@/lib/sync/task-dependency-manager', () => ({
  beginDependencySnapshotGeneration: mocks.beginDependencyGeneration,
  createTargetedDependencyCollection: mocks.createTargetedCollection,
  getDependencyReconciliationHealth: mocks.getDependencyHealth,
  getResumableDependencyReconciliations: mocks.getResumeCandidates,
  reconcileTargetedTaskDependencies: mocks.reconcileTargetedDependencies,
  reconcileTaskDependencies: mocks.reconcileDependencies,
  recordDependencyReconciliationResumeOutcome: mocks.recordResumeOutcome,
}));
vi.mock('@/lib/sync/github-hierarchy-reconciliation', () => ({
  mergeGitHubHierarchyObservation: vi.fn((
    observations: Map<string, unknown>,
    observation: { childSourceId: string },
  ) => {
    observations.set(observation.childSourceId, observation);
    return true;
  }),
  readGitHubHierarchyObservation: mocks.readHierarchyObservation,
  reconcileGitHubTaskHierarchy: mocks.reconcileHierarchy,
}));
vi.mock('@/lib/sync/search-indexer', () => ({
  indexAlertForSearch: vi.fn(),
  warmUpSearchAfterSync: vi.fn(async () => undefined),
}));
vi.mock('@/lib/rules', () => ({ evaluateRulesForTasks: vi.fn(async () => undefined) }));
vi.mock('@/lib/events', () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/sync/events', () => ({
  syncEventBus: { emitSyncEvent: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  syncLogger: {
    info: mocks.syncInfo,
    debug: vi.fn(),
    warn: mocks.syncWarn,
    error: vi.fn(),
  },
}));
vi.mock('@/lib/public-demo', () => ({ isPublicDemoMode: vi.fn(() => false) }));
vi.mock('@/lib/external-identities', () => ({
  GitHubIdentityComparisonRuntime: class {
    markNetworkPage = mocks.identityRuntime.markNetworkPage;
    markIneligible = mocks.identityRuntime.markIneligible;
    complete = mocks.identityRuntime.complete;
  },
  getGitHubIdentityModeSnapshot: vi.fn((connectorInstanceId: string) => ({
    connectorInstanceId,
    phase: 'shadow_write',
    effectiveMode: mocks.identityMode,
    stablePrimaryEnabled: false,
    modeRevision: 1,
    capturedAt: '2026-08-09T00:00:00.000Z',
  })),
}));
vi.mock('@/lib/notifications', () => ({
  createNotificationsInTransaction: vi.fn(async () => []),
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));
vi.mock('@/lib/sync/job-queue', () => ({
  countRemainingSyncJobs: vi.fn(() => 0),
  enqueueSyncJob: vi.fn(),
  getActiveSyncJobConnectorIds: vi.fn(() => []),
  getLatestDurableSyncResult: vi.fn(),
  getSyncSchedules: vi.fn(() => []),
  getSyncDurationBudgetMs: vi.fn(() => 300_000),
  getSyncQueueMetrics: vi.fn(() => ({})),
  isDurableSyncMode: vi.fn(() => false),
  markSyncScheduleEnqueued: vi.fn(),
  registerSyncSchedule: vi.fn(),
  unregisterSyncSchedule: vi.fn(),
  waitForSyncJob: vi.fn(),
}));
vi.mock('@/lib/sync/maintenance-lock', () => ({
  assertConnectorMaintenanceUnlocked: vi.fn(),
}));
vi.mock('@/lib/telemetry/operations', () => ({
  setQueuedExpensiveOperations: vi.fn(),
  withRuntimeOperation: vi.fn((_operation, callback: () => unknown) => callback()),
}));
vi.mock('@/lib/sync/connector-lock', () => {
  class ConnectorOperationBusyError extends Error {
    constructor(message = 'Another operation is already queued or in progress for this connector') {
      super(message);
      this.name = 'ConnectorOperationBusyError';
    }
  }
  return {
    ConnectorOperationBusyError,
    runWithConnectorOperationLease: (...args: unknown[]) => mocks.runWithLease(...args),
  };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => 'sync-log-1'),
  };
});
vi.mock('node-cron', () => ({
  default: {
    schedule: mocks.cronSchedule.mockImplementation(
      () => ({ start: vi.fn(), stop: vi.fn() }),
    ),
  },
}));

import { SyncExecutionPipeline } from '@/lib/sync';
import { ConnectorOperationBusyError } from '@/lib/sync/connector-lock';

function createScheduler(): SyncExecutionPipeline {
  const scheduler = Object.create(
    SyncExecutionPipeline.prototype,
  ) as SyncExecutionPipeline;
  Reflect.set(scheduler, 'jobs', new Map());
  Reflect.set(scheduler, 'hydratePromise', null);
  Reflect.set(scheduler, 'syncInProgress', new Set<string>());
  Reflect.set(scheduler, 'lastSyncResults', new Map());
  Reflect.set(scheduler, 'syncQueue', []);
  Reflect.set(scheduler, 'activeSyncCount', 0);
  Reflect.set(scheduler, 'nightlyFullSyncTask', null);
  Reflect.set(scheduler, 'dependencyReconciliationResumeTimer', null);
  Reflect.set(scheduler, 'dependencyReconciliationResumeRun', null);
  Reflect.set(scheduler, 'dependencyReconciliationResumeEnabled', false);
  Reflect.set(scheduler, 'dependencyReconciliationFollowUpRequested', false);
  Reflect.set(scheduler, 'dependencyRelationshipPollTimer', null);
  Reflect.set(scheduler, 'dependencyRelationshipPollRun', null);
  Reflect.set(scheduler, 'dependencyRelationshipPollEnabled', false);
  Reflect.set(scheduler, 'dependencyRelationshipPollAbortController', null);
  Reflect.set(scheduler, 'dependencyReconciliationRetryTimers', new Map());
  Reflect.set(scheduler, 'dependencyReconciliationBusyRetryCounts', new Map());
  Reflect.set(scheduler, 'watchdogTimer', null);
  return scheduler;
}

function resumeCandidate(
  connectorId: string,
  overrides: Partial<{
    generationId: string;
    status: 'running' | 'failed';
    processed: number;
    total: number;
    nextAttemptAt: string | null;
  }> = {},
) {
  return {
    connectorId,
    generationId: `${connectorId}-generation`,
    status: 'running' as const,
    processed: 0,
    total: 75,
    nextAttemptAt: null,
    ...overrides,
  };
}

function reconciliationResult(
  candidate: ReturnType<typeof resumeCandidate>,
  status: 'running' | 'failed' | 'partial' | 'completed',
  processed: number,
) {
  return {
    imported: 0,
    removed: 0,
    pushed: 0,
    failed: 0,
    snapshot: {
      generationId: candidate.generationId,
      status,
      processed,
      total: candidate.total,
      batchSize: 25,
      imported: 0,
      removed: 0,
      startedAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      completedAt: status === 'completed' || status === 'partial'
        ? '2026-08-09T00:01:00.000Z'
        : null,
      failureReason: status === 'partial' ? 'removals skipped' : null,
      nextAttemptAt: null,
      lastCompletedAt: status === 'completed'
        ? '2026-08-09T00:01:00.000Z'
        : null,
      lastResumeAttemptAt: null,
      lastResumeOutcome: null,
      lastResumeReason: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('connector settings refresh before sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identityMode = 'legacy';
    mocks.getConnector.mockReturnValue(mocks.staleConnector);
    mocks.getResumeCandidates.mockResolvedValue([]);
    mocks.recordResumeOutcome.mockResolvedValue(undefined);
    mocks.getDependencyHealth.mockResolvedValue(new Map());
    mocks.dependencyPollConfigs.length = 0;
    mocks.reconcileDependencies.mockResolvedValue({ failed: 0 });
    mocks.runWithLease.mockImplementation(
      async (_connectorId: string, _operationType: string, operation: () => unknown) =>
        operation(),
    );
    mocks.upsertTasks.mockImplementation(async (
      _connectorId: string,
      _connector: IConnector,
      pages: AsyncGenerator<unknown[]>,
    ) => {
      await Array.fromAsync(pages);
      return {
        added: 1,
        updated: 0,
        removed: 0,
        localOnlyProtected: 0,
        parentTasksAdded: 1,
        subtasksAdded: 0,
        remoteSourceIds: new Set<string>(),
      };
    });
  });

  it('uses persisted repository settings even when an instance is already cached', async () => {
    let refreshedConnector: IConnector | undefined;
    mocks.replaceConnector.mockImplementation(async (config: ConnectorConfig) => {
      const repos = (config.settings as { repos: string[] }).repos;
      refreshedConnector = {
        id: config.id,
        type: config.type,
        displayName: config.name,
        icon: 'github',
        capabilities: config.capabilities,
        initialize: vi.fn(),
        testConnection: vi.fn(),
        dispose: vi.fn(),
        fetchSourceLists: vi.fn(async () => repos.map((repo) => ({
          id: `${config.id}:repo:${repo}`,
          connectorInstanceId: config.id,
          sourceId: repo,
          name: repo,
          type: 'repo',
          taskCount: 1,
          lastSyncedAt: '2026-08-08T00:00:00.000Z',
        }))),
        fetchTasks: vi.fn(async function* () {
          yield repos.map((repo) => ({ sourceId: `${repo}:1` }));
        }),
        fetchNotifications: vi.fn(async () => []),
        getLastSyncToken: vi.fn(async () => null),
        syncDomainData: vi.fn(async () => ({
          itemsAdded: 0,
          itemsUpdated: 0,
          itemsRemoved: 0,
          notificationsAdded: 3,
        })),
      } as IConnector;
      return refreshedConnector;
    });

    const scheduler = createScheduler();
    Reflect.set(scheduler, 'upsertNotifications', vi.fn(async () => 2));
    Reflect.set(scheduler, 'reconcileStaleNotifications', vi.fn(async () => 0));

    const result = await scheduler.runSyncLocally('github-1', { full: true });

    expect(result.success).toBe(true);
    expect(result.notificationsAdded).toBe(5);
    expect(mocks.replaceConnector).toHaveBeenCalledWith(expect.objectContaining({
      settings: { repos: ['octo/existing', 'octo/new'] },
      syncedLists: ['octo/existing', 'octo/new'],
    }));
    expect(refreshedConnector?.fetchSourceLists).toHaveBeenCalledOnce();
    expect(refreshedConnector?.fetchTasks).toHaveBeenCalledOnce();
    expect(mocks.upsertSourceLists).toHaveBeenCalledWith(
      'github-1',
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'octo/new' }),
      ]),
      'shadow_write',
      undefined,
      expect.any(Set),
      true,
    );
    expect(mocks.staleConnector.fetchSourceLists).not.toHaveBeenCalled();
    expect(mocks.staleConnector.fetchTasks).not.toHaveBeenCalled();
  });
});

describe('dependency reconciliation resume scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnector.mockReturnValue(mocks.staleConnector);
    mocks.getResumeCandidates.mockResolvedValue([]);
    mocks.recordResumeOutcome.mockResolvedValue(undefined);
    mocks.runWithLease.mockImplementation(
      async (_connectorId: string, _operationType: string, operation: () => unknown) =>
        operation(),
    );
    delete process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS;
    delete process.env.MC_DEPENDENCY_RECONCILIATION_RESUME_MINUTES;
    delete process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS;
    delete process.env.MC_GITHUB_DEPENDENCY_POLL_INTERVAL_MINUTES;
    delete process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS;
    delete process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it('checks relationship poll due state at a bounded cadence without duplicate timers', async () => {
    vi.useFakeTimers();
    process.env.MC_GITHUB_DEPENDENCY_POLL_INTERVAL_MINUTES = '5';
    const scheduler = createScheduler();
    const poll = vi.spyOn(scheduler, 'pollDueDependencyRelationships');

    try {
      scheduler.startDependencyRelationshipPolling();
      scheduler.startDependencyRelationshipPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(poll).toHaveBeenCalledOnce();
      expect(poll).toHaveBeenLastCalledWith('startup');

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(poll).toHaveBeenLastCalledWith('recurring');

      await scheduler.stopAll();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally {
      poll.mockRestore();
      delete process.env.MC_GITHUB_DEPENDENCY_POLL_INTERVAL_MINUTES;
      vi.useRealTimers();
    }
  });

  it('collects a due relationship generation without upserting tasks and skips fresh or active state', async () => {
    const connectorId = 'github-due-poll';
    mocks.dependencyPollConfigs.push({
      ...persistedConfig,
      id: connectorId,
      capabilities: JSON.stringify({ dependencyRead: true }),
    });
    const writer = {
      stagePage: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    mocks.beginDependencyGeneration.mockResolvedValue(writer);
    const fetchTasks = vi.fn(async function* (_since, options) {
      await options.dependencyGeneration.stagePage({
        dependencies: [],
        completeBlockedSourceIds: [],
      }, 'graphql-bulk');
      await options.dependencyGeneration.complete('graphql-bulk');
      yield [{ sourceId: 'acme/app:1' }];
    });
    mocks.getConnector.mockReturnValue({
      id: connectorId,
      type: 'github-issues',
      displayName: 'GitHub',
      icon: 'github',
      dependencySnapshotStrategy: 'task-stream',
      capabilities: { dependencyRead: true },
      fetchTasks,
      getIdentityObservationState: () => [{
        sourceId: 'acme/app',
        state: 'complete',
      }],
      getHierarchyRepositoryAliases: () => [{
        sourceId: 'acme/app',
        canonicalSourceId: 'acme/app',
      }],
    });
    mocks.reconcileDependencies.mockResolvedValue({ imported: 0, removed: 0, pushed: 0, failed: 0 });
    const scheduler = createScheduler();

    await scheduler.pollDueDependencyRelationships('manual');

    expect(mocks.beginDependencyGeneration).toHaveBeenCalledWith(
      connectorId,
      expect.objectContaining({
        connectorInstanceId: connectorId,
        stablePrimaryEnabled: false,
      }),
    );
    expect(fetchTasks).toHaveBeenCalledWith(undefined, expect.objectContaining({
      dependencyGeneration: writer,
    }));
    expect(mocks.upsertTasks).not.toHaveBeenCalled();
    expect(mocks.reconcileHierarchy).toHaveBeenCalledWith(
      connectorId,
      new Map([[
        'acme/app:1',
        { childSourceId: 'acme/app:1', parent: null },
      ]]),
      new Set(['acme/app']),
      true,
      new Map([['acme/app', 'acme/app']]),
      { identityComparison: undefined },
    );
    expect(mocks.reconcileDependencies).toHaveBeenCalledWith(
      connectorId,
      expect.any(Object),
      { full: true, identityComparison: undefined },
    );

    mocks.getDependencyHealth.mockResolvedValue(new Map([[
      connectorId,
      {
        lastCompletedAt: new Date().toISOString(),
        collectionPhase: 'complete',
        reconciliationPhase: 'complete',
      },
    ]]));
    await scheduler.pollDueDependencyRelationships('manual');
    mocks.getDependencyHealth.mockResolvedValue(new Map([[
      connectorId,
      {
        lastCompletedAt: null,
        collectionPhase: 'collecting',
        reconciliationPhase: 'pending',
      },
    ]]));
    await scheduler.pollDueDependencyRelationships('manual');

    expect(mocks.beginDependencyGeneration).toHaveBeenCalledOnce();
  });

  it('cancels comparison evidence when a relationship generation is revision-fenced', async () => {
    const connectorId = 'github-fenced-poll';
    mocks.identityMode = 'comparison';
    mocks.dependencyPollConfigs.push({
      ...persistedConfig,
      id: connectorId,
      capabilities: JSON.stringify({ dependencyRead: true }),
    });
    mocks.beginDependencyGeneration.mockResolvedValue({
      stagePage: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    });
    mocks.getConnector.mockReturnValue({
      id: connectorId,
      type: 'github-issues',
      displayName: 'GitHub',
      icon: 'github',
      dependencySnapshotStrategy: 'task-stream',
      capabilities: { dependencyRead: true },
      fetchTasks: async function* (_since, options) {
        await options.dependencyGeneration.complete('graphql-bulk');
        yield [];
      },
      getIdentityObservationState: () => [{
        sourceId: 'acme/app',
        state: 'complete',
      }],
      getHierarchyRepositoryAliases: () => [{
        sourceId: 'acme/app',
        canonicalSourceId: 'acme/app',
      }],
    });
    mocks.reconcileDependencies.mockResolvedValue({
      imported: 0,
      removed: 0,
      pushed: 0,
      failed: 0,
      resumeSkippedReason: 'identity-context-changed',
    });

    await createScheduler().pollDueDependencyRelationships('manual');

    expect(mocks.identityRuntime.markIneligible)
      .toHaveBeenCalledWith('dependency_identity_context_changed');
    expect(mocks.identityRuntime.complete).toHaveBeenCalledWith(
      'cancelled',
      'dependency_identity_context_changed',
    );
    expect(mocks.identityRuntime.complete).not.toHaveBeenCalledWith('succeeded');
  });

  it('advances one bounded batch at startup and on each recurring cadence tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T18:22:45.000Z'));
    process.env.MC_DEPENDENCY_RECONCILIATION_RESUME_MINUTES = '1';
    const candidate = resumeCandidate('github-cadence');
    let processed = 0;
    mocks.getResumeCandidates.mockImplementation(async () =>
      processed < candidate.total
        ? [{ ...candidate, processed }]
        : []);
    mocks.reconcileDependencies.mockImplementation(async () => {
      processed += 25;
      return reconciliationResult(
        candidate,
        processed === candidate.total ? 'completed' : 'running',
        processed,
      );
    });
    const scheduler = createScheduler();

    try {
      scheduler.startDependencyReconciliationResume();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.reconcileDependencies).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.reconcileDependencies).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.reconcileDependencies).toHaveBeenCalledTimes(3);
      scheduler.startDependencyReconciliationResume();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(processed).toBe(75);
      expect(mocks.cronSchedule).not.toHaveBeenCalled();
      const tickLogs = mocks.syncInfo.mock.calls.filter(
        ([, message]) => message === 'Dependency reconciliation resume tick fired',
      );
      expect(tickLogs).toEqual([
        [{ trigger: 'recurring', intervalMinutes: 1 },
          'Dependency reconciliation resume tick fired'],
        [{ trigger: 'recurring', intervalMinutes: 1 },
          'Dependency reconciliation resume tick fired'],
        [{ trigger: 'recurring', intervalMinutes: 1 },
          'Dependency reconciliation resume tick fired'],
      ]);
      expect(mocks.getResumeCandidates).toHaveBeenCalledTimes(4);
      expect(mocks.recordResumeOutcome).toHaveBeenCalledTimes(3);
      expect(mocks.recordResumeOutcome.mock.calls.map((call) => call.slice(0, 3)))
        .toEqual([
          [candidate.generationId, 'advanced', 'batch-advanced'],
          [candidate.generationId, 'advanced', 'batch-advanced'],
          [candidate.generationId, 'advanced', 'snapshot-completed'],
        ]);
    } finally {
      await scheduler.stopAll();
      delete process.env.MC_DEPENDENCY_RECONCILIATION_RESUME_MINUTES;
      vi.useRealTimers();
    }
  });

  it('records a cadence-aligned in-memory sync deferral and retries after it clears', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS = '10';
    const candidate = resumeCandidate('github-busy');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    mocks.reconcileDependencies.mockResolvedValue(
      reconciliationResult(candidate, 'running', 25),
    );
    const scheduler = createScheduler();
    const busy = new Set([candidate.connectorId]);
    Reflect.set(scheduler, 'syncInProgress', busy);

    scheduler.startDependencyReconciliationResume();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recordResumeOutcome).toHaveBeenCalledWith(
      candidate.generationId,
      'deferred',
      'connector-busy',
      expect.any(String),
    );
    expect(mocks.reconcileDependencies).not.toHaveBeenCalled();

    busy.clear();
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.reconcileDependencies).toHaveBeenCalledOnce();
    expect(mocks.recordResumeOutcome).toHaveBeenLastCalledWith(
      candidate.generationId,
      'advanced',
      'batch-advanced',
      expect.any(String),
    );
    vi.useRealTimers();
  });

  it('defers a durable worker lease collision and retries without overlap', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS = '10';
    const candidate = resumeCandidate('github-durable-busy');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    mocks.runWithLease
      .mockRejectedValueOnce(new ConnectorOperationBusyError())
      .mockImplementationOnce(
        async (_connectorId: string, _operationType: string, operation: () => unknown) =>
          operation(),
      );
    mocks.reconcileDependencies.mockResolvedValue(
      reconciliationResult(candidate, 'running', 25),
    );
    const scheduler = createScheduler();

    scheduler.startDependencyReconciliationResume();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.runWithLease).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileDependencies).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('bounds busy retries until the next recurring cadence', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS = '10';
    const candidate = resumeCandidate('github-always-busy');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    const scheduler = createScheduler();
    Reflect.set(scheduler, 'syncInProgress', new Set([candidate.connectorId]));

    scheduler.startDependencyReconciliationResume();
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.recordResumeOutcome).toHaveBeenCalledTimes(4);
    expect(mocks.reconcileDependencies).not.toHaveBeenCalled();
    expect(Reflect.get(scheduler, 'dependencyReconciliationRetryTimers')).toHaveProperty(
      'size',
      0,
    );
    vi.useRealTimers();
  });

  it('coalesces an overlapping recurring tick into a follow-up run', async () => {
    const candidate = resumeCandidate('github-overlap');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    let releaseFirst: (() => void) | undefined;
    const firstBatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.reconcileDependencies
      .mockImplementationOnce(async () => {
        await firstBatch;
        return reconciliationResult(candidate, 'running', 25);
      })
      .mockResolvedValueOnce(reconciliationResult(candidate, 'running', 50));
    const scheduler = createScheduler();
    Reflect.set(scheduler, 'dependencyReconciliationResumeEnabled', true);

    const firstRun = scheduler.resumeDependencyReconciliations('recurring');
    await vi.waitFor(() => expect(mocks.reconcileDependencies).toHaveBeenCalledOnce());
    await scheduler.resumeDependencyReconciliations('recurring');
    releaseFirst?.();
    await firstRun;
    await vi.waitFor(() => expect(mocks.reconcileDependencies).toHaveBeenCalledTimes(2));

    expect(mocks.getResumeCandidates).toHaveBeenCalledTimes(2);
  });

  it('records no-active, backoff, unavailable, terminal, and isolated failure outcomes', async () => {
    const backoff = resumeCandidate('github-backoff', {
      status: 'failed',
      nextAttemptAt: '2999-01-01T00:00:00.000Z',
    });
    const unavailable = resumeCandidate('github-unavailable');
    const partial = resumeCandidate('github-partial', { total: 25 });
    const completed = resumeCandidate('github-completed', { total: 25 });
    const stale = resumeCandidate('github-stale');
    const failed = resumeCandidate('github-failed');
    mocks.getResumeCandidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        backoff,
        unavailable,
        partial,
        completed,
        stale,
        failed,
      ]);
    mocks.getConnector.mockImplementation((connectorId: string) =>
      connectorId === unavailable.connectorId ? undefined : mocks.staleConnector);
    mocks.reconcileDependencies.mockImplementation(async (connectorId: string) => {
      if (connectorId === partial.connectorId) {
        return reconciliationResult(partial, 'partial', 25);
      }
      if (connectorId === completed.connectorId) {
        return reconciliationResult(completed, 'completed', 25);
      }
      if (connectorId === stale.connectorId) {
        return {
          imported: 0,
          removed: 0,
          pushed: 0,
          failed: 0,
          resumeSkippedReason: 'snapshot-no-longer-active',
        };
      }
      if (connectorId === failed.connectorId) throw new Error('bounded failure');
      throw new Error(`Unexpected reconciliation for ${connectorId}`);
    });
    const scheduler = createScheduler();
    vi.spyOn(scheduler, 'initializeConnectorFromDb').mockResolvedValue(null);

    await scheduler.resumeDependencyReconciliations('recurring');
    await scheduler.resumeDependencyReconciliations('recurring');

    expect(mocks.recordResumeOutcome.mock.calls.map((call) => call.slice(0, 3)))
      .toEqual([
        [backoff.generationId, 'deferred', 'retry-backoff'],
        [unavailable.generationId, 'deferred', 'connector-unavailable'],
        [partial.generationId, 'advanced', 'snapshot-partial'],
        [completed.generationId, 'advanced', 'snapshot-completed'],
        [stale.generationId, 'deferred', 'snapshot-no-longer-active'],
        [failed.generationId, 'failed', 'batch-failed'],
      ]);
    expect(mocks.reconcileDependencies).toHaveBeenCalledTimes(4);
  });

  it('stops the cadence timer and pending retries without creating duplicates', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS = '10';
    process.env.MC_DEPENDENCY_RECONCILIATION_RESUME_MINUTES = '1';
    const candidate = resumeCandidate('github-shutdown');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    const scheduler = createScheduler();
    Reflect.set(scheduler, 'syncInProgress', new Set([candidate.connectorId]));

    scheduler.startDependencyReconciliationResume();
    scheduler.startDependencyReconciliationResume();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stopAll();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.cronSchedule).not.toHaveBeenCalled();
    expect(mocks.reconcileDependencies).not.toHaveBeenCalled();
    expect(mocks.syncInfo.mock.calls).not.toContainEqual([
      { trigger: 'recurring', intervalMinutes: 1 },
      'Dependency reconciliation resume tick fired',
    ]);
    expect(Reflect.get(scheduler, 'dependencyReconciliationResumeTimer')).toBeNull();
    expect(Reflect.get(scheduler, 'dependencyReconciliationRetryTimers')).toHaveProperty(
      'size',
      0,
    );
    vi.useRealTimers();
  });

  it('drains an active resume batch during shutdown', async () => {
    const candidate = resumeCandidate('github-drain');
    mocks.getResumeCandidates.mockResolvedValue([candidate]);
    let releaseBatch: (() => void) | undefined;
    const batch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    mocks.reconcileDependencies.mockImplementation(async () => {
      await batch;
      return reconciliationResult(candidate, 'running', 25);
    });
    const scheduler = createScheduler();

    const activeRun = scheduler.resumeDependencyReconciliations('manual');
    await vi.waitFor(() => expect(mocks.reconcileDependencies).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = scheduler.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseBatch?.();
    await Promise.all([activeRun, stopping]);
    expect(stopped).toBe(true);
  });

  it('drains an active dependency relationship poll during shutdown', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    let releasePoll: (() => void) | undefined;
    const poll = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const executePoll = vi.fn(async () => poll);
    Reflect.set(scheduler, 'executeDueDependencyRelationshipPolls', executePoll);

    try {
      const activeRun = scheduler.pollDueDependencyRelationships('manual');
      await vi.waitFor(() => expect(executePoll).toHaveBeenCalledOnce());
      let stopped = false;
      const stopping = scheduler.stopAll().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      releasePoll?.();
      await Promise.all([activeRun, stopping]);

      expect(stopped).toBe(true);
      expect(mocks.syncWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Dependency relationship poll did not drain before shutdown timeout',
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releasePoll?.();
      vi.useRealTimers();
    }
  });

  it('bounds shutdown when an active dependency relationship poll is stuck', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS = '10';
    const scheduler = createScheduler();
    let releasePoll: (() => void) | undefined;
    const poll = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const executePoll = vi.fn(async () => poll);
    Reflect.set(scheduler, 'executeDueDependencyRelationshipPolls', executePoll);

    try {
      const activeRun = scheduler.pollDueDependencyRelationships('manual');
      await vi.waitFor(() => expect(executePoll).toHaveBeenCalledOnce());
      let stopped = false;
      const stopping = scheduler.stopAll().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(stopped).toBe(true);
      expect(mocks.syncWarn).toHaveBeenCalledWith(
        { timeoutMs: 10 },
        'Dependency relationship poll did not drain before shutdown timeout',
      );
      expect(vi.getTimerCount()).toBe(0);

      releasePoll?.();
      await activeRun;
    } finally {
      releasePoll?.();
      delete process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS;
      vi.useRealTimers();
    }
  });

  it('bounds concurrent stuck dependency runs with one shared configured budget', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS = '10';
    process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS = '20';
    const scheduler = createScheduler();
    Reflect.set(scheduler, 'dependencyReconciliationResumeRun', new Promise<void>(() => undefined));
    Reflect.set(scheduler, 'dependencyRelationshipPollRun', new Promise<void>(() => undefined));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      const stopping = scheduler.stopAll();
      await Promise.resolve();
      const deadlineCalls = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 20);
      expect(deadlineCalls).toHaveLength(1);
      const deadlineCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 20);
      const deadline = setTimeoutSpy.mock.results[deadlineCallIndex]?.value as NodeJS.Timeout;
      expect(deadline.hasRef()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(19);
      expect(mocks.syncWarn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(mocks.syncWarn).toHaveBeenCalledWith(
        { timeoutMs: 20 },
        'Dependency reconciliation resume did not drain before shutdown timeout',
      );
      expect(mocks.syncWarn).toHaveBeenCalledWith(
        { timeoutMs: 20 },
        'Dependency relationship poll did not drain before shutdown timeout',
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears the shared deadline when both dependency runs complete within budget', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS = '10';
    process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS = '20';
    const scheduler = createScheduler();
    const resume = deferred<void>();
    const poll = deferred<void>();
    Reflect.set(scheduler, 'dependencyReconciliationResumeRun', resume.promise);
    Reflect.set(scheduler, 'dependencyRelationshipPollRun', poll.promise);

    try {
      const stopping = scheduler.stopAll();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);

      resume.resolve();
      poll.resolve();
      await stopping;

      expect(mocks.syncWarn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a run rejection only after its active peer reaches the shared deadline', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS = '10';
    process.env.MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS = '10';
    const scheduler = createScheduler();
    const resume = deferred<void>();
    const resumeError = new Error('resume failed');
    Reflect.set(scheduler, 'dependencyReconciliationResumeRun', resume.promise);
    Reflect.set(scheduler, 'dependencyRelationshipPollRun', new Promise<void>(() => undefined));

    try {
      const stopping = scheduler.stopAll();
      const rejection = expect(stopping).rejects.toBe(resumeError);
      let stopped = false;
      void stopping.finally(() => {
        stopped = true;
      }).catch(() => undefined);

      resume.reject(resumeError);
      await vi.advanceTimersByTimeAsync(9);
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;

      expect(mocks.syncWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Dependency reconciliation resume did not drain before shutdown timeout',
      );
      expect(mocks.syncWarn).toHaveBeenCalledWith(
        { timeoutMs: 10 },
        'Dependency relationship poll did not drain before shutdown timeout',
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the first run rejection after both dependency runs settle', async () => {
    vi.useFakeTimers();
    process.env.MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS = '20';
    const scheduler = createScheduler();
    const resume = deferred<void>();
    const poll = deferred<void>();
    const pollError = new Error('poll failed first');
    const resumeError = new Error('resume failed second');
    Reflect.set(scheduler, 'dependencyReconciliationResumeRun', resume.promise);
    Reflect.set(scheduler, 'dependencyRelationshipPollRun', poll.promise);

    try {
      const stopping = scheduler.stopAll();
      const rejection = expect(stopping).rejects.toBe(pollError);
      let stopped = false;
      void stopping.finally(() => {
        stopped = true;
      }).catch(() => undefined);

      poll.reject(pollError);
      await Promise.resolve();
      expect(stopped).toBe(false);
      resume.reject(resumeError);
      await rejection;

      expect(mocks.syncWarn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
