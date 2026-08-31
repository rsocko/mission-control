import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import { resolveDatabaseBackend } from '@/db/runtime-backend';

let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories | null = null;
let sqliteWorkerPersistencePromise: Promise<WorkerPersistenceRepositories> | null = null;
let workerPersistenceRegistered = false;
let workerPersistenceAccessed = false;

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (
    selectedWorkerPersistenceRepositories !== repositories
    && (workerPersistenceRegistered || workerPersistenceAccessed)
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  selectedWorkerPersistenceRepositories = repositories;
  workerPersistenceRegistered = true;
}

async function createSqliteWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  const [
    { default: db, sqlite },
    { sqliteCorePersistenceRepositories },
    { SqliteSyncRunRepository },
    { createSqliteConnectorExecutionRepositories },
    { createSqliteGitHubIdentityRepositories },
    { createSqliteGitHubDependencyRepositories },
    { createSqliteGitHubHierarchyRepositories },
    { createSqliteGitHubProjectRepositories },
    { createSqliteGitHubRecoveryRepositories },
    { createSqliteWorkTodoRepositories },
  ] = await Promise.all([
    import('@/db'),
    import('@/db/persistence/sqlite-core-repositories'),
    import('@/db/persistence/sqlite-sync-run-repository'),
    import('@/db/persistence/sqlite-connector-execution-repositories'),
    import('@/db/persistence/sqlite-github-identity-repositories'),
    import('@/db/persistence/sqlite-github-dependency-repositories'),
    import('@/db/persistence/sqlite-github-hierarchy-repositories'),
    import('@/db/persistence/sqlite-github-project-repositories'),
    import('@/db/persistence/sqlite-github-recovery-repositories'),
    import('@/db/persistence/sqlite-work-todo-repositories'),
  ]);
  const githubIdentity = createSqliteGitHubIdentityRepositories(sqlite, db);
  return {
    connectors: sqliteCorePersistenceRepositories.connectors,
    syncRuns: new SqliteSyncRunRepository(sqlite),
    execution: createSqliteConnectorExecutionRepositories(sqlite, db),
    github: {
      identity: githubIdentity.identity,
      writeFence: githubIdentity.writeFence,
      dependencies: createSqliteGitHubDependencyRepositories(sqlite, db),
      hierarchy: createSqliteGitHubHierarchyRepositories(sqlite, db),
      projects: createSqliteGitHubProjectRepositories(sqlite, db),
      recovery: createSqliteGitHubRecoveryRepositories(sqlite, db),
    },
    connectorState: {
      workTodo: createSqliteWorkTodoRepositories(sqlite, db),
    },
  };
}

export async function getWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  workerPersistenceAccessed = true;
  if (selectedWorkerPersistenceRepositories) {
    return selectedWorkerPersistenceRepositories;
  }
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'PostgreSQL worker repositories must be registered before worker persistence is accessed',
    );
  }
  sqliteWorkerPersistencePromise ??= createSqliteWorkerPersistenceRepositories()
    .then((repositories) => {
      selectedWorkerPersistenceRepositories = repositories;
      return repositories;
    });
  return sqliteWorkerPersistencePromise;
}
