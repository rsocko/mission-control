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
    { sqlite },
    { sqliteCorePersistenceRepositories },
    { SqliteSyncRunRepository },
  ] = await Promise.all([
    import('@/db'),
    import('@/db/persistence/sqlite-core-repositories'),
    import('@/db/persistence/sqlite-sync-run-repository'),
  ]);
  return {
    connectors: sqliteCorePersistenceRepositories.connectors,
    syncRuns: new SqliteSyncRunRepository(sqlite),
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
