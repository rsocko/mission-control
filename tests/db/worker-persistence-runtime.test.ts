import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';

function createWorkerRepositories(): WorkerPersistenceRepositories {
  return {
    connectors: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async (connector) => connector),
      delete: vi.fn(async () => false),
      mergeSettings: vi.fn(async (_id, settings, patch) => ({ ...settings, ...patch })),
      patchSettingsState: vi.fn(async (_id, key, patch) => ({
        settings: { [key]: patch },
        state: patch,
      })),
    },
    syncRuns: {
      listLatestSuccessfulPulls: vi.fn(async () => []),
      append: vi.fn(async () => undefined),
    },
    execution: {} as WorkerPersistenceRepositories['execution'],
  };
}

afterEach(() => {
  vi.doUnmock('@/db');
  vi.doUnmock('@/db/runtime-backend');
  vi.doUnmock('@/db/persistence/sqlite-core-repositories');
  vi.doUnmock('@/db/persistence/sqlite-sync-run-repository');
  vi.doUnmock('@/db/persistence/sqlite-connector-execution-repositories');
  vi.resetModules();
});

describe('worker persistence runtime', () => {
  it('does not evaluate SQLite adapters until SQLite persistence is accessed', async () => {
    const repositories = createWorkerRepositories();
    const databaseModule = vi.fn(() => ({ default: {}, sqlite: {} }));
    const coreModule = vi.fn(() => ({
      sqliteCorePersistenceRepositories: {
        connectors: repositories.connectors,
      },
    }));
    const syncRunModule = vi.fn(() => ({
      SqliteSyncRunRepository: class {
        listLatestSuccessfulPulls = repositories.syncRuns.listLatestSuccessfulPulls;
        append = repositories.syncRuns.append;
      },
    }));
    const executionModule = vi.fn(() => ({
      createSqliteConnectorExecutionRepositories: () => repositories.execution,
    }));
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'sqlite',
    }));
    vi.doMock('@/db', databaseModule);
    vi.doMock('@/db/persistence/sqlite-core-repositories', coreModule);
    vi.doMock('@/db/persistence/sqlite-sync-run-repository', syncRunModule);
    vi.doMock('@/db/persistence/sqlite-connector-execution-repositories', executionModule);

    const runtime = await import('@/lib/persistence/worker-runtime');

    expect(databaseModule).not.toHaveBeenCalled();
    expect(coreModule).not.toHaveBeenCalled();
    expect(syncRunModule).not.toHaveBeenCalled();
    expect(executionModule).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      runtime.getWorkerPersistenceRepositories(),
      runtime.getWorkerPersistenceRepositories(),
    ]);

    expect(first).toBe(second);
    expect(first.connectors).toBe(repositories.connectors);
    expect(databaseModule).toHaveBeenCalledOnce();
    expect(coreModule).toHaveBeenCalledOnce();
    expect(syncRunModule).toHaveBeenCalledOnce();
    expect(executionModule).toHaveBeenCalledOnce();
  });

  it('fails closed before PostgreSQL registration without evaluating SQLite', async () => {
    const databaseModule = vi.fn(() => {
      throw new Error('SQLite must not be evaluated');
    });
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'postgres',
    }));
    vi.doMock('@/db', databaseModule);

    const runtime = await import('@/lib/persistence/worker-runtime');

    await expect(runtime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'PostgreSQL worker repositories must be registered before worker persistence is accessed',
    );
    expect(databaseModule).not.toHaveBeenCalled();
    expect(() => runtime.registerWorkerPersistenceRepositories(createWorkerRepositories()))
      .toThrow('Worker persistence repositories are already selected');
  });

  it('keeps a registered PostgreSQL composition stable', async () => {
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'postgres',
    }));
    const runtime = await import('@/lib/persistence/worker-runtime');
    const selected = createWorkerRepositories();

    runtime.registerWorkerPersistenceRepositories(selected);

    await expect(runtime.getWorkerPersistenceRepositories()).resolves.toBe(selected);
    expect(() => runtime.registerWorkerPersistenceRepositories(selected)).not.toThrow();
    expect(() => runtime.registerWorkerPersistenceRepositories(createWorkerRepositories()))
      .toThrow('Worker persistence repositories are already selected');
  });
});
