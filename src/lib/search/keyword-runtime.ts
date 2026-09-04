import type { KeywordSearchRepository } from './repository';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface KeywordSearchRegistry {
  repository: KeywordSearchRepository | null;
}

const REGISTRY_KEY = 'mission-control.keyword-search-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): KeywordSearchRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repository: null,
  }));
}

export function registerKeywordSearchRepository(
  next: KeywordSearchRepository,
): void {
  assertCanRegisterKeywordSearchRepository(next);
  registry().repository = next;
}

export function assertCanRegisterKeywordSearchRepository(
  next: KeywordSearchRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().repository;
  if (selected && selected !== next) {
    throw new Error('Keyword search repository is already selected');
  }
}

export function clearKeywordSearchRepository(
  expectedRepository?: KeywordSearchRepository,
): void {
  const state = registry();
  if (expectedRepository && state.repository !== expectedRepository) return;
  state.repository = null;
}

export function getKeywordSearchRepository(): KeywordSearchRepository {
  assertPersistenceCompositionAccessAllowed();
  const repository = registry().repository;
  if (!repository) {
    throw new Error('Keyword search repository has not been registered');
  }
  return repository;
}
