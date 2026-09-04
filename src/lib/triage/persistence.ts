import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface TriagePersistenceRegistry {
  repositories: TriagePersistenceRepositories | null;
  accessed: boolean;
}

const REGISTRY_KEY = 'mission-control.triage-persistence-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): TriagePersistenceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repositories: null,
    accessed: false,
  }));
}

export interface TriagePersistenceRegistration {
  repositories: TriagePersistenceRepositories;
  accessed: boolean;
}

export function registerTriagePersistenceRepositories(
  nextRepositories: TriagePersistenceRepositories,
): void {
  assertCanRegisterTriagePersistenceRepositories(nextRepositories);
  registry().repositories = nextRepositories;
}

export function assertCanRegisterTriagePersistenceRepositories(
  nextRepositories: TriagePersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (state.repositories && state.repositories !== nextRepositories && state.accessed) {
    throw new Error('Triage persistence repositories are already registered');
  }
}

export function clearTriagePersistenceRepositories(
  expectedRepositories: TriagePersistenceRepositories,
): void {
  const state = registry();
  if (state.repositories === expectedRepositories) state.repositories = null;
  if (!state.repositories) state.accessed = false;
}

export function getTriagePersistenceRegistrationForComposition():
  TriagePersistenceRegistration | null {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (!state.repositories) return null;
  return { repositories: state.repositories, accessed: state.accessed };
}

export function getTriagePersistenceRepositories(): TriagePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  const state = registry();
  state.accessed = true;
  if (!state.repositories) {
    throw new Error('Triage persistence repositories have not been registered');
  }
  return state.repositories;
}
