import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAiRunRepository } from '@/lib/ai/durable-runs/repository';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';

const mocks = vi.hoisted(() => {
  const registerCore = vi.fn();
  const registerWorker = vi.fn();
  const clearCore = vi.fn();
  const clearWorker = vi.fn();
  const registerConnectorRuntime = vi.fn();
  const resumeSemantic = vi.fn();
  const stopSemantic = vi.fn(async () => undefined);
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
    clearCore,
    clearWorker,
    registerConnectorRuntime,
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
          listEnabled: vi.fn(async () => []),
          upsert: vi.fn(async (connector) => connector),
          updateCredentials: vi.fn(async () => undefined),
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
    resumeSemantic,
    stopSemantic,
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
        eventDelivery: {} as WorkerPersistenceRepositories['eventDelivery'],
        notificationEntityLinking:
          {} as WorkerPersistenceRepositories['notificationEntityLinking'],
        notificationEnrichment: {} as WorkerPersistenceRepositories['notificationEnrichment'],
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
vi.mock('@/lib/connectors', () => {
  throw new Error('Runtime initialization evaluated the connector domain barrel');
});
vi.mock('@/lib/connectors/registry-runtime', () => ({
  assertCanRegisterConnectorRuntimeRegistry: vi.fn(),
  registerConnectorRuntimeRegistry: mocks.registerConnectorRuntime,
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  assertCanRegisterSemanticPublicationService: vi.fn(),
  registerSemanticPublicationService: vi.fn(),
}));
vi.mock('@/lib/persistence/runtime', () => ({
  clearCorePersistenceRepositories: mocks.clearCore,
  registerCorePersistenceRepositories: mocks.registerCore,
}));
vi.mock('@/lib/persistence/worker-runtime', () => ({
  clearWorkerPersistenceRepositories: mocks.clearWorker,
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
vi.mock('@/lib/semantic-index/packaged-worker-runtime', () => ({
  resumePackagedPostgresSemanticRuntime: mocks.resumeSemantic,
  stopPackagedPostgresSemanticWorker: mocks.stopSemantic,
}));

describe('PostgreSQL runtime core repository registration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.backend.generation = 0;
    mocks.repositories.length = 0;
    mocks.workerRepositories.length = 0;
  });

  it('keeps the neutral registration identity stable while replacing the live delegate', async () => {
    const {
      getPostgresCoreRepositories,
      getPostgresSyncJobRepository,
      initializeRuntimeDatabase,
      registerPostgresSyncJobRepository,
      shutdownRuntimeDatabase,
    } = await import('@/db/runtime');

    await Promise.all([
      initializeRuntimeDatabase(),
      initializeRuntimeDatabase(),
    ]);
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
    expect(mocks.backend.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.registerCore).toHaveBeenCalledTimes(1);
    expect(mocks.registerWorker).toHaveBeenCalledTimes(1);
    expect(mocks.registerConnectorRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSemantic).toHaveBeenCalledTimes(1);

    await shutdownRuntimeDatabase();
    expect(mocks.stopSemantic).toHaveBeenCalledOnce();
    expect(mocks.stopSemantic.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.backend.shutdown.mock.invocationCallOrder[0],
    );
    await initializeRuntimeDatabase();

    expect(mocks.registerCore).toHaveBeenCalledTimes(2);
    expect(mocks.registerCore.mock.calls[1][0]).toBe(registeredComposition);
    expect(mocks.registerWorker.mock.calls[1][0]).toBe(registeredWorkerComposition);
    expect(mocks.resumeSemantic).toHaveBeenCalledTimes(2);
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

    mocks.stopSemantic.mockRejectedValueOnce(new Error('semantic stop failed'));
    mocks.backend.shutdown.mockRejectedValueOnce(new Error('backend stop failed'));
    await expect(shutdownRuntimeDatabase()).rejects.toThrow('PostgreSQL runtime shutdown failed');
    expect(mocks.stopSemantic).toHaveBeenCalledTimes(2);
    expect(mocks.backend.shutdown).toHaveBeenCalledTimes(2);
    expect(() => registeredComposition.tasks.get('fenced-task')).toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
    expect(() => getPostgresSyncJobRepository()).toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
    expect(() => registerPostgresSyncJobRepository({} as SyncJobRepository)).toThrow(
      'Persistence composition publication is blocked until initializeRuntimeDatabase()',
    );
    const durableRuntime = await import('@/lib/ai/durable-runs/runtime');
    const replacementDurableRepository = {} as DurableAiRunRepository;
    await expect(durableRuntime.getDurableAiRunRepository()).rejects.toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
    expect(() => (
      durableRuntime.registerPostgresDurableAiRunRepository(replacementDurableRepository)
    )).toThrow(
      'Persistence composition publication is blocked until initializeRuntimeDatabase()',
    );

    let finishCleanup!: () => void;
    mocks.backend.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCleanup = resolve;
    }));
    const reinitialize = initializeRuntimeDatabase();
    expect(initializeRuntimeDatabase()).toBe(reinitialize);
    await vi.waitFor(() => expect(finishCleanup).toBeTypeOf('function'));
    expect(mocks.backend.initialize).toHaveBeenCalledTimes(2);
    finishCleanup();
    await reinitialize;
    expect(mocks.stopSemantic).toHaveBeenCalledTimes(3);
    expect(mocks.backend.shutdown).toHaveBeenCalledTimes(3);
    expect(mocks.backend.initialize).toHaveBeenCalledTimes(3);
    expect(mocks.registerCore).toHaveBeenCalledTimes(3);
    expect(mocks.registerWorker).toHaveBeenCalledTimes(3);
    expect(mocks.resumeSemantic).toHaveBeenCalledTimes(3);
    const selectedDurableRepository = await durableRuntime.getDurableAiRunRepository();
    durableRuntime.clearPostgresDurableAiRunRepository(replacementDurableRepository);
    expect(await durableRuntime.getDurableAiRunRepository()).toBe(selectedDurableRepository);
  });

  it('fences access immediately while failed initialization cleanup is unresolved', async () => {
    const {
      getPostgresSyncJobRepository,
      initializeRuntimeDatabase,
      registerPostgresSyncJobRepository,
      shutdownRuntimeDatabase,
    } = await import('@/db/runtime');
    let finishCleanup!: () => void;
    mocks.resumeSemantic.mockImplementationOnce(() => {
      throw new Error('semantic resume failed');
    });
    mocks.backend.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCleanup = resolve;
    }));

    const initialization = initializeRuntimeDatabase();
    await vi.waitFor(() => expect(mocks.resumeSemantic).toHaveBeenCalledOnce());

    expect(() => getPostgresSyncJobRepository()).toThrow(
      'Persistence composition is unavailable until initializeRuntimeDatabase() completes',
    );
    expect(() => registerPostgresSyncJobRepository({} as SyncJobRepository)).toThrow(
      'Persistence composition publication is blocked until initializeRuntimeDatabase()',
    );
    expect(initializeRuntimeDatabase()).toBe(initialization);
    expect(mocks.backend.initialize).toHaveBeenCalledOnce();

    finishCleanup();
    await expect(initialization).rejects.toThrow('semantic resume failed');

    await expect(initializeRuntimeDatabase()).resolves.toBeUndefined();
    await shutdownRuntimeDatabase();
  });
});
