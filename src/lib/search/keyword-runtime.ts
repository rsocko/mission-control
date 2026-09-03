import type { KeywordSearchRepository } from './repository';

let repository: KeywordSearchRepository | null = null;

export function registerKeywordSearchRepository(
  next: KeywordSearchRepository,
): void {
  repository = next;
}

export function clearKeywordSearchRepository(): void {
  repository = null;
}

export function getKeywordSearchRepository(): KeywordSearchRepository {
  if (!repository) {
    throw new Error('Keyword search repository has not been registered');
  }
  return repository;
}
