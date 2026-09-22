import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from './composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface CorePersistenceRegistry {
  selected: CorePersistenceRepositories | null;
  accessed: boolean;
}

// Next.js may evaluate instrumentation and route handlers in separate bundles.
const REGISTRY_KEY = 'mission-control.core-persistence-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): CorePersistenceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
    accessed: false,
  }));
}

export function registerCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  assertCanRegisterCorePersistenceRepositories(repositories);
  registry().selected = repositories;
}

export function assertCanRegisterCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (
    state.selected
    && state.selected !== repositories
    && state.accessed
  ) {
    throw new Error('Core persistence repositories are already selected');
  }
}

export function clearCorePersistenceRepositories(
  repositories: CorePersistenceRepositories,
): void {
  const state = registry();
  if (state.selected !== repositories) return;
  state.selected = null;
  state.accessed = false;
}

export function getCorePersistenceRepositories(): CorePersistenceRepositories {
  assertPersistenceCompositionAccessAllowed();
  const state = registry();
  state.accessed = true;
  if (!state.selected) {
    throw new Error('Core persistence repositories have not been registered');
  }
  return state.selected;
}

export async function getCorePersistenceRepositoriesForBackend(): Promise<
  CorePersistenceRepositories
> {
  return getCorePersistenceRepositories();
}
