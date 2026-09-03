import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';
import type { ConnectorOperationLeaseRepository } from '@/lib/sync/connector-operation-lease-repository';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import type { SemanticIndexRepository } from '@/lib/semantic-index/contracts';
import type { SemanticSourcePort } from '@/lib/semantic-index/source/contracts';
import type { DurableAiRunRepository } from '@/lib/ai/durable-runs/repository';
import {
  clearKeywordSearchRepository,
  registerKeywordSearchRepository,
} from '@/lib/search/keyword-runtime';
import {
  clearAIEnrichmentService,
  registerAIEnrichmentService,
  type AIEnrichmentService,
} from '@/lib/notifications/enrichment/ai-enrichment-service';
import {
  clearPostgresDurableAiRunRepository,
  registerPostgresDurableAiRunRepository,
} from '@/lib/ai/durable-runs/runtime';
import { PostgresDurableAiRunRepository } from '@/lib/ai/durable-runs/postgres-adapter';
import {
  clearCorePersistenceRepositories,
  registerCorePersistenceRepositories,
} from '@/lib/persistence/runtime';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
  beginPersistenceCompositionInitialization,
  blockPersistenceComposition,
  completePersistenceCompositionInitialization,
} from '@/lib/persistence/composition-lifecycle';
import {
  clearWorkerPersistenceRepositories,
  registerWorkerPersistenceRepositories,
} from '@/lib/persistence/worker-runtime';
import { PostgresPersistenceBackend } from './postgres/runtime';
import { resolveDatabaseBackend } from './runtime-backend';
import {
  createPostgresCoreRepositories,
  createPostgresWorkerPersistenceRepositories,
} from './postgres/repositories';
import { createPostgresConnectorOperationLeaseRepository } from './postgres/sync/connector-operation-lease-repository';
import { createPostgresSyncJobRepository } from './postgres/sync/job-repository';
import { createPostgresAIEnrichmentService } from './postgres/sync/notification-enrichment-service';
import { createPostgresKeywordSearchRepository } from './postgres/search';
import { createPostgresSemanticIndexRepository } from './postgres/semantic-index/repository';
import { createPostgresSemanticSourcePort } from './postgres/semantic-index/source-port';

const postgresBackend = new PostgresPersistenceBackend();
let postgresRepositories: CorePersistenceRepositories | null = null;
let postgresWorkerRepositories: WorkerPersistenceRepositories | null = null;
let postgresSyncJobRepository: SyncJobRepository | null = null;
let postgresConnectorOperationLeaseRepository: ConnectorOperationLeaseRepository | null = null;
let postgresKeywordSearchRepository: KeywordSearchRepository | null = null;
let postgresSemanticIndexRepository: SemanticIndexRepository | null = null;
let postgresSemanticSourcePort: SemanticSourcePort | null = null;
let postgresDurableAiRunRepository: DurableAiRunRepository | null = null;
let postgresAIEnrichmentService: AIEnrichmentService | null = null;
let runtimeInitialized = false;
let runtimeInitializationPromise: Promise<void> | null = null;
let runtimeShutdownPromise: Promise<void> | null = null;
let runtimePostShutdownInitializationPromise: Promise<void> | null = null;
let runtimeCleanupRequired = false;

function clearPostgresRuntimeComposition(): void {
  if (postgresWorkerRepositories) {
    clearWorkerPersistenceRepositories(postgresWorkerPersistenceRepositories);
  }
  if (postgresRepositories) {
    clearCorePersistenceRepositories(postgresCorePersistenceRepositories);
  }
  if (postgresKeywordSearchRepository) {
    clearKeywordSearchRepository(postgresKeywordSearchRepository);
  }
  if (postgresAIEnrichmentService) {
    clearAIEnrichmentService(postgresAIEnrichmentService);
  }
  if (postgresDurableAiRunRepository) {
    clearPostgresDurableAiRunRepository(postgresDurableAiRunRepository);
  }
  postgresRepositories = null;
  postgresWorkerRepositories = null;
  postgresSyncJobRepository = null;
  postgresConnectorOperationLeaseRepository = null;
  postgresKeywordSearchRepository = null;
  postgresSemanticIndexRepository = null;
  postgresSemanticSourcePort = null;
  postgresDurableAiRunRepository = null;
  postgresAIEnrichmentService = null;
}

function requirePostgresRepositories(): CorePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresRepositories) {
    throw new Error('PostgreSQL core repositories have not been registered');
  }
  return postgresRepositories;
}

function requirePostgresWorkerRepositories(): WorkerPersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresWorkerRepositories) {
    throw new Error('PostgreSQL worker repositories have not been registered');
  }
  return postgresWorkerRepositories;
}

const postgresCorePersistenceRepositories: CorePersistenceRepositories = {
  tasks: {
    get: (id) => requirePostgresRepositories().tasks.get(id),
    upsert: (task) => requirePostgresRepositories().tasks.upsert(task),
    delete: (id) => requirePostgresRepositories().tasks.delete(id),
  },
  projects: {
    get: (id) => requirePostgresRepositories().projects.get(id),
    upsert: (project) => requirePostgresRepositories().projects.upsert(project),
    delete: (id) => requirePostgresRepositories().projects.delete(id),
  },
  connectors: {
    listEnabled: () => requirePostgresRepositories().connectors.listEnabled(),
    get: (id) => requirePostgresRepositories().connectors.get(id),
    upsert: (connector) => requirePostgresRepositories().connectors.upsert(connector),
    updateCredentials: (id, credentials, settings) => (
      requirePostgresRepositories().connectors.updateCredentials(id, credentials, settings)
    ),
    delete: (id) => requirePostgresRepositories().connectors.delete(id),
    mergeSettings: (id, currentSettings, patch) => (
      requirePostgresRepositories().connectors.mergeSettings(id, currentSettings, patch)
    ),
    patchSettingsState: (id, key, patch) => (
      requirePostgresRepositories().connectors.patchSettingsState(id, key, patch)
    ),
  },
  notifications: {
    get: (id) => requirePostgresRepositories().notifications.get(id),
    upsert: (notification) => requirePostgresRepositories().notifications.upsert(notification),
    delete: (id) => requirePostgresRepositories().notifications.delete(id),
  },
  settings: {
    get: (key) => requirePostgresRepositories().settings.get(key),
    set: (key, value) => requirePostgresRepositories().settings.set(key, value),
    delete: (key) => requirePostgresRepositories().settings.delete(key),
  },
  houstonMemories: {
    get: (id, authorizationScope) => (
      requirePostgresRepositories().houstonMemories.get(id, authorizationScope)
    ),
    list: (input) => requirePostgresRepositories().houstonMemories.list(input),
    upsert: (input) => requirePostgresRepositories().houstonMemories.upsert(input),
    exclude: (id, authorizationScope, now) => (
      requirePostgresRepositories().houstonMemories.exclude(id, authorizationScope, now)
    ),
    delete: (id, authorizationScope) => (
      requirePostgresRepositories().houstonMemories.delete(id, authorizationScope)
    ),
    deleteExpired: (now, limit) => (
      requirePostgresRepositories().houstonMemories.deleteExpired(now, limit)
    ),
  },
};

const postgresWorkerPersistenceRepositories: WorkerPersistenceRepositories = {
  connectors: postgresCorePersistenceRepositories.connectors,
  syncRuns: {
    listLatestSuccessfulPulls: () => (
      requirePostgresWorkerRepositories().syncRuns.listLatestSuccessfulPulls()
    ),
    append: (record) => requirePostgresWorkerRepositories().syncRuns.append(record),
  },
  execution: new Proxy({} as WorkerPersistenceRepositories['execution'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().execution[
        property as keyof WorkerPersistenceRepositories['execution']
      ]
    ),
  }),
  github: new Proxy({} as WorkerPersistenceRepositories['github'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().github[
        property as keyof WorkerPersistenceRepositories['github']
      ]
    ),
  }),
  connectorState: new Proxy({} as WorkerPersistenceRepositories['connectorState'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().connectorState[
        property as keyof WorkerPersistenceRepositories['connectorState']
      ]
    ),
  }),
  notificationDelivery: new Proxy({} as WorkerPersistenceRepositories['notificationDelivery'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().notificationDelivery[
        property as keyof WorkerPersistenceRepositories['notificationDelivery']
      ]
    ),
  }),
  reminders: new Proxy({} as WorkerPersistenceRepositories['reminders'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().reminders[
        property as keyof WorkerPersistenceRepositories['reminders']
      ]
    ),
  }),
  triage: new Proxy({} as WorkerPersistenceRepositories['triage'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().triage[
        property as keyof WorkerPersistenceRepositories['triage']
      ]
    ),
  }),
  planningSignals: new Proxy({} as WorkerPersistenceRepositories['planningSignals'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().planningSignals[
        property as keyof WorkerPersistenceRepositories['planningSignals']
      ]
    ),
  }),
  projectAutomation: new Proxy({} as WorkerPersistenceRepositories['projectAutomation'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().projectAutomation[
        property as keyof WorkerPersistenceRepositories['projectAutomation']
      ]
    ),
  }),
  eventDelivery: {
    subscriptions: new Proxy(
      {} as WorkerPersistenceRepositories['eventDelivery']['subscriptions'],
      {
        get: (_target, property) => (
          requirePostgresWorkerRepositories().eventDelivery.subscriptions[
            property as keyof WorkerPersistenceRepositories['eventDelivery']['subscriptions']
          ]
        ),
      },
    ),
    outbox: new Proxy({} as WorkerPersistenceRepositories['eventDelivery']['outbox'], {
      get: (_target, property) => (
        requirePostgresWorkerRepositories().eventDelivery.outbox[
          property as keyof WorkerPersistenceRepositories['eventDelivery']['outbox']
        ]
      ),
    }),
  },
  notificationEntityLinking: new Proxy(
    {} as WorkerPersistenceRepositories['notificationEntityLinking'],
    {
      get: (_target, property) => (
        requirePostgresWorkerRepositories().notificationEntityLinking[
          property as keyof WorkerPersistenceRepositories['notificationEntityLinking']
        ]
      ),
    },
  ),
  notificationEnrichment: new Proxy(
    {} as WorkerPersistenceRepositories['notificationEnrichment'],
    {
      get: (_target, property) => (
        requirePostgresWorkerRepositories().notificationEnrichment[
          property as keyof WorkerPersistenceRepositories['notificationEnrichment']
        ]
      ),
    },
  ),
  finance: new Proxy({} as WorkerPersistenceRepositories['finance'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().finance[
        property as keyof WorkerPersistenceRepositories['finance']
      ]
    ),
  }),
};

/**
 * Initializes the selected persistence backend. For PostgreSQL, this also
 * instantiates and registers the portable-contract adapters
 * (`createPostgresCoreRepositories`, `createPostgresSyncJobRepository`,
 * `createPostgresConnectorOperationLeaseRepository`, the worker persistence
 * composition — which includes the atomic
 * `createPostgresGitHubWorkerRepositories` GitHub and Layer 5A finance
 * compositions —
 * `createPostgresKeywordSearchRepository`,
 * `createPostgresSemanticIndexRepository`, and
 * `createPostgresSemanticSourcePort`) from the freshly-initialized
 * `PostgresDatabase`/`Pool` handles, so `getPostgresCoreRepositories` and its
 * siblings below are guaranteed to be populated as soon as this resolves.
 * SQLite loads the same composition through its backend-selected startup path.
 */
async function initializeRuntimeDatabaseOnce(): Promise<void> {
  if (resolveDatabaseBackend() === 'sqlite') {
    const { initializeSqlitePersistenceComposition } = await import('./index');
    await initializeSqlitePersistenceComposition();
    return;
  }
  await postgresBackend.initialize();
  const { db, pool, vector } = postgresBackend.context;
  postgresRepositories = createPostgresCoreRepositories(db);
  registerCorePersistenceRepositories(postgresCorePersistenceRepositories);
  postgresWorkerRepositories = createPostgresWorkerPersistenceRepositories(
    db,
    pool,
    postgresRepositories,
  );
  registerWorkerPersistenceRepositories(postgresWorkerPersistenceRepositories);
  postgresSyncJobRepository = createPostgresSyncJobRepository(pool);
  postgresConnectorOperationLeaseRepository = createPostgresConnectorOperationLeaseRepository(pool);
  postgresKeywordSearchRepository = createPostgresKeywordSearchRepository(pool);
  registerKeywordSearchRepository(postgresKeywordSearchRepository);
  postgresAIEnrichmentService = createPostgresAIEnrichmentService();
  registerAIEnrichmentService(postgresAIEnrichmentService);
  postgresSemanticIndexRepository = createPostgresSemanticIndexRepository(pool, vector);
  postgresSemanticSourcePort = createPostgresSemanticSourcePort(pool);
  postgresDurableAiRunRepository = new PostgresDurableAiRunRepository(pool);
  registerPostgresDurableAiRunRepository(postgresDurableAiRunRepository);
  const { resumePackagedPostgresSemanticRuntime } = await import(
    '@/lib/semantic-index/packaged-worker-runtime'
  );
  resumePackagedPostgresSemanticRuntime();
}

export function initializeRuntimeDatabase(): Promise<void> {
  if (runtimeShutdownPromise) {
    return initializeRuntimeDatabaseAfterShutdown(runtimeShutdownPromise);
  }
  if (runtimePostShutdownInitializationPromise) {
    return runtimePostShutdownInitializationPromise;
  }
  if (runtimeCleanupRequired) {
    const shutdown = shutdownRuntimeDatabase();
    return initializeRuntimeDatabaseAfterShutdown(shutdown);
  }
  if (runtimeInitialized) return Promise.resolve();
  if (runtimeInitializationPromise) return runtimeInitializationPromise;

  beginPersistenceCompositionInitialization();
  runtimeInitializationPromise = initializeRuntimeDatabaseOnce()
    .then(() => {
      completePersistenceCompositionInitialization();
      runtimeInitialized = true;
    })
    .catch(async (error) => {
      blockPersistenceComposition();
      try {
        if (resolveDatabaseBackend() === 'postgres') {
          try {
            await postgresBackend.shutdown();
            runtimeCleanupRequired = false;
          } catch (cleanupError) {
            runtimeCleanupRequired = true;
            throw new AggregateError(
              [error, cleanupError],
              'PostgreSQL runtime initialization cleanup failed',
              { cause: error },
            );
          } finally {
            clearPostgresRuntimeComposition();
          }
        }
        throw error;
      } finally {
        blockPersistenceComposition();
      }
    })
    .finally(() => {
      runtimeInitializationPromise = null;
    });
  return runtimeInitializationPromise;
}

function initializeRuntimeDatabaseAfterShutdown(shutdown: Promise<void>): Promise<void> {
  if (runtimePostShutdownInitializationPromise) {
    return runtimePostShutdownInitializationPromise;
  }
  let queued: Promise<void>;
  queued = shutdown.then(() => {
    if (runtimePostShutdownInitializationPromise === queued) {
      runtimePostShutdownInitializationPromise = null;
    }
    return initializeRuntimeDatabase();
  }, (error) => {
    if (runtimePostShutdownInitializationPromise === queued) {
      runtimePostShutdownInitializationPromise = null;
    }
    throw error;
  });
  runtimePostShutdownInitializationPromise = queued;
  return queued;
}

export function shutdownRuntimeDatabase(): Promise<void> {
  blockPersistenceComposition();
  if (runtimeShutdownPromise) return runtimeShutdownPromise;

  runtimeShutdownPromise = (async () => {
    if (runtimeInitializationPromise) {
      await runtimeInitializationPromise.catch(() => undefined);
    }
    if (resolveDatabaseBackend() === 'postgres') {
      const shutdownErrors: unknown[] = [];
      try {
        const { stopPackagedPostgresSemanticWorker } = await import(
          '@/lib/semantic-index/packaged-worker-runtime'
        );
        await stopPackagedPostgresSemanticWorker();
      } catch (error) {
        shutdownErrors.push(error);
      }
      try {
        await postgresBackend.shutdown();
      } catch (error) {
        shutdownErrors.push(error);
      } finally {
        clearPostgresRuntimeComposition();
        runtimeInitialized = false;
      }
      runtimeCleanupRequired = shutdownErrors.length > 0;
      if (shutdownErrors.length === 1) throw shutdownErrors[0];
      if (shutdownErrors.length > 1) {
        throw new AggregateError(shutdownErrors, 'PostgreSQL runtime shutdown failed');
      }
      return;
    }
    try {
      const { shutdownSqlitePersistenceComposition } = await import('./index');
      await shutdownSqlitePersistenceComposition();
      runtimeCleanupRequired = false;
      runtimeInitialized = false;
    } catch (error) {
      runtimeCleanupRequired = true;
      throw error;
    }
  })().finally(() => {
    runtimeShutdownPromise = null;
  });
  return runtimeShutdownPromise;
}

export function getPostgresPersistenceBackend(): PostgresPersistenceBackend {
  assertPersistenceCompositionAccessAllowed();
  if (resolveDatabaseBackend() !== 'postgres') {
    throw new Error('PostgreSQL persistence is not selected');
  }
  return postgresBackend;
}

/**
 * Explicit override hook (primarily for tests): callers do not need to
 * invoke this in production — `initializeRuntimeDatabase` registers the
 * PostgreSQL core repositories automatically once the backend is ready.
 */
export function registerPostgresCoreRepositories(
  repositories: CorePersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresRepositories = repositories;
  registerCorePersistenceRepositories(postgresCorePersistenceRepositories);
}

export function getPostgresCoreRepositories(): CorePersistenceRepositories {
  return requirePostgresRepositories();
}

export function getPostgresWorkerPersistenceRepositories(): WorkerPersistenceRepositories {
  return requirePostgresWorkerRepositories();
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresSyncJobRepository(repository: SyncJobRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresSyncJobRepository = repository;
}

export function getPostgresSyncJobRepository(): SyncJobRepository {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresSyncJobRepository) {
    throw new Error('PostgreSQL sync job repository has not been registered');
  }
  return postgresSyncJobRepository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresConnectorOperationLeaseRepository(
  repository: ConnectorOperationLeaseRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresConnectorOperationLeaseRepository = repository;
}

export function getPostgresConnectorOperationLeaseRepository(): ConnectorOperationLeaseRepository {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresConnectorOperationLeaseRepository) {
    throw new Error('PostgreSQL connector-operation lease repository has not been registered');
  }
  return postgresConnectorOperationLeaseRepository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresKeywordSearchRepository(repository: KeywordSearchRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresKeywordSearchRepository = repository;
}

export function getPostgresKeywordSearchRepository(): KeywordSearchRepository {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresKeywordSearchRepository) {
    throw new Error('PostgreSQL keyword search repository has not been registered');
  }
  return postgresKeywordSearchRepository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresSemanticIndexRepository(
  repository: SemanticIndexRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresSemanticIndexRepository = repository;
}

export function getPostgresSemanticIndexRepository(): SemanticIndexRepository {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresSemanticIndexRepository) {
    throw new Error('PostgreSQL semantic index repository has not been registered');
  }
  return postgresSemanticIndexRepository;
}

/** Explicit override hook (primarily for tests). */
export function registerPostgresSemanticSourcePort(port: SemanticSourcePort): void {
  assertPersistenceCompositionPublicationAllowed();
  postgresSemanticSourcePort = port;
}

export function getPostgresSemanticSourcePort(): SemanticSourcePort {
  assertPersistenceCompositionAccessAllowed();
  if (!postgresSemanticSourcePort) {
    throw new Error('PostgreSQL semantic source port has not been registered');
  }
  return postgresSemanticSourcePort;
}
