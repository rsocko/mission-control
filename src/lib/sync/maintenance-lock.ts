import { sqlite } from '@/db';

export interface ConnectorMaintenanceLock {
  connectorInstanceId: string;
  operationId: string;
  actor: string;
  reason: string;
  acquiredAt: string;
  updatedAt: string;
}

export function getConnectorMaintenanceLock(
  connectorInstanceId: string,
): ConnectorMaintenanceLock | null {
  const row = sqlite.prepare(`
    SELECT
      connector_instance_id AS connectorInstanceId,
      operation_id AS operationId,
      actor,
      reason,
      acquired_at AS acquiredAt,
      updated_at AS updatedAt
    FROM connector_maintenance_locks
    WHERE connector_instance_id = ?
  `).get(connectorInstanceId) as ConnectorMaintenanceLock | undefined;
  return row ?? null;
}

export function assertConnectorMaintenanceUnlocked(connectorInstanceId: string): void {
  const lock = getConnectorMaintenanceLock(connectorInstanceId);
  if (lock) {
    throw new Error(
      `Connector is locked for maintenance by operation ${lock.operationId}`,
    );
  }
}
