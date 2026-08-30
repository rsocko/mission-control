import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import { ConnectorSyncControlError } from '@/lib/sync/control-state';
import type { SyncStreamEvent } from '@/lib/sync/events';
import type {
  EnqueueSyncJobOptions,
  PersistedSyncEvent,
  SyncCancellationResult,
  SyncJob,
  SyncJobFailureOptions,
  SyncJobRepository,
  SyncJobSource,
  SyncJobStatus,
  SyncQueueMetrics,
  SyncSchedule,
  SyncScheduleHealth,
} from '@/lib/sync/job-repository';
import type { SyncResult } from '@/types';
import { connectorSyncLeaseOwner, recoverExpiredSyncJobsWithOutcome } from './lease-helpers';

// ─── Environment-tunable defaults (mirrors the SQLite worker's knobs) ──────

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getSyncLeaseMs(): number {
  return positiveInteger(process.env.MC_SYNC_JOB_LEASE_MS, 120_000);
}

export function getSyncDurationBudgetMs(): number {
  return positiveInteger(process.env.MC_SYNC_DURATION_BUDGET_MS, 300_000);
}

function getSyncMaxAttemptsDefault(): number {
  return positiveInteger(process.env.MC_SYNC_JOB_MAX_ATTEMPTS, 3);
}

function getRetryBaseMs(): number {
  return positiveInteger(process.env.MC_SYNC_JOB_RETRY_BASE_MS, 30_000);
}

function getMissedScheduleGraceMs(): number {
  return positiveInteger(process.env.MC_SYNC_MISSED_SCHEDULE_GRACE_MS, 120_000);
}

export function failedResult(connectorId: string, error: string): SyncResult {
  return {
    connectorId,
    success: false,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [error],
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Exponential retry backoff, capped at 15 minutes — a pure, unit-testable
 * port of the SQLite worker's retry schedule.
 */
export function computeRetryAvailableAt(now: Date, attempt: number, retryBaseMs = getRetryBaseMs()): string {
  const delayMs = Math.min(retryBaseMs * (2 ** Math.max(0, attempt - 1)), 15 * 60_000);
  return new Date(now.getTime() + delayMs).toISOString();
}

/**
 * Builds a `connector_id NOT IN (...)` SQL fragment and its bound parameters,
 * starting at `startIndex`. Pure and unit-testable without a database.
 */
export function buildExclusionClause(
  excludedConnectorIds: ReadonlySet<string>,
  startIndex: number,
): { clause: string; params: string[] } {
  const excluded = [...excludedConnectorIds];
  if (excluded.length === 0) return { clause: '', params: [] };
  const placeholders = excluded.map((_, index) => `$${startIndex + index}`).join(', ');
  return { clause: `AND connector_id NOT IN (${placeholders})`, params: excluded };
}

const JOB_COLUMNS = `
  id,
  connector_id AS "connectorId",
  "full",
  source,
  status,
  attempt,
  max_attempts AS "maxAttempts",
  available_at AS "availableAt",
  scheduled_for AS "scheduledFor",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  cancel_requested_at AS "cancelRequestedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  result,
  error,
  duration_budget_ms AS "durationBudgetMs",
  identity_mode AS "identityMode",
  identity_mode_revision AS "identityModeRevision",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

interface SyncJobDatabaseRow {
  id: string;
  connectorId: string;
  full: boolean;
  source: SyncJobSource;
  status: SyncJobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  scheduledFor: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: SyncResult | null;
  error: string | null;
  durationBudgetMs: number;
  identityMode: string | null;
  identityModeRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `result` is stored as `jsonb`, so `pg`/drizzle already deserialize it —
 * unlike the SQLite adapter, no `JSON.parse` is required here.
 */
export function deserializeJob(row: SyncJobDatabaseRow): SyncJob {
  return { ...row };
}

export type Client = Pool | PoolClient;

async function query<T>(client: Client, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows as T[];
}

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

async function captureGitHubIdentityStamp(
  client: Client,
  connectorId: string,
): Promise<{ mode: typeof GITHUB_IDENTITY_MODE; revision: number } | null> {
  const [row] = await query<{ type: string; modeRevision: number }>(
    client,
    `
      SELECT
        connector_configs.type AS type,
        COALESCE(github_identity_controls.mode_revision, 0) AS "modeRevision"
      FROM connector_configs
      LEFT JOIN github_identity_controls
        ON github_identity_controls.connector_instance_id = connector_configs.id
      WHERE connector_configs.id = $1
    `,
    [connectorId],
  );
  if (!row || row.type !== 'github-issues') return null;
  return { mode: GITHUB_IDENTITY_MODE, revision: row.modeRevision };
}

async function isGitHubConnector(client: Client, connectorId: string): Promise<boolean> {
  const [row] = await query<{ type: string }>(
    client,
    `SELECT type FROM connector_configs WHERE id = $1`,
    [connectorId],
  );
  return row?.type === 'github-issues';
}

export async function isConnectorSyncQuarantinedInPostgres(
  client: Client,
  connectorId: string,
): Promise<boolean> {
  const [control] = await query(
    client,
    `SELECT 1 FROM connector_sync_controls WHERE connector_id = $1 AND scheduler_state = 'quarantined'`,
    [connectorId],
  );
  return Boolean(control);
}

export async function assertConnectorSyncEnqueueAllowedInPostgres(
  client: Client,
  connectorId: string,
  source: SyncJobSource,
  operatorCanaryRunId?: string,
): Promise<void> {
  const [control] = await query<{ quarantineId: string | null }>(
    client,
    `
      SELECT quarantine_id AS "quarantineId"
      FROM connector_sync_controls
      WHERE connector_id = $1 AND scheduler_state = 'quarantined'
    `,
    [connectorId],
  );
  if (!control) {
    if (source === 'operator-canary') {
      throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
    }
    return;
  }
  if (source !== 'operator-canary' || !operatorCanaryRunId) {
    throw new ConnectorSyncControlError('connector_sync_quarantined');
  }
  const [authorized] = await query(
    client,
    `
      SELECT 1
      FROM connector_sync_operator_runs
      WHERE id = $1
        AND connector_id = $2
        AND quarantine_id IS NOT DISTINCT FROM $3
        AND operation = 'canary'
        AND job_id IS NULL
    `,
    [operatorCanaryRunId, connectorId, control.quarantineId],
  );
  if (!authorized) {
    throw new ConnectorSyncControlError('operator_canary_authorization_invalid');
  }
}

/**
 * PostgreSQL-backed implementation of the portable `SyncJobRepository`
 * contract. Unlike the SQLite adapter (which relies on `better-sqlite3`'s
 * whole-database exclusive `IMMEDIATE` transactions for atomicity), this
 * adapter uses per-statement Postgres transactions plus `SELECT ... FOR
 * UPDATE SKIP LOCKED` to atomically claim the next job without blocking
 * concurrent workers on unrelated rows.
 */
export class PostgresSyncJobRepository implements SyncJobRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(connectorId: string, request: import('@/lib/sync/job-repository').SyncJobEnqueueRequest = {}): Promise<SyncJob> {
    const options: EnqueueSyncJobOptions = {
      ...request,
      availableAt: request.availableAt ? new Date(request.availableAt) : undefined,
      scheduledFor: request.scheduledFor ? new Date(request.scheduledFor) : undefined,
    };
    return withTransaction(this.pool, (client) => this.enqueueWithClient(client, connectorId, options));
  }

  private async enqueueWithClient(
    client: PoolClient,
    connectorId: string,
    options: EnqueueSyncJobOptions,
  ): Promise<SyncJob> {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const availableAt = (options.availableAt ?? nowDate).toISOString();
    const scheduledFor = (options.scheduledFor ?? options.availableAt ?? nowDate).toISOString();
    const full = options.full === true;
    const source = options.source ?? 'api';

    await assertConnectorSyncEnqueueAllowedInPostgres(client, connectorId, source, options.operatorCanaryRunId);
    const identityStamp = await captureGitHubIdentityStamp(client, connectorId);

    // Serialize concurrent enqueue() calls for the same connector: without
    // this, two transactions that both observe "no existing queued job" for
    // a connector with none yet would both fall through to the INSERT
    // branch below and race on the partial unique index
    // (idx_sync_jobs_active_connector), turning what should be a graceful
    // merge into an existing job into an unhandled unique-violation error.
    // The lock is released automatically at transaction end.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [connectorId]);

    const [maintenanceLock] = await query<{ operationId: string }>(
      client,
      `SELECT operation_id AS "operationId" FROM connector_maintenance_locks WHERE connector_instance_id = $1`,
      [connectorId],
    );
    if (maintenanceLock) {
      throw new Error(
        `Connector is locked for maintenance by operation ${maintenanceLock.operationId}`,
      );
    }

    let [existing] = await query<SyncJobDatabaseRow>(
      client,
      `SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE connector_id = $1 AND status = 'queued' LIMIT 1 FOR UPDATE`,
      [connectorId],
    );

    if (
      existing
      && identityStamp
      && (existing.identityMode === null || existing.identityModeRevision === null)
    ) {
      await client.query(
        `
          UPDATE sync_jobs
          SET status = 'cancelled',
              completed_at = $1,
              updated_at = $1,
              error = 'Queued GitHub job had no enqueue-time identity context'
          WHERE id = $2 AND status = 'queued'
        `,
        [now, existing.id],
      );
      existing = undefined as unknown as SyncJobDatabaseRow;
    }

    if (existing) {
      const accelerate = availableAt < existing.availableAt;
      if ((full && !existing.full) || accelerate) {
        const nextFull = full || existing.full;
        const nextAvailableAt = accelerate ? availableAt : existing.availableAt;
        const nextScheduledFor = accelerate ? scheduledFor : existing.scheduledFor;
        await client.query(
          `
            UPDATE sync_jobs
            SET "full" = $1, available_at = $2, scheduled_for = $3, updated_at = $4
            WHERE id = $5
          `,
          [nextFull, nextAvailableAt, nextScheduledFor, now, existing.id],
        );
        existing = {
          ...existing,
          full: nextFull,
          availableAt: nextAvailableAt,
          scheduledFor: nextScheduledFor,
          updatedAt: now,
        };
      }
      return deserializeJob(existing);
    }

    const id = randomUUID();
    await client.query(
      `
        INSERT INTO sync_jobs (
          id, connector_id, "full", source, status, attempt, max_attempts,
          available_at, scheduled_for, duration_budget_ms,
          identity_mode, identity_mode_revision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6, $7, $8, $9, $10, $11, $11)
      `,
      [
        id,
        connectorId,
        full,
        source,
        options.maxAttempts ?? getSyncMaxAttemptsDefault(),
        availableAt,
        scheduledFor,
        options.durationBudgetMs ?? getSyncDurationBudgetMs(),
        identityStamp?.mode ?? null,
        identityStamp?.revision ?? null,
        now,
      ],
    );
    const [created] = await query<SyncJobDatabaseRow>(
      client,
      `SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = $1`,
      [id],
    );
    return deserializeJob(created);
  }

  async claimNext(
    owner: string,
    leaseMs = getSyncLeaseMs(),
    excludedConnectorIds: ReadonlySet<string> = new Set(),
  ): Promise<SyncJob | null> {
    return withTransaction(this.pool, async (client) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

      await recoverExpiredSyncJobsWithOutcome(client, nowIso);

      await client.query(
        `
          UPDATE sync_jobs
          SET status = 'cancelled',
              completed_at = $1,
              updated_at = $1,
              error = COALESCE(error, 'Sync cancelled before execution')
          WHERE status = 'queued' AND cancel_requested_at IS NOT NULL
        `,
        [nowIso],
      );

      await client.query(
        `DELETE FROM connector_operation_leases WHERE lease_expires_at <= $1`,
        [nowIso],
      );

      const { clause: exclusionClause, params: exclusionParams } = buildExclusionClause(
        excludedConnectorIds,
        2,
      );

      const [candidate] = await query<SyncJobDatabaseRow>(
        client,
        `
          SELECT ${JOB_COLUMNS}
          FROM sync_jobs
          WHERE status = 'queued'
            AND cancel_requested_at IS NULL
            AND available_at <= $1
            ${exclusionClause}
            AND NOT EXISTS (
              SELECT 1 FROM connector_operation_leases
              WHERE connector_id = sync_jobs.connector_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM connector_maintenance_locks
              WHERE connector_instance_id = sync_jobs.connector_id
            )
            AND (
              (
                sync_jobs.source <> 'operator-canary'
                AND NOT EXISTS (
                  SELECT 1 FROM connector_sync_controls
                  WHERE connector_id = sync_jobs.connector_id
                    AND scheduler_state = 'quarantined'
                )
              )
              OR (
                sync_jobs.source = 'operator-canary'
                AND EXISTS (
                  SELECT 1
                  FROM connector_sync_controls controls
                  INNER JOIN connector_sync_operator_runs runs
                    ON runs.connector_id = controls.connector_id
                    AND runs.quarantine_id IS NOT DISTINCT FROM controls.quarantine_id
                    AND runs.operation = 'canary'
                    AND runs.job_id = sync_jobs.id
                  WHERE controls.connector_id = sync_jobs.connector_id
                    AND controls.scheduler_state = 'quarantined'
                )
              )
            )
          ORDER BY "full" DESC, scheduled_for ASC, created_at ASC
          LIMIT 1
          FOR UPDATE OF sync_jobs SKIP LOCKED
        `,
        [nowIso, ...exclusionParams],
      );
      if (!candidate) return null;

      if (
        (await isGitHubConnector(client, candidate.connectorId))
        && (candidate.identityMode === null || candidate.identityModeRevision === null)
      ) {
        await client.query(
          `
            UPDATE sync_jobs
            SET status = 'cancelled',
                completed_at = $1,
                updated_at = $1,
                error = 'Queued GitHub job had no enqueue-time identity context'
            WHERE id = $2 AND status = 'queued'
          `,
          [nowIso, candidate.id],
        );
        return null;
      }

      const claimed = await client.query(
        `
          UPDATE sync_jobs
          SET status = 'running',
              attempt = attempt + 1,
              lease_owner = $1,
              lease_expires_at = $2,
              started_at = $3,
              updated_at = $3,
              error = NULL
          WHERE id = $4 AND status = 'queued'
        `,
        [owner, leaseExpiresAt, nowIso, candidate.id],
      );
      if (claimed.rowCount !== 1) return null;

      const lockOwner = connectorSyncLeaseOwner(candidate.id, owner);
      try {
        await client.query(
          `
            INSERT INTO connector_operation_leases (
              connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
            ) VALUES ($1, 'sync', $2, $3, $4, $4)
          `,
          [candidate.connectorId, lockOwner, leaseExpiresAt, nowIso],
        );
      } catch (error) {
        throw new Error(
          `Could not acquire connector lease for sync job ${candidate.id}`,
          { cause: error },
        );
      }

      const [row] = await query<SyncJobDatabaseRow>(
        client,
        `SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = $1`,
        [candidate.id],
      );
      return deserializeJob(row);
    });
  }

  async renewLease(jobId: string, owner: string, leaseMs = getSyncLeaseMs()): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

      const [job] = await query<{ connectorId: string }>(
        client,
        `
          SELECT connector_id AS "connectorId"
          FROM sync_jobs
          WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > $3
          FOR UPDATE
        `,
        [jobId, owner, nowIso],
      );
      if (!job) return false;

      const lockOwner = connectorSyncLeaseOwner(jobId, owner);
      // Lock the connector-operation lease row before renewing it: without
      // FOR UPDATE, a concurrent release/fail/complete could delete this row
      // between the existence check and the UPDATE below, and the UPDATE
      // would silently affect zero rows unless we check its rowCount.
      const [lease] = await query(
        client,
        `
          SELECT 1 FROM connector_operation_leases
          WHERE connector_id = $1 AND owner = $2 AND lease_expires_at > $3
          FOR UPDATE
        `,
        [job.connectorId, lockOwner, nowIso],
      );
      if (!lease) return false;

      await client.query(
        `UPDATE sync_jobs SET lease_expires_at = $1, updated_at = $2 WHERE id = $3`,
        [leaseExpiresAt, nowIso, jobId],
      );
      const leaseUpdate = await client.query(
        `
          UPDATE connector_operation_leases
          SET lease_expires_at = $1, updated_at = $2
          WHERE connector_id = $3 AND owner = $4
        `,
        [leaseExpiresAt, nowIso, job.connectorId, lockOwner],
      );
      // The row was locked and confirmed to exist above, so an update
      // affecting anything other than exactly one row means lease
      // ownership was lost (or something is structurally wrong) — treat
      // both as "renewal failed" rather than reporting success.
      return leaseUpdate.rowCount === 1;
    });
  }

  async isCancellationRequested(jobId: string, owner: string): Promise<boolean> {
    const [row] = await query<{ cancelRequestedAt: string | null }>(
      this.pool,
      `
        SELECT cancel_requested_at AS "cancelRequestedAt"
        FROM sync_jobs
        WHERE id = $1 AND status = 'running' AND lease_owner = $2
      `,
      [jobId, owner],
    );
    return row?.cancelRequestedAt !== null && row?.cancelRequestedAt !== undefined;
  }

  async complete(jobId: string, owner: string, result: SyncResult): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const now = new Date().toISOString();
      const [job] = await query<{ connectorId: string }>(
        client,
        `SELECT connector_id AS "connectorId" FROM sync_jobs WHERE id = $1 AND status = 'running' AND lease_owner = $2 FOR UPDATE`,
        [jobId, owner],
      );
      const lockOwner = job ? connectorSyncLeaseOwner(jobId, owner) : null;
      const [lease] = job
        ? await query(
            client,
            `SELECT 1 FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2 AND lease_expires_at > $3`,
            [job.connectorId, lockOwner, now],
          )
        : [];
      if (!job || !lease) {
        throw new Error(`Sync job ${jobId} ownership was lost before completion`);
      }

      await client.query(
        `
          UPDATE sync_jobs
          SET status = 'succeeded',
              result = $1,
              error = NULL,
              completed_at = $2,
              updated_at = $2,
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE id = $3
        `,
        [JSON.stringify(result), now, jobId],
      );
      await client.query(
        `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2`,
        [job.connectorId, lockOwner],
      );
    });
  }

  async finalizeSuccess(job: SyncJob, owner: string, result: SyncResult): Promise<void> {
    if (!result.syncRunId) {
      throw new Error(`Sync job ${job.id} returned no exact sync-run identity`);
    }
    await withTransaction(this.pool, async (client) => {
      const [ownedJob] = await query<{ connectorId: string; leaseExpiresAt: string }>(
        client,
        `
          SELECT
            connector_id AS "connectorId",
            lease_expires_at AS "leaseExpiresAt"
          FROM sync_jobs
          WHERE id = $1 AND status = 'running' AND lease_owner = $2
          FOR UPDATE
        `,
        [job.id, owner],
      );
      const now = new Date().toISOString();
      const lockOwner = connectorSyncLeaseOwner(job.id, owner);
      const ownsUnexpiredJob = ownedJob && ownedJob.leaseExpiresAt > now;
      const [lease] = ownsUnexpiredJob
        ? await query(
            client,
            `
              SELECT 1 FROM connector_operation_leases
              WHERE connector_id = $1 AND owner = $2 AND lease_expires_at > $3
              FOR UPDATE
            `,
            [ownedJob.connectorId, lockOwner, now],
          )
        : [];
      if (!ownsUnexpiredJob || !lease || ownedJob.connectorId !== job.connectorId) {
        throw new Error(`Sync job ${job.id} ownership was lost before completion`);
      }

      const linked = await client.query(
        `
          UPDATE sync_log
          SET job_id = $1,
              success = true,
              trigger = $2,
              scheduled_for = $3,
              started_at = $4,
              attempt = $5,
              max_attempts = $6,
              identity_mode = $7,
              identity_mode_revision = $8
          WHERE id = $9
            AND connector_id = $10
            AND job_id IS NULL
            AND synced_at = $11
            AND success = false
        `,
        [
          job.id,
          job.source,
          job.scheduledFor,
          job.startedAt,
          job.attempt,
          job.maxAttempts,
          job.identityMode,
          job.identityModeRevision,
          result.syncRunId,
          job.connectorId,
          result.syncedAt,
        ],
      );
      if (linked.rowCount !== 1) {
        throw new Error(`Sync job ${job.id} exact success log could not be linked`);
      }

      const completed = await client.query(
        `
          UPDATE sync_jobs
          SET status = 'succeeded',
              result = $1,
              error = NULL,
              completed_at = $2,
              updated_at = $2,
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE id = $3 AND status = 'running' AND lease_owner = $4
        `,
        [JSON.stringify(result), now, job.id, owner],
      );
      if (completed.rowCount !== 1) {
        throw new Error(`Sync job ${job.id} ownership was lost before completion`);
      }
      const released = await client.query(
        `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2`,
        [job.connectorId, lockOwner],
      );
      if (released.rowCount !== 1) {
        throw new Error(`Sync job ${job.id} connector lease was lost before completion`);
      }
    });
  }

  async linkSyncLog(job: SyncJob, result: SyncResult): Promise<void> {
    const linked = result.syncRunId
      ? await this.pool.query(
          `
            UPDATE sync_log
            SET job_id = $1,
                trigger = $2,
                scheduled_for = $3,
                started_at = $4,
                attempt = $5,
                max_attempts = $6,
                identity_mode = $7,
                identity_mode_revision = $8
            WHERE id = $9
              AND connector_id = $10
              AND synced_at = $11
              AND (job_id IS NULL OR job_id = $1)
          `,
          [
            job.id,
            job.source,
            job.scheduledFor,
            job.startedAt,
            job.attempt,
            job.maxAttempts,
            job.identityMode,
            job.identityModeRevision,
            result.syncRunId,
            job.connectorId,
            result.syncedAt,
          ],
        )
      : await this.pool.query(
        `
        UPDATE sync_log
        SET job_id = $1,
            trigger = $2,
            scheduled_for = $3,
            started_at = $4,
            attempt = $5,
            max_attempts = $6,
            identity_mode = $7,
            identity_mode_revision = $8
        WHERE connector_id = $9
          AND synced_at = $10
          AND job_id IS NULL
      `,
      [
        job.id,
        job.source,
        job.scheduledFor,
        job.startedAt,
        job.attempt,
        job.maxAttempts,
        job.identityMode,
        job.identityModeRevision,
        job.connectorId,
        result.syncedAt,
      ],
    );
    if (result.syncRunId && linked.rowCount !== 1) {
      throw new Error(`Sync job ${job.id} exact sync log could not be linked`);
    }
  }

  async fail(
    job: SyncJob,
    owner: string,
    error: string,
    options: SyncJobFailureOptions = {},
  ): Promise<SyncJobStatus> {
    return withTransaction(this.pool, async (client) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const lockOwner = connectorSyncLeaseOwner(job.id, owner);
      const [lease] = await query(
        client,
        `SELECT 1 FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2 AND lease_expires_at > $3`,
        [job.connectorId, lockOwner, nowIso],
      );
      if (!lease) {
        throw new Error(`Sync job ${job.id} ownership was lost before failure was recorded`);
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [job.connectorId],
      );

      const [followUp] = await query(
        client,
        `SELECT 1 FROM sync_jobs WHERE connector_id = $1 AND status = 'queued' AND id <> $2 LIMIT 1`,
        [job.connectorId, job.id],
      );
      const retry = options.retry !== false
        && !options.cancelled
        && !options.terminal
        && job.attempt < job.maxAttempts
        && !followUp;
      const status: SyncJobStatus = options.cancelled || options.terminal
        ? 'cancelled'
        : retry
          ? 'queued'
          : 'failed';
      const availableAt = retry ? computeRetryAvailableAt(now, job.attempt) : nowIso;
      const completedAt = status === 'failed' || status === 'cancelled' ? nowIso : null;

      const updated = await client.query(
        `
          UPDATE sync_jobs
          SET status = $1,
              available_at = $2,
              error = $3,
              completed_at = $4,
              updated_at = $5,
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE id = $6 AND status = 'running' AND lease_owner = $7
        `,
        [status, availableAt, error, completedAt, nowIso, job.id, owner],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Sync job ${job.id} ownership was lost before failure was recorded`);
      }
      await client.query(
        `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2`,
        [job.connectorId, lockOwner],
      );
      return status;
    });
  }

  async release(jobId: string, owner: string, reason: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const now = new Date().toISOString();
      const [job] = await query<{ connectorId: string }>(
        client,
        `SELECT connector_id AS "connectorId" FROM sync_jobs WHERE id = $1 AND status = 'running' AND lease_owner = $2 FOR UPDATE`,
        [jobId, owner],
      );
      if (!job) return false;
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [job.connectorId],
      );
      const lockOwner = connectorSyncLeaseOwner(jobId, owner);
      const [followUp] = await query(
        client,
        `SELECT 1 FROM sync_jobs WHERE connector_id = $1 AND status = 'queued' AND id <> $2 LIMIT 1`,
        [job.connectorId, jobId],
      );
      const updated = await client.query(
        `
          UPDATE sync_jobs
          SET status = $1,
              source = 'recovery',
              available_at = $2,
              error = $3,
              completed_at = $4,
              updated_at = $2,
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE id = $5 AND status = 'running' AND lease_owner = $6
        `,
        [
          followUp ? 'failed' : 'queued',
          now,
          followUp ? `${reason}; queued follow-up superseded recovery` : reason,
          followUp ? now : null,
          jobId,
          owner,
        ],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        `DELETE FROM connector_operation_leases WHERE connector_id = $1 AND owner = $2`,
        [job.connectorId, lockOwner],
      );
      return true;
    });
  }

  async requestCancellation(params: { jobId?: string; connectorId?: string }): Promise<SyncCancellationResult> {
    if (!params.jobId && !params.connectorId) {
      throw new Error('A jobId or connectorId is required');
    }
    return withTransaction(this.pool, async (client) => {
      const now = new Date().toISOString();
      const condition = params.jobId ? 'id = $2' : 'connector_id = $2';
      const value = params.jobId ?? params.connectorId;
      const cancelled = await client.query(
        `
          UPDATE sync_jobs
          SET status = 'cancelled',
              cancel_requested_at = $1,
              completed_at = $1,
              error = 'Sync cancelled before execution',
              updated_at = $1
          WHERE ${condition} AND status = 'queued'
        `,
        [now, value],
      );
      const cancellationRequested = await client.query(
        `
          UPDATE sync_jobs
          SET cancel_requested_at = $1, updated_at = $1
          WHERE ${condition} AND status = 'running'
        `,
        [now, value],
      );
      return {
        cancelled: cancelled.rowCount ?? 0,
        cancellationRequested: cancellationRequested.rowCount ?? 0,
      };
    });
  }

  async get(jobId: string): Promise<SyncJob | null> {
    const [row] = await query<SyncJobDatabaseRow>(
      this.pool,
      `SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = $1`,
      [jobId],
    );
    return row ? deserializeJob(row) : null;
  }

  async persistEvent(jobId: string, event: SyncStreamEvent): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO sync_job_events (job_id, connector_id, event_type, payload, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [jobId, event.connectorId, event.type, JSON.stringify(event), new Date().toISOString()],
    );
  }

  async getEventsAfter(cursor: number, limit = 100): Promise<PersistedSyncEvent[]> {
    const rows = await query<{
      id: number;
      jobId: string | null;
      connectorId: string;
      payload: SyncStreamEvent;
      createdAt: string;
    }>(
      this.pool,
      `
        SELECT id, job_id AS "jobId", connector_id AS "connectorId", payload, created_at AS "createdAt"
        FROM sync_job_events
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2
      `,
      [cursor, limit],
    );
    return rows.map(({ payload, ...row }) => ({ ...row, event: payload }));
  }

  async getLatestEventId(): Promise<number> {
    const [row] = await query<{ id: number }>(
      this.pool,
      `SELECT COALESCE(MAX(id), 0) AS id FROM sync_job_events`,
    );
    return row.id;
  }

  async getMetrics(at?: string): Promise<SyncQueueMetrics> {
    const now = at ? new Date(at) : new Date();
    const nowIso = now.toISOString();
    const missedBefore = new Date(now.getTime() - getMissedScheduleGraceMs()).toISOString();

    const [jobsRow] = await query<{
      queued: string | null;
      running: string | null;
      retrying: string | null;
      cancelled: string | null;
      oldestQueuedAt: string | null;
      overBudget: string | null;
      expiredLeases: string | null;
    }>(
      this.pool,
      `
        SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'queued' AND attempt > 0 THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
          MIN(CASE WHEN status = 'queued' THEN created_at END) AS "oldestQueuedAt",
          SUM(CASE
            WHEN status = 'running'
              AND started_at IS NOT NULL
              AND (EXTRACT(EPOCH FROM ($1::timestamptz - started_at::timestamptz)) * 1000) > duration_budget_ms
            THEN 1 ELSE 0 END) AS "overBudget",
          SUM(CASE
            WHEN status = 'running'
              AND lease_expires_at::timestamptz < $1::timestamptz
            THEN 1 ELSE 0 END) AS "expiredLeases"
        FROM sync_jobs
      `,
      [nowIso],
    );
    const [scheduleRow] = await query<{ missedSchedules: string | null; oldestMissedAt: string | null }>(
      this.pool,
      `
        SELECT COUNT(*) AS "missedSchedules", MIN(next_due_at) AS "oldestMissedAt"
        FROM sync_schedules
        WHERE next_due_at < $1
      `,
      [missedBefore],
    );

    return {
      queued: Number(jobsRow?.queued ?? 0),
      running: Number(jobsRow?.running ?? 0),
      retrying: Number(jobsRow?.retrying ?? 0),
      cancelled: Number(jobsRow?.cancelled ?? 0),
      oldestQueuedAgeMs: jobsRow?.oldestQueuedAt
        ? Math.max(0, now.getTime() - new Date(jobsRow.oldestQueuedAt).getTime())
        : 0,
      missedSchedules: Number(scheduleRow?.missedSchedules ?? 0),
      oldestScheduleOverdueMs: scheduleRow?.oldestMissedAt
        ? Math.max(0, now.getTime() - new Date(scheduleRow.oldestMissedAt).getTime())
        : 0,
      overBudget: Number(jobsRow?.overBudget ?? 0),
      expiredLeases: Number(jobsRow?.expiredLeases ?? 0),
    };
  }

  async countQueued(): Promise<number> {
    const [row] = await query<{ count: string }>(
      this.pool,
      `SELECT COUNT(*) AS count FROM sync_jobs WHERE status = 'queued'`,
    );
    return Number(row?.count ?? 0);
  }

  async registerSchedule(connectorId: string, intervalMinutes: number): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const [quarantined] = await query(
        client,
        `SELECT 1 FROM connector_sync_controls WHERE connector_id = $1 AND scheduler_state = 'quarantined'`,
        [connectorId],
      );
      if (quarantined) {
        await client.query(`DELETE FROM sync_schedules WHERE connector_id = $1`, [connectorId]);
        return;
      }
      const now = new Date();
      const nowIso = now.toISOString();
      const nextDueAt = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
      await client.query(
        `
          INSERT INTO sync_schedules (connector_id, interval_minutes, next_due_at, last_enqueued_at, updated_at)
          VALUES ($1, $2, $3, NULL, $4)
          ON CONFLICT (connector_id) DO UPDATE SET
            interval_minutes = EXCLUDED.interval_minutes,
            next_due_at = CASE
              WHEN sync_schedules.interval_minutes <> EXCLUDED.interval_minutes
                THEN EXCLUDED.next_due_at
              ELSE sync_schedules.next_due_at
            END,
            updated_at = EXCLUDED.updated_at
        `,
        [connectorId, intervalMinutes, nextDueAt, nowIso],
      );
    });
  }

  async markScheduleEnqueued(connectorId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const [row] = await query<{ intervalMinutes: number }>(
        client,
        `SELECT interval_minutes AS "intervalMinutes" FROM sync_schedules WHERE connector_id = $1 FOR UPDATE`,
        [connectorId],
      );
      if (!row) return;
      const now = new Date();
      const nowIso = now.toISOString();
      await client.query(
        `
          UPDATE sync_schedules
          SET last_enqueued_at = $1, next_due_at = $2, updated_at = $1
          WHERE connector_id = $3
        `,
        [nowIso, new Date(now.getTime() + row.intervalMinutes * 60_000).toISOString(), connectorId],
      );
    });
  }

  async unregisterSchedule(connectorId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sync_schedules WHERE connector_id = $1`, [connectorId]);
  }

  async getSchedules(): Promise<SyncSchedule[]> {
    return query<SyncSchedule>(
      this.pool,
      `
        SELECT connector_id AS "connectorId", interval_minutes AS "intervalMinutes"
        FROM sync_schedules
        ORDER BY connector_id
      `,
    );
  }

  async getScheduleHealth(at?: string): Promise<SyncScheduleHealth[]> {
    const now = at ? new Date(at) : new Date();
    const graceMs = getMissedScheduleGraceMs();
    const rows = await query<{
      connectorId: string;
      intervalMinutes: number;
      nextDueAt: string;
      lastEnqueuedAt: string | null;
    }>(
      this.pool,
      `
        SELECT
          connector_id AS "connectorId",
          interval_minutes AS "intervalMinutes",
          next_due_at AS "nextDueAt",
          last_enqueued_at AS "lastEnqueuedAt"
        FROM sync_schedules
        ORDER BY next_due_at, connector_id
      `,
    );
    return rows.map((schedule) => {
      const overdueMs = Math.max(0, now.getTime() - new Date(schedule.nextDueAt).getTime());
      return { ...schedule, overdueMs, overdue: overdueMs > graceMs };
    });
  }

  async enqueueDueSchedules(at?: string): Promise<SyncJob[]> {
    const now = at ? new Date(at) : new Date();
    const nowIso = now.toISOString();

    await this.pool.query(
      `
        DELETE FROM sync_schedules
        WHERE NOT EXISTS (
          SELECT 1 FROM connector_configs
          WHERE connector_configs.id = sync_schedules.connector_id
            AND connector_configs.enabled = true
            AND connector_configs.deleted_at IS NULL
            AND connector_configs.sync_mode = 'poll'
            AND connector_configs.poll_interval_minutes IS NOT NULL
            AND connector_configs.poll_interval_minutes > 0
        )
          AND NOT EXISTS (
            SELECT 1 FROM connector_maintenance_locks
            WHERE connector_instance_id = sync_schedules.connector_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_controls
            WHERE connector_id = sync_schedules.connector_id
              AND scheduler_state = 'quarantined'
          )
      `,
    );

    const due = await query<{ connectorId: string; intervalMinutes: number; nextDueAt: string }>(
      this.pool,
      `
        SELECT connector_id AS "connectorId", interval_minutes AS "intervalMinutes", next_due_at AS "nextDueAt"
        FROM sync_schedules
        WHERE next_due_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM connector_maintenance_locks
            WHERE connector_instance_id = sync_schedules.connector_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_controls
            WHERE connector_id = sync_schedules.connector_id
              AND scheduler_state = 'quarantined'
          )
        ORDER BY next_due_at, connector_id
      `,
      [nowIso],
    );

    const jobs: SyncJob[] = [];
    for (const schedule of due) {
      const job = await withTransaction(this.pool, async (client) => {
        // Lock this schedule row (skipping it if another worker already
        // holds it) so claiming the due schedule, enqueueing its job, and
        // advancing next_due_at happen as a single atomic unit — otherwise
        // two concurrent workers could both observe the same due schedule
        // and race to enqueue/advance it independently.
        const [locked] = await query<{ nextDueAt: string; intervalMinutes: number }>(
          client,
          `
            SELECT next_due_at AS "nextDueAt", interval_minutes AS "intervalMinutes"
            FROM sync_schedules
            WHERE connector_id = $1
            FOR UPDATE SKIP LOCKED
          `,
          [schedule.connectorId],
        );
        // Another worker already claimed and advanced (or removed) this
        // schedule between the SELECT above and acquiring the lock here.
        if (!locked || locked.nextDueAt > nowIso) return null;

        const enqueued = await this.enqueueWithClient(client, schedule.connectorId, {
          source: 'schedule',
          scheduledFor: new Date(locked.nextDueAt),
        });
        const intervalMs = locked.intervalMinutes * 60_000;
        const missedIntervals = Math.max(
          1,
          Math.floor((now.getTime() - new Date(locked.nextDueAt).getTime()) / intervalMs) + 1,
        );
        const nextDueAt = new Date(
          new Date(locked.nextDueAt).getTime() + missedIntervals * intervalMs,
        ).toISOString();
        const updated = await client.query(
          `
            UPDATE sync_schedules
            SET last_enqueued_at = $1, next_due_at = $2, updated_at = $1
            WHERE connector_id = $3 AND next_due_at = $4
          `,
          [nowIso, nextDueAt, schedule.connectorId, locked.nextDueAt],
        );
        return updated.rowCount === 1 ? enqueued : null;
      });
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async getLatestResult(connectorId: string): Promise<SyncResult | undefined> {
    const [row] = await query<{
      connectorId: string;
      success: boolean;
      tasksAdded: number;
      tasksUpdated: number;
      tasksRemoved: number;
      notificationsAdded: number;
      errors: string[];
      syncedAt: string;
    }>(
      this.pool,
      `
        SELECT
          connector_id AS "connectorId",
          success,
          tasks_added AS "tasksAdded",
          tasks_updated AS "tasksUpdated",
          tasks_removed AS "tasksRemoved",
          alerts_added AS "notificationsAdded",
          errors,
          synced_at AS "syncedAt"
        FROM sync_log
        WHERE connector_id = $1
          AND success = true
          AND COALESCE(duration_ms, -1) <> 0
        ORDER BY synced_at DESC
        LIMIT 1
      `,
      [connectorId],
    );
    return row ?? undefined;
  }

  async getActiveConnectorIds(): Promise<string[]> {
    const rows = await query<{ connectorId: string }>(
      this.pool,
      `SELECT connector_id AS "connectorId" FROM sync_jobs WHERE status = 'running' ORDER BY started_at`,
    );
    return rows.map((row) => row.connectorId);
  }

  async prune(retentionDays = 14): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
    await this.pool.query(
      `
        DELETE FROM sync_jobs
        WHERE status IN ('succeeded', 'failed', 'cancelled')
          AND completed_at < $1
      `,
      [cutoff],
    );
  }
}

/**
 * Stable construction point for composition roots: builds a
 * `SyncJobRepository` backed by PostgreSQL from a `pg` `Pool` (typically
 * `PostgresPersistenceBackend#context.pool` from `@/db/postgres/runtime`),
 * without callers needing to know the concrete class.
 */
export function createPostgresSyncJobRepository(pool: Pool): SyncJobRepository {
  return new PostgresSyncJobRepository(pool);
}
