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
  assertCanRegisterSemanticPublicationService,
  registerSemanticPublicationService,
  type SemanticPublicationService,
} from '@/lib/semantic-index/publication-service';
import {
  assertCanRegisterConnectorRuntimeRegistry,
  registerConnectorRuntimeRegistry,
} from '@/lib/connectors/registry-runtime';
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
  clearSelectedTaskCorePersistence,
  registerTaskCorePersistence,
} from '@/lib/tasks/core/runtime';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';
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
import type { DemoSeedCommandService } from '@/lib/settings/mode-route-services';
import type { RelativeReminderTimezoneRepository } from './persistence/relative-reminder-timezone';
import {
  registerDemoSeedCommandService,
  registerRelativeReminderTimezoneRepository,
} from '@/lib/settings/mode-route-services';
import { PostgresPersistenceBackend } from './postgres/runtime';
import { resolveDatabaseBackend } from './runtime-backend';
import {
  createPostgresCoreRepositories,
  createPostgresWorkerPersistenceRepositories,
} from './postgres/repositories';
import { createPostgresTaskCorePersistence } from './postgres/repositories/task-core-repositories';
import { createPostgresConnectorOperationLeaseRepository } from './postgres/sync/connector-operation-lease-repository';
import { createPostgresSyncJobRepository } from './postgres/sync/job-repository';
import { createPostgresAIEnrichmentService } from './postgres/sync/notification-enrichment-service';
import { createPostgresKeywordSearchRepository } from './postgres/search';
import { createPostgresSemanticIndexRepository } from './postgres/semantic-index/repository';
import { createPostgresSemanticSourcePort } from './postgres/semantic-index/source-port';
import { createPostgresRelativeReminderTimezoneRepository } from './postgres/repositories/relative-reminder-timezone-repository';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface DatabaseRuntimeRegistry {
  backend: PostgresPersistenceBackend;
  repositories: CorePersistenceRepositories | null;
  workerRepositories: WorkerPersistenceRepositories | null;
  syncJobRepository: SyncJobRepository | null;
  connectorOperationLeaseRepository: ConnectorOperationLeaseRepository | null;
  keywordSearchRepository: KeywordSearchRepository | null;
  semanticIndexRepository: SemanticIndexRepository | null;
  semanticSourcePort: SemanticSourcePort | null;
  durableAiRunRepository: DurableAiRunRepository | null;
  aiEnrichmentService: AIEnrichmentService | null;
  taskCorePersistence: TaskCorePersistence | null;
  initialized: boolean;
  initializationPromise: Promise<void> | null;
  shutdownPromise: Promise<void> | null;
  postShutdownInitializationPromise: Promise<void> | null;
  cleanupRequired: boolean;
  lifecycleGeneration: number;
  modeRouteDemoSeedCommandDelegate: DemoSeedCommandService | null;
  modeRouteTimezoneDelegate: RelativeReminderTimezoneRepository | null;
  coreFacade: CorePersistenceRepositories | null;
  workerFacade: WorkerPersistenceRepositories | null;
  semanticPublicationService: SemanticPublicationService | null;
  modeRouteDemoSeedCommandService: DemoSeedCommandService | null;
  modeRouteTimezoneRepository: RelativeReminderTimezoneRepository | null;
  shutdownSqliteComposition: (() => Promise<void>) | null;
  stopPostgresSemanticWorker: (() => Promise<void>) | null;
}

const DATABASE_RUNTIME_REGISTRY_KEY = 'mission-control.database-runtime-registry';
const DATABASE_RUNTIME_REGISTRY_SCHEMA_VERSION = 1;

function databaseRuntimeRegistry(): DatabaseRuntimeRegistry {
  return getProcessRuntimeSlot(
    DATABASE_RUNTIME_REGISTRY_KEY,
    DATABASE_RUNTIME_REGISTRY_SCHEMA_VERSION,
    () => ({
      backend: new PostgresPersistenceBackend(),
      repositories: null,
      workerRepositories: null,
      syncJobRepository: null,
      connectorOperationLeaseRepository: null,
      keywordSearchRepository: null,
      semanticIndexRepository: null,
      semanticSourcePort: null,
      durableAiRunRepository: null,
      aiEnrichmentService: null,
      taskCorePersistence: null,
      initialized: false,
      initializationPromise: null,
      shutdownPromise: null,
      postShutdownInitializationPromise: null,
      cleanupRequired: false,
      lifecycleGeneration: 0,
      modeRouteDemoSeedCommandDelegate: null,
      modeRouteTimezoneDelegate: null,
      coreFacade: null,
      workerFacade: null,
      semanticPublicationService: null,
      modeRouteDemoSeedCommandService: null,
      modeRouteTimezoneRepository: null,
      shutdownSqliteComposition: null,
      stopPostgresSemanticWorker: null,
    }),
  );
}

function requireModeRouteDemoSeedCommandDelegate(): DemoSeedCommandService {
  assertPersistenceCompositionAccessAllowed();
  const delegate = databaseRuntimeRegistry().modeRouteDemoSeedCommandDelegate;
  if (!delegate) {
    throw new Error('Demo seed command service has not been registered');
  }
  return delegate;
}

function requireModeRouteTimezoneDelegate(): RelativeReminderTimezoneRepository {
  assertPersistenceCompositionAccessAllowed();
  const delegate = databaseRuntimeRegistry().modeRouteTimezoneDelegate;
  if (!delegate) {
    throw new Error('Relative reminder timezone repository has not been registered');
  }
  return delegate;
}

const modeRouteDemoSeedCommandService: DemoSeedCommandService = {
  resetDemoDatabase: () => requireModeRouteDemoSeedCommandDelegate().resetDemoDatabase(),
  clearDatabase: () => requireModeRouteDemoSeedCommandDelegate().clearDatabase(),
  clearTriageSampleData: () => (
    requireModeRouteDemoSeedCommandDelegate().clearTriageSampleData()
  ),
};
const modeRouteTimezoneRepository: RelativeReminderTimezoneRepository = {
  applyTimezoneRecompute: (input) => (
    requireModeRouteTimezoneDelegate().applyTimezoneRecompute(input)
  ),
};

function registerModeRouteServices(
  demoSeedCommandService: DemoSeedCommandService,
  timezoneRepository: RelativeReminderTimezoneRepository,
): void {
  const runtime = databaseRuntimeRegistry();
  runtime.modeRouteDemoSeedCommandDelegate = demoSeedCommandService;
  runtime.modeRouteTimezoneDelegate = timezoneRepository;
  runtime.modeRouteDemoSeedCommandService ??= modeRouteDemoSeedCommandService;
  runtime.modeRouteTimezoneRepository ??= modeRouteTimezoneRepository;
  registerDemoSeedCommandService(runtime.modeRouteDemoSeedCommandService);
  registerRelativeReminderTimezoneRepository(runtime.modeRouteTimezoneRepository);
}

function clearModeRouteServiceDelegates(): void {
  const runtime = databaseRuntimeRegistry();
  runtime.modeRouteDemoSeedCommandDelegate = null;
  runtime.modeRouteTimezoneDelegate = null;
}

function clearPostgresRuntimeComposition(): void {
  const runtime = databaseRuntimeRegistry();
  if (runtime.taskCorePersistence) {
    clearSelectedTaskCorePersistence(runtime.taskCorePersistence);
  }
  if (runtime.workerRepositories) {
    if (runtime.workerFacade) {
      clearWorkerPersistenceRepositories(runtime.workerFacade);
    }
  }
  if (runtime.repositories) {
    if (runtime.coreFacade) {
      clearCorePersistenceRepositories(runtime.coreFacade);
    }
  }
  if (runtime.keywordSearchRepository) {
    clearKeywordSearchRepository(runtime.keywordSearchRepository);
  }
  if (runtime.aiEnrichmentService) {
    clearAIEnrichmentService(runtime.aiEnrichmentService);
  }
  if (runtime.durableAiRunRepository) {
    clearPostgresDurableAiRunRepository(runtime.durableAiRunRepository);
  }
  runtime.repositories = null;
  runtime.workerRepositories = null;
  runtime.syncJobRepository = null;
  runtime.connectorOperationLeaseRepository = null;
  runtime.keywordSearchRepository = null;
  runtime.semanticIndexRepository = null;
  runtime.semanticSourcePort = null;
  runtime.durableAiRunRepository = null;
  runtime.aiEnrichmentService = null;
  runtime.taskCorePersistence = null;
}

function requirePostgresRepositories(): CorePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  const repositories = databaseRuntimeRegistry().repositories;
  if (!repositories) {
    throw new Error('PostgreSQL core repositories have not been registered');
  }
  return repositories;
}

function requirePostgresWorkerRepositories(): WorkerPersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  const repositories = databaseRuntimeRegistry().workerRepositories;
  if (!repositories) {
    throw new Error('PostgreSQL worker repositories have not been registered');
  }
  return repositories;
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
const semanticPublicationRuntimeService: SemanticPublicationService = {
  upsert: async (entityType, entityId) => {
    const { publishSemanticEntityUpsert } = await import(
      '@/lib/semantic-index/publication'
    );
    return publishSemanticEntityUpsert(entityType, entityId);
  },
  delete: async (entityType, entityId) => {
    const { publishSemanticEntityDelete } = await import(
      '@/lib/semantic-index/publication'
    );
    return publishSemanticEntityDelete(entityType, entityId);
  },
};

function stableCorePersistenceFacade(): CorePersistenceRepositories {
  const runtime = databaseRuntimeRegistry();
  runtime.coreFacade ??= postgresCorePersistenceRepositories;
  return runtime.coreFacade;
}

function stableWorkerPersistenceFacade(): WorkerPersistenceRepositories {
  const runtime = databaseRuntimeRegistry();
  runtime.workerFacade ??= postgresWorkerPersistenceRepositories;
  return runtime.workerFacade;
}

function stableSemanticPublicationService(): SemanticPublicationService {
  const runtime = databaseRuntimeRegistry();
  runtime.semanticPublicationService ??= semanticPublicationRuntimeService;
  return runtime.semanticPublicationService;
}

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
 *
 * Also registers the two `src/app/api/settings/mode/route.ts` (Layer L02)
 * services declared in `@/lib/settings/mode-route-services` — see that
 * module's doc comment. For SQLite this wires the real
 * `clearDatabase`/`resetDemoDatabase`/`clearTriageSampleData` functions
 * (via the SQLite-named `./persistence/sqlite-demo-seed-command-adapter`
 * seam, so `@/lib/seed-api`/`@/lib/triage/lifecycle` are never imported —
 * statically or dynamically — from anywhere reachable on the PostgreSQL
 * branch) and the drizzle-backed timezone repository. For PostgreSQL, the
 * timezone repository gets a real adapter, but the demo/seed commands have
 * no PostgreSQL equivalent yet, so all three reject with the documented
 * "SQLite-only" error.
 */
async function registerStableRuntimeServices(): Promise<void> {
  const semanticService = stableSemanticPublicationService();
  assertCanRegisterConnectorRuntimeRegistry();
  assertCanRegisterSemanticPublicationService(semanticService);
  registerConnectorRuntimeRegistry();
  registerSemanticPublicationService(semanticService);
}

async function initializeRuntimeDatabaseOnce(isCurrentGeneration: () => boolean): Promise<void> {
  if (resolveDatabaseBackend() === 'sqlite') {
    const sqliteRuntime = await import('./index');
    databaseRuntimeRegistry().shutdownSqliteComposition =
      sqliteRuntime.shutdownSqlitePersistenceComposition;
    await sqliteRuntime.initializeSqlitePersistenceComposition();
    if (!isCurrentGeneration()) return;
    await registerStableRuntimeServices();
    const [
      { createSqliteDemoSeedCommandService },
      { createSqliteRelativeReminderTimezoneRepository },
    ] = await Promise.all([
      import('./persistence/sqlite-demo-seed-command-adapter'),
      import('./persistence/sqlite-relative-reminder-timezone-repository'),
    ]);
    if (!isCurrentGeneration()) return;
    registerModeRouteServices(
      createSqliteDemoSeedCommandService(),
      createSqliteRelativeReminderTimezoneRepository(sqliteRuntime.default),
    );
    return;
  }
  const runtime = databaseRuntimeRegistry();
  await runtime.backend.initialize();
  if (!isCurrentGeneration()) return;
  const { db, pool, vector } = runtime.backend.context;
  runtime.repositories = createPostgresCoreRepositories(db);
  registerCorePersistenceRepositories(stableCorePersistenceFacade());
  // The task-core composition is built atomically from the freshly
  // initialized handle, so no request can observe a half-registered
  // task-core surface under PostgreSQL.
  runtime.taskCorePersistence = createPostgresTaskCorePersistence(db);
  registerTaskCorePersistence(runtime.taskCorePersistence);
  runtime.workerRepositories = createPostgresWorkerPersistenceRepositories(
    db,
    pool,
    runtime.repositories,
  );
  registerWorkerPersistenceRepositories(stableWorkerPersistenceFacade());
  runtime.syncJobRepository = createPostgresSyncJobRepository(pool);
  runtime.connectorOperationLeaseRepository = createPostgresConnectorOperationLeaseRepository(pool);
  runtime.keywordSearchRepository = createPostgresKeywordSearchRepository(pool);
  registerKeywordSearchRepository(runtime.keywordSearchRepository);
  runtime.aiEnrichmentService = createPostgresAIEnrichmentService();
  registerAIEnrichmentService(runtime.aiEnrichmentService);
  runtime.semanticIndexRepository = createPostgresSemanticIndexRepository(pool, vector);
  runtime.semanticSourcePort = createPostgresSemanticSourcePort(pool);
  runtime.durableAiRunRepository = new PostgresDurableAiRunRepository(pool);
  registerPostgresDurableAiRunRepository(runtime.durableAiRunRepository);
  await registerStableRuntimeServices();
  if (!isCurrentGeneration()) return;
  const packagedSemanticRuntime = await import(
    '@/lib/semantic-index/packaged-worker-runtime'
  );
  runtime.stopPostgresSemanticWorker =
    packagedSemanticRuntime.stopPackagedPostgresSemanticWorker;
  if (!isCurrentGeneration()) return;
  packagedSemanticRuntime.resumePackagedPostgresSemanticRuntime();
  const unsupportedDemoSeedCommand = (message: string) => () => Promise.reject(new Error(message));
  const postgresDemoSeedCommandService: DemoSeedCommandService = {
    resetDemoDatabase: unsupportedDemoSeedCommand(
      'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    ),
    clearDatabase: unsupportedDemoSeedCommand(
      'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    ),
    clearTriageSampleData: unsupportedDemoSeedCommand(
      'Clearing triage demo/sample data is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    ),
  };
  registerModeRouteServices(
    postgresDemoSeedCommandService,
    createPostgresRelativeReminderTimezoneRepository(db),
  );
}

export function initializeRuntimeDatabase(): Promise<void> {
  const runtime = databaseRuntimeRegistry();
  if (runtime.shutdownPromise) {
    return initializeRuntimeDatabaseAfterShutdown(runtime.shutdownPromise);
  }
  if (runtime.postShutdownInitializationPromise) {
    return runtime.postShutdownInitializationPromise;
  }
  if (runtime.cleanupRequired) {
    const shutdown = shutdownRuntimeDatabase();
    return initializeRuntimeDatabaseAfterShutdown(shutdown);
  }
  if (runtime.initialized) return Promise.resolve();
  if (runtime.initializationPromise) return runtime.initializationPromise;

  const initializationGeneration = ++runtime.lifecycleGeneration;
  beginPersistenceCompositionInitialization();
  runtime.initializationPromise = initializeRuntimeDatabaseOnce(
    () => initializationGeneration === runtime.lifecycleGeneration,
  )
    .then(() => {
      if (initializationGeneration !== runtime.lifecycleGeneration) return;
      completePersistenceCompositionInitialization();
      runtime.initialized = true;
    })
    .catch(async (error) => {
      blockPersistenceComposition();
      try {
        if (resolveDatabaseBackend() === 'postgres') {
          try {
            await runtime.backend.shutdown();
            runtime.cleanupRequired = false;
          } catch (cleanupError) {
            runtime.cleanupRequired = true;
            throw new AggregateError(
              [error, cleanupError],
              'PostgreSQL runtime initialization cleanup failed',
              { cause: error },
            );
          } finally {
            clearPostgresRuntimeComposition();
          }
        } else {
          try {
            if (!runtime.shutdownSqliteComposition) {
              throw new Error('SQLite runtime shutdown delegate has not been registered');
            }
            await runtime.shutdownSqliteComposition();
            runtime.cleanupRequired = false;
            runtime.shutdownSqliteComposition = null;
          } catch (cleanupError) {
            runtime.cleanupRequired = true;
            throw new AggregateError(
              [error, cleanupError],
              'SQLite runtime initialization cleanup failed',
              { cause: error },
            );
          }
        }
        throw error;
      } finally {
        blockPersistenceComposition();
      }
    })
    .finally(() => {
      runtime.initializationPromise = null;
    });
  return runtime.initializationPromise;
}

function initializeRuntimeDatabaseAfterShutdown(shutdown: Promise<void>): Promise<void> {
  const runtime = databaseRuntimeRegistry();
  if (runtime.postShutdownInitializationPromise) {
    return runtime.postShutdownInitializationPromise;
  }
  const queuedGeneration = runtime.lifecycleGeneration;
  const queued = shutdown.then(() => {
    if (runtime.postShutdownInitializationPromise === queued) {
      runtime.postShutdownInitializationPromise = null;
    }
    if (runtime.lifecycleGeneration !== queuedGeneration) return;
    return initializeRuntimeDatabase();
  }, (error) => {
    if (runtime.postShutdownInitializationPromise === queued) {
      runtime.postShutdownInitializationPromise = null;
    }
    throw error;
  });
  runtime.postShutdownInitializationPromise = queued;
  return queued;
}

export function shutdownRuntimeDatabase(): Promise<void> {
  const runtime = databaseRuntimeRegistry();
  runtime.lifecycleGeneration += 1;
  blockPersistenceComposition();
  if (runtime.shutdownPromise) return runtime.shutdownPromise;

  runtime.shutdownPromise = (async () => {
    if (runtime.initializationPromise) {
      await runtime.initializationPromise.catch(() => undefined);
    }
    if (resolveDatabaseBackend() === 'postgres') {
      const shutdownErrors: unknown[] = [];
      try {
        if (
          !runtime.stopPostgresSemanticWorker
          && (runtime.initialized || runtime.cleanupRequired)
        ) {
          throw new Error('PostgreSQL semantic worker shutdown delegate has not been registered');
        }
        await runtime.stopPostgresSemanticWorker?.();
      } catch (error) {
        shutdownErrors.push(error);
      }
      try {
        await runtime.backend.shutdown();
      } catch (error) {
        shutdownErrors.push(error);
      } finally {
        clearPostgresRuntimeComposition();
        clearModeRouteServiceDelegates();
        runtime.initialized = false;
      }
      runtime.cleanupRequired = shutdownErrors.length > 0;
      if (!runtime.cleanupRequired) runtime.stopPostgresSemanticWorker = null;
      if (shutdownErrors.length === 1) throw shutdownErrors[0];
      if (shutdownErrors.length > 1) {
        throw new AggregateError(shutdownErrors, 'PostgreSQL runtime shutdown failed');
      }
      return;
    }
    try {
      if (
        !runtime.shutdownSqliteComposition
        && (runtime.initialized || runtime.cleanupRequired)
      ) {
        throw new Error('SQLite runtime shutdown delegate has not been registered');
      }
      await runtime.shutdownSqliteComposition?.();
      runtime.cleanupRequired = false;
      runtime.initialized = false;
    } catch (error) {
      runtime.cleanupRequired = true;
      throw error;
    } finally {
      clearModeRouteServiceDelegates();
      if (!runtime.cleanupRequired) runtime.shutdownSqliteComposition = null;
    }
  })().finally(() => {
    runtime.shutdownPromise = null;
  });
  return runtime.shutdownPromise;
}

export function getPostgresPersistenceBackend(): PostgresPersistenceBackend {
  assertPersistenceCompositionAccessAllowed();
  if (resolveDatabaseBackend() !== 'postgres') {
    throw new Error('PostgreSQL persistence is not selected');
  }
  return databaseRuntimeRegistry().backend;
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
  databaseRuntimeRegistry().repositories = repositories;
  registerCorePersistenceRepositories(stableCorePersistenceFacade());
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
  databaseRuntimeRegistry().syncJobRepository = repository;
}

export function getPostgresSyncJobRepository(): SyncJobRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().syncJobRepository;
  if (!repository) {
    throw new Error('PostgreSQL sync job repository has not been registered');
  }
  return repository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresConnectorOperationLeaseRepository(
  repository: ConnectorOperationLeaseRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  databaseRuntimeRegistry().connectorOperationLeaseRepository = repository;
}

export function getPostgresConnectorOperationLeaseRepository(): ConnectorOperationLeaseRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().connectorOperationLeaseRepository;
  if (!repository) {
    throw new Error('PostgreSQL connector-operation lease repository has not been registered');
  }
  return repository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresKeywordSearchRepository(repository: KeywordSearchRepository): void {
  assertPersistenceCompositionPublicationAllowed();
  const runtime = databaseRuntimeRegistry();
  const previous = runtime.keywordSearchRepository;
  if (previous === repository) return;
  if (previous) clearKeywordSearchRepository(previous);
  try {
    registerKeywordSearchRepository(repository);
    runtime.keywordSearchRepository = repository;
  } catch (error) {
    if (previous) registerKeywordSearchRepository(previous);
    throw error;
  }
}

export function getPostgresKeywordSearchRepository(): KeywordSearchRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().keywordSearchRepository;
  if (!repository) {
    throw new Error('PostgreSQL keyword search repository has not been registered');
  }
  return repository;
}

/**
 * Explicit override hook (primarily for tests); see
 * `registerPostgresCoreRepositories`.
 */
export function registerPostgresSemanticIndexRepository(
  repository: SemanticIndexRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  databaseRuntimeRegistry().semanticIndexRepository = repository;
}

export function getPostgresSemanticIndexRepository(): SemanticIndexRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().semanticIndexRepository;
  if (!repository) {
    throw new Error('PostgreSQL semantic index repository has not been registered');
  }
  return repository;
}

/** Explicit override hook (primarily for tests). */
export function registerPostgresSemanticSourcePort(port: SemanticSourcePort): void {
  assertPersistenceCompositionPublicationAllowed();
  databaseRuntimeRegistry().semanticSourcePort = port;
}

export function getPostgresSemanticSourcePort(): SemanticSourcePort {
  assertPersistenceCompositionAccessAllowed();
  const port = databaseRuntimeRegistry().semanticSourcePort;
  if (!port) {
    throw new Error('PostgreSQL semantic source port has not been registered');
  }
  return port;
}
