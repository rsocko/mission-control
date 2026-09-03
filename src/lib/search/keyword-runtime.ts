import type { KeywordSearchRepository } from './repository';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

let repository: KeywordSearchRepository | null = null;

export function registerKeywordSearchRepository(
  next: KeywordSearchRepository,
): void {
  assertCanRegisterKeywordSearchRepository(next);
  repository = next;
}

export function assertCanRegisterKeywordSearchRepository(
  next: KeywordSearchRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repository && repository !== next) {
    throw new Error('Keyword search repository is already selected');
  }
}

export function clearKeywordSearchRepository(
  expectedRepository?: KeywordSearchRepository,
): void {
  if (expectedRepository && repository !== expectedRepository) return;
  repository = null;
}

export function getKeywordSearchRepository(): KeywordSearchRepository {
  assertPersistenceCompositionAccessAllowed();
  if (!repository) {
    throw new Error('Keyword search repository has not been registered');
  }
  return repository;
}
