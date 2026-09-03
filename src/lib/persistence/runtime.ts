import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from './composition-lifecycle';

let selectedCorePersistenceRepositories: CorePersistenceRepositories | null = null;
let corePersistenceAccessed = false;

export function registerCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  assertCanRegisterCorePersistenceRepositories(repositories);
  selectedCorePersistenceRepositories = repositories;
}

export function assertCanRegisterCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (
    selectedCorePersistenceRepositories
    && selectedCorePersistenceRepositories !== repositories
    && corePersistenceAccessed
  ) {
    throw new Error('Core persistence repositories are already selected');
  }
}

export function clearCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  if (selectedCorePersistenceRepositories !== repositories) return;
  selectedCorePersistenceRepositories = null;
  corePersistenceAccessed = false;
}

export function getCorePersistenceRepositories(): CorePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  corePersistenceAccessed = true;
  if (!selectedCorePersistenceRepositories) {
    throw new Error('Core persistence repositories have not been registered');
  }
  return selectedCorePersistenceRepositories;
}

export async function getCorePersistenceRepositoriesForBackend(): Promise<
  CorePersistenceRepositories
> {
  return getCorePersistenceRepositories();
}
