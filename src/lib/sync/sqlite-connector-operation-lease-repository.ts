import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sqlite } from '@/db';
import type {
  ConnectorOperationLeaseRepository,
  ConnectorOperationRecoveryOutcome,
  ConnectorOperationType,
} from './connector-operation-lease-repository';

export class ConnectorOperationBusyError extends Error {
  constructor(message = 'Another operation is already queued or in progress for this connector') {
    super(message);
    this.name = 'ConnectorOperationBusyError';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConnectorOperationLeaseMs(): number {
  return positiveInteger(process.env.MC_CONNECTOR_OPERATION_LEASE_MS, 120_000);
}

export function connectorSyncLeaseOwner(jobId: string, workerOwner: string): string {
  return `sync:${jobId}:${workerOwner}`;
}

export function hasConnectorSyncJobLease(
  connectorId: string,
  jobId: string,
  now = new Date().toISOString(),
): boolean {
  return sqlite.prepare(`
    SELECT 1
    FROM connector_operation_leases
    WHERE connector_id = ?
      AND operation_type = 'sync'
      AND owner LIKE ? ESCAPE '\\'
      AND lease_expires_at > ?
    LIMIT 1
  `).get(
    connectorId,
    `sync:${jobId.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}:%`,
    now,
  ) !== undefined;
}

function recoverExpiredSyncJobsWithOutcome(
  nowIso: string,
): ConnectorOperationRecoveryOutcome {
  const exhausted = sqlite.prepare(`
    UPDATE sync_jobs
    SET status = 'failed',
        completed_at = ?,
        updated_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        error = COALESCE(error, 'Worker lease expired after final attempt')
    WHERE status = 'running'
      AND lease_expires_at < ?
      AND attempt >= max_attempts
  `).run(nowIso, nowIso, nowIso).changes;

  const superseded = sqlite.prepare(`
    UPDATE sync_jobs AS expired
    SET status = 'failed',
        completed_at = ?,
        updated_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        error = COALESCE(error, 'Worker lease expired; queued follow-up superseded retry')
    WHERE expired.status = 'running'
      AND expired.lease_expires_at < ?
      AND EXISTS (
        SELECT 1 FROM sync_jobs AS follow_up
        WHERE follow_up.connector_id = expired.connector_id
          AND follow_up.status = 'queued'
          AND follow_up.id <> expired.id
      )
  `).run(nowIso, nowIso, nowIso).changes;

  const requeued = sqlite.prepare(`
    UPDATE sync_jobs
    SET status = 'queued',
        source = 'recovery',
        available_at = ?,
        updated_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        error = COALESCE(error, 'Worker lease expired; retrying')
    WHERE status = 'running'
      AND lease_expires_at < ?
      AND attempt < max_attempts
      AND NOT EXISTS (
        SELECT 1 FROM sync_jobs AS follow_up
        WHERE follow_up.connector_id = sync_jobs.connector_id
          AND follow_up.status = 'queued'
          AND follow_up.id <> sync_jobs.id
      )
  `).run(nowIso, nowIso, nowIso).changes;
  return { exhausted, superseded, requeued };
}

export function recoverExpiredSyncJobs(nowIso: string): void {
  recoverExpiredSyncJobsWithOutcome(nowIso);
}

export function acquireConnectorOperationLease(
  connectorId: string,
  operationType: ConnectorOperationType,
  owner: string,
  leaseMs = getConnectorOperationLeaseMs(),
  now = new Date(),
): boolean {
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE connector_id = ? AND lease_expires_at <= ?
    `).run(connectorId, nowIso);

    const maintenanceLock = sqlite.prepare(`
      SELECT 1
      FROM connector_maintenance_locks
      WHERE connector_instance_id = ?
      LIMIT 1
    `).get(connectorId);
    if (maintenanceLock) return false;

    if (operationType === 'retention') {
      recoverExpiredSyncJobs(nowIso);
      const activeJob = sqlite.prepare(`
        SELECT 1
        FROM sync_jobs
        WHERE connector_id = ? AND status IN ('queued', 'running')
        LIMIT 1
      `).get(connectorId);
      if (activeJob) return false;
    }

    const inserted = sqlite.prepare(`
      INSERT OR IGNORE INTO connector_operation_leases (
        connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(connectorId, operationType, owner, leaseExpiresAt, nowIso, nowIso);
    return inserted.changes === 1;
  });
  return transaction.immediate();
}

export function renewConnectorOperationLease(
  connectorId: string,
  owner: string,
  leaseMs = getConnectorOperationLeaseMs(),
  now = new Date(),
): boolean {
  const renewed = sqlite.prepare(`
    UPDATE connector_operation_leases
    SET lease_expires_at = ?, updated_at = ?
    WHERE connector_id = ? AND owner = ? AND lease_expires_at > ?
  `).run(
    new Date(now.getTime() + leaseMs).toISOString(),
    now.toISOString(),
    connectorId,
    owner,
    now.toISOString(),
  );
  return renewed.changes === 1;
}

export function releaseConnectorOperationLease(connectorId: string, owner: string): boolean {
  return sqlite.prepare(`
    DELETE FROM connector_operation_leases
    WHERE connector_id = ? AND owner = ?
  `).run(connectorId, owner).changes === 1;
}

export async function runWithConnectorOperationLease<T>(
  connectorId: string,
  operationType: ConnectorOperationType,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = `${operationType}:${hostname()}:${process.pid}:${randomUUID()}`;
  const leaseMs = getConnectorOperationLeaseMs();
  if (!acquireConnectorOperationLease(connectorId, operationType, owner, leaseMs)) {
    throw new ConnectorOperationBusyError();
  }

  let leaseError: Error | null = null;
  const heartbeat = setInterval(() => {
    try {
      if (!renewConnectorOperationLease(connectorId, owner, leaseMs)) {
        leaseError = new Error('Connector operation lease ownership was lost');
      }
    } catch (error) {
      leaseError = error instanceof Error ? error : new Error(String(error));
    }
  }, Math.max(1, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  let operationSucceeded = false;
  try {
    const result = await operation();
    if (leaseError || !renewConnectorOperationLease(connectorId, owner, leaseMs)) {
      throw leaseError ?? new Error('Connector operation lease ownership was lost');
    }
    operationSucceeded = true;
    return result;
  } finally {
    clearInterval(heartbeat);
    const released = releaseConnectorOperationLease(connectorId, owner);
    if (operationSucceeded && !released) {
      throw new Error('Connector operation lease ownership was lost before release');
    }
  }
}

export const sqliteConnectorOperationLeaseRepository:
ConnectorOperationLeaseRepository = {
  hasActiveSyncJobLease: async ({ connectorId, jobId, at }) =>
    hasConnectorSyncJobLease(connectorId, jobId, at),
  acquire: async ({
    connectorId,
    operationType,
    owner,
    leaseDurationMs,
    at,
  }) => {
    const now = new Date(at);
    const acquired = acquireConnectorOperationLease(
      connectorId,
      operationType,
      owner,
      leaseDurationMs,
      now,
    );
    return acquired
      ? {
          status: 'acquired',
          expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        }
      : { status: 'conflict' };
  },
  renew: async ({ connectorId, owner, leaseDurationMs, at }) => {
    const now = new Date(at);
    const renewed = renewConnectorOperationLease(
      connectorId,
      owner,
      leaseDurationMs,
      now,
    );
    return renewed
      ? {
          status: 'renewed',
          expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        }
      : { status: 'lost' };
  },
  release: async ({ connectorId, owner }) =>
    releaseConnectorOperationLease(connectorId, owner)
      ? { status: 'released' }
      : { status: 'lost' },
  recoverExpiredJobs: async (at) => recoverExpiredSyncJobsWithOutcome(at),
};
