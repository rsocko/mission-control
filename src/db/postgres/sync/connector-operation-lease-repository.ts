import type { Pool, PoolClient } from 'pg';
import type {
  ConnectorOperationLeaseAcquireOutcome,
  ConnectorOperationLeaseIdentity,
  ConnectorOperationLeaseReleaseOutcome,
  ConnectorOperationLeaseRenewOutcome,
  ConnectorOperationLeaseRepository,
  ConnectorOperationLeaseRequest,
  ConnectorOperationRecoveryOutcome,
} from '@/lib/sync/connector-operation-lease-repository';
import { escapeLikePattern, recoverExpiredSyncJobsWithOutcome } from './lease-helpers';

type PgClient = Pool | PoolClient;

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function hasConnectorSyncJobLease(
  client: PgClient,
  connectorId: string,
  jobId: string,
  nowIso: string,
): Promise<boolean> {
  const result = await client.query(
    `
      SELECT 1
      FROM connector_operation_leases
      WHERE connector_id = $1
        AND operation_type = 'sync'
        AND owner LIKE $2 ESCAPE '\\'
        AND lease_expires_at > $3
      LIMIT 1
    `,
    [connectorId, `sync:${escapeLikePattern(jobId)}:%`, nowIso],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * PostgreSQL-backed implementation of the portable
 * `ConnectorOperationLeaseRepository` contract. `connector_operation_leases`
 * is keyed on `connector_id` (one active lease per connector across
 * sync/retention/transfer operation types), so `acquire` relies on that
 * primary key to atomically reject conflicting concurrent acquisitions via a
 * unique-violation rather than a separate existence check plus insert.
 */
export class PostgresConnectorOperationLeaseRepository implements ConnectorOperationLeaseRepository {
  constructor(private readonly pool: Pool) {}

  async hasActiveSyncJobLease(input: {
    connectorId: string;
    jobId: string;
    at: string;
  }): Promise<boolean> {
    return hasConnectorSyncJobLease(this.pool, input.connectorId, input.jobId, input.at);
  }

  async acquire(
    request: ConnectorOperationLeaseRequest,
  ): Promise<ConnectorOperationLeaseAcquireOutcome> {
    const { connectorId, operationType, owner, leaseDurationMs, at } = request;
    return withTransaction(this.pool, async (client) => {
      const now = new Date(at);
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

      await client.query(
        `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND lease_expires_at <= $2`,
        [connectorId, nowIso],
      );

      const [maintenanceLock] = (await client.query(
        `SELECT 1 FROM connector_maintenance_locks WHERE connector_instance_id = $1 LIMIT 1`,
        [connectorId],
      )).rows;
      if (maintenanceLock) return { status: 'conflict' };

      if (operationType === 'retention') {
        await recoverExpiredSyncJobsWithOutcome(client, nowIso);
        const [activeJob] = (await client.query(
          `SELECT 1 FROM sync_jobs WHERE connector_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
          [connectorId],
        )).rows;
        if (activeJob) return { status: 'conflict' };
      }

      const inserted = await client.query(
        `
          INSERT INTO connector_operation_leases (
            connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (connector_id) DO NOTHING
        `,
        [connectorId, operationType, owner, leaseExpiresAt, nowIso],
      );
      if (inserted.rowCount !== 1) return { status: 'conflict' };
      return { status: 'acquired', expiresAt: leaseExpiresAt };
    });
  }

  async renew(
    request: Omit<ConnectorOperationLeaseRequest, 'operationType'>,
  ): Promise<ConnectorOperationLeaseRenewOutcome> {
    const { connectorId, owner, leaseDurationMs, at } = request;
    const now = new Date(at);
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const updated = await this.pool.query(
      `
        UPDATE connector_operation_leases
        SET lease_expires_at = $1, updated_at = $2
        WHERE connector_id = $3 AND owner = $4 AND lease_expires_at > $2
      `,
      [leaseExpiresAt, nowIso, connectorId, owner],
    );
    return (updated.rowCount ?? 0) === 1
      ? { status: 'renewed', expiresAt: leaseExpiresAt }
      : { status: 'lost' };
  }

  async release(
    identity: ConnectorOperationLeaseIdentity,
  ): Promise<ConnectorOperationLeaseReleaseOutcome> {
    const deleted = await this.pool.query(
      `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2`,
      [identity.connectorId, identity.owner],
    );
    return (deleted.rowCount ?? 0) === 1 ? { status: 'released' } : { status: 'lost' };
  }

  async recoverExpiredJobs(at: string): Promise<ConnectorOperationRecoveryOutcome> {
    return withTransaction(this.pool, (client) => recoverExpiredSyncJobsWithOutcome(client, at));
  }
}

/**
 * Stable construction point for composition roots: builds a
 * `ConnectorOperationLeaseRepository` backed by PostgreSQL from a `pg`
 * `Pool` (typically `PostgresPersistenceBackend#context.pool` from
 * `@/db/postgres/runtime`), without callers needing to know the concrete
 * class.
 */
export function createPostgresConnectorOperationLeaseRepository(
  pool: Pool,
): ConnectorOperationLeaseRepository {
  return new PostgresConnectorOperationLeaseRepository(pool);
}
