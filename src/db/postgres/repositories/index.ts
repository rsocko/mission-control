import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import type { PostgresDatabase } from '../runtime';
import { PostgresConnectorRepository } from './connector-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { PostgresProjectRepository } from './project-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { PostgresSyncRunRepository } from './sync-run-repository';
import { PostgresTaskRepository } from './task-repository';
import { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';
import type { Pool } from 'pg';

export { PostgresConnectorRepository } from './connector-repository';
export { PostgresNotificationRepository } from './notification-repository';
export { PostgresProjectRepository } from './project-repository';
export { PostgresSettingsRepository } from './settings-repository';
export { PostgresSyncRunRepository } from './sync-run-repository';
export { PostgresTaskRepository } from './task-repository';
export { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';

/**
 * Builds the full set of PostgreSQL-backed `CorePersistenceRepositories`
 * (tasks, projects, connectors, notifications, settings) for a given
 * `PostgresDatabase` handle (typically `PostgresPersistenceBackend#context.db`
 * from `@/db/postgres/runtime`).
 */
export function createPostgresCoreRepositories(
  db: PostgresDatabase,
): CorePersistenceRepositories {
  return {
    tasks: new PostgresTaskRepository(db),
    projects: new PostgresProjectRepository(db),
    connectors: new PostgresConnectorRepository(db),
    notifications: new PostgresNotificationRepository(db),
    settings: new PostgresSettingsRepository(db),
  };
}

export function createPostgresWorkerPersistenceRepositories(
  db: PostgresDatabase,
  pool: Pool,
  core: CorePersistenceRepositories,
): WorkerPersistenceRepositories {
  return {
    connectors: core.connectors,
    syncRuns: new PostgresSyncRunRepository(db),
    execution: createPostgresConnectorExecutionRepositories(pool),
  };
}
