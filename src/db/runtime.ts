import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { WorkerPersistenceRepositories } from './persistence/worker-repositories';
import type { ConnectorOperationLeaseRepository } from '@/lib/sync/connector-operation-lease-repository';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import type { SemanticIndexRepository } from '@/lib/semantic-index/contracts';
import type { SemanticSourcePort } from '@/lib/semantic-index/source/contracts';
import {
  registerCorePersistenceRepositories,
} from '@/lib/persistence/runtime';
import {
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

function requirePostgresRepositories(): CorePersistenceRepositories {
  if (!postgresRepositories) {
    throw new Error('PostgreSQL core repositories have not been registered');
  }
  return postgresRepositories;
}

function requirePostgresWorkerRepositories(): WorkerPersistenceRepositories {
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
    get: (id) => requirePostgresRepositories().connectors.get(id),
    upsert: (connector) => requirePostgresRepositories().connectors.upsert(connector),
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
};

/**
 * Initializes the selected persistence backend. For PostgreSQL, this also
 * instantiates and registers the portable-contract adapters
 * (`createPostgresCoreRepositories`, `createPostgresSyncJobRepository`,
 * `createPostgresConnectorOperationLeaseRepository`, the worker persistence
 * composition — which now includes the atomic
 * `createPostgresGitHubWorkerRepositories` GitHub composition —
 * `createPostgresKeywordSearchRepository`,
 * `createPostgresSemanticIndexRepository`, and
 * `createPostgresSemanticSourcePort`) from the freshly-initialized
 * `PostgresDatabase`/`Pool` handles, so `getPostgresCoreRepositories` and its
 * siblings below are guaranteed to be populated as soon as this resolves.
 * SQLite initialization is untouched.
 */
export async function initializeRuntimeDatabase(): Promise<void> {
  if (resolveDatabaseBackend() === 'sqlite') {
    const [
      { initializeDatabase },
      { sqliteCorePersistenceRepositories },
    ] = await Promise.all([
      import('./index'),
      import('./persistence/sqlite-core-repositories'),
    ]);
    initializeDatabase();
    registerCorePersistenceRepositories(sqliteCorePersistenceRepositories);
    return;
  }
  await postgresBackend.initialize();
  const { db, pool } = postgresBackend.context;
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
  postgresSemanticIndexRepository = createPostgresSemanticIndexRepository(pool);
  postgresSemanticSourcePort = createPostgresSemanticSourcePort(pool);
}

export async function shutdownRuntimeDatabase(): Promise<void> {
  if (resolveDatabaseBackend() === 'postgres') {
    await postgresBackend.shutdown();
    postgresRepositories = null;
    postgresWorkerRepositories = null;
    postgresSyncJobRepository = null;
    postgresConnectorOperationLeaseRepository = null;
    postgresKeywordSearchRepository = null;
    postgresSemanticIndexRepository = null;
    postgresSemanticSourcePort = null;
  }
}

export function getPostgresPersistenceBackend(): PostgresPersistenceBackend {
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
  postgresSyncJobRepository = repository;
}

export function getPostgresSyncJobRepository(): SyncJobRepository {
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
  postgresConnectorOperationLeaseRepository = repository;
}

export function getPostgresConnectorOperationLeaseRepository(): ConnectorOperationLeaseRepository {
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
  postgresKeywordSearchRepository = repository;
}

export function getPostgresKeywordSearchRepository(): KeywordSearchRepository {
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
  postgresSemanticIndexRepository = repository;
}

export function getPostgresSemanticIndexRepository(): SemanticIndexRepository {
  if (!postgresSemanticIndexRepository) {
    throw new Error('PostgreSQL semantic index repository has not been registered');
  }
  return postgresSemanticIndexRepository;
}

/** Explicit override hook (primarily for tests). */
export function registerPostgresSemanticSourcePort(port: SemanticSourcePort): void {
  postgresSemanticSourcePort = port;
}

export function getPostgresSemanticSourcePort(): SemanticSourcePort {
  if (!postgresSemanticSourcePort) {
    throw new Error('PostgreSQL semantic source port has not been registered');
  }
  return postgresSemanticSourcePort;
}
