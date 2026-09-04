import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

describe('SQLite runtime composition', () => {
  beforeEach(() => {
    resetProcessRuntimeRegistries();
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

  it('keeps raw SQLite access from publishing persistence composition', async () => {
    const source = readFileSync('src/db/index.ts', 'utf8');
    const initDatabaseSource = source.slice(
      source.indexOf('function initDatabase('),
      source.indexOf('export function initializeDatabase()'),
    );
    expect(source).not.toContain('publishTemporarySqliteCompatibilityComposition');
    expect(initDatabaseSource).not.toContain('publishSqliteComposition');
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
    const taskCoreRuntime = await import('@/lib/tasks/core/runtime');
    await expect(workerRuntime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'Worker persistence repositories must be registered before worker persistence is accessed',
    );
    await expect(taskCoreRuntime.getTaskCorePersistence()).rejects.toThrow(
      'Task-core persistence has not been registered',
    );

    database.sqlite.prepare('SELECT 1').get();
    await expect(workerRuntime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'Worker persistence repositories must be registered before worker persistence is accessed',
    );
    await expect(taskCoreRuntime.getTaskCorePersistence()).rejects.toThrow(
      'Task-core persistence has not been registered',
    );

    const close = database.sqlite.close.bind(database.sqlite);
    const runtime = await import('@/db/runtime');
    await runtime.initializeRuntimeDatabase();
    await expect(workerRuntime.getWorkerPersistenceRepositories()).resolves.toBeDefined();
    await expect(taskCoreRuntime.getTaskCorePersistence()).resolves.toBeDefined();
    await runtime.shutdownRuntimeDatabase();
    close();
  });

  it('retires a legacy lazy task-core provider without clearing its selected composition', async () => {
    const legacyKey = Symbol.for('mission-control.task-core-persistence-registry');
    const currentKey = Symbol.for('mission-control.task-core-persistence-registry.v2');
    const host = globalThis as typeof globalThis & {
      [legacyKey]?: {
        selected: TaskCorePersistence | null;
        provider: (() => TaskCorePersistence) | null;
        revision: number;
      };
      [currentKey]?: unknown;
    };
    const selected = { marker: 'postgres' } as unknown as TaskCorePersistence;
    const legacyProvider = vi.fn(
      () => ({ marker: 'sqlite' }) as unknown as TaskCorePersistence,
    );
    delete host[currentKey];
    host[legacyKey] = {
      selected,
      provider: legacyProvider,
      revision: 7,
    };
    vi.resetModules();

    const taskCoreRuntime = await import('@/lib/tasks/core/runtime');
    expect(taskCoreRuntime.getRegisteredTaskCorePersistence()).toBe(selected);
    await expect(taskCoreRuntime.getTaskCorePersistence()).resolves.toBe(selected);
    expect(legacyProvider).not.toHaveBeenCalled();

    taskCoreRuntime.clearSelectedTaskCorePersistence(selected);
    await expect(taskCoreRuntime.getTaskCorePersistence()).rejects.toThrow(
      'Task-core persistence has not been registered',
    );
    expect(legacyProvider).not.toHaveBeenCalled();
    delete host[legacyKey];
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

  it('uses initializer-owned teardown delegates after isolated module evaluation', async () => {
    const firstDatabase = await import('@/db');
    const firstRuntime = await import('@/db/runtime');
    await firstRuntime.initializeRuntimeDatabase();
    const closeFirst = firstDatabase.sqlite.close.bind(firstDatabase.sqlite);

    vi.resetModules();
    const secondRuntime = await import('@/db/runtime');
    await secondRuntime.shutdownRuntimeDatabase();
    closeFirst();

    await secondRuntime.initializeRuntimeDatabase();
    const secondDatabase = await import('@/db');
    const syncJobs = await import('@/lib/sync/job-runtime');
    await expect(syncJobs.getSyncJobRepository()).resolves.toBeDefined();
    const closeSecond = secondDatabase.sqlite.close.bind(secondDatabase.sqlite);
    await secondRuntime.shutdownRuntimeDatabase();
    closeSecond();
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
