import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import { registerTriagePersistenceRepositories } from '@/lib/triage/persistence';

let selectedWorkerPersistenceRepositories: WorkerPersistenceRepositories | null = null;
let workerPersistenceRegistered = false;
let workerPersistenceAccessed = false;

export function registerWorkerPersistenceRepositories(
  repositories: WorkerPersistenceRepositories,
): void {
  if (
    selectedWorkerPersistenceRepositories !== repositories
    && (workerPersistenceRegistered || workerPersistenceAccessed)
  ) {
    throw new Error('Worker persistence repositories are already selected');
  }
  registerTriagePersistenceRepositories(repositories.triage);
  selectedWorkerPersistenceRepositories = repositories;
  workerPersistenceRegistered = true;
}

export async function getWorkerPersistenceRepositories(): Promise<
  WorkerPersistenceRepositories
> {
  workerPersistenceAccessed = true;
  if (selectedWorkerPersistenceRepositories) {
    return selectedWorkerPersistenceRepositories;
  }
  throw new Error(
    'Worker persistence repositories must be registered before worker persistence is accessed',
  );
}
