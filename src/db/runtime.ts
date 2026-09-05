import { randomUUID } from 'node:crypto';
import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';
import type { ConnectorOperationLeaseRepository } from '@/lib/sync/connector-operation-lease-repository';
import type { SyncControlStateRepository } from '@/lib/sync/control-state';
import type { ConnectorMaintenanceLockRepository } from '@/lib/sync/maintenance-lock';
import type { SyncOperatorControlRepository } from '@/lib/sync/operator-control';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import type { SemanticIndexRepository } from '@/lib/semantic-index/contracts';
import type { SemanticSourcePort } from '@/lib/semantic-index/source/contracts';
import type { DurableAiRunRepository } from '@/lib/ai/durable-runs/repository';
import {
  clearKeywordSearchRepository,
  registerKeywordSearchRepository,
} from '@/lib/search/keyword-runtime';
import type { SemanticSearchRuntime } from '@/lib/search/semantic';
import {
  clearSyncControlStateRepository,
  registerSyncControlStateRepository,
} from '@/lib/sync/control-state';
import {
  clearConnectorOperationLeaseRepository,
  registerConnectorOperationLeaseRepository,
} from '@/lib/sync/connector-lock-runtime';
import {
  clearSyncJobRepository,
  registerSyncJobRepository as registerSelectedSyncJobRepository,
} from '@/lib/sync/job-runtime';
import {
  clearConnectorMaintenanceLockRepository,
  registerConnectorMaintenanceLockRepository,
} from '@/lib/sync/maintenance-lock';
import {
  clearSyncOperatorControlRepository,
  registerSyncOperatorControlRepository,
} from '@/lib/sync/operator-control';
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
  clearDurableAiRunRepository,
  registerDurableAiRunRepository,
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
import { createPostgresSyncControlStateRepository } from './postgres/sync/control-state-repository';
import { createPostgresConnectorMaintenanceLockRepository } from './postgres/sync/maintenance-lock-repository';
import { createPostgresSyncOperatorControlRepository } from './postgres/sync/operator-control-repository';
import { createPostgresSyncJobRepository } from './postgres/sync/job-repository';
import { createPostgresAIEnrichmentService } from './postgres/sync/notification-enrichment-service';
import { createPostgresKeywordSearchRepository } from './postgres/search';
import { createPostgresSemanticIndexRepository } from './postgres/semantic-index/repository';
import { createPostgresSemanticSourcePort } from './postgres/semantic-index/source-port';
import { getSemanticEmbeddingProvider } from '@/lib/semantic-index/embedding-provider';
import { loadAIProviderConfiguration } from '@/lib/ai/provider-configuration-service';
import { resolveSensitivity } from '@/lib/ai/sensitivity-policy';
import { semanticIndexLogger } from '@/lib/logger';
import { runIdempotencyKey } from '@/lib/semantic-index/runs';
import { SemanticIndexService } from '@/lib/semantic-index/service';
import { SEMANTIC_SOURCE_ENTITY_TYPES } from '@/lib/semantic-index/source/contracts';
import { resolveSemanticWorkerConfig } from '@/lib/semantic-index/worker-config';
import { createPostgresRelativeReminderTimezoneRepository } from './postgres/repositories/relative-reminder-timezone-repository';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';
import { PostgresDatabaseHealthProbe } from './postgres/health';
import { createPostgresRuntimeTelemetryPersistence } from './postgres/telemetry-runtime';
import { PostgresHealthSnapshotStore } from '@/lib/telemetry/postgres-health-snapshot-store';
import {
  clearRuntimeHealthPersistence,
  registerRuntimeHealthPersistence,
  type RuntimeHealthPersistence,
} from '@/lib/telemetry/database-health-runtime';
import {
  clearRuntimeTelemetryPersistence,
  registerRuntimeTelemetryPersistence,
  type RuntimeTelemetryPersistence,
} from '@/lib/telemetry/runtime-persistence';
import {
  clearSemanticSourcePort,
  registerSemanticSourcePort,
} from '@/lib/semantic-index/source/facade';

interface DatabaseRuntimeRegistry {
  backend: PostgresPersistenceBackend;
  repositories: CorePersistenceRepositories | null;
  workerRepositories: WorkerPersistenceRepositories | null;
  syncJobRepository: SyncJobRepository | null;
  connectorOperationLeaseRepository: ConnectorOperationLeaseRepository | null;
  syncControlStateRepository: SyncControlStateRepository | null;
  connectorMaintenanceLockRepository: ConnectorMaintenanceLockRepository | null;
  syncOperatorControlRepository: SyncOperatorControlRepository | null;
  keywordSearchRepository: KeywordSearchRepository | null;
  semanticIndexRepository: SemanticIndexRepository | null;
  semanticSearchRuntime: SemanticSearchRuntime | null;
  semanticSourcePort: SemanticSourcePort | null;
  durableAiRunRepository: DurableAiRunRepository | null;
  aiEnrichmentService: AIEnrichmentService | null;
  taskCorePersistence: TaskCorePersistence | null;
  runtimeHealthPersistence: RuntimeHealthPersistence | null;
  runtimeTelemetryPersistence: RuntimeTelemetryPersistence | null;
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
  clearSqliteSyncInfrastructure: (() => void) | null;
  stopPostgresSemanticWorker: (() => Promise<void>) | null;
}

const DATABASE_RUNTIME_REGISTRY_KEY = 'mission-control.database-runtime-registry';
const DATABASE_RUNTIME_REGISTRY_SCHEMA_VERSION = 1;
const SEMANTIC_SEARCH_RUNTIME_KEY = 'mission-control.semantic-search-runtime';
const SEMANTIC_SEARCH_RUNTIME_SCHEMA_VERSION = 1;

interface SemanticSearchRuntimeRegistry {
  selected: SemanticSearchRuntime | null;
}

function semanticSearchRuntimeRegistry(): SemanticSearchRuntimeRegistry {
  return getProcessRuntimeSlot(
    SEMANTIC_SEARCH_RUNTIME_KEY,
    SEMANTIC_SEARCH_RUNTIME_SCHEMA_VERSION,
    () => ({ selected: null }),
  );
}

function assertCanSelectSemanticSearchRuntime(runtime: SemanticSearchRuntime): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = semanticSearchRuntimeRegistry().selected;
  if (selected && selected !== runtime) {
    throw new Error('Semantic search runtime is already selected');
  }
}

function selectSemanticSearchRuntime(runtime: SemanticSearchRuntime): void {
  assertCanSelectSemanticSearchRuntime(runtime);
  semanticSearchRuntimeRegistry().selected = runtime;
}

function clearSelectedSemanticSearchRuntime(runtime: SemanticSearchRuntime): void {
  const registry = semanticSearchRuntimeRegistry();
  if (registry.selected === runtime) registry.selected = null;
}

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
      syncControlStateRepository: null,
      connectorMaintenanceLockRepository: null,
      syncOperatorControlRepository: null,
      keywordSearchRepository: null,
      semanticIndexRepository: null,
      semanticSearchRuntime: null,
      semanticSourcePort: null,
      durableAiRunRepository: null,
      aiEnrichmentService: null,
      taskCorePersistence: null,
      runtimeHealthPersistence: null,
      runtimeTelemetryPersistence: null,
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
      clearSqliteSyncInfrastructure: null,
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

async function shutdownSqliteRuntimeDelegates(
  runtime: DatabaseRuntimeRegistry,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runtime.shutdownSqliteComposition?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    runtime.clearSqliteSyncInfrastructure?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'SQLite runtime shutdown failed');
  }
}

function clearPostgresRuntimeComposition(): void {
  const runtime = databaseRuntimeRegistry();
  clearRuntimeObservabilityComposition(runtime);
  if (runtime.syncOperatorControlRepository) {
    clearSyncOperatorControlRepository(runtime.syncOperatorControlRepository);
  }
  if (runtime.connectorMaintenanceLockRepository) {
    clearConnectorMaintenanceLockRepository(runtime.connectorMaintenanceLockRepository);
  }
  if (runtime.syncControlStateRepository) {
    clearSyncControlStateRepository(runtime.syncControlStateRepository);
  }
  if (runtime.connectorOperationLeaseRepository) {
    clearConnectorOperationLeaseRepository(runtime.connectorOperationLeaseRepository);
  }
  if (runtime.syncJobRepository) {
    clearSyncJobRepository(runtime.syncJobRepository);
  }
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
  if (runtime.semanticSearchRuntime) {
    clearSelectedSemanticSearchRuntime(runtime.semanticSearchRuntime);
  }
  if (runtime.aiEnrichmentService) {
    clearAIEnrichmentService(runtime.aiEnrichmentService);
  }
  clearAiControlPlaneComposition(runtime);
  runtime.repositories = null;
  runtime.workerRepositories = null;
  runtime.syncJobRepository = null;
  runtime.connectorOperationLeaseRepository = null;
  runtime.syncControlStateRepository = null;
  runtime.connectorMaintenanceLockRepository = null;
  runtime.syncOperatorControlRepository = null;
  runtime.keywordSearchRepository = null;
  runtime.semanticIndexRepository = null;
  runtime.semanticSearchRuntime = null;
  runtime.semanticSourcePort = null;
  runtime.aiEnrichmentService = null;
  runtime.taskCorePersistence = null;
}

function clearAiControlPlaneComposition(runtime: DatabaseRuntimeRegistry): void {
  if (runtime.semanticSourcePort) {
    clearSemanticSourcePort(runtime.semanticSourcePort);
    runtime.semanticSourcePort = null;
  }
  if (runtime.durableAiRunRepository) {
    clearDurableAiRunRepository(runtime.durableAiRunRepository);
    runtime.durableAiRunRepository = null;
  }
}

function clearRuntimeObservabilityComposition(runtime: DatabaseRuntimeRegistry): void {
  if (runtime.runtimeHealthPersistence) {
    clearRuntimeHealthPersistence(runtime.runtimeHealthPersistence);
    runtime.runtimeHealthPersistence = null;
  }
  if (runtime.runtimeTelemetryPersistence) {
    clearRuntimeTelemetryPersistence(runtime.runtimeTelemetryPersistence);
    runtime.runtimeTelemetryPersistence = null;
  }
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
    listDeletedIds: () => {
      const repository = requirePostgresRepositories().connectors;
      if (typeof repository.listDeletedIds !== 'function') {
        return Promise.reject(new Error(
          'PostgreSQL connector deleted-ID repository has not been registered',
        ));
      }
      return repository.listDeletedIds();
    },
    get: (id) => requirePostgresRepositories().connectors.get(id),
    upsert: (connector) => requirePostgresRepositories().connectors.upsert(connector),
    updateCredentials: (id, credentials, settings) => (
      requirePostgresRepositories().connectors.updateCredentials(id, credentials, settings)
    ),
    delete: (id) => requirePostgresRepositories().connectors.delete(id),
    recordTestResult: (command) => (
      requirePostgresRepositories().connectors.recordTestResult(command)
    ),
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
    getMany: (keys) => requirePostgresRepositories().settings.getMany!(keys),
    set: (key, value) => requirePostgresRepositories().settings.set(key, value),
    setMany: (entries) => requirePostgresRepositories().settings.setMany!(entries),
    delete: (key) => requirePostgresRepositories().settings.delete(key),
    getActiveEmbeddingIdentity: () => (
      requirePostgresRepositories().settings.getActiveEmbeddingIdentity!()
    ),
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
  externalAgentControl: new Proxy(
    {} as WorkerPersistenceRepositories['externalAgentControl'],
    {
      get: (_target, property) => (
        requirePostgresWorkerRepositories().externalAgentControl[
          property as keyof WorkerPersistenceRepositories['externalAgentControl']
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
  ideationWorkspaces: new Proxy({} as WorkerPersistenceRepositories['ideationWorkspaces'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().ideationWorkspaces[
        property as keyof WorkerPersistenceRepositories['ideationWorkspaces']
      ]
    ),
  }),
  analytics: new Proxy({} as WorkerPersistenceRepositories['analytics'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().analytics[
        property as keyof WorkerPersistenceRepositories['analytics']
      ]
    ),
  }),
  routines: new Proxy({} as WorkerPersistenceRepositories['routines'], {
    get: (_target, property) => (
      requirePostgresWorkerRepositories().routines[
        property as keyof WorkerPersistenceRepositories['routines']
      ]
    ),
  }),
  webhookIntegrations: new Proxy(
    {} as WorkerPersistenceRepositories['webhookIntegrations'],
    {
      get: (_target, property) => (
        requirePostgresWorkerRepositories().webhookIntegrations[
          property as keyof WorkerPersistenceRepositories['webhookIntegrations']
        ]
      ),
    },
  ),
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
    const [
      { SqliteDatabaseHealthProbe },
      { SqliteHealthSnapshotStore },
      { SqliteRuntimeTelemetryPersistence },
      { SqliteDurableAiRunRepository },
      { SqliteSemanticSourcePort },
    ] = await Promise.all([
      import('@/lib/telemetry/sqlite-database-health-probe'),
      import('@/lib/telemetry/sqlite-health-snapshot-store'),
      import('@/lib/telemetry/sqlite-runtime-telemetry'),
      import('@/lib/ai/durable-runs/sqlite-adapter'),
      import('@/lib/semantic-index/source/sqlite-source-port'),
    ]);
    if (!isCurrentGeneration()) return;
    const runtime = databaseRuntimeRegistry();
    runtime.runtimeHealthPersistence = {
      databaseHealthProbe: new SqliteDatabaseHealthProbe(
        sqliteRuntime.sqlite,
        sqliteRuntime.withoutDatabaseObservation,
      ),
      createHealthSnapshotStore: <TSummary>() => (
        new SqliteHealthSnapshotStore<TSummary>(
          sqliteRuntime.sqlite,
          sqliteRuntime.withoutDatabaseObservation,
        )
      ),
    };
    runtime.runtimeTelemetryPersistence = new SqliteRuntimeTelemetryPersistence(
      sqliteRuntime.sqlite,
      sqliteRuntime.withoutDatabaseObservation,
      sqliteRuntime.getDatabaseTelemetry,
    );
    registerRuntimeHealthPersistence(runtime.runtimeHealthPersistence);
    registerRuntimeTelemetryPersistence(runtime.runtimeTelemetryPersistence);
    runtime.durableAiRunRepository = new SqliteDurableAiRunRepository();
    runtime.semanticSourcePort = new SqliteSemanticSourcePort(sqliteRuntime.sqlite);
    registerDurableAiRunRepository(runtime.durableAiRunRepository);
    registerSemanticSourcePort(runtime.semanticSourcePort);
    const sqliteSyncRuntime = await import(
      './persistence/sqlite-sync-runtime'
    );
    databaseRuntimeRegistry().clearSqliteSyncInfrastructure =
      sqliteSyncRuntime.clearSqliteSyncInfrastructure;
    if (!isCurrentGeneration()) return;
    sqliteSyncRuntime.registerSqliteSyncInfrastructure();
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
  const packagedSemanticRuntime = await import(
    '@/lib/semantic-index/packaged-worker-runtime'
  );
  const semanticSearchRuntime: SemanticSearchRuntime = {
    async resolve() {
      const repository = databaseRuntimeRegistry().semanticIndexRepository;
      if (!repository) {
        throw new Error('PostgreSQL semantic index repository has not been registered');
      }
      return {
        repository,
        embeddings: getSemanticEmbeddingProvider(),
      };
    },
    async scheduleBackfill() {
      if (/^(1|true|yes|on)$/i.test(
        process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED?.trim() ?? '',
      )) {
        return { status: 'skipped', reason: 'semantic-search-disabled' };
      }
      try {
        const { resolved, routingPolicy } = await loadAIProviderConfiguration();
        if (!resolved.semanticSearchEnabled && !resolved.houstonMemoryEnabled) {
          return { status: 'skipped', reason: 'semantic-search-disabled' };
        }
        const entityTypes = SEMANTIC_SOURCE_ENTITY_TYPES.filter((entityType) =>
          entityType === 'houston-summary'
            ? resolved.houstonMemoryEnabled
            : resolved.semanticSearchEnabled
        );
        const config = resolveSemanticWorkerConfig(entityTypes);
        const repository = databaseRuntimeRegistry().semanticIndexRepository;
        const source = databaseRuntimeRegistry().semanticSourcePort;
        if (!repository || !source) {
          throw new Error('PostgreSQL semantic persistence has not been registered');
        }
        const service = new SemanticIndexService({
          repository,
          source,
          embeddings: getSemanticEmbeddingProvider(),
          resolveSensitivity: ({ connectorType }) => resolveSensitivity(
            'semantic-embedding',
            routingPolicy,
            { sources: connectorType ? [connectorType.trim().toLowerCase()] : [] },
          ),
          embeddingTimeoutMs: config.embeddingTimeoutMs,
        });
        const identity = await service.ensureIdentity();
        if (identity.status !== 'ready') {
          return { status: 'skipped', reason: identity.reason };
        }
        const window = `manual:${Math.floor(Date.now() / config.maintenanceIntervalMs)}`;
        const created = await repository.createRun({
          id: randomUUID(),
          indexId: identity.identity.id,
          kind: 'backfill',
          idempotencyKey: runIdempotencyKey(identity.identity.id, 'backfill', window),
          now: new Date().toISOString(),
        });
        semanticIndexLogger.info({
          event: 'semantic_backfill_scheduled',
          indexId: identity.identity.id,
          runId: created.run.id,
          status: created.status,
        }, 'Semantic index backfill scheduled');
        return {
          status: created.status === 'created' ? 'scheduled' : 'existing',
          indexId: identity.identity.id,
          runId: created.run.id,
          runStatus: created.run.status,
        };
      } catch (error) {
        semanticIndexLogger.warn({
          event: 'semantic_backfill_schedule_failed',
          err: error,
        }, 'Failed to schedule semantic index backfill');
        return { status: 'skipped', reason: 'schedule-failed' };
      }
    },
  };
  assertCanSelectSemanticSearchRuntime(semanticSearchRuntime);
  const { db, pool, vector } = runtime.backend.context;
  runtime.runtimeHealthPersistence = {
    databaseHealthProbe: new PostgresDatabaseHealthProbe(pool),
    createHealthSnapshotStore: <TSummary>() => (
      new PostgresHealthSnapshotStore<TSummary>(db)
    ),
  };
  runtime.runtimeTelemetryPersistence = createPostgresRuntimeTelemetryPersistence(pool);
  registerRuntimeHealthPersistence(runtime.runtimeHealthPersistence);
  registerRuntimeTelemetryPersistence(runtime.runtimeTelemetryPersistence);
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
  const syncJobRepository = createPostgresSyncJobRepository(pool);
  runtime.syncJobRepository = syncJobRepository;
  runtime.connectorOperationLeaseRepository = createPostgresConnectorOperationLeaseRepository(pool);
  runtime.syncControlStateRepository = createPostgresSyncControlStateRepository(pool);
  runtime.connectorMaintenanceLockRepository =
    createPostgresConnectorMaintenanceLockRepository(pool);
  runtime.syncOperatorControlRepository =
    createPostgresSyncOperatorControlRepository(pool, syncJobRepository);
  registerSelectedSyncJobRepository(syncJobRepository);
  registerConnectorOperationLeaseRepository(runtime.connectorOperationLeaseRepository);
  registerSyncControlStateRepository(runtime.syncControlStateRepository);
  registerConnectorMaintenanceLockRepository(runtime.connectorMaintenanceLockRepository);
  registerSyncOperatorControlRepository(runtime.syncOperatorControlRepository);
  runtime.keywordSearchRepository = createPostgresKeywordSearchRepository(pool);
  registerKeywordSearchRepository(runtime.keywordSearchRepository);
  runtime.aiEnrichmentService = createPostgresAIEnrichmentService();
  registerAIEnrichmentService(runtime.aiEnrichmentService);
  runtime.semanticIndexRepository = createPostgresSemanticIndexRepository(pool, vector);
  runtime.semanticSearchRuntime = semanticSearchRuntime;
  runtime.semanticSourcePort = createPostgresSemanticSourcePort(pool);
  runtime.durableAiRunRepository = new PostgresDurableAiRunRepository(pool);
  registerSemanticSourcePort(runtime.semanticSourcePort);
  selectSemanticSearchRuntime(runtime.semanticSearchRuntime);
  registerDurableAiRunRepository(runtime.durableAiRunRepository);
  await registerStableRuntimeServices();
  if (!isCurrentGeneration()) return;
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
            await shutdownSqliteRuntimeDelegates(runtime);
            runtime.cleanupRequired = false;
            runtime.shutdownSqliteComposition = null;
            runtime.clearSqliteSyncInfrastructure = null;
          } catch (cleanupError) {
            runtime.cleanupRequired = true;
            throw new AggregateError(
              [error, cleanupError],
              'SQLite runtime initialization cleanup failed',
              { cause: error },
            );
          } finally {
            clearRuntimeObservabilityComposition(runtime);
            clearAiControlPlaneComposition(runtime);
            const { clearSqliteSyncInfrastructure } = await import(
              './persistence/sqlite-sync-runtime'
            );
            clearSqliteSyncInfrastructure();
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
        (!runtime.shutdownSqliteComposition || !runtime.clearSqliteSyncInfrastructure)
        && (runtime.initialized || runtime.cleanupRequired)
      ) {
        throw new Error('SQLite runtime shutdown delegates have not been registered');
      }
      await shutdownSqliteRuntimeDelegates(runtime);
      runtime.cleanupRequired = false;
      runtime.initialized = false;
    } catch (error) {
      runtime.cleanupRequired = true;
      throw error;
    } finally {
      clearModeRouteServiceDelegates();
      clearRuntimeObservabilityComposition(runtime);
      clearAiControlPlaneComposition(runtime);
      if (!runtime.cleanupRequired) {
        runtime.shutdownSqliteComposition = null;
        runtime.clearSqliteSyncInfrastructure = null;
      }
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
  const runtime = databaseRuntimeRegistry();
  const previous = runtime.syncJobRepository;
  if (previous === repository) return;
  if (previous) clearSyncJobRepository(previous);
  try {
    registerSelectedSyncJobRepository(repository);
    runtime.syncJobRepository = repository;
  } catch (error) {
    if (previous) registerSelectedSyncJobRepository(previous);
    throw error;
  }
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
  const runtime = databaseRuntimeRegistry();
  const previous = runtime.connectorOperationLeaseRepository;
  if (previous === repository) return;
  if (previous) clearConnectorOperationLeaseRepository(previous);
  try {
    registerConnectorOperationLeaseRepository(repository);
    runtime.connectorOperationLeaseRepository = repository;
  } catch (error) {
    if (previous) registerConnectorOperationLeaseRepository(previous);
    throw error;
  }
}

export function getPostgresConnectorOperationLeaseRepository(): ConnectorOperationLeaseRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().connectorOperationLeaseRepository;
  if (!repository) {
    throw new Error('PostgreSQL connector-operation lease repository has not been registered');
  }
  return repository;
}

export function getPostgresSyncControlStateRepository(): SyncControlStateRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().syncControlStateRepository;
  if (!repository) {
    throw new Error('PostgreSQL sync control-state repository has not been registered');
  }
  return repository;
}

export function getPostgresConnectorMaintenanceLockRepository():
ConnectorMaintenanceLockRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().connectorMaintenanceLockRepository;
  if (!repository) {
    throw new Error('PostgreSQL connector maintenance-lock repository has not been registered');
  }
  return repository;
}

export function getPostgresSyncOperatorControlRepository():
SyncOperatorControlRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = databaseRuntimeRegistry().syncOperatorControlRepository;
  if (!repository) {
    throw new Error('PostgreSQL sync operator-control repository has not been registered');
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
  const runtime = databaseRuntimeRegistry();
  const previous = runtime.semanticSourcePort;
  if (previous === port) return;
  if (previous) clearSemanticSourcePort(previous);
  try {
    registerSemanticSourcePort(port);
    runtime.semanticSourcePort = port;
  } catch (error) {
    if (previous) registerSemanticSourcePort(previous);
    throw error;
  }
}

export function getPostgresSemanticSourcePort(): SemanticSourcePort {
  assertPersistenceCompositionAccessAllowed();
  const port = databaseRuntimeRegistry().semanticSourcePort;
  if (!port) {
    throw new Error('PostgreSQL semantic source port has not been registered');
  }
  return port;
}
