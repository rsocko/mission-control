import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  assertCanRegisterTriagePersistenceRepositories,
  clearTriagePersistenceRepositories,
  registerTriagePersistenceRepositories,
} from '@/lib/triage/persistence';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from './composition-lifecycle';

let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories | null = null;
let workerPersistenceAccessed = false;

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  assertCanRegisterWorkerPersistenceRepositories(repositories);
  registerTriagePersistenceRepositories(repositories.triage);
  selectedWorkerPersistenceRepositories = repositories;
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

export function clearWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (selectedWorkerPersistenceRepositories !== repositories) return;
  clearTriagePersistenceRepositories(repositories.triage);
  selectedWorkerPersistenceRepositories = null;
  workerPersistenceAccessed = false;
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
