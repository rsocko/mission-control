import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities';
import type { SyncResult } from '@/types';
import type { SyncStreamEvent } from './events';
import type {
  EnqueueSyncJobOptions,
  PersistedSyncEvent,
  SyncCancellationResult,
  SyncJob,
  SyncJobFailureOptions,
  SyncJobFinalizationOptions,
  SyncJobRepository,
  SyncJobSource,
  SyncJobStatus,
  SyncQueueMetrics,
  SyncScheduleHealth,
} from './job-repository';
import { connectorSyncLeaseOwner } from './connector-lock-values';
import { enqueueSqliteEventOutbox } from '@/db/persistence/sqlite-event-outbox-repository';
import { isTerminalSyncJobStatus } from './terminal-events';
import { recoverExpiredSyncJobs } from './sqlite-connector-operation-lease-repository';
import {
  assertConnectorSyncEnqueueAllowed,
  isConnectorSyncQuarantined,
} from './sqlite-control-state';

interface SyncJobDatabaseRow {
  id: string;
  connectorId: string;
  full: number;
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
  result: string | null;
  error: string | null;
  durationBudgetMs: number;
  identityMode: string | null;
  identityModeRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export function countRemainingSyncJobs(metrics: Pick<SyncQueueMetrics, 'queued' | 'running'>): number {
  return metrics.queued + Math.max(0, metrics.running - 1);
}

const JOB_COLUMNS = `
  id,
  connector_id AS connectorId,
  full,
  source,
  status,
  attempt,
  max_attempts AS maxAttempts,
  available_at AS availableAt,
  scheduled_for AS scheduledFor,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  cancel_requested_at AS cancelRequestedAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  result,
  error,
  duration_budget_ms AS durationBudgetMs,
  identity_mode AS identityMode,
  identity_mode_revision AS identityModeRevision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deserializeJob(row: SyncJobDatabaseRow): SyncJob {
  return {
    ...row,
    full: row.full === 1,
    result: row.result ? JSON.parse(row.result) as SyncResult : null,
  };
}

/**
 * Stamps the queued job with the connector identity epoch. GitHub identity is
 * permanently NodeID-first, so only the revision is variable.
 */
function captureGitHubIdentityStamp(connectorId: string): {
  mode: typeof GITHUB_IDENTITY_MODE;
  revision: number;
} | null {
  const row = sqlite.prepare(`
    SELECT
      connector_configs.type,
      COALESCE(github_identity_controls.mode_revision, 0) AS modeRevision
    FROM connector_configs
    LEFT JOIN github_identity_controls
      ON github_identity_controls.connector_instance_id = connector_configs.id
    WHERE connector_configs.id = ?
  `).get(connectorId) as {
    type: string;
    modeRevision: number;
  } | undefined;
  if (!row || row.type !== 'github-issues') return null;
  return { mode: GITHUB_IDENTITY_MODE, revision: row.modeRevision };
}

function isGitHubConnector(connectorId: string): boolean {
  const row = sqlite.prepare(`
    SELECT type FROM connector_configs WHERE id = ?
  `).get(connectorId) as { type: string } | undefined;
  return row?.type === 'github-issues';
}

function failedResult(connectorId: string, error: string): SyncResult {
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

export function isDurableSyncMode(): boolean {
  return process.env.MC_SYNC_EXECUTION_MODE === 'worker';
}

export function getSyncLeaseMs(): number {
  return positiveInteger(process.env.MC_SYNC_JOB_LEASE_MS, 120_000);
}

export function getSyncDurationBudgetMs(): number {
  return positiveInteger(process.env.MC_SYNC_DURATION_BUDGET_MS, 300_000);
}

function enqueueSyncJobRecord(
  connectorId: string,
  options: EnqueueSyncJobOptions = {},
): SyncJob {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const availableAt = (options.availableAt ?? nowDate).toISOString();
  const scheduledFor = (options.scheduledFor ?? options.availableAt ?? nowDate).toISOString();
  const full = options.full === true;
  const source = options.source ?? 'api';
  assertConnectorSyncEnqueueAllowed(
    connectorId,
    source,
    options.operatorCanaryRunId,
  );
  const identityStamp = captureGitHubIdentityStamp(connectorId);
  const maintenanceLock = sqlite.prepare(`
    SELECT operation_id AS operationId
    FROM connector_maintenance_locks
    WHERE connector_instance_id = ?
  `).get(connectorId) as { operationId: string } | undefined;
  if (maintenanceLock) {
    throw new Error(
      `Connector is locked for maintenance by operation ${maintenanceLock.operationId}`,
    );
  }
  let existing = sqlite.prepare(`
    SELECT ${JOB_COLUMNS}
    FROM sync_jobs
    WHERE connector_id = ? AND status = 'queued'
    LIMIT 1
  `).get(connectorId) as SyncJobDatabaseRow | undefined;

  if (
    existing
    && identityStamp
    && (existing.identityMode === null || existing.identityModeRevision === null)
  ) {
    sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'cancelled',
          completed_at = ?,
          updated_at = ?,
          error = 'Queued GitHub job had no enqueue-time identity context'
      WHERE id = ? AND status = 'queued'
    `).run(now, now, existing.id);
    existing = undefined;
  }
  if (existing) {
    const accelerate = availableAt < existing.availableAt;
    if ((full && existing.full !== 1) || accelerate) {
      sqlite.prepare(`
        UPDATE sync_jobs
        SET full = ?,
            available_at = ?,
            scheduled_for = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        full || existing.full === 1 ? 1 : 0,
        accelerate ? availableAt : existing.availableAt,
        accelerate ? scheduledFor : existing.scheduledFor,
        now,
        existing.id,
      );
      existing.full = full || existing.full === 1 ? 1 : 0;
      if (accelerate) {
        existing.availableAt = availableAt;
        existing.scheduledFor = scheduledFor;
      }
      existing.updatedAt = now;
    }
    return deserializeJob(existing);
  }

  const id = randomUUID();
  sqlite.prepare(`
    INSERT INTO sync_jobs (
      id, connector_id, full, source, status, attempt, max_attempts,
      available_at, scheduled_for, duration_budget_ms,
      identity_mode, identity_mode_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    connectorId,
    full ? 1 : 0,
    source,
    options.maxAttempts ?? positiveInteger(process.env.MC_SYNC_JOB_MAX_ATTEMPTS, 3),
    availableAt,
    scheduledFor,
    options.durationBudgetMs ?? getSyncDurationBudgetMs(),
    identityStamp?.mode ?? null,
    identityStamp?.revision ?? null,
    now,
    now,
  );

  return deserializeJob(sqlite.prepare(`
    SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = ?
  `).get(id) as SyncJobDatabaseRow);
}

export function enqueueSyncJob(
  connectorId: string,
  options: EnqueueSyncJobOptions = {},
): SyncJob {
  return sqlite.transaction(() => enqueueSyncJobRecord(connectorId, options)).immediate();
}

export function enqueueSyncJobInCurrentTransaction(
  connectorId: string,
  options: EnqueueSyncJobOptions = {},
): SyncJob {
  return enqueueSyncJobRecord(connectorId, options);
}

export function claimNextSyncJob(
  owner: string,
  leaseMs = getSyncLeaseMs(),
  excludedConnectorIds: ReadonlySet<string> = new Set(),
): SyncJob | null {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const excluded = [...excludedConnectorIds];
  const exclusionClause = excluded.length > 0
    ? `AND connector_id NOT IN (${excluded.map(() => '?').join(', ')})`
    : '';
  const transaction = sqlite.transaction(() => {
    recoverExpiredSyncJobs(nowIso);

    sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'cancelled',
          completed_at = ?,
          updated_at = ?,
          error = COALESCE(error, 'Sync cancelled before execution')
      WHERE status = 'queued' AND cancel_requested_at IS NOT NULL
    `).run(nowIso, nowIso);

    sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE lease_expires_at <= ?
    `).run(nowIso);

    const candidate = sqlite.prepare(`
      SELECT ${JOB_COLUMNS}
      FROM sync_jobs
      WHERE status = 'queued'
        AND cancel_requested_at IS NULL
        AND available_at <= ?
        ${exclusionClause}
        AND NOT EXISTS (
          SELECT 1
          FROM connector_operation_leases
          WHERE connector_id = sync_jobs.connector_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM connector_maintenance_locks
          WHERE connector_instance_id = sync_jobs.connector_id
        )
        AND (
          (
            sync_jobs.source <> 'operator-canary'
            AND NOT EXISTS (
              SELECT 1
              FROM connector_sync_controls
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
                AND runs.quarantine_id = controls.quarantine_id
                AND runs.operation = 'canary'
                AND runs.job_id = sync_jobs.id
              WHERE controls.connector_id = sync_jobs.connector_id
                AND controls.scheduler_state = 'quarantined'
            )
          )
        )
      ORDER BY full DESC, scheduled_for ASC, created_at ASC
      LIMIT 1
    `).get(nowIso, ...excluded) as SyncJobDatabaseRow | undefined;
    if (!candidate) return null;
    if (
      isGitHubConnector(candidate.connectorId)
      && (candidate.identityMode === null || candidate.identityModeRevision === null)
    ) {
      sqlite.prepare(`
        UPDATE sync_jobs
        SET status = 'cancelled',
            completed_at = ?,
            updated_at = ?,
            error = 'Queued GitHub job had no enqueue-time identity context'
        WHERE id = ? AND status = 'queued'
      `).run(nowIso, nowIso, candidate.id);
      return null;
    }

    const claimed = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'running',
          attempt = attempt + 1,
          lease_owner = ?,
          lease_expires_at = ?,
          started_at = ?,
          updated_at = ?,
          error = NULL
      WHERE id = ? AND status = 'queued'
    `).run(
      owner,
      leaseExpiresAt,
      nowIso,
      nowIso,
      candidate.id,
    );
    if (claimed.changes !== 1) return null;

    const lockOwner = connectorSyncLeaseOwner(candidate.id, owner);
    const locked = sqlite.prepare(`
      INSERT INTO connector_operation_leases (
        connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
      ) VALUES (?, 'sync', ?, ?, ?, ?)
    `).run(candidate.connectorId, lockOwner, leaseExpiresAt, nowIso, nowIso);
    if (locked.changes !== 1) {
      throw new Error(`Could not acquire connector lease for sync job ${candidate.id}`);
    }

    return deserializeJob(sqlite.prepare(`
      SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = ?
    `).get(candidate.id) as SyncJobDatabaseRow);
  });

  return transaction.immediate();
}

export function renewSyncJobLease(jobId: string, owner: string, leaseMs = getSyncLeaseMs()): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const transaction = sqlite.transaction(() => {
    const job = sqlite.prepare(`
      SELECT connector_id AS connectorId
      FROM sync_jobs
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
    `).get(jobId, owner, nowIso) as { connectorId: string } | undefined;
    if (!job) return false;

    const lockOwner = connectorSyncLeaseOwner(jobId, owner);
    const lease = sqlite.prepare(`
      SELECT 1
      FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ? AND lease_expires_at > ?
    `).get(job.connectorId, lockOwner, nowIso);
    if (!lease) return false;

    sqlite.prepare(`
      UPDATE sync_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(leaseExpiresAt, nowIso, jobId);
    sqlite.prepare(`
      UPDATE connector_operation_leases
      SET lease_expires_at = ?, updated_at = ?
      WHERE connector_id = ? AND owner = ?
    `).run(leaseExpiresAt, nowIso, job.connectorId, lockOwner);
    return true;
  });
  return transaction.immediate();
}

export function isSyncJobCancellationRequested(jobId: string, owner: string): boolean {
  const row = sqlite.prepare(`
    SELECT cancel_requested_at AS cancelRequestedAt
    FROM sync_jobs
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).get(jobId, owner) as { cancelRequestedAt: string | null } | undefined;
  return row?.cancelRequestedAt !== null && row?.cancelRequestedAt !== undefined;
}

export function completeSyncJob(jobId: string, owner: string, result: SyncResult): void {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const job = sqlite.prepare(`
      SELECT connector_id AS connectorId
      FROM sync_jobs
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).get(jobId, owner) as { connectorId: string } | undefined;
    const lockOwner = connectorSyncLeaseOwner(jobId, owner);
    const lease = job && sqlite.prepare(`
      SELECT 1 FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ? AND lease_expires_at > ?
    `).get(job.connectorId, lockOwner, now);
    if (!job || !lease) {
      throw new Error(`Sync job ${jobId} ownership was lost before completion`);
    }

    sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'succeeded',
          result = ?,
          error = NULL,
          completed_at = ?,
          updated_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ?
    `).run(JSON.stringify(result), now, now, jobId);
    sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ?
    `).run(job.connectorId, lockOwner);
  });
  transaction.immediate();
}

export function finalizeSuccessfulSyncJob(
  job: SyncJob,
  owner: string,
  result: SyncResult,
  options: SyncJobFinalizationOptions = {},
): void {
  if (!result.syncRunId) {
    throw new Error(`Sync job ${job.id} returned no exact sync-run identity`);
  }
  const transaction = sqlite.transaction(() => {
    const now = new Date().toISOString();
    const ownedJob = sqlite.prepare(`
      SELECT connector_id AS connectorId
      FROM sync_jobs
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND lease_expires_at > ?
    `).get(job.id, owner, now) as { connectorId: string } | undefined;
    const lockOwner = connectorSyncLeaseOwner(job.id, owner);
    const lease = ownedJob && sqlite.prepare(`
      SELECT 1 FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ? AND lease_expires_at > ?
    `).get(ownedJob.connectorId, lockOwner, now);
    if (!ownedJob || !lease || ownedJob.connectorId !== job.connectorId) {
      throw new Error(`Sync job ${job.id} ownership was lost before completion`);
    }

    const linked = sqlite.prepare(`
      UPDATE sync_log
      SET job_id = ?,
          success = 1,
          trigger = ?,
          scheduled_for = ?,
          started_at = ?,
          attempt = ?,
          max_attempts = ?,
          identity_mode = ?,
          identity_mode_revision = ?
      WHERE id = ?
        AND connector_id = ?
        AND job_id IS NULL
        AND synced_at = ?
        AND success = 0
    `).run(
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
    );
    if (linked.changes !== 1) {
      throw new Error(`Sync job ${job.id} exact success log could not be linked`);
    }

    const completed = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'succeeded',
          result = ?,
          error = NULL,
          completed_at = ?,
          updated_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(JSON.stringify(result), now, now, job.id, owner);
    if (completed.changes !== 1) {
      throw new Error(`Sync job ${job.id} ownership was lost before completion`);
    }
    const released = sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ?
    `).run(job.connectorId, lockOwner);
    if (released.changes !== 1) {
      throw new Error(`Sync job ${job.id} connector lease was lost before completion`);
    }
    // Same transaction as the authoritative terminal transition: the outbox row
    // exists if and only if the job actually succeeded.
    for (const event of options.events ?? []) {
      enqueueSqliteEventOutbox(sqlite, {
        stableKey: event.stableKey,
        eventType: event.eventType,
        payload: event.payload,
        occurredAt: event.occurredAt,
      });
    }
  });
  transaction.immediate();
}

export function linkSyncLogToJob(job: SyncJob, result: SyncResult): void {
  const idClause = result.syncRunId ? 'id = ?' : 'connector_id = ? AND synced_at = ?';
  const identityParams = result.syncRunId
    ? [result.syncRunId]
    : [job.connectorId, result.syncedAt];
  const linked = sqlite.prepare(`
    UPDATE sync_log
    SET job_id = ?,
        trigger = ?,
        scheduled_for = ?,
        started_at = ?,
        attempt = ?,
        max_attempts = ?,
        identity_mode = ?,
        identity_mode_revision = ?
    WHERE ${idClause}
      AND connector_id = ?
      AND synced_at = ?
      AND (job_id IS NULL OR job_id = ?)
  `).run(
    job.id,
    job.source,
    job.scheduledFor,
    job.startedAt,
    job.attempt,
    job.maxAttempts,
    job.identityMode,
    job.identityModeRevision,
    ...identityParams,
    job.connectorId,
    result.syncedAt,
    job.id,
  );
  if (result.syncRunId && linked.changes !== 1) {
    throw new Error(`Sync job ${job.id} exact sync log could not be linked`);
  }
}

export function failSyncJob(
  job: SyncJob,
  owner: string,
  error: string,
  options: SyncJobFailureOptions = {},
): SyncJobStatus {
  const now = new Date();
  const nowIso = now.toISOString();
  const retryBaseMs = positiveInteger(process.env.MC_SYNC_JOB_RETRY_BASE_MS, 30_000);
  const transaction = sqlite.transaction(() => {
    const lockOwner = connectorSyncLeaseOwner(job.id, owner);
    const lease = sqlite.prepare(`
      SELECT 1 FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ? AND lease_expires_at > ?
    `).get(job.connectorId, lockOwner, nowIso);
    if (!lease) {
      throw new Error(`Sync job ${job.id} ownership was lost before failure was recorded`);
    }
    const followUpQueued = Boolean(sqlite.prepare(`
      SELECT 1 FROM sync_jobs
      WHERE connector_id = ? AND status = 'queued' AND id <> ?
      LIMIT 1
    `).get(job.connectorId, job.id));
    const retry = options.retry !== false
      && !options.cancelled
      && !options.terminal
      && job.attempt < job.maxAttempts
      && !followUpQueued;
    const status: SyncJobStatus = options.cancelled || options.terminal
      ? 'cancelled'
      : retry
        ? 'queued'
        : 'failed';
    const availableAt = retry
      ? new Date(now.getTime() + Math.min(retryBaseMs * (2 ** Math.max(0, job.attempt - 1)), 15 * 60_000)).toISOString()
      : nowIso;
    const update = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = ?,
          available_at = ?,
          error = ?,
          completed_at = CASE WHEN ? IN ('failed', 'cancelled') THEN ? ELSE NULL END,
          updated_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(status, availableAt, error, status, nowIso, nowIso, job.id, owner);
    if (update.changes !== 1) {
      throw new Error(`Sync job ${job.id} ownership was lost before failure was recorded`);
    }
    sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ?
    `).run(job.connectorId, lockOwner);
    // A `queued` status means the attempt will be retried, so no terminal event
    // has occurred yet — this is what stops retries from duplicating events.
    if (isTerminalSyncJobStatus(status)) {
      for (const event of options.events ?? []) {
        enqueueSqliteEventOutbox(sqlite, {
          stableKey: event.stableKey,
          eventType: event.eventType,
          payload: event.payload,
          occurredAt: event.occurredAt,
        });
      }
    }
    return status;
  });
  return transaction.immediate();
}

export function releaseSyncJob(jobId: string, owner: string, reason: string): boolean {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const job = sqlite.prepare(`
      SELECT connector_id AS connectorId
      FROM sync_jobs
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).get(jobId, owner) as { connectorId: string } | undefined;
    if (!job) return false;
    const lockOwner = connectorSyncLeaseOwner(jobId, owner);
    const update = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'queued',
          source = 'recovery',
          available_at = ?,
          error = ?,
          updated_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(now, reason, now, jobId, owner);
    if (update.changes !== 1) return false;
    sqlite.prepare(`
      DELETE FROM connector_operation_leases
      WHERE connector_id = ? AND owner = ?
    `).run(job.connectorId, lockOwner);
    return true;
  });
  return transaction.immediate();
}

export function requestSyncJobCancellation(
  params: { jobId?: string; connectorId?: string },
): SyncCancellationResult {
  if (!params.jobId && !params.connectorId) {
    throw new Error('A jobId or connectorId is required');
  }
  const now = new Date().toISOString();
  const condition = params.jobId ? 'id = ?' : 'connector_id = ?';
  const value = params.jobId ?? params.connectorId;
  const transaction = sqlite.transaction(() => {
    const cancelled = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'cancelled',
          cancel_requested_at = ?,
          completed_at = ?,
          error = 'Sync cancelled before execution',
          updated_at = ?
      WHERE ${condition} AND status = 'queued'
    `).run(now, now, now, value).changes;
    const cancellationRequested = sqlite.prepare(`
      UPDATE sync_jobs
      SET cancel_requested_at = ?, updated_at = ?
      WHERE ${condition} AND status = 'running'
    `).run(now, now, value).changes;
    return { cancelled, cancellationRequested };
  });
  return transaction.immediate();
}

export function getSyncJob(jobId: string): SyncJob | null {
  const row = sqlite.prepare(`
    SELECT ${JOB_COLUMNS} FROM sync_jobs WHERE id = ?
  `).get(jobId) as SyncJobDatabaseRow | undefined;
  return row ? deserializeJob(row) : null;
}

export async function waitForSyncJob(
  job: SyncJob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const timeoutMs = options.timeoutMs
    ?? positiveInteger(process.env.MC_SYNC_API_WAIT_TIMEOUT_MS, 15 * 60_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      return failedResult(job.connectorId, 'Request ended while sync continues in the worker');
    }
    const current = getSyncJob(job.id);
    if (!current) return failedResult(job.connectorId, 'Sync job disappeared before completion');
    if (current.status === 'succeeded') {
      if (!current.result?.success) {
        return failedResult(job.connectorId, 'Worker stored an invalid success result');
      }
      return current.result;
    }
    if (current.status === 'failed' || current.status === 'cancelled') {
      return failedResult(
        job.connectorId,
        current.error ?? `Sync job ${current.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return failedResult(
    job.connectorId,
    `Timed out waiting ${timeoutMs}ms for sync worker job ${job.id}`,
  );
}

export function persistSyncJobEvent(jobId: string, event: SyncStreamEvent): void {
  sqlite.prepare(`
    INSERT INTO sync_job_events (job_id, connector_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobId, event.connectorId, event.type, JSON.stringify(event), new Date().toISOString());
}

export function getSyncJobEventsAfter(cursor: number, limit = 100): PersistedSyncEvent[] {
  const rows = sqlite.prepare(`
    SELECT
      id,
      job_id AS jobId,
      connector_id AS connectorId,
      payload,
      created_at AS createdAt
    FROM sync_job_events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(cursor, limit) as Array<{
    id: number;
    jobId: string | null;
    connectorId: string;
    payload: string;
    createdAt: string;
  }>;
  return rows.map(({ payload, ...row }) => ({
    ...row,
    event: JSON.parse(payload) as SyncStreamEvent,
  }));
}

export function getLatestSyncJobEventId(): number {
  const row = sqlite.prepare(`
    SELECT COALESCE(MAX(id), 0) AS id FROM sync_job_events
  `).get() as { id: number };
  return row.id;
}

export function countQueuedSyncJobs(): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM sync_jobs INDEXED BY idx_sync_jobs_claim
    WHERE status = 'queued'
  `).get() as { count: number };
  return row.count;
}

export function getSyncQueueMetrics(now = new Date()): SyncQueueMetrics {
  const nowIso = now.toISOString();
  const missedBefore = new Date(
    now.getTime() - positiveInteger(process.env.MC_SYNC_MISSED_SCHEDULE_GRACE_MS, 120_000),
  ).toISOString();
  const row = sqlite.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'queued' AND attempt > 0 THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldestQueuedAt,
      (SELECT COUNT(*) FROM sync_schedules WHERE next_due_at < ?) AS missedSchedules,
      (SELECT MIN(next_due_at) FROM sync_schedules WHERE next_due_at < ?) AS oldestMissedAt,
      SUM(CASE
        WHEN status = 'running'
          AND started_at IS NOT NULL
          AND (unixepoch(?) - unixepoch(started_at)) * 1000 > duration_budget_ms
        THEN 1 ELSE 0 END) AS overBudget,
      SUM(CASE WHEN status = 'running' AND lease_expires_at < ? THEN 1 ELSE 0 END) AS expiredLeases
    FROM sync_jobs
  `).get(missedBefore, missedBefore, nowIso, nowIso) as {
    queued: number | null;
    running: number | null;
    retrying: number | null;
    cancelled: number | null;
    oldestQueuedAt: string | null;
    missedSchedules: number | null;
    oldestMissedAt: string | null;
    overBudget: number | null;
    expiredLeases: number | null;
  };
  return {
    queued: row.queued ?? 0,
    running: row.running ?? 0,
    retrying: row.retrying ?? 0,
    cancelled: row.cancelled ?? 0,
    oldestQueuedAgeMs: row.oldestQueuedAt
      ? Math.max(0, now.getTime() - new Date(row.oldestQueuedAt).getTime())
      : 0,
    missedSchedules: row.missedSchedules ?? 0,
    oldestScheduleOverdueMs: row.oldestMissedAt
      ? Math.max(0, now.getTime() - new Date(row.oldestMissedAt).getTime())
      : 0,
    overBudget: row.overBudget ?? 0,
    expiredLeases: row.expiredLeases ?? 0,
  };
}

export function registerSyncSchedule(connectorId: string, intervalMinutes: number): void {
  if (isConnectorSyncQuarantined(connectorId)) {
    unregisterSyncSchedule(connectorId);
    return;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  sqlite.prepare(`
    INSERT INTO sync_schedules (
      connector_id, interval_minutes, next_due_at, last_enqueued_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(connector_id) DO UPDATE SET
      interval_minutes = excluded.interval_minutes,
      next_due_at = CASE
        WHEN sync_schedules.interval_minutes <> excluded.interval_minutes
          THEN excluded.next_due_at
        ELSE sync_schedules.next_due_at
      END,
      updated_at = excluded.updated_at
  `).run(
    connectorId,
    intervalMinutes,
    new Date(now.getTime() + intervalMinutes * 60_000).toISOString(),
    nowIso,
  );
}

export function markSyncScheduleEnqueued(connectorId: string): void {
  const now = new Date();
  const row = sqlite.prepare(`
    SELECT interval_minutes AS intervalMinutes
    FROM sync_schedules
    WHERE connector_id = ?
  `).get(connectorId) as { intervalMinutes: number } | undefined;
  if (!row) return;
  const nowIso = now.toISOString();
  sqlite.prepare(`
    UPDATE sync_schedules
    SET last_enqueued_at = ?, next_due_at = ?, updated_at = ?
    WHERE connector_id = ?
  `).run(
    nowIso,
    new Date(now.getTime() + row.intervalMinutes * 60_000).toISOString(),
    nowIso,
    connectorId,
  );
}

export function unregisterSyncSchedule(connectorId: string): void {
  sqlite.prepare(`DELETE FROM sync_schedules WHERE connector_id = ?`).run(connectorId);
}

export function getSyncSchedules(): Array<{
  connectorId: string;
  intervalMinutes: number;
}> {
  return sqlite.prepare(`
    SELECT connector_id AS connectorId, interval_minutes AS intervalMinutes
    FROM sync_schedules
    ORDER BY connector_id
  `).all() as Array<{ connectorId: string; intervalMinutes: number }>;
}

export function getSyncScheduleHealth(now = new Date()): SyncScheduleHealth[] {
  const graceMs = positiveInteger(process.env.MC_SYNC_MISSED_SCHEDULE_GRACE_MS, 120_000);
  return (sqlite.prepare(`
    SELECT
      connector_id AS connectorId,
      interval_minutes AS intervalMinutes,
      next_due_at AS nextDueAt,
      last_enqueued_at AS lastEnqueuedAt
    FROM sync_schedules
    ORDER BY next_due_at, connector_id
  `).all() as Array<{
    connectorId: string;
    intervalMinutes: number;
    nextDueAt: string;
    lastEnqueuedAt: string | null;
  }>).map((schedule) => {
    const overdueMs = Math.max(0, now.getTime() - new Date(schedule.nextDueAt).getTime());
    return {
      ...schedule,
      overdueMs,
      overdue: overdueMs > graceMs,
    };
  });
}

export function enqueueDueSyncSchedules(now = new Date()): SyncJob[] {
  const nowIso = now.toISOString();
  sqlite.prepare(`
    DELETE FROM sync_schedules
    WHERE NOT EXISTS (
      SELECT 1
      FROM connector_configs
      WHERE connector_configs.id = sync_schedules.connector_id
        AND connector_configs.enabled = 1
        AND connector_configs.deleted_at IS NULL
        AND connector_configs.sync_mode = 'poll'
        AND connector_configs.poll_interval_minutes IS NOT NULL
        AND connector_configs.poll_interval_minutes > 0
    )
      AND NOT EXISTS (
        SELECT 1
        FROM connector_maintenance_locks
        WHERE connector_instance_id = sync_schedules.connector_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM connector_sync_controls
        WHERE connector_id = sync_schedules.connector_id
          AND scheduler_state = 'quarantined'
      )
  `).run();
  const due = sqlite.prepare(`
    SELECT
      connector_id AS connectorId,
      interval_minutes AS intervalMinutes,
      next_due_at AS nextDueAt
    FROM sync_schedules
    WHERE next_due_at <= ?
      AND NOT EXISTS (
        SELECT 1
        FROM connector_maintenance_locks
        WHERE connector_instance_id = sync_schedules.connector_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM connector_sync_controls
        WHERE connector_id = sync_schedules.connector_id
          AND scheduler_state = 'quarantined'
      )
    ORDER BY next_due_at, connector_id
  `).all(nowIso) as Array<{
    connectorId: string;
    intervalMinutes: number;
    nextDueAt: string;
  }>;

  const jobs: SyncJob[] = [];
  for (const schedule of due) {
    const job = enqueueSyncJob(schedule.connectorId, {
      source: 'schedule',
      scheduledFor: new Date(schedule.nextDueAt),
    });
    const intervalMs = schedule.intervalMinutes * 60_000;
    const missedIntervals = Math.max(
      1,
      Math.floor((now.getTime() - new Date(schedule.nextDueAt).getTime()) / intervalMs) + 1,
    );
    const nextDueAt = new Date(
      new Date(schedule.nextDueAt).getTime() + missedIntervals * intervalMs,
    ).toISOString();
    const updated = sqlite.prepare(`
      UPDATE sync_schedules
      SET last_enqueued_at = ?, next_due_at = ?, updated_at = ?
      WHERE connector_id = ? AND next_due_at = ?
    `).run(nowIso, nextDueAt, nowIso, schedule.connectorId, schedule.nextDueAt);
    if (updated.changes === 1) jobs.push(job);
  }
  return jobs;
}

export function getLatestDurableSyncResult(connectorId: string): SyncResult | undefined {
  const row = sqlite.prepare(`
    SELECT
      connector_id AS connectorId,
      success,
      tasks_added AS tasksAdded,
      tasks_updated AS tasksUpdated,
      tasks_removed AS tasksRemoved,
      alerts_added AS notificationsAdded,
      errors,
      synced_at AS syncedAt
    FROM sync_log
    WHERE connector_id = ?
      AND success = 1
      AND COALESCE(duration_ms, -1) <> 0
    ORDER BY synced_at DESC
    LIMIT 1
  `).get(connectorId) as {
    connectorId: string;
    success: number;
    tasksAdded: number;
    tasksUpdated: number;
    tasksRemoved: number;
    notificationsAdded: number;
    errors: string;
    syncedAt: string;
  } | undefined;
  if (!row) return undefined;
  return {
    ...row,
    success: row.success === 1,
    errors: JSON.parse(row.errors) as string[],
  };
}

export function getActiveSyncJobConnectorIds(): string[] {
  return (sqlite.prepare(`
    SELECT connector_id AS connectorId
    FROM sync_jobs
    WHERE status = 'running'
    ORDER BY started_at
  `).all() as Array<{ connectorId: string }>).map((row) => row.connectorId);
}

export function pruneSyncJobs(retentionDays = 14): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
  sqlite.prepare(`
    DELETE FROM sync_jobs
    WHERE status IN ('succeeded', 'failed', 'cancelled')
      AND completed_at < ?
  `).run(cutoff);
}

export const sqliteSyncJobRepository: SyncJobRepository = {
  enqueue: async (connectorId, request = {}) => enqueueSyncJob(connectorId, {
    ...request,
    availableAt: request.availableAt ? new Date(request.availableAt) : undefined,
    scheduledFor: request.scheduledFor ? new Date(request.scheduledFor) : undefined,
  }),
  claimNext: async (...args) => claimNextSyncJob(...args),
  renewLease: async (...args) => renewSyncJobLease(...args),
  isCancellationRequested: async (...args) => isSyncJobCancellationRequested(...args),
  complete: async (...args) => completeSyncJob(...args),
  finalizeSuccess: async (...args) => finalizeSuccessfulSyncJob(...args),
  linkSyncLog: async (...args) => linkSyncLogToJob(...args),
  fail: async (...args) => failSyncJob(...args),
  release: async (...args) => releaseSyncJob(...args),
  requestCancellation: async (...args) => requestSyncJobCancellation(...args),
  get: async (...args) => getSyncJob(...args),
  persistEvent: async (...args) => persistSyncJobEvent(...args),
  getEventsAfter: async (...args) => getSyncJobEventsAfter(...args),
  getLatestEventId: async () => getLatestSyncJobEventId(),
  countQueued: async () => countQueuedSyncJobs(),
  getMetrics: async (at) => getSyncQueueMetrics(at ? new Date(at) : undefined),
  registerSchedule: async (...args) => registerSyncSchedule(...args),
  markScheduleEnqueued: async (...args) => markSyncScheduleEnqueued(...args),
  unregisterSchedule: async (...args) => unregisterSyncSchedule(...args),
  getSchedules: async () => getSyncSchedules(),
  getScheduleHealth: async (at) => getSyncScheduleHealth(at ? new Date(at) : undefined),
  enqueueDueSchedules: async (at) => enqueueDueSyncSchedules(at ? new Date(at) : undefined),
  getLatestResult: async (...args) => getLatestDurableSyncResult(...args),
  getActiveConnectorIds: async () => getActiveSyncJobConnectorIds(),
  prune: async (...args) => pruneSyncJobs(...args),
};
