import type { ConnectorManagementPersistence } from '@/db/persistence/connector-management';
import type { DeletionPersistence } from '@/db/persistence/connector-execution';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export async function getConnectorManagementPersistence(): Promise<
  ConnectorManagementPersistence
> {
  return (await getWorkerPersistenceRepositories()).execution.management;
}

export async function getConnectorDeletionPersistence(): Promise<DeletionPersistence> {
  return (await getWorkerPersistenceRepositories()).execution.deletions;
}
