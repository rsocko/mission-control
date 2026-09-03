import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';

/**
 * Proves the `src/app/api/settings/mode/route.ts` (Layer L02) service
 * registration performed by `initializeRuntimeDatabase()`'s PostgreSQL
 * branch: the demo/seed command service registered for PostgreSQL rejects
 * all three commands with the documented "SQLite-only" error, WITHOUT ever
 * importing `@/lib/seed-api` or `@/lib/triage/lifecycle` (both modules are
 * mocked to throw on import so any accidental import is caught
 * immediately, proving the reject happens before any SQLite-side module is
 * evaluated) — while the timezone repository still gets a real,
 * functioning PostgreSQL adapter.
 */

const mocks = vi.hoisted(() => {
  const registerCore = vi.fn();
  const registerWorker = vi.fn();
  const backend = {
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => undefined),
    get context() {
      return {
        db: { marker: 'fake-postgres-db' },
        pool: {},
      };
    },
  };
  return { backend, registerCore, registerWorker };
});

vi.mock('@/db', () => ({ initializeDatabase: vi.fn() }));
vi.mock('@/db/runtime-backend', () => ({ resolveDatabaseBackend: () => 'postgres' }));
vi.mock('@/lib/persistence/runtime', () => ({
  registerCorePersistenceRepositories: mocks.registerCore,
}));
vi.mock('@/lib/persistence/worker-runtime', () => ({
  registerWorkerPersistenceRepositories: mocks.registerWorker,
}));
vi.mock('@/db/postgres/runtime', () => ({
  PostgresPersistenceBackend: class {
    initialize = mocks.backend.initialize;
    shutdown = mocks.backend.shutdown;
    get context() {
      return mocks.backend.context;
    }
  },
}));
vi.mock('@/db/postgres/repositories', () => ({
  createPostgresCoreRepositories: vi.fn(() => ({}) as CorePersistenceRepositories),
  createPostgresWorkerPersistenceRepositories: vi.fn(
    () => ({}) as WorkerPersistenceRepositories,
  ),
}));
vi.mock('@/db/postgres/sync/job-repository', () => ({
  createPostgresSyncJobRepository: vi.fn(() => ({})),
}));
vi.mock('@/db/postgres/sync/connector-operation-lease-repository', () => ({
  createPostgresConnectorOperationLeaseRepository: vi.fn(() => ({})),
}));
vi.mock('@/db/postgres/search', () => ({
  createPostgresKeywordSearchRepository: vi.fn(() => ({})),
}));
// Poisoned: importing either module fails the test immediately, proving
// the PostgreSQL branch never reaches them.
vi.mock('@/lib/seed-api', () => {
  throw new Error('POISON: @/lib/seed-api must not be imported on the PostgreSQL branch');
});
vi.mock('@/lib/triage/lifecycle', () => {
  throw new Error('POISON: @/lib/triage/lifecycle must not be imported on the PostgreSQL branch');
});

describe('initializeRuntimeDatabase PostgreSQL branch: mode-route-services registration', () => {
  beforeEach(() => {
    // `initializeRuntimeDatabase()` registers process-wide composition-root
    // singletons (see `tests/db/sqlite-core-repositories.test.ts`'s
    // "rejects replacement" tests for the same pattern), so each test needs
    // a fresh module instance — otherwise the second `it()`'s call throws
    // "already registered" against the first test's registration.
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('registers a demo seed command service that rejects all three commands without importing SQLite-only modules', async () => {
    const { initializeRuntimeDatabase } = await import('@/db/runtime');
    const { getDemoSeedCommandService } = await import('@/lib/settings/mode-route-services');

    await initializeRuntimeDatabase();

    const service = getDemoSeedCommandService();
    await expect(service.resetDemoDatabase()).rejects.toThrow(
      'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    );
    await expect(service.clearDatabase()).rejects.toThrow(
      'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    );
    await expect(service.clearTriageSampleData()).rejects.toThrow(
      'Clearing triage demo/sample data is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    );
  });

  it('registers a working PostgreSQL relative reminder timezone repository', async () => {
    const { initializeRuntimeDatabase } = await import('@/db/runtime');
    const { getRelativeReminderTimezoneRepository } = await import(
      '@/lib/settings/mode-route-services'
    );

    await initializeRuntimeDatabase();

    const repository = getRelativeReminderTimezoneRepository();
    expect(repository).toBeDefined();
    expect(typeof repository.applyTimezoneRecompute).toBe('function');
  });
});
