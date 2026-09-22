import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

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

interface ConnectorMaintenanceLockRuntimeRegistry {
  repository: ConnectorMaintenanceLockRepository | null;
}

const REGISTRY_KEY = 'mission-control.connector-maintenance-lock-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): ConnectorMaintenanceLockRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    repository: null,
  }));
}

export function registerConnectorMaintenanceLockRepository(
  next: ConnectorMaintenanceLockRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().repository;
  if (selected && selected !== next) {
    throw new Error('Connector maintenance-lock repository is already selected');
  }
  registry().repository = next;
}

export function clearConnectorMaintenanceLockRepository(
  expectedRepository?: ConnectorMaintenanceLockRepository,
): void {
  const state = registry();
  if (expectedRepository && state.repository !== expectedRepository) return;
  state.repository = null;
}

export async function getConnectorMaintenanceLockRepository():
Promise<ConnectorMaintenanceLockRepository> {
  assertPersistenceCompositionAccessAllowed();
  const repository = registry().repository;
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
