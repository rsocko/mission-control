import type { Pool } from 'pg';
import type {
  ConnectorMaintenanceLock,
  ConnectorMaintenanceLockRepository,
} from '@/lib/sync/maintenance-lock';

export class PostgresConnectorMaintenanceLockRepository
implements ConnectorMaintenanceLockRepository {
  constructor(private readonly pool: Pool) {}

  async get(connectorInstanceId: string): Promise<ConnectorMaintenanceLock | null> {
    const result = await this.pool.query<ConnectorMaintenanceLock>(
      `SELECT
         connector_instance_id AS "connectorInstanceId",
         operation_id AS "operationId",
         actor,
         reason,
         acquired_at AS "acquiredAt",
         updated_at AS "updatedAt"
       FROM connector_maintenance_locks
       WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    return result.rows[0] ?? null;
  }

  async assertUnlocked(connectorInstanceId: string): Promise<void> {
    const lock = await this.get(connectorInstanceId);
    if (lock) {
      throw new Error(
        `Connector is locked for maintenance by operation ${lock.operationId}`,
      );
    }
  }
}

export function createPostgresConnectorMaintenanceLockRepository(
  pool: Pool,
): ConnectorMaintenanceLockRepository {
  return new PostgresConnectorMaintenanceLockRepository(pool);
}
