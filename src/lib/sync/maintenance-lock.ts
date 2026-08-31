import { resolveDatabaseBackend } from '@/db/runtime-backend';

export interface ConnectorMaintenanceLock {
  connectorInstanceId: string;
  operationId: string;
  actor: string;
  reason: string;
  acquiredAt: string;
  updatedAt: string;
}

/**
 * Backend-selected, async equivalent of `assertConnectorMaintenanceUnlocked`.
 * SQLite delegates to the unchanged synchronous check above; PostgreSQL
 * queries `connector_maintenance_locks` directly via the registered pool
 * (dynamically imported so SQLite-only callers never pull in the PostgreSQL
 * schema/driver graph).
 */
export async function assertConnectorMaintenanceUnlockedAsync(
  connectorInstanceId: string,
): Promise<void> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresPersistenceBackend } = await import('@/db/runtime');
    const result = await getPostgresPersistenceBackend().context.pool.query<{ operationId: string }>(
      `SELECT operation_id AS "operationId" FROM connector_maintenance_locks WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    const lock = result.rows[0];
    if (lock) {
      throw new Error(`Connector is locked for maintenance by operation ${lock.operationId}`);
    }
    return;
  }
  const { assertConnectorMaintenanceUnlocked } = await import('./sqlite-maintenance-lock');
  assertConnectorMaintenanceUnlocked(connectorInstanceId);
}
