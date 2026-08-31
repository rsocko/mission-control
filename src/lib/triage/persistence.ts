import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';

let repositories: TriagePersistenceRepositories | null = null;

export function registerTriagePersistenceRepositories(
  nextRepositories: TriagePersistenceRepositories,
): void {
  if (repositories && repositories !== nextRepositories) {
    throw new Error('Triage persistence repositories are already registered');
  }
  repositories = nextRepositories;
}

export function getTriagePersistenceRepositories(): TriagePersistenceRepositories {
  if (!repositories) {
    throw new Error('Triage persistence repositories have not been registered');
  }
  return repositories;
}
