import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { PostgresDatabase } from '../runtime';
import { PostgresConnectorRepository } from './connector-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { PostgresProjectRepository } from './project-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { PostgresTaskRepository } from './task-repository';

export { PostgresConnectorRepository } from './connector-repository';
export { PostgresNotificationRepository } from './notification-repository';
export { PostgresProjectRepository } from './project-repository';
export { PostgresSettingsRepository } from './settings-repository';
export { PostgresTaskRepository } from './task-repository';

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
