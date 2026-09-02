import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';

const mocks = vi.hoisted(() => {
  const registerCore = vi.fn();
  const registerWorker = vi.fn();
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
  const workerRepositories: WorkerPersistenceRepositories[] = [];
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
          mergeSettings: vi.fn(async (_id, settings, patch) => ({ ...settings, ...patch })),
          patchSettingsState: vi.fn(async (_id, key, patch) => ({
            settings: { [key]: patch },
            state: patch,
          })),
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
        houstonMemories: {} as CorePersistenceRepositories['houstonMemories'],
      };
      repositories.push(repository);
      return repository;
    }),
    registerWorker,
    workerRepositories,
    createWorker: vi.fn((_db, _pool, core: CorePersistenceRepositories) => {
      const repository: WorkerPersistenceRepositories = {
        connectors: core.connectors,
        syncRuns: {
          listLatestSuccessfulPulls: vi.fn(async () => []),
          append: vi.fn(async () => undefined),
        },
        execution: {} as WorkerPersistenceRepositories['execution'],
        github: {} as WorkerPersistenceRepositories['github'],
        connectorState: {} as WorkerPersistenceRepositories['connectorState'],
        notificationDelivery: {
          getNextWakeAt: vi.fn(async () => null),
        } as unknown as WorkerPersistenceRepositories['notificationDelivery'],
        reminders: {
          cancelInvalidated: vi.fn(async () => 0),
        } as unknown as WorkerPersistenceRepositories['reminders'],
        triage: {
          syncState: {
            getAll: vi.fn(async () => []),
          },
        } as unknown as WorkerPersistenceRepositories['triage'],
        planningSignals: {} as WorkerPersistenceRepositories['planningSignals'],
        projectAutomation: {} as WorkerPersistenceRepositories['projectAutomation'],
        finance: {} as WorkerPersistenceRepositories['finance'],
      };
      workerRepositories.push(repository);
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
  createPostgresCoreRepositories: mocks.createCore,
  createPostgresWorkerPersistenceRepositories: mocks.createWorker,
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
    mocks.workerRepositories.length = 0;
  });

  it('keeps the neutral registration identity stable while replacing the live delegate', async () => {
    const {
      getPostgresCoreRepositories,
      initializeRuntimeDatabase,
      shutdownRuntimeDatabase,
    } = await import('@/db/runtime');

    await initializeRuntimeDatabase();
    const registeredComposition = mocks.registerCore.mock.calls[0][0];
    const registeredWorkerComposition = mocks.registerWorker.mock.calls[0][0];
    await getPostgresCoreRepositories().tasks.get('task-1');
    await registeredWorkerComposition.syncRuns.listLatestSuccessfulPulls();
    await registeredWorkerComposition.notificationDelivery.getNextWakeAt();
    await registeredWorkerComposition.reminders.cancelInvalidated({
      now: new Date(),
      limit: 1,
    });
    await registeredWorkerComposition.triage.syncState.getAll();
    expect(mocks.repositories[0].tasks.get).toHaveBeenCalledWith('task-1');
    expect(mocks.workerRepositories[0].syncRuns.listLatestSuccessfulPulls)
      .toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[0].notificationDelivery.getNextWakeAt)
      .toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[0].reminders.cancelInvalidated).toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[0].triage.syncState.getAll).toHaveBeenCalledOnce();

    await shutdownRuntimeDatabase();
    await initializeRuntimeDatabase();

    expect(mocks.registerCore).toHaveBeenCalledTimes(2);
    expect(mocks.registerCore.mock.calls[1][0]).toBe(registeredComposition);
    expect(mocks.registerWorker.mock.calls[1][0]).toBe(registeredWorkerComposition);
    await getPostgresCoreRepositories().tasks.get('task-1');
    await registeredWorkerComposition.syncRuns.listLatestSuccessfulPulls();
    await registeredWorkerComposition.notificationDelivery.getNextWakeAt();
    await registeredWorkerComposition.reminders.cancelInvalidated({
      now: new Date(),
      limit: 1,
    });
    await registeredWorkerComposition.triage.syncState.getAll();
    expect(mocks.repositories[1].tasks.get).toHaveBeenCalledWith('task-1');
    expect(mocks.workerRepositories[1].syncRuns.listLatestSuccessfulPulls)
      .toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[1].notificationDelivery.getNextWakeAt)
      .toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[1].reminders.cancelInvalidated).toHaveBeenCalledOnce();
    expect(mocks.workerRepositories[1].triage.syncState.getAll).toHaveBeenCalledOnce();
  });
});
