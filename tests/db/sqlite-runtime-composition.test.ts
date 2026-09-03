import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SQLite runtime composition', () => {
  beforeEach(() => {
    process.env.MC_DATABASE_BACKEND = 'sqlite';
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.doUnmock('@/db/bootstrap/connection');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_DATABASE_BACKEND;
    delete process.env.MC_DB_PATH;
  });

  it('documents the temporary cold-access publication that L03a2 must remove', async () => {
    const source = readFileSync('src/db/index.ts', 'utf8');
    expect(source).toContain(
      '// Temporary L03a1 bridge. L03a2 removes this call from raw SQLite access.',
    );
    expect(source).toMatch(
      /function initDatabase\(\)[\s\S]*publishTemporarySqliteCompatibilityComposition\(\)/,
    );
    const connectorSource = readFileSync('src/lib/connectors/index.ts', 'utf8');
    const runtimeSource = readFileSync('src/db/runtime.ts', 'utf8');
    const semanticSource = readFileSync('src/lib/semantic-index/publication.ts', 'utf8');
    expect(connectorSource).not.toMatch(
      /^registerConnectorRegistry\(connectorRegistry\);/m,
    );
    expect(runtimeSource).not.toMatch(/import\(['"]@\/lib\/connectors['"]\)/);
    expect(semanticSource).not.toMatch(/^registerSemanticPublicationService\(/m);

    const database = await import('@/db');
    const workerRuntime = await import('@/lib/persistence/worker-runtime');
    await expect(workerRuntime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'Worker persistence repositories must be registered before worker persistence is accessed',
    );

    database.sqlite.prepare('SELECT 1').get();
    await expect(workerRuntime.getWorkerPersistenceRepositories()).resolves.toBeDefined();

    const close = database.sqlite.close.bind(database.sqlite);
    await (await import('@/db/runtime')).shutdownRuntimeDatabase();
    close();
  });

  it('shares initialization, fences the full stop interval, and reuses one generation', async () => {
    const database = await import('@/db');
    const runtime = await import('@/db/runtime');
    const workerRuntime = await import('@/lib/persistence/worker-runtime');

    const firstInitialization = runtime.initializeRuntimeDatabase();
    const concurrentInitialization = runtime.initializeRuntimeDatabase();
    expect(concurrentInitialization).toBe(firstInitialization);
    await firstInitialization;

    const firstRepositories = await workerRuntime.getWorkerPersistenceRepositories();
    const close = database.sqlite.close.bind(database.sqlite);
    const firstShutdown = runtime.shutdownRuntimeDatabase();
    const concurrentShutdown = runtime.shutdownRuntimeDatabase();
    expect(concurrentShutdown).toBe(firstShutdown);
    expect(() => database.sqlite.prepare('SELECT 1')).toThrow(
      'SQLite compatibility access is blocked after shutdown',
    );
    await firstShutdown;

    await expect(workerRuntime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
    expect(() => workerRuntime.registerWorkerPersistenceRepositories(firstRepositories)).toThrow(
      'Persistence composition publication is blocked until initializeRuntimeDatabase()',
    );
    expect(() => database.sqlite.prepare('SELECT 1')).toThrow(
      'SQLite compatibility access is blocked after shutdown',
    );

    const reinitialization = runtime.initializeRuntimeDatabase();
    expect(runtime.initializeRuntimeDatabase()).toBe(reinitialization);
    await reinitialization;
    expect(await workerRuntime.getWorkerPersistenceRepositories()).toBe(firstRepositories);
    expect(database.sqlite.prepare('SELECT 1').get()).toBeDefined();

    await runtime.shutdownRuntimeDatabase();
    close();
  });

  it('fences shutdown before a cold SQLite module can open a connection', async () => {
    const openDatabaseConnection = vi.fn();
    vi.doMock('@/db/bootstrap/connection', () => ({
      configureDatabaseConnection: vi.fn(),
      openDatabaseConnection,
      shouldRunDatabaseInitialization: () => false,
    }));

    const runtime = await import('@/db/runtime');
    const shutdown = runtime.shutdownRuntimeDatabase();
    const database = await import('@/db');

    expect(() => database.sqlite.prepare('SELECT 1')).toThrow(
      'SQLite compatibility access is blocked after shutdown',
    );
    expect(openDatabaseConnection).not.toHaveBeenCalled();
    await shutdown;
  });

  it('rolls back partial publication and permits an explicit clean retry', async () => {
    const runtime = await import('@/db/runtime');
    const keywordRuntime = await import('@/lib/search/keyword-runtime');
    const triageRuntime = await import('@/lib/triage/persistence');
    const conflictingRepository = {
      rebuild: vi.fn(async () => undefined),
      indexTask: vi.fn(async () => undefined),
      removeTask: vi.fn(async () => undefined),
      indexNotification: vi.fn(async () => undefined),
      removeNotification: vi.fn(async () => undefined),
      warmUp: vi.fn(async () => undefined),
      search: vi.fn(async () => []),
    };
    keywordRuntime.registerKeywordSearchRepository(conflictingRepository);

    await expect(runtime.initializeRuntimeDatabase()).rejects.toThrow(
      'Keyword search repository is already selected',
    );
    expect(() => triageRuntime.getTriagePersistenceRepositories()).toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );

    const compositionLifecycle = await import('@/lib/persistence/composition-lifecycle');
    const financeRuntime = await import(
      '@/lib/connectors/monarch-money/transaction-query'
    );
    const probeQuery = { list: vi.fn(async () => []) };
    compositionLifecycle.beginPersistenceCompositionInitialization();
    expect(() => financeRuntime.registerFinanceTransactionQuery(probeQuery)).not.toThrow();
    financeRuntime.clearFinanceTransactionQuery(probeQuery);
    compositionLifecycle.blockPersistenceComposition();

    keywordRuntime.clearKeywordSearchRepository(conflictingRepository);
    await expect(runtime.initializeRuntimeDatabase()).resolves.toBeUndefined();
    const database = await import('@/db');
    const close = database.sqlite.close.bind(database.sqlite);
    await runtime.shutdownRuntimeDatabase();
    close();
  });
});
