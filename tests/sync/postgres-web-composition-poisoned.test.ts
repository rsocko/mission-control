import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    connectors: {},
    notifications: {},
    settings: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    },
    houstonMemories: {},
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
    finance: {},
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
  return {
    sqliteTouch,
    pool,
    backendInitialize,
    backendShutdown,
    resumeSemantic,
    stopSemantic,
    core,
    worker,
    queue,
    lease,
    keyword,
    enrich,
    createEnrichmentExecutor,
    publish,
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
});
