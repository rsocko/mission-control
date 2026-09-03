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

let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories | null = null;
let workerPersistenceAccessed = false;
let selectedWorkerOwnsTriage = false;

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  assertCanRegisterWorkerPersistenceRepositories(repositories);
  registerTriagePersistenceRepositories(repositories.triage);
  selectedWorkerPersistenceRepositories = repositories;
  selectedWorkerOwnsTriage = true;
}

export function assertCanRegisterWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (
    selectedWorkerPersistenceRepositories
    && selectedWorkerPersistenceRepositories !== repositories
    && workerPersistenceAccessed
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  assertCanRegisterTriagePersistenceRepositories(repositories.triage);
}

export function assertCanRegisterWorkerPersistenceRepositoriesWithBorrowedTriage(
  repositories: WorkerPersistenceRepositories,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (
    selectedWorkerPersistenceRepositories
    && selectedWorkerPersistenceRepositories !== repositories
    && workerPersistenceAccessed
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
  selectedWorkerPersistenceRepositories = repositories;
  selectedWorkerOwnsTriage = false;
}

export function clearWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (selectedWorkerPersistenceRepositories !== repositories) return;
  if (selectedWorkerOwnsTriage) {
    clearTriagePersistenceRepositories(repositories.triage);
  }
  selectedWorkerPersistenceRepositories = null;
  workerPersistenceAccessed = false;
  selectedWorkerOwnsTriage = false;
}

export async function getWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  assertPersistenceCompositionAccessAllowed();
  workerPersistenceAccessed = true;
  if (selectedWorkerPersistenceRepositories) {
    return selectedWorkerPersistenceRepositories;
  }
  throw new Error(
    'Worker persistence repositories must be registered before worker persistence is accessed',
  );
}
