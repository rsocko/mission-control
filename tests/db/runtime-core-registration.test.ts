import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';

const mocks = vi.hoisted(() => {
  const registerCore = vi.fn();
  const backend = {
    generation: 0,
    initialize: vi.fn(async () => {
      backend.generation++;
    }),
    shutdown: vi.fn(async () => undefined),
    get context() {
      return {
        db: { generation: backend.generation },
        pool: { generation: backend.generation },
      };
    },
  };
  const repositories: CorePersistenceRepositories[] = [];
  return {
    backend,
    registerCore,
    repositories,
    createCore: vi.fn(() => {
      const repository: CorePersistenceRepositories = {
        tasks: {
          get: vi.fn(async () => null),
          upsert: vi.fn(async (task) => task),
          delete: vi.fn(async () => false),
        },
        projects: {
          get: vi.fn(async () => null),
          upsert: vi.fn(async (project) => project),
          delete: vi.fn(async () => false),
        },
        connectors: {
          get: vi.fn(async () => null),
          upsert: vi.fn(async (connector) => connector),
          delete: vi.fn(async () => false),
        },
        notifications: {
          get: vi.fn(async () => null),
          upsert: vi.fn(async (notification) => notification),
          delete: vi.fn(async () => false),
        },
        settings: {
          get: vi.fn(async () => null),
          set: vi.fn(async () => undefined),
          delete: vi.fn(async () => false),
        },
      };
      repositories.push(repository);
      return repository;
    }),
  };
});

vi.mock('@/db', () => ({
  initializeDatabase: vi.fn(),
}));
vi.mock('@/db/runtime-backend', () => ({
  resolveDatabaseBackend: () => 'postgres',
}));
vi.mock('@/lib/persistence/runtime', () => ({
  registerCorePersistenceRepositories: mocks.registerCore,
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
  createPostgresCoreRepositories: mocks.createCore,
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

describe('PostgreSQL runtime core repository registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backend.generation = 0;
    mocks.repositories.length = 0;
  });

  it('keeps the neutral registration identity stable while replacing the live delegate', async () => {
    const {
      getPostgresCoreRepositories,
      initializeRuntimeDatabase,
      shutdownRuntimeDatabase,
    } = await import('@/db/runtime');

    await initializeRuntimeDatabase();
    const registeredComposition = mocks.registerCore.mock.calls[0][0];
    await getPostgresCoreRepositories().tasks.get('task-1');
    expect(mocks.repositories[0].tasks.get).toHaveBeenCalledWith('task-1');

    await shutdownRuntimeDatabase();
    await initializeRuntimeDatabase();

    expect(mocks.registerCore).toHaveBeenCalledTimes(2);
    expect(mocks.registerCore.mock.calls[1][0]).toBe(registeredComposition);
    await getPostgresCoreRepositories().tasks.get('task-1');
    expect(mocks.repositories[1].tasks.get).toHaveBeenCalledWith('task-1');
  });
});
