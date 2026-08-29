import type { CorePersistenceRepositories } from './persistence/core-repositories';
import type { ConnectorOperationLeaseRepository } from '@/lib/sync/connector-operation-lease-repository';
import type { SyncJobRepository } from '@/lib/sync/job-repository';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import {
  registerCorePersistenceRepositories,
} from '@/lib/persistence/runtime';
import { initializeDatabase } from './index';
import { PostgresPersistenceBackend } from './postgres/runtime';
import { resolveDatabaseBackend } from './runtime-backend';
import { createPostgresCoreRepositories } from './postgres/repositories';
import { createPostgresConnectorOperationLeaseRepository } from './postgres/sync/connector-operation-lease-repository';
import { createPostgresSyncJobRepository } from './postgres/sync/job-repository';
import { createPostgresKeywordSearchRepository } from './postgres/search';

const postgresBackend = new PostgresPersistenceBackend();
let postgresRepositories: CorePersistenceRepositories | null = null;
let postgresSyncJobRepository: SyncJobRepository | null = null;
let postgresConnectorOperationLeaseRepository: ConnectorOperationLeaseRepository | null = null;
let postgresKeywordSearchRepository: KeywordSearchRepository | null = null;

function requirePostgresRepositories(): CorePersistenceRepositories {
  if (!postgresRepositories) {
    throw new Error('PostgreSQL core repositories have not been registered');
  }
  return postgresRepositories;
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

/**
 * Initializes the selected persistence backend. For PostgreSQL, this also
 * instantiates and registers the four portable-contract adapters
 * (`createPostgresCoreRepositories`, `createPostgresSyncJobRepository`,
 * `createPostgresConnectorOperationLeaseRepository`,
 * `createPostgresKeywordSearchRepository`) from the freshly-initialized
 * `PostgresDatabase`/`Pool` handles, so `getPostgresCoreRepositories` and its
 * siblings below are guaranteed to be populated as soon as this resolves.
 * SQLite initialization is untouched.
 */
export async function initializeRuntimeDatabase(): Promise<void> {
  if (resolveDatabaseBackend() === 'sqlite') {
    initializeDatabase();
    return;
  }
  await postgresBackend.initialize();
  const { db, pool } = postgresBackend.context;
  postgresRepositories = createPostgresCoreRepositories(db);
  registerCorePersistenceRepositories(postgresCorePersistenceRepositories);
  postgresSyncJobRepository = createPostgresSyncJobRepository(pool);
  postgresConnectorOperationLeaseRepository = createPostgresConnectorOperationLeaseRepository(pool);
  postgresKeywordSearchRepository = createPostgresKeywordSearchRepository(pool);
}

export async function shutdownRuntimeDatabase(): Promise<void> {
  if (resolveDatabaseBackend() === 'postgres') {
    await postgresBackend.shutdown();
    postgresRepositories = null;
    postgresSyncJobRepository = null;
    postgresConnectorOperationLeaseRepository = null;
    postgresKeywordSearchRepository = null;
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
