import type {
  ConnectorMaintenanceLock,
  ConnectorMaintenanceLockRepository,
} from './maintenance-lock';

export interface SynchronousConnectorMaintenanceLockCapability {
  getConnectorMaintenanceLock(connectorInstanceId: string): ConnectorMaintenanceLock | null;
  assertConnectorMaintenanceUnlocked(connectorInstanceId: string): void;
}

let capability: SynchronousConnectorMaintenanceLockCapability | null = null;

export function registerSqliteConnectorMaintenanceLockCapability(
  next: SynchronousConnectorMaintenanceLockCapability,
): void {
  capability = next;
}

export function clearSqliteConnectorMaintenanceLockCapability(): void {
  capability = null;
}

function requireCapability(): SynchronousConnectorMaintenanceLockCapability {
  if (!capability) {
    throw new Error('SQLite connector maintenance-lock capability has not been registered');
  }
  return capability;
}

export function getConnectorMaintenanceLock(
  connectorInstanceId: string,
): ConnectorMaintenanceLock | null {
  return requireCapability().getConnectorMaintenanceLock(connectorInstanceId);
}

export function assertConnectorMaintenanceUnlocked(connectorInstanceId: string): void {
  requireCapability().assertConnectorMaintenanceUnlocked(connectorInstanceId);
}

export const sqliteConnectorMaintenanceLockRepository:
ConnectorMaintenanceLockRepository = {
  get: async (connectorInstanceId) => getConnectorMaintenanceLock(connectorInstanceId),
  assertUnlocked: async (connectorInstanceId) =>
    assertConnectorMaintenanceUnlocked(connectorInstanceId),
};
