import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves that every backend-selected sync/lease/search facade actually
 * switches to the PostgreSQL contract under `MC_DATABASE_BACKEND=postgres`
 * — and, just as importantly, never touches the SQLite compatibility layer
 * while doing so. `@/db`'s `sqlite` export is mocked to throw on any access,
 * so any code path that still reached into SQLite would fail this test
 * immediately instead of silently working "by accident".
 */

const sqliteTouch = vi.fn();

vi.mock('@/db', () => ({
  get sqlite() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  get db() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
}));

const postgresMocks = vi.hoisted(() => ({
  syncJobRepository: {
    enqueue: vi.fn(async (connectorId: string) => ({
      id: 'pg-job-1',
      connectorId,
      full: false,
      source: 'api',
      status: 'queued',
    })),
    getScheduleHealth: vi.fn(async () => []),
    countQueued: vi.fn(async () => 1),
    getMetrics: vi.fn(async () => ({
      queued: 1,
      running: 0,
      retrying: 0,
      cancelled: 0,
      oldestQueuedAgeMs: 0,
      missedSchedules: 0,
      oldestScheduleOverdueMs: 0,
      overBudget: 0,
      expiredLeases: 0,
    })),
    getLatestResult: vi.fn(async () => undefined),
    getActiveConnectorIds: vi.fn(async () => ['pg-connector']),
    claimNext: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    get: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    enqueueDueSchedules: vi.fn(async () => []),
    registerSchedule: vi.fn(async () => undefined),
    unregisterSchedule: vi.fn(async () => undefined),
    markScheduleEnqueued: vi.fn(async () => undefined),
    getSchedules: vi.fn(async () => []),
    complete: vi.fn(async () => undefined),
    finalizeSuccess: vi.fn(async () => undefined),
    fail: vi.fn(async () => 'failed'),
    linkSyncLog: vi.fn(async () => undefined),
    persistEvent: vi.fn(async () => undefined),
    getEventsAfter: vi.fn(async () => []),
    getLatestEventId: vi.fn(async () => 0),
    prune: vi.fn(async () => undefined),
    isCancellationRequested: vi.fn(async () => false),
    renewLease: vi.fn(async () => true),
    release: vi.fn(async () => true),
    requestCancellation: vi.fn(async () => ({ cancelled: 0, cancellationRequested: 0 })),
  },
  leaseRepository: {
    hasActiveSyncJobLease: vi.fn(async () => true),
    acquire: vi.fn(async () => ({ status: 'acquired' as const, expiresAt: '2026-01-01T00:00:00.000Z' })),
    renew: vi.fn(async () => ({ status: 'renewed' as const, expiresAt: '2026-01-01T00:01:00.000Z' })),
    release: vi.fn(async () => ({ status: 'released' as const })),
    recoverExpiredJobs: vi.fn(async () => ({ exhausted: 0, superseded: 0, requeued: 0 })),
  },
  searchRepository: {
    rebuild: vi.fn(async () => undefined),
    indexTask: vi.fn(async () => undefined),
    removeTask: vi.fn(async () => undefined),
    indexNotification: vi.fn(async () => undefined),
    removeNotification: vi.fn(async () => undefined),
    warmUp: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
  },
  controlStateRepository: {
    isQuarantined: vi.fn(async () => false),
    assertEnqueueAllowed: vi.fn(async () => undefined),
  },
  maintenanceLockRepository: {
    get: vi.fn(async () => null),
    assertUnlocked: vi.fn(async () => undefined),
  },
  operatorControlRepository: {
    getStatus: vi.fn(async () => ({
      connector: {
        id: 'pg-connector',
        enabled: true,
        configurationState: { status: 'configured' as const, code: null },
      },
      scheduler: {
        state: 'scheduled' as const,
        quarantineId: null,
        quarantinedAt: null,
        releasedAt: null,
        queued: 0,
        running: 0,
      },
      gates: {
        shadowIngestEnabled: true,
        immediateNotificationsEnabled: false,
        monthlyDigestEnabled: false,
        deliveryEnabled: false,
        presentationEnabled: false,
        actionsEnabled: false,
      },
      canary: { status: 'not-started' as const, jobId: null, counts: null, resultCode: null },
      readiness: { ready: false, blockers: ['sync_quarantine_required' as const] },
    })),
    quarantine: vi.fn(async () => ({
      status: 'quarantined' as const,
      quarantineId: 'pg-quarantine',
      cancelledQueuedCount: 0,
      replayed: false,
    })),
    enqueueCanary: vi.fn(),
    release: vi.fn(),
    rollback: vi.fn(),
  },
  publishSemanticEntityUpsert: vi.fn(async () => ({ status: 'published' as const })),
  publishSemanticEntityDelete: vi.fn(async () => ({ status: 'published' as const })),
  workerRepositories: {
    notificationEntityLinking: {
      findTaskBySourceReference: vi.fn(async () => null),
      findProjectByRepository: vi.fn(async () => null),
    },
    connectors: {
      get: vi.fn(async () => null),
      mergeSettings: vi.fn(async (
        _id: string,
        settings: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => ({ ...settings, ...patch })),
      patchSettingsState: vi.fn(async (
        _id: string,
        key: string,
        patch: Record<string, unknown>,
      ) => ({
        settings: { [key]: patch },
        state: patch,
      })),
    },
    syncRuns: {
      listLatestSuccessfulPulls: vi.fn(async () => []),
      append: vi.fn(async () => undefined),
    },
    execution: {
      support: {
        allowsLegacyWorkflow: vi.fn(() => false),
        assertConfigSupported: vi.fn((config: { type: string }) => {
          if (config.type === 'github-issues') throw new Error('unsupported GitHub identity state');
        }),
        assertConnectorSupported: vi.fn((connector: { type: string; syncDomainData?: unknown }) => {
          if (connector.type === 'github-issues' || connector.syncDomainData) {
            throw new Error('unsupported connector execution');
          }
        }),
      },
      pushes: {
        listCandidates: vi.fn(async () => []),
      },
    },
  },
  isConnectorSyncQuarantinedInPostgres: vi.fn(async () => false),
  assertConnectorSyncEnqueueAllowedInPostgres: vi.fn(async () => undefined),
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

vi.mock('@/db/runtime', () => ({
  getPostgresSyncJobRepository: () => postgresMocks.syncJobRepository,
  getPostgresConnectorOperationLeaseRepository: () => postgresMocks.leaseRepository,
  getPostgresKeywordSearchRepository: () => postgresMocks.searchRepository,
  getPostgresPersistenceBackend: () => ({ context: { pool: postgresMocks.pool } }),
}));

vi.mock('@/db/postgres/sync/job-repository', () => ({
  isConnectorSyncQuarantinedInPostgres: postgresMocks.isConnectorSyncQuarantinedInPostgres,
  assertConnectorSyncEnqueueAllowedInPostgres: postgresMocks.assertConnectorSyncEnqueueAllowedInPostgres,
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => postgresMocks.workerRepositories,
}));

vi.mock('@/lib/search/keyword-runtime', () => ({
  getKeywordSearchRepository: () => postgresMocks.searchRepository,
}));

vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: postgresMocks.publishSemanticEntityDelete,
  publishSemanticEntityUpsert: postgresMocks.publishSemanticEntityUpsert,
}));

const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.MC_DATABASE_BACKEND = 'postgres';
  vi.resetModules();
  const [
    { registerSyncJobRepository },
    { registerConnectorOperationLeaseRepository },
    { registerSyncControlStateRepository },
    { registerConnectorMaintenanceLockRepository },
    { registerSyncOperatorControlRepository },
  ] = await Promise.all([
    import('@/lib/sync/job-runtime'),
    import('@/lib/sync/connector-lock-runtime'),
    import('@/lib/sync/control-state'),
    import('@/lib/sync/maintenance-lock'),
    import('@/lib/sync/operator-control'),
  ]);
  registerSyncJobRepository(postgresMocks.syncJobRepository as never);
  registerConnectorOperationLeaseRepository(postgresMocks.leaseRepository);
  registerSyncControlStateRepository(postgresMocks.controlStateRepository);
  registerConnectorMaintenanceLockRepository(postgresMocks.maintenanceLockRepository);
  registerSyncOperatorControlRepository(postgresMocks.operatorControlRepository);
});

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
});

describe('PostgreSQL backend selection — sync job queue', () => {
  it('getSyncJobRepository resolves to the PostgreSQL adapter without touching SQLite', async () => {
    const { getSyncJobRepository } = await import('@/lib/sync/job-runtime');
    const repository = await getSyncJobRepository();
    expect(repository).toBe(postgresMocks.syncJobRepository);

    const job = await repository.enqueue('pg-connector', { source: 'api' });
    expect(postgresMocks.syncJobRepository.enqueue).toHaveBeenCalledWith('pg-connector', { source: 'api' });
    expect(job.connectorId).toBe('pg-connector');
    await expect(repository.countQueued()).resolves.toBe(1);
    expect(postgresMocks.syncJobRepository.countQueued).toHaveBeenCalledOnce();
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  describe('PostgreSQL backend selection — worker persistence', () => {
    it('connector settings use the selected worker composition without touching SQLite', async () => {
      const {
        mergeConnectorSettings,
        patchConnectorSettingsState,
      } = await import('@/lib/connectors/shared/connector-config-store');

      await expect(mergeConnectorSettings(
        'pg-connector',
        { retained: true },
        { authenticatedUser: 'octocat' },
      )).resolves.toEqual({ retained: true, authenticatedUser: 'octocat' });
      await expect(patchConnectorSettingsState(
        'pg-connector',
        'checkpoint',
        { cursor: 'page-1' },
      )).resolves.toMatchObject({ state: { cursor: 'page-1' } });
      expect(sqliteTouch).not.toHaveBeenCalled();
    });

    it('fails closed before an unsupported connector write is dispatched', async () => {
      const updateTask = vi.fn(async () => undefined);
      const { pushPendingChanges } = await import('@/lib/sync/push-manager');

      await expect(pushPendingChanges('pg-github', {
        type: 'github-issues',
        updateTask,
      } as never)).rejects.toThrow('unsupported connector execution');
      expect(updateTask).not.toHaveBeenCalled();
      expect(postgresMocks.workerRepositories.execution.pushes.listCandidates)
        .not.toHaveBeenCalled();
      expect(sqliteTouch).not.toHaveBeenCalled();
    });
  });

  it('enqueueSyncJobInCurrentTransaction explicitly rejects (no ambient-transaction contract) under PostgreSQL', async () => {
    const { enqueueSyncJobInCurrentTransaction } = await import('@/lib/sync/job-queue');
    expect(() => enqueueSyncJobInCurrentTransaction('pg-connector')).toThrow(
      /SQLite-only/,
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — connector operation lease', () => {
  it('getConnectorOperationLeaseRepository resolves to the PostgreSQL adapter without touching SQLite', async () => {
    const { getConnectorOperationLeaseRepository } = await import('@/lib/sync/connector-lock-runtime');
    const repository = await getConnectorOperationLeaseRepository();
    expect(repository).toBe(postgresMocks.leaseRepository);

    const hasLease = await repository.hasActiveSyncJobLease({
      connectorId: 'pg-connector',
      jobId: 'pg-job-1',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(hasLease).toBe(true);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('runWithConnectorOperationLease acquires/releases through the PostgreSQL adapter without touching SQLite', async () => {
    const { runWithConnectorOperationLease } = await import('@/lib/sync/connector-lock-runtime');
    const result = await runWithConnectorOperationLease('pg-connector', 'transfer', async () => 'done');
    expect(result).toBe('done');
    expect(postgresMocks.leaseRepository.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'pg-connector', operationType: 'transfer' }),
    );
    expect(postgresMocks.leaseRepository.release).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'pg-connector' }),
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — connector sync controls', () => {
  it('isConnectorSyncQuarantinedAsync delegates to the PostgreSQL check without touching SQLite', async () => {
    const { isConnectorSyncQuarantinedAsync } = await import('@/lib/sync/control-state');
    const quarantined = await isConnectorSyncQuarantinedAsync('pg-connector');
    expect(quarantined).toBe(false);
    expect(postgresMocks.controlStateRepository.isQuarantined)
      .toHaveBeenCalledWith('pg-connector');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('assertConnectorSyncEnqueueAllowedAsync delegates to the PostgreSQL check without touching SQLite', async () => {
    const { assertConnectorSyncEnqueueAllowedAsync } = await import('@/lib/sync/control-state');
    await expect(assertConnectorSyncEnqueueAllowedAsync('pg-connector', 'api')).resolves.toBeUndefined();
    expect(postgresMocks.controlStateRepository.assertEnqueueAllowed)
      .toHaveBeenCalledWith('pg-connector', 'api', undefined);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — connector maintenance lock', () => {
  it('assertConnectorMaintenanceUnlockedAsync delegates to the selected repository', async () => {
    const { assertConnectorMaintenanceUnlockedAsync } = await import('@/lib/sync/maintenance-lock');
    await expect(assertConnectorMaintenanceUnlockedAsync('pg-connector')).resolves.toBeUndefined();
    expect(postgresMocks.maintenanceLockRepository.assertUnlocked)
      .toHaveBeenCalledWith('pg-connector');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — operator control', () => {
  it('delegates status reads without touching SQLite', async () => {
    const { getFinanceSyncControlStatus } = await import('@/lib/sync/operator-control');
    await expect(getFinanceSyncControlStatus('pg-connector')).resolves.toMatchObject({
      connector: { id: 'pg-connector' },
    });
    expect(postgresMocks.operatorControlRepository.getStatus)
      .toHaveBeenCalledWith('pg-connector');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — keyword search', () => {
  it('fts.ts wrapper functions delegate to the PostgreSQL adapter without touching SQLite', async () => {
    const { indexTask, searchFTS } = await import('@/lib/search/fts');
    await indexTask({ id: 'pg-task-1', title: 'A PostgreSQL-indexed task' });
    expect(postgresMocks.searchRepository.indexTask).toHaveBeenCalledWith({
      id: 'pg-task-1',
      title: 'A PostgreSQL-indexed task',
    });

    await searchFTS('quokka');
    expect(postgresMocks.searchRepository.search).toHaveBeenCalledWith('quokka');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('publishes keyword and semantic updates without touching SQLite state', async () => {
    const {
      indexAlertForSearch,
      indexTaskForSearch,
      warmUpSearchAfterSync,
    } = await import('@/lib/sync/search-indexer');
    await indexTaskForSearch({ id: 'pg-task-2', title: 'Portable task' });
    await indexAlertForSearch({
      id: 'pg-notification-1',
      title: 'Portable notification',
    });
    await warmUpSearchAfterSync();

    expect(postgresMocks.searchRepository.indexTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pg-task-2' }),
    );
    expect(postgresMocks.searchRepository.indexNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pg-notification-1' }),
    );
    expect(postgresMocks.publishSemanticEntityUpsert).toHaveBeenCalledWith(
      'task',
      'pg-task-2',
    );
    expect(postgresMocks.publishSemanticEntityUpsert).toHaveBeenCalledWith(
      'alert',
      'pg-notification-1',
    );
    expect(postgresMocks.searchRepository.warmUp).toHaveBeenCalled();
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL backend selection — API-triggered enqueue (SyncQueue)', () => {
  it('requestSync enqueues through the PostgreSQL job repository and waits on it, without touching SQLite', async () => {
    process.env.MC_SYNC_EXECUTION_MODE = 'worker';
    try {
      const { SyncQueue } = await import('@/lib/sync/queue');
      const queue = new SyncQueue(
        async () => { throw new Error('inline execution path must not run in durable mode'); },
        () => false,
      );

      postgresMocks.syncJobRepository.enqueue.mockResolvedValueOnce({
        id: 'pg-job-2',
        connectorId: 'pg-connector',
        full: false,
        source: 'api',
        status: 'queued',
      });
      postgresMocks.syncJobRepository.get.mockResolvedValueOnce({
        id: 'pg-job-2',
        connectorId: 'pg-connector',
        status: 'succeeded',
        result: {
          connectorId: 'pg-connector',
          success: true,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          notificationsAdded: 0,
          errors: [],
          syncedAt: '2026-01-01T00:00:00.000Z',
        },
      });

      const result = await queue.requestSync('pg-connector', { source: 'api' });

      expect(result.success).toBe(true);
      expect(postgresMocks.syncJobRepository.enqueue).toHaveBeenCalledWith('pg-connector', {
        full: undefined,
        source: 'api',
      });
      expect(sqliteTouch).not.toHaveBeenCalled();
    } finally {
      delete process.env.MC_SYNC_EXECUTION_MODE;
    }
  });
});

describe('PostgreSQL backend selection — durable cron scheduling', () => {
  it('schedule() registers the schedule through the PostgreSQL job repository, without touching SQLite', async () => {
    process.env.MC_SYNC_EXECUTION_MODE = 'worker';
    try {
      const { SyncCronScheduler } = await import('@/lib/sync/cron-scheduler');
      const scheduler = new SyncCronScheduler(
        vi.fn(),
        vi.fn(async () => undefined),
        vi.fn(async () => []),
      );

      await scheduler.schedule({
        id: 'pg-connector',
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

      expect(postgresMocks.syncJobRepository.registerSchedule).toHaveBeenCalledWith('pg-connector', 10);
      expect(sqliteTouch).not.toHaveBeenCalled();
    } finally {
      delete process.env.MC_SYNC_EXECUTION_MODE;
    }
  });
});

describe('PostgreSQL backend selection — worker drain loop', () => {
  it('claims, executes, and completes a job through the PostgreSQL job repository, without touching SQLite', async () => {
    // Mock the job-queue facade directly (as tests/sync/sync-worker-runtime.test.ts
    // does for the SQLite path) rather than routing through the dynamic
    // `@/db/runtime` import chain: SyncWorker only ever calls
    // `getSyncJobRepository()`, so asserting it resolves to the PostgreSQL
    // repository here is sufficient and avoids flakiness from resolving a
    // module dynamically imported from inside a long-lived timer loop.
    vi.doMock('@/lib/sync/job-runtime', () => ({
      getSyncLeaseMs: () => 120_000,
      getSyncQueueMetrics: () => ({ queued: 0 }),
      getSyncJobRepository: async () => postgresMocks.syncJobRepository,
    }));

    const { SyncWorker } = await import('@/lib/sync/worker');
    const claimedJob = {
      id: 'pg-job-3',
      connectorId: 'pg-connector',
      full: false,
      source: 'api' as const,
      status: 'running' as const,
      attempt: 1,
      maxAttempts: 3,
      availableAt: '2026-01-01T00:00:00.000Z',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-01-01T00:02:00.000Z',
      cancelRequestedAt: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      result: null,
      error: null,
      durationBudgetMs: 300_000,
      identityMode: null,
      identityModeRevision: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    postgresMocks.syncJobRepository.claimNext
      .mockResolvedValueOnce(claimedJob)
      .mockResolvedValue(null);

    const worker = new SyncWorker(
      async () => ({
        connectorId: 'pg-connector',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt: '2026-01-01T00:00:05.000Z',
      }),
      { ownerId: 'worker-a', pollIntervalMs: 1 },
    );

    worker.start();
    try {
      await vi.waitFor(() => {
        expect(postgresMocks.syncJobRepository.finalizeSuccess).toHaveBeenCalledOnce();
      }, { timeout: 2000, interval: 10 });
    } finally {
      await worker.stop();
    }

    expect(postgresMocks.syncJobRepository.claimNext).toHaveBeenCalled();
    expect(postgresMocks.syncJobRepository.linkSyncLog).not.toHaveBeenCalled();
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
