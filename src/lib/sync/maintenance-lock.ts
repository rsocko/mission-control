import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export interface ConnectorMaintenanceLock {
  connectorInstanceId: string;
  operationId: string;
  actor: string;
  reason: string;
  acquiredAt: string;
  updatedAt: string;
}

export interface ConnectorMaintenanceLockRepository {
  get(connectorInstanceId: string): Promise<ConnectorMaintenanceLock | null>;
  assertUnlocked(connectorInstanceId: string): Promise<void>;
}

let repository: ConnectorMaintenanceLockRepository | null = null;

export function registerConnectorMaintenanceLockRepository(
  next: ConnectorMaintenanceLockRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (repository && repository !== next) {
    throw new Error('Connector maintenance-lock repository is already selected');
  }
  repository = next;
}

export function clearConnectorMaintenanceLockRepository(
  expectedRepository?: ConnectorMaintenanceLockRepository,
): void {
  if (expectedRepository && repository !== expectedRepository) return;
  repository = null;
}

export async function getConnectorMaintenanceLockRepository():
Promise<ConnectorMaintenanceLockRepository> {
  assertPersistenceCompositionAccessAllowed();
  if (!repository) {
    throw new Error('Connector maintenance-lock repository has not been registered');
  }
  return repository;
}

export async function assertConnectorMaintenanceUnlockedAsync(
  connectorInstanceId: string,
): Promise<void> {
  await (await getConnectorMaintenanceLockRepository()).assertUnlocked(
    connectorInstanceId,
  );
}
