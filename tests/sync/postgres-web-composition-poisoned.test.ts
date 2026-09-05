import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  const sqliteTouch = vi.fn();
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const backendInitialize = vi.fn(async () => undefined);
  const backendShutdown = vi.fn(async () => undefined);
  const resumeSemantic = vi.fn();
  const stopSemantic = vi.fn(async () => undefined);
  const core = {
    tasks: {},
    projects: {},
    connectors: {
      get: vi.fn(async (id: string) => (
        id === 'missing'
          ? null
          : {
              id,
              type: 'finance-manager',
              name: 'Finance',
              enabled: true,
              syncMode: 'pull',
              pollIntervalMinutes: 240,
              capabilities: { read: true, write: false, delete: false },
              credentials: {},
              settings: {},
              syncedLists: [],
            }
      )),
      listEnabled: vi.fn(async () => [] as Array<Record<string, unknown>>),
      recordTestResult: vi.fn(async () => ({ recorded: true })),
    },
    notifications: {},
    settings: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    },
    houstonMemories: {},
  };
  const financeOperator = {
    isLegacyAnomalyProductionEnabled: vi.fn(async () => true),
    readHealthSnapshot: vi.fn(async () => ({
      sync: null,
      attribution: null,
      activeJob: null,
      capture: null,
      evaluation: null,
    })),
    readCutoverReadiness: vi.fn(async () => ({
      connector: {
        id: 'finance',
        type: 'finance-manager',
        enabled: true,
        settings: { householdCurrency: 'USD' },
      },
      enabledFinanceConnectorCount: 1,
      publication: null,
      cutover: null,
    })),
    readCutoverGeneration: vi.fn(async () => null),
    enableCutover: vi.fn(async () => ({
      outcome: 'blocked' as const,
      blockers: ['finance_insight_cutover_generation_unavailable'],
    })),
    rollbackCutover: vi.fn(async () => ({
      outcome: 'rolled-back' as const,
      legacyExpiredCount: 0,
      importedCount: 0,
      suppressedDeliveryCount: 0,
      replayed: false,
    })),
  };
  const financeAttribution = {
    assertConnector: vi.fn(async () => undefined),
    listExceptions: vi.fn(async () => ({ exceptions: [], hasMore: false, subjects: [] })),
    applyManualDecision: vi.fn(async () => ({
      status: 'resolved' as const,
      transactionId: 'transaction',
      kidId: null,
      replayed: false,
    })),
    actOnException: vi.fn(async () => ({
      status: 'dismissed',
      exceptionId: 'exception',
      replayed: false,
      retryScheduled: false,
    })),
  };
  const financeDatasets = {
    listState: vi.fn(async () => []),
  };
  const financeWeb = {
    listKidsWithSpending: vi.fn(async () => []),
    listTransactions: vi.fn(async () => []),
    readSummary: vi.fn(async () => ({
      total: 0,
      transactionCount: 0,
      byCategory: [],
      byKid: [],
    })),
    listNotifications: vi.fn(async () => []),
    dismissNotification: vi.fn(async () => undefined),
    updateDemoCategory: vi.fn(async () => true),
    readOperationsOverview: vi.fn(async () => ({
      connectors: [{ id: 'finance', name: 'Finance' }],
      connector: { id: 'finance', name: 'Finance' },
      attention: {
        total: 0,
        pendingExceptions: 0,
        retryRequested: 0,
        failedWritebacks: 0,
        openAlerts: 0,
      },
      alerts: [],
      subjects: [],
      digest: [],
    })),
    claimCategoryUpdate: vi.fn(async () => ({
      outcome: 'claimed' as const,
      upstreamTransactionId: 'upstream',
      claimToken: 'claim-token',
    })),
    completeCategoryUpdate: vi.fn(async () => true),
    failCategoryUpdate: vi.fn(async () => true),
  };
  const worker = {
    connectors: core.connectors,
    syncRuns: {},
    execution: {},
    github: {},
    connectorState: {},
    notificationDelivery: {},
    reminders: {},
    triage: {},
    planningSignals: {},
    projectAutomation: {},
    eventDelivery: {},
    notificationEntityLinking: {},
    notificationEnrichment: {},
    externalAgentControl: {},
    finance: {
      attribution: financeAttribution,
      datasets: financeDatasets,
      web: financeWeb,
      operator: financeOperator,
      insights: {
        connectors: {
          resolveSingleEnabledConnectorId: vi.fn(async () => 'finance'),
        },
        notifications: {
          isDeliveryEnabled: vi.fn(async () => false),
        },
      },
    },
    ideationWorkspaces: {},
    analytics: {},
  };
  const queue = {
    countQueued: vi.fn(async () => 0),
  };
  const lease = {
    hasActiveSyncJobLease: vi.fn(async () => false),
  };
  const keyword = {
    search: vi.fn(async () => []),
  };
  const enrich = vi.fn(async () => ({ summary: 'postgres' }));
  const createEnrichmentExecutor = vi.fn(async () => enrich);
  const publish = vi.fn(async () => ({ status: 'skipped' as const }));
  const monarchUpdateCategory = vi.fn(async () => undefined);
  return {
    sqliteTouch,
    pool,
    backendInitialize,
    backendShutdown,
    resumeSemantic,
    stopSemantic,
    core,
    worker,
    financeOperator,
    financeAttribution,
    financeDatasets,
    financeWeb,
    queue,
    lease,
    keyword,
    enrich,
    createEnrichmentExecutor,
    publish,
    monarchUpdateCategory,
    demoMode: false,
  };
});

const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalNextRuntime = process.env.NEXT_RUNTIME;
const originalAiProvider = process.env.AI_PROVIDER;
const originalAiBaseUrl = process.env.AI_BASE_URL;
const originalAiModel = process.env.AI_MODEL;

vi.mock('@/db', () => ({
  get sqlite() {
    mocks.sqliteTouch();
    throw new Error('SQLite was evaluated');
  },
  get db() {
    mocks.sqliteTouch();
    throw new Error('SQLite was evaluated');
  },
}));
vi.mock('@/db/runtime-backend', () => ({
  resolveDatabaseBackend: () => 'postgres',
}));
vi.mock('@/db/postgres/runtime', () => ({
  PostgresPersistenceBackend: class {
    initialize = mocks.backendInitialize;
    shutdown = mocks.backendShutdown;
    context = { db: {}, pool: mocks.pool, vector: {} };
  },
}));
vi.mock('@/db/postgres/repositories', () => ({
  createPostgresCoreRepositories: () => mocks.core,
  createPostgresWorkerPersistenceRepositories: () => mocks.worker,
}));
vi.mock('@/db/postgres/sync/job-repository', () => ({
  createPostgresSyncJobRepository: () => mocks.queue,
}));
vi.mock('@/db/postgres/sync/connector-operation-lease-repository', () => ({
  createPostgresConnectorOperationLeaseRepository: () => mocks.lease,
}));
vi.mock('@/db/postgres/search', () => ({
  createPostgresKeywordSearchRepository: () => mocks.keyword,
}));
vi.mock('@/db/postgres/telemetry-runtime', () => ({
  createPostgresRuntimeTelemetryPersistence: () => ({
    getDatabaseTelemetry: () => undefined,
    registerInstance: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    recordStop: vi.fn(async () => undefined),
    maintainHistory: vi.fn(async () => undefined),
    getCurrent: vi.fn(async () => []),
    getHistory: vi.fn(async () => []),
    getAlertHistory: vi.fn(async () => []),
    getInstances: vi.fn(async () => []),
  }),
}));
vi.mock('@/db/postgres/semantic-index/repository', () => ({
  createPostgresSemanticIndexRepository: () => ({}),
}));
vi.mock('@/db/postgres/semantic-index/source-port', () => ({
  createPostgresSemanticSourcePort: () => ({}),
}));
vi.mock('@/lib/ai/durable-runs/postgres-adapter', () => ({
  PostgresDurableAiRunRepository: class {},
}));
vi.mock('@/lib/notifications/enrichment/packaged-executor', () => ({
  createPackagedNotificationEnrichmentExecutor: mocks.createEnrichmentExecutor,
}));
vi.mock('@/lib/semantic-index/packaged-worker-runtime', () => ({
  publishPackagedPostgresSemanticEntity: mocks.publish,
  resumePackagedPostgresSemanticRuntime: mocks.resumeSemantic,
  stopPackagedPostgresSemanticWorker: mocks.stopSemantic,
}));
vi.mock('@/lib/runtime/lifecycle', () => ({
  configureRuntimeLifecycle: vi.fn(),
  markRuntimeReady: vi.fn(),
}));
vi.mock('@/lib/runtime/startup', () => ({
  terminateFailedStartup: (error: unknown) => {
    throw error;
  },
}));
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => true,
}));
vi.mock('@/lib/public-demo-runtime', () => ({
  initializePublicDemoData: vi.fn(async () => undefined),
}));
vi.mock('@/lib/mode', () => ({
  isDemoMode: () => mocks.demoMode,
  getTimezone: () => 'UTC',
}));
vi.mock('@/lib/connectors/monarch-money/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/monarch-money/client')>();
  return {
    ...actual,
    MonarchBridgeClient: class {
      updateCategory = mocks.monarchUpdateCategory;
    },
  };
});
vi.mock('@/lib/telemetry/runtime', () => ({
  startRuntimeTelemetry: vi.fn(async () => undefined),
}));
describe('poisoned-SQLite PostgreSQL web composition', () => {
  beforeAll(async () => {
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.AI_PROVIDER;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    const { register } = await import('@/instrumentation');
    await register();
    await register();
    const { shutdownRuntimeDatabase } = await import('@/db/runtime');
    await shutdownRuntimeDatabase();
    await register();
  });

  afterAll(async () => {
    const { shutdownRuntimeDatabase } = await import('@/db/runtime');
    await shutdownRuntimeDatabase();
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalNextRuntime;
    if (originalAiProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalAiProvider;
    if (originalAiBaseUrl === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = originalAiBaseUrl;
    if (originalAiModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = originalAiModel;
  });

  it('registers and calls normal services through the web startup path', async () => {
    const [
      { getConnectorRegistry },
      { getCorePersistenceRepositories },
      { getWorkerPersistenceRepositories },
      { getKeywordSearchRepository },
      { enrichWithAI },
      { publishSemanticEntityUpsert },
    ] = await Promise.all([
      import('@/lib/connectors/registry-runtime'),
      import('@/lib/persistence/runtime'),
      import('@/lib/persistence/worker-runtime'),
      import('@/lib/search/keyword-runtime'),
      import('@/lib/notifications/enrichment/ai-enrichment-service'),
      import('@/lib/semantic-index/publication-service'),
    ]);

    expect(getConnectorRegistry().getAllConnectors()).toEqual([]);
    await expect(
      getCorePersistenceRepositories().settings.get('key'),
    ).resolves.toBeNull();
    await expect(getWorkerPersistenceRepositories()).resolves.toHaveProperty('execution');
    await expect(getWorkerPersistenceRepositories()).resolves.toHaveProperty(
      'externalAgentControl',
    );
    await expect(getKeywordSearchRepository().search('query')).resolves.toEqual([]);
    await expect(enrichWithAI({
      notificationId: 'notification',
      title: 'Review requested',
      connectorType: 'github',
      category: 'development',
      metadata: {},
      presentation: {},
    })).resolves.toEqual({ summary: 'postgres' });
    await expect(enrichWithAI({
      notificationId: 'informational',
      title: 'No enrichment needed',
      connectorType: 'test',
      category: 'informational',
      metadata: {},
      presentation: {},
    })).resolves.toBeNull();
    await expect(
      publishSemanticEntityUpsert('task', 'task'),
    ).resolves.toEqual({ status: 'skipped' });
    expect(mocks.backendInitialize).toHaveBeenCalledTimes(2);
    expect(mocks.backendShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSemantic).toHaveBeenCalledTimes(2);
    expect(mocks.stopSemantic).toHaveBeenCalledTimes(1);
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });

  it('retries enrichment executor composition after a transient setup failure', async () => {
    const { createPostgresAIEnrichmentService } = await import(
      '@/db/postgres/sync/notification-enrichment-service'
    );
    const service = createPostgresAIEnrichmentService();
    const input = {
      notificationId: 'retry',
      title: 'Review requested',
      connectorType: 'github',
      category: 'development',
      metadata: {},
      presentation: {},
    };
    mocks.createEnrichmentExecutor.mockRejectedValueOnce(new Error('transient setup failure'));

    await expect(service.enrich(input)).rejects.toThrow('transient setup failure');
    await expect(service.enrich(input)).resolves.toEqual({ summary: 'postgres' });
  });

  it('normalizes absent and null enrichment bodies identically', async () => {
    const { createPostgresAIEnrichmentService } = await import(
      '@/db/postgres/sync/notification-enrichment-service'
    );
    const service = createPostgresAIEnrichmentService();
    const input = {
      notificationId: 'body-normalization',
      title: 'Review requested',
      connectorType: 'github',
      category: 'development',
      metadata: {},
      presentation: {},
    };
    mocks.enrich.mockClear();

    await service.enrich(input);
    await service.enrich({ ...input, body: null });

    expect(mocks.enrich).toHaveBeenCalledTimes(2);
    expect(mocks.enrich.mock.calls[0][0]).toMatchObject({ body: null });
    expect(mocks.enrich.mock.calls[1][0]).toMatchObject({ body: null });
  });

  it('fails closed for documented optional SQLite-only services', async () => {
    const [
      { getLegacySearchIndexingService },
      { queryFinanceTransactions },
      { inspectGitHubRepointBackup },
    ] = await Promise.all([
      import('@/lib/search/indexing-service'),
      import('@/lib/connectors/monarch-money/transaction-query'),
      import('@/lib/connectors/github-issues/backup-verifier'),
    ]);

    expect(() => getLegacySearchIndexingService()).toThrow(
      'unavailable for the selected backend',
    );
    await expect(queryFinanceTransactions('connector')).rejects.toThrow(
      'unavailable for the selected backend',
    );
    await expect(inspectGitHubRepointBackup('backup.db')).rejects.toThrow(
      'unavailable for the selected backend',
    );
    expect(mocks.sqliteTouch).not.toHaveBeenCalled();
  });

  /**
   * L12b: every owned finance connector/operator route and library must be
   * importable *and* callable — read and mutation paths alike — under
   * `MC_DATABASE_BACKEND=postgres` with a throwing `@/db`. Any static or
   * dynamic SQLite reach fails immediately through the poisoned module.
   */
  describe('finance connector/operator web surface', () => {
    const financeRequest = (url: string, init?: RequestInit) => new Request(url, {
      ...init,
      headers: {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        ...(init?.headers ?? {}),
      },
    });

    it('serves every owned route without evaluating SQLite', async () => {
      const [health, test, operations, recovery, exceptions, exceptionAction, kid] =
        await Promise.all([
          import('@/app/api/connectors/[id]/health/route'),
          import('@/app/api/connectors/[id]/test/route'),
          import('@/app/api/connectors/[id]/finance-operations/route'),
          import('@/app/api/connectors/[id]/finance/recovery/route'),
          import('@/app/api/connectors/[id]/finance/attribution-exceptions/route'),
          import('@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'),
          import('@/app/api/finance/transactions/[id]/kid/route'),
        ]);
      const params = Promise.resolve({ id: 'finance' });

      expect((await health.GET(
        financeRequest('http://localhost:3000/api/connectors/missing/health'),
        { params: Promise.resolve({ id: 'missing' }) },
      )).status).toBe(404);
      expect((await test.POST(
        financeRequest('http://localhost:3000/api/connectors/missing/test', { method: 'POST' }),
        { params: Promise.resolve({ id: 'missing' }) },
      )).status).toBe(404);
      expect((await operations.GET(
        new NextRequest('http://localhost:3000/api/connectors/finance/finance-operations'),
        { params },
      )).status).toBe(403);
      expect((await recovery.POST(
        new Request('http://localhost:3000/api/connectors/finance/finance/recovery', {
          method: 'POST',
        }),
        { params },
      )).status).toBe(403);
      expect((await exceptions.GET(
        new Request(
          'http://localhost:3000/api/connectors/finance/finance/attribution-exceptions',
        ),
        { params },
      )).status).toBe(403);
      expect((await exceptionAction.POST(
        new Request('http://localhost:3000/api/connectors/finance/x', { method: 'POST' }),
        { params: Promise.resolve({ id: 'finance', exceptionId: 'exception' }) },
      )).status).toBe(403);
      expect((await kid.PATCH(
        new Request('http://localhost:3000/api/finance/transactions/t/kid', { method: 'PATCH' }),
        { params: Promise.resolve({ id: 'transaction' }) },
      )).status).toBe(403);
      expect(mocks.sqliteTouch).not.toHaveBeenCalled();
    });

    it('runs every owned library read and mutation path without evaluating SQLite', async () => {
      const [attribution, datasets, cutover, cutoverOperator] = await Promise.all([
        import('@/lib/connectors/monarch-money/attribution-service'),
        import('@/lib/connectors/monarch-money/dataset-sync'),
        import('@/lib/finance-insights/cutover'),
        import('@/lib/finance-insights/cutover-operator'),
      ]);

      await expect(attribution.listAttributionExceptions('finance', {})).resolves.toEqual({
        exceptions: [],
        nextCursor: null,
        subjects: [],
      });
      await expect(attribution.applyManualAttributionDecision({
        connectorId: 'finance',
        transactionId: 'transaction',
        action: 'parent-expense',
        kidId: null,
        idempotencyKey: 'idempotency-key-1',
        actorType: 'service',
      })).resolves.toMatchObject({ status: 'resolved', replayed: false });
      await expect(attribution.actOnAttributionException({
        connectorId: 'finance',
        exceptionId: 'exception',
        action: 'dismiss',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        idempotencyKey: 'idempotency-key-2',
        actorType: 'service',
      })).resolves.toMatchObject({ status: 'dismissed', retryScheduled: false });

      const health = await datasets.getFinanceDatasetHealth('finance');
      expect(health.aggregate).toBe('unavailable');
      expect(health.datasets).toHaveLength(6);

      await expect(cutover.isFinanceInsightDeliveryEnabled('finance')).resolves.toBe(false);
      await expect(cutover.resolveSingleFinanceConnectorId()).resolves.toBe('finance');
      await expect(cutover.enableFinanceInsightCutover({
        connectorId: 'finance',
        sourceGeneration: 'generation',
      })).rejects.toThrow('finance_insight_cutover_generation_unavailable');
      await expect(cutover.rollbackFinanceInsightCutover({
        connectorId: 'finance',
        sourceGeneration: 'generation',
      })).resolves.toMatchObject({ status: 'rolled-back' });

      const readiness = await cutoverOperator.getFinanceInsightCutoverReadiness('finance');
      expect(readiness.readiness.ready).toBe(false);
      await expect(cutoverOperator.rollbackFinanceInsightCutoverForOperator({
        connectorId: 'finance',
        sourceGeneration: 'generation',
        actorType: 'service',
        idempotencyKey: 'operator-idempotency-key-1',
      })).resolves.toMatchObject({ status: 'rolled-back' });
      expect(mocks.financeOperator.rollbackCutover).toHaveBeenCalled();
      expect(mocks.sqliteTouch).not.toHaveBeenCalled();
    });

    it('serves the finance web routes through the composed PostgreSQL port', async () => {
      mocks.core.connectors.listEnabled.mockResolvedValue([{
        id: 'finance',
        type: 'finance-manager',
        name: 'Finance',
        enabled: true,
        syncMode: 'poll',
        capabilities: { read: true, write: true, delete: false },
        credentials: {},
        settings: {},
        syncedLists: [],
      }]);
      const [kids, notifications, dismiss, overview, summary, transactions, category] =
        await Promise.all([
          import('@/app/api/finance/kids/route'),
          import('@/app/api/finance/notifications/route'),
          import('@/app/api/finance/notifications/[id]/dismiss/route'),
          import('@/app/api/finance/overview/route'),
          import('@/app/api/finance/summary/route'),
          import('@/app/api/finance/transactions/route'),
          import('@/app/api/finance/transactions/[id]/category/route'),
        ]);

      expect((await kids.GET(financeRequest(
        'http://localhost:3000/api/finance/kids?connectorId=finance',
      ))).status).toBe(200);
      expect((await notifications.GET(financeRequest(
        'http://localhost:3000/api/finance/notifications?dismissed=false',
      ))).status).toBe(200);
      expect((await dismiss.PATCH(
        financeRequest(
          'http://localhost:3000/api/finance/notifications/notification/dismiss',
          { method: 'PATCH' },
        ),
        { params: Promise.resolve({ id: 'notification' }) },
      )).status).toBe(200);
      expect((await overview.GET(financeRequest(
        'http://localhost:3000/api/finance/overview?connectorId=finance',
      ))).status).toBe(200);
      expect((await summary.GET(financeRequest(
        'http://localhost:3000/api/finance/summary?connectorId=finance'
          + '&startDate=2026-08-01&endDate=2026-08-31',
      ))).status).toBe(200);
      expect((await transactions.GET(financeRequest(
        'http://localhost:3000/api/finance/transactions?connectorId=finance',
      ))).status).toBe(200);

      expect((await category.PATCH(
        financeRequest('http://localhost:3000/api/finance/transactions/transaction/category', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'category-write-1',
          },
          body: JSON.stringify({ connectorId: 'finance', categoryId: 'category' }),
        }),
        { params: Promise.resolve({ id: 'transaction' }) },
      )).status).toBe(200);

      mocks.demoMode = true;
      try {
        expect((await category.PATCH(
          financeRequest('http://localhost:3000/api/finance/transactions/transaction/category', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ connectorId: 'finance', categoryId: 'category' }),
          }),
          { params: Promise.resolve({ id: 'transaction' }) },
        )).status).toBe(200);
      } finally {
        mocks.demoMode = false;
      }

      expect(mocks.financeWeb.listKidsWithSpending).toHaveBeenCalled();
      expect(mocks.financeWeb.listNotifications).toHaveBeenCalled();
      expect(mocks.financeWeb.dismissNotification).toHaveBeenCalled();
      expect(mocks.financeWeb.readOperationsOverview).toHaveBeenCalled();
      expect(mocks.financeWeb.readSummary).toHaveBeenCalled();
      expect(mocks.financeWeb.listTransactions).toHaveBeenCalled();
      expect(mocks.financeWeb.claimCategoryUpdate).toHaveBeenCalledWith(expect.objectContaining({
        connectorId: 'finance',
        transactionId: 'transaction',
        categoryId: 'category',
        idempotencyKey: 'category-write-1',
      }));
      expect(mocks.monarchUpdateCategory).toHaveBeenCalledWith(
        'upstream',
        'category',
        expect.any(AbortSignal),
      );
      expect(mocks.financeWeb.completeCategoryUpdate).toHaveBeenCalledWith(expect.objectContaining({
        connectorId: 'finance',
        transactionId: 'transaction',
        categoryId: 'category',
        idempotencyKey: 'category-write-1',
        claimToken: 'claim-token',
      }));
      expect(mocks.financeWeb.updateDemoCategory).toHaveBeenCalled();
      expect(mocks.sqliteTouch).not.toHaveBeenCalled();
    });
  });
});
