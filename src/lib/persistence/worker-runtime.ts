import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  assertCanRegisterTriagePersistenceRepositories,
  clearTriagePersistenceRepositories,
  getTriagePersistenceRegistrationForComposition,
  registerTriagePersistenceRepositories,
} from '@/lib/triage/persistence';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from './composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface WorkerPersistenceRegistry {
  selected: WorkerPersistenceRepositories | null;
  accessed: boolean;
  ownsTriage: boolean;
}

// Next.js may evaluate instrumentation and route handlers in separate bundles.
const REGISTRY_KEY = 'mission-control.worker-persistence-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): WorkerPersistenceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
    accessed: false,
    ownsTriage: false,
  }));
}

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  assertCanRegisterWorkerPersistenceRepositories(repositories);
  registerTriagePersistenceRepositories(repositories.triage);
  const state = registry();
  state.selected = repositories;
  state.ownsTriage = true;
}

export function assertCanRegisterWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (
    state.selected
    && state.selected !== repositories
    && state.accessed
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  assertCanRegisterTriagePersistenceRepositories(repositories.triage);
}

export function assertCanRegisterWorkerPersistenceRepositoriesWithBorrowedTriage(
  repositories: WorkerPersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (
    state.selected
    && state.selected !== repositories
    && state.accessed
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  const triageRegistration = getTriagePersistenceRegistrationForComposition();
  if (
    triageRegistration?.repositories !== repositories.triage
    || !triageRegistration.accessed
  ) {
    throw new Error('Borrowed triage persistence identity is no longer selected');
  }
}

export function registerWorkerPersistenceRepositoriesWithBorrowedTriage(
  repositories: WorkerPersistenceRepositories,
): void {
  assertCanRegisterWorkerPersistenceRepositoriesWithBorrowedTriage(repositories);
  const state = registry();
  state.selected = repositories;
  state.ownsTriage = false;
}

export function clearWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  const state = registry();
  if (state.selected !== repositories) return;
  if (state.ownsTriage) {
    clearTriagePersistenceRepositories(repositories.triage);
  }
  state.selected = null;
  state.accessed = false;
  state.ownsTriage = false;
}

export async function getWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  assertPersistenceCompositionAccessAllowed();
  const state = registry();
  state.accessed = true;
  if (state.selected) {
    return state.selected;
  }
  throw new Error(
    'Worker persistence repositories must be registered before worker persistence is accessed',
  );
}
