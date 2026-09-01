import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import { resolveDatabaseBackend } from '@/db/runtime-backend';

let selectedCorePersistenceRepositories: CorePersistenceRepositories | null = null;
let sqliteCorePersistencePromise: Promise<CorePersistenceRepositories> | null = null;
let corePersistenceRegistered = false;
let corePersistenceAccessed = false;

export function registerCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  if (
    selectedCorePersistenceRepositories !== repositories
    && (corePersistenceRegistered || corePersistenceAccessed)
  ) {
    throw new Error('Core persistence repositories are already selected');
  }
  selectedCorePersistenceRepositories = repositories;
  corePersistenceRegistered = true;
}

export function getCorePersistenceRepositories(): CorePersistenceRepositories {
  corePersistenceAccessed = true;
  if (!selectedCorePersistenceRepositories) {
    throw new Error('Core persistence repositories have not been registered');
  }
  return selectedCorePersistenceRepositories;
}

export async function getCorePersistenceRepositoriesForBackend(): Promise<
  CorePersistenceRepositories
> {
  if (selectedCorePersistenceRepositories) return selectedCorePersistenceRepositories;
  if (resolveDatabaseBackend() === 'postgres') return getCorePersistenceRepositories();

  sqliteCorePersistencePromise ??= import('@/db/persistence/sqlite-core-repositories')
    .then(({ sqliteCorePersistenceRepositories }) => sqliteCorePersistenceRepositories);
  return sqliteCorePersistencePromise;
}
