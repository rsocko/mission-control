import type { Pool, PoolClient } from 'pg';
import type { ConnectorOperationRecoveryOutcome } from '@/lib/sync/connector-operation-lease-repository';

/**
 * Shared helpers between the PostgreSQL sync-job and connector-operation
 * lease repositories. Split out so both modules (and their unit tests) can
 * depend on pure, DB-free logic without importing each other.
 */

export type PgClient = Pool | PoolClient;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConnectorOperationLeaseMs(): number {
  return positiveInteger(process.env.MC_CONNECTOR_OPERATION_LEASE_MS, 120_000);
}

/**
 * The `connector_operation_leases` table has one row per connector
 * (`operation_type` distinguishes sync/retention/transfer), so a running
 * sync job's exclusivity lock is stored under a composite owner string
 * scoped to the job, keeping it distinct from retention/transfer leases.
 */
export function connectorSyncLeaseOwner(jobId: string, workerOwner: string): string {
  return `sync:${jobId}:${workerOwner}`;
}

/**
 * Escapes a value for safe embedding in a `LIKE`/`ILIKE` pattern using `\`
 * as the escape character (paired with `ESCAPE '\'` at the call site). Pure
 * and unit-testable without a database.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Recovers `running` sync jobs whose lease has expired: exhausts jobs at
 * their final attempt, marks jobs superseded by an already-queued follow-up
 * as failed, and requeues everything else for retry. Shared by the sync-job
 * repository (as part of claiming) and the connector-operation-lease
 * repository (as its own `recoverExpiredJobs` contract method).
 */
export async function recoverExpiredSyncJobsWithOutcome(
  client: PgClient,
  nowIso: string,
): Promise<ConnectorOperationRecoveryOutcome> {
  const exhausted = await client.query(
    `
      UPDATE sync_jobs
      SET status = 'failed',
          completed_at = $1,
          updated_at = $1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          error = COALESCE(error, 'Worker lease expired after final attempt')
      WHERE status = 'running'
        AND lease_expires_at < $1
        AND attempt >= max_attempts
    `,
    [nowIso],
  );

  const superseded = await client.query(
    `
      UPDATE sync_jobs AS expired
      SET status = 'failed',
          completed_at = $1,
          updated_at = $1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          error = COALESCE(expired.error, 'Worker lease expired; queued follow-up superseded retry')
      WHERE expired.status = 'running'
        AND expired.lease_expires_at < $1
        AND EXISTS (
          SELECT 1 FROM sync_jobs AS follow_up
          WHERE follow_up.connector_id = expired.connector_id
            AND follow_up.status = 'queued'
            AND follow_up.id <> expired.id
        )
    `,
    [nowIso],
  );

  const requeued = await client.query(
    `
      UPDATE sync_jobs
      SET status = 'queued',
          source = 'recovery',
          available_at = $1,
          updated_at = $1,
          lease_owner = NULL,
          lease_expires_at = NULL,
          error = COALESCE(error, 'Worker lease expired; retrying')
      WHERE status = 'running'
        AND lease_expires_at < $1
        AND attempt < max_attempts
        AND NOT EXISTS (
          SELECT 1 FROM sync_jobs AS follow_up
          WHERE follow_up.connector_id = sync_jobs.connector_id
            AND follow_up.status = 'queued'
            AND follow_up.id <> sync_jobs.id
        )
    `,
    [nowIso],
  );

  return {
    exhausted: exhausted.rowCount ?? 0,
    superseded: superseded.rowCount ?? 0,
    requeued: requeued.rowCount ?? 0,
  };
}
