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
    github: {
      identity: {},
      writeFence: {},
      dependencies: {},
      hierarchy: {},
      projects: {},
    } as WorkerPersistenceRepositories['github'],
    connectorState: {
      workTodo: {},
    } as WorkerPersistenceRepositories['connectorState'],
    finance: {
      identity: {},
      snapshots: {},
      datasets: {},
      attribution: {},
    } as WorkerPersistenceRepositories['finance'],
  };
}

afterEach(() => {
  vi.doUnmock('@/db');
  vi.doUnmock('@/db/runtime-backend');
  vi.doUnmock('@/db/persistence/sqlite-core-repositories');
  vi.doUnmock('@/db/persistence/sqlite-sync-run-repository');
  vi.doUnmock('@/db/persistence/sqlite-connector-execution-repositories');
  vi.doUnmock('@/db/persistence/sqlite-github-identity-repositories');
  vi.doUnmock('@/db/persistence/sqlite-github-dependency-repositories');
  vi.doUnmock('@/db/persistence/sqlite-github-hierarchy-repositories');
  vi.doUnmock('@/db/persistence/sqlite-github-project-repositories');
  vi.doUnmock('@/db/persistence/sqlite-work-todo-repositories');
  vi.doUnmock('@/db/persistence/sqlite-finance-worker-repositories');
  vi.doUnmock('@/lib/finance-insights/publication');
  vi.doUnmock('@/lib/finance-insights/canonical');
  vi.doUnmock('@/lib/connectors/monarch-money/constants');
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
    const githubIdentityModule = vi.fn(() => ({
      createSqliteGitHubIdentityRepositories: () => ({
        identity: repositories.github.identity,
        writeFence: repositories.github.writeFence,
      }),
    }));
    const githubDependencyModule = vi.fn(() => ({
      createSqliteGitHubDependencyRepositories: () => repositories.github.dependencies,
    }));
    const githubHierarchyModule = vi.fn(() => ({
      createSqliteGitHubHierarchyRepositories: () => repositories.github.hierarchy,
    }));
    const githubProjectModule = vi.fn(() => ({
      createSqliteGitHubProjectRepositories: () => repositories.github.projects,
    }));
    const workTodoModule = vi.fn(() => ({
      createSqliteWorkTodoRepositories: () => repositories.connectorState.workTodo,
    }));
    const financeModule = vi.fn(() => ({
      createSqliteFinanceWorkerPersistence: () => repositories.finance,
    }));
    const publicationModule = vi.fn(() => ({
      loadFinanceInsightProjectionFacts: vi.fn(),
    }));
    const canonicalModule = vi.fn(() => ({
      financeInsightDigestV1: vi.fn(),
    }));
    const constantsModule = vi.fn(() => ({
      MONARCH_BRIDGE_CONTRACT_VERSION: 'bridge-v1',
    }));
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'sqlite',
    }));
    vi.doMock('@/db', databaseModule);
    vi.doMock('@/db/persistence/sqlite-core-repositories', coreModule);
    vi.doMock('@/db/persistence/sqlite-sync-run-repository', syncRunModule);
    vi.doMock('@/db/persistence/sqlite-connector-execution-repositories', executionModule);
    vi.doMock('@/db/persistence/sqlite-github-identity-repositories', githubIdentityModule);
    vi.doMock('@/db/persistence/sqlite-github-dependency-repositories', githubDependencyModule);
    vi.doMock('@/db/persistence/sqlite-github-hierarchy-repositories', githubHierarchyModule);
    vi.doMock('@/db/persistence/sqlite-github-project-repositories', githubProjectModule);
    vi.doMock('@/db/persistence/sqlite-work-todo-repositories', workTodoModule);
    vi.doMock('@/db/persistence/sqlite-finance-worker-repositories', financeModule);
    vi.doMock('@/lib/finance-insights/publication', publicationModule);
    vi.doMock('@/lib/finance-insights/canonical', canonicalModule);
    vi.doMock('@/lib/connectors/monarch-money/constants', constantsModule);

    const runtime = await import('@/lib/persistence/worker-runtime');

    expect(databaseModule).not.toHaveBeenCalled();
    expect(coreModule).not.toHaveBeenCalled();
    expect(syncRunModule).not.toHaveBeenCalled();
    expect(executionModule).not.toHaveBeenCalled();
    expect(githubIdentityModule).not.toHaveBeenCalled();
    expect(githubDependencyModule).not.toHaveBeenCalled();
    expect(githubHierarchyModule).not.toHaveBeenCalled();
    expect(githubProjectModule).not.toHaveBeenCalled();
    expect(workTodoModule).not.toHaveBeenCalled();
    expect(financeModule).not.toHaveBeenCalled();
    expect(publicationModule).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      runtime.getWorkerPersistenceRepositories(),
      runtime.getWorkerPersistenceRepositories(),
    ]);

    expect(first).toBe(second);
    expect(first.connectors).toBe(repositories.connectors);
    expect(first.github.identity).toBe(repositories.github.identity);
    expect(first.github.writeFence).toBe(repositories.github.writeFence);
    expect(first.github.dependencies).toBe(repositories.github.dependencies);
    expect(first.github.hierarchy).toBe(repositories.github.hierarchy);
    expect(first.github.projects).toBe(repositories.github.projects);
    expect(first.connectorState.workTodo).toBe(repositories.connectorState.workTodo);
    expect(first.finance).toBe(repositories.finance);
    expect(databaseModule).toHaveBeenCalledOnce();
    expect(coreModule).toHaveBeenCalledOnce();
    expect(syncRunModule).toHaveBeenCalledOnce();
    expect(executionModule).toHaveBeenCalledOnce();
    expect(githubIdentityModule).toHaveBeenCalledOnce();
    expect(githubDependencyModule).toHaveBeenCalledOnce();
    expect(githubHierarchyModule).toHaveBeenCalledOnce();
    expect(githubProjectModule).toHaveBeenCalledOnce();
    expect(workTodoModule).toHaveBeenCalledOnce();
    expect(financeModule).toHaveBeenCalledOnce();
    expect(publicationModule).toHaveBeenCalledOnce();
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
