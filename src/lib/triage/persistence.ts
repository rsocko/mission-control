import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

let repositories: TriagePersistenceRepositories | null = null;
let repositoriesAccessed = false;

export function registerTriagePersistenceRepositories(
  nextRepositories: TriagePersistenceRepositories,
): void {
  assertCanRegisterTriagePersistenceRepositories(nextRepositories);
  repositories = nextRepositories;
}

export function assertCanRegisterTriagePersistenceRepositories(
  nextRepositories: TriagePersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repositories && repositories !== nextRepositories && repositoriesAccessed) {
    throw new Error('Triage persistence repositories are already registered');
  }
}

export function clearTriagePersistenceRepositories(
  expectedRepositories: TriagePersistenceRepositories,
): void {
  if (repositories === expectedRepositories) repositories = null;
  if (!repositories) repositoriesAccessed = false;
}

export function getTriagePersistenceRepositories(): TriagePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  repositoriesAccessed = true;
  if (!repositories) {
    throw new Error('Triage persistence repositories have not been registered');
  }
  return repositories;
}
