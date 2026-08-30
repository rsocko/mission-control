import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import type { GitHubWorkerRepositories } from '@/db/persistence/github-worker';
import type { PostgresDatabase } from '../runtime';
import { PostgresConnectorRepository } from './connector-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { PostgresProjectRepository } from './project-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { PostgresSyncRunRepository } from './sync-run-repository';
import { PostgresTaskRepository } from './task-repository';
import { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';
import { createPostgresGitHubIdentityRepositories } from './github-identity-repositories';
import { createPostgresGitHubDependencyRepositories } from './github-dependency-repositories';
import { createPostgresGitHubHierarchyRepositories } from './github-hierarchy-repositories';
import { createPostgresGitHubProjectRepositories } from './github-project-repositories';
import type { Pool } from 'pg';

export { PostgresConnectorRepository } from './connector-repository';
export { PostgresNotificationRepository } from './notification-repository';
export { PostgresProjectRepository } from './project-repository';
export { PostgresSettingsRepository } from './settings-repository';
export { PostgresSyncRunRepository } from './sync-run-repository';
export { PostgresTaskRepository } from './task-repository';
export { createPostgresConnectorExecutionRepositories } from './connector-execution-repositories';
export { createPostgresGitHubIdentityRepositories } from './github-identity-repositories';
export { createPostgresGitHubDependencyRepositories } from './github-dependency-repositories';
export { createPostgresGitHubHierarchyRepositories } from './github-hierarchy-repositories';
export { createPostgresGitHubProjectRepositories } from './github-project-repositories';

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

/**
 * Builds the GitHub worker persistence composition atomically. Either every
 * member resolves (and `github-issues` normal queue execution is supported on
 * PostgreSQL) or construction fails and nothing is registered — there is no
 * partially-migrated GitHub surface.
 */
export function createPostgresGitHubWorkerRepositories(
  pool: Pool,
): GitHubWorkerRepositories {
  const identity = createPostgresGitHubIdentityRepositories(pool);
  return {
    identity: identity.identity,
    writeFence: identity.writeFence,
    dependencies: createPostgresGitHubDependencyRepositories(pool),
    hierarchy: createPostgresGitHubHierarchyRepositories(pool),
    projects: createPostgresGitHubProjectRepositories(pool),
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
    github: createPostgresGitHubWorkerRepositories(pool),
  };
}
