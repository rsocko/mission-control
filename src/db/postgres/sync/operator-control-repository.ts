import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import logger from '@/lib/logger';
import {
  getFinanceConnectorConfigurationState,
  isFinanceConnectorType,
} from '@/lib/connectors/monarch-money/config';
import { getPersistedFinanceManagerServiceToken } from '@/lib/connectors/monarch-money/client';
import { isFinanceInsightShadowIngestEnabled } from '@/lib/finance-insights/orchestrator';
import {
  FINANCE_IMMEDIATE_NOTIFICATION_GATE,
  FINANCE_MONTHLY_DIGEST_GATE,
} from '@/lib/finance-insights/notification-ingestion';
import {
  normalizeSyncOperatorIdempotencyKey,
  SyncOperatorError,
  type EnqueueFinanceOperatorCanaryResult,
  type FinanceSyncControlStatus,
  type QuarantineFinanceConnectorSyncResult,
  type ReleaseFinanceConnectorQuarantineResult,
  type RollbackFinanceOperatorCanaryResult,
  type SyncOperatorControlRepository,
  type SyncOperatorErrorCode,
  type SyncOperatorInput,
} from '@/lib/sync/operator-control';
import type { SyncJob, SyncJobStatus } from '@/lib/sync/job-repository';
import { PostgresSyncJobRepository } from './job-repository';

type Client = Pool | PoolClient;

interface ConnectorRow {
  id: string;
  type: string;
  enabled: boolean;
  syncMode: string;
  pollIntervalMinutes: number | null;
  credentials: Record<string, string> | null;
  settings: Record<string, unknown> | null;
}

interface OperatorRunRow {
  id: string;
  operation: string;
  quarantineId: string | null;
  jobId: string | null;
  resultCode: string;
  cancelledQueuedCount: number;
}

async function queryOne<T>(
  client: Client,
  sql: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const result = await client.query(sql, values);
  return result.rows[0] as T | undefined;
}

async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

function gateEnabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function policyFenceConfigured(): boolean {
  const value = Number(process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION);
  return Number.isSafeInteger(value) && value > 0;
}

function metadataResult(job: {
  id: string;
  status: SyncJobStatus;
  result: SyncJob['result'];
} | null): FinanceSyncControlStatus['canary'] {
  if (!job) {
    return { status: 'not-started', jobId: null, counts: null, resultCode: null };
  }
  return {
    status: job.status,
    jobId: job.id,
    counts: job.status === 'succeeded' && job.result
      ? {
          tasksAdded: job.result.tasksAdded,
          tasksUpdated: job.result.tasksUpdated,
          tasksRemoved: job.result.tasksRemoved,
          notificationsAdded: job.result.notificationsAdded,
        }
      : null,
    resultCode: job.status === 'failed' || job.status === 'cancelled'
      ? 'operator_canary_sync_failed'
      : null,
  };
}

export class PostgresSyncOperatorControlRepository
implements SyncOperatorControlRepository {
  constructor(
    private readonly pool: Pool,
    private readonly jobs: PostgresSyncJobRepository,
  ) {}

  private async connectorRow(
    client: Client,
    connectorId: string,
    lock = false,
  ): Promise<ConnectorRow> {
    const row = await queryOne<ConnectorRow>(
      client,
      `SELECT
         id,
         type,
         enabled,
         sync_mode AS "syncMode",
         poll_interval_minutes AS "pollIntervalMinutes",
         credentials,
         settings
       FROM connector_configs
       WHERE id = $1 AND deleted_at IS NULL
       ${lock ? 'FOR UPDATE' : ''}`,
      [connectorId],
    );
    if (!row) throw new SyncOperatorError('finance_connector_not_found', 404);
    if (!isFinanceConnectorType(row.type)) {
      throw new SyncOperatorError('invalid_finance_connector_type', 400);
    }
    return row;
  }

  private async existingRun(
    client: Client,
    connectorId: string,
    idempotencyKey: string,
  ): Promise<OperatorRunRow | undefined> {
    return queryOne<OperatorRunRow>(
      client,
      `SELECT
         id,
         operation,
         quarantine_id AS "quarantineId",
         job_id AS "jobId",
         result_code AS "resultCode",
         cancelled_queued_count AS "cancelledQueuedCount"
       FROM connector_sync_operator_runs
       WHERE connector_id = $1 AND idempotency_key = $2`,
      [connectorId, idempotencyKey],
    );
  }

  private async replayOrConflict(
    client: Client,
    connectorId: string,
    idempotencyKey: string,
    operation: OperatorRunRow['operation'],
  ): Promise<OperatorRunRow | undefined> {
    const existing = await this.existingRun(client, connectorId, idempotencyKey);
    if (!existing) return undefined;
    if (existing.operation !== operation) {
      throw new SyncOperatorError('operator_idempotency_conflict');
    }
    return existing;
  }

  private async getStatusWithClient(
    client: Client,
    connectorId: string,
  ): Promise<FinanceSyncControlStatus> {
    const connector = await this.connectorRow(client, connectorId);
    const [control, jobs, lastCanary, cutover] = await Promise.all([
      queryOne<{
        schedulerState: 'scheduled' | 'quarantined';
        quarantineId: string | null;
        quarantinedAt: string | null;
        releasedAt: string | null;
      }>(
        client,
        `SELECT
           scheduler_state AS "schedulerState",
           quarantine_id AS "quarantineId",
           quarantined_at AS "quarantinedAt",
           released_at AS "releasedAt"
         FROM connector_sync_controls
         WHERE connector_id = $1`,
        [connectorId],
      ),
      queryOne<{ queued: string | null; running: string | null }>(
        client,
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
         FROM sync_jobs
         WHERE connector_id = $1 AND status IN ('queued', 'running')`,
        [connectorId],
      ),
      queryOne<{ id: string; status: SyncJobStatus; result: SyncJob['result'] }>(
        client,
        `SELECT jobs.id, jobs.status, jobs.result
         FROM connector_sync_operator_runs runs
         INNER JOIN sync_jobs jobs ON jobs.id = runs.job_id
         WHERE runs.connector_id = $1 AND runs.operation = 'canary'
         ORDER BY runs.created_at DESC
         LIMIT 1`,
        [connectorId],
      ),
      queryOne<{ deliveryEnabled: boolean }>(
        client,
        `SELECT delivery_enabled AS "deliveryEnabled"
         FROM finance_insight_cutovers
         WHERE connector_id = $1`,
        [connectorId],
      ),
    ]);
    const immediateNotificationsEnabled = gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE);
    const monthlyDigestEnabled = gateEnabled(FINANCE_MONTHLY_DIGEST_GATE);
    const deliveryEnabled = cutover?.deliveryEnabled === true;
    const queued = Number(jobs?.queued ?? 0);
    const running = Number(jobs?.running ?? 0);
    const configurationState = getFinanceConnectorConfigurationState(connector.settings ?? {});
    const tokenConfigured = Boolean(
      getPersistedFinanceManagerServiceToken({
        credentials: connector.credentials ?? {},
      })
        || process.env.FINANCE_MANAGER_API_TOKEN?.trim(),
    );
    const blockers: SyncOperatorErrorCode[] = [];
    if (control?.schedulerState !== 'quarantined') blockers.push('sync_quarantine_required');
    if (queued + running > 0) blockers.push('sync_job_active');
    if (configurationState.status !== 'configured') blockers.push('household_currency_unavailable');
    if (!tokenConfigured) blockers.push('finance_service_token_unavailable');
    if (!policyFenceConfigured()) blockers.push('attribution_policy_fence_unavailable');
    if (!isFinanceInsightShadowIngestEnabled()) {
      blockers.push('finance_insight_shadow_ingest_disabled');
    }
    if (deliveryEnabled) blockers.push('finance_delivery_gate_enabled');
    if (immediateNotificationsEnabled || monthlyDigestEnabled) {
      blockers.push('finance_notification_gate_enabled');
    }

    return {
      connector: {
        id: connector.id,
        enabled: connector.enabled,
        configurationState,
      },
      scheduler: {
        state: control?.schedulerState ?? 'scheduled',
        quarantineId: control?.quarantineId ?? null,
        quarantinedAt: control?.quarantinedAt ?? null,
        releasedAt: control?.releasedAt ?? null,
        queued,
        running,
      },
      gates: {
        shadowIngestEnabled: isFinanceInsightShadowIngestEnabled(),
        immediateNotificationsEnabled,
        monthlyDigestEnabled,
        deliveryEnabled,
        presentationEnabled: deliveryEnabled,
        actionsEnabled: deliveryEnabled,
      },
      canary: metadataResult(lastCanary ?? null),
      readiness: {
        ready: blockers.length === 0,
        blockers,
      },
    };
  }

  getStatus(connectorId: string): Promise<FinanceSyncControlStatus> {
    return this.getStatusWithClient(this.pool, connectorId);
  }

  async quarantine(
    input: SyncOperatorInput,
  ): Promise<QuarantineFinanceConnectorSyncResult> {
    const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
    const result = await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.connectorId]);
      await this.connectorRow(client, input.connectorId, true);
      const replay = await this.replayOrConflict(
        client,
        input.connectorId,
        idempotencyKey,
        'quarantine',
      );
      if (replay) {
        return {
          status: 'quarantined' as const,
          quarantineId: replay.quarantineId,
          cancelledQueuedCount: replay.cancelledQueuedCount,
          replayed: true,
        };
      }
      const activeControl = await queryOne(
        client,
        `SELECT 1 FROM connector_sync_controls
         WHERE connector_id = $1 AND scheduler_state = 'quarantined'`,
        [input.connectorId],
      );
      if (activeControl) throw new SyncOperatorError('sync_quarantine_already_active');
      const running = await queryOne(
        client,
        `SELECT 1 FROM sync_jobs
         WHERE connector_id = $1 AND status = 'running'
         LIMIT 1`,
        [input.connectorId],
      );
      if (running) throw new SyncOperatorError('sync_quarantine_active_job');

      const now = (input.now ?? new Date()).toISOString();
      const quarantineId = randomUUID();
      const cancelled = await client.query(
        `UPDATE sync_jobs
         SET status = 'cancelled',
             completed_at = $1,
             updated_at = $1,
             error = 'Cancelled by operator scheduler quarantine'
         WHERE connector_id = $2 AND status = 'queued'`,
        [now, input.connectorId],
      );
      await client.query(
        `INSERT INTO connector_sync_controls (
           connector_id, scheduler_state, quarantine_id, quarantined_at, released_at, updated_at
         ) VALUES ($1, 'quarantined', $2, $3, NULL, $3)
         ON CONFLICT (connector_id) DO UPDATE SET
           scheduler_state = 'quarantined',
           quarantine_id = EXCLUDED.quarantine_id,
           quarantined_at = EXCLUDED.quarantined_at,
           released_at = NULL,
           updated_at = EXCLUDED.updated_at`,
        [input.connectorId, quarantineId, now],
      );
      await client.query('DELETE FROM sync_schedules WHERE connector_id = $1', [input.connectorId]);
      await client.query(
        `INSERT INTO connector_sync_operator_runs (
           id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
           result_code, cancelled_queued_count, created_at, completed_at
         ) VALUES ($1, $2, $3, 'quarantine', $4, $5, 'sync_quarantined', $6, $7, $7)`,
        [
          randomUUID(),
          input.connectorId,
          quarantineId,
          input.actorType,
          idempotencyKey,
          cancelled.rowCount ?? 0,
          now,
        ],
      );
      return {
        status: 'quarantined' as const,
        quarantineId,
        cancelledQueuedCount: cancelled.rowCount ?? 0,
        replayed: false,
      };
    });
    logger.info({
      connectorId: input.connectorId,
      quarantineId: result.quarantineId,
      cancelledQueuedCount: result.cancelledQueuedCount,
      operation: 'financeSyncQuarantine',
    }, 'Finance connector scheduler quarantined');
    return result;
  }

  async enqueueCanary(
    input: SyncOperatorInput,
  ): Promise<EnqueueFinanceOperatorCanaryResult> {
    const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
    const result = await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.connectorId]);
      await this.connectorRow(client, input.connectorId, true);
      const replay = await this.replayOrConflict(
        client,
        input.connectorId,
        idempotencyKey,
        'canary',
      );
      if (replay?.jobId) {
        const job = await this.jobs.getWithClient(client, replay.jobId);
        if (!job) throw new SyncOperatorError('sync_canary_already_invoked');
        return { job, replayed: true };
      }
      const status = await this.getStatusWithClient(client, input.connectorId);
      const existingCanary = await queryOne(
        client,
        `SELECT 1
         FROM connector_sync_operator_runs
         WHERE connector_id = $1
           AND quarantine_id IS NOT DISTINCT FROM $2
           AND operation = 'canary'
         LIMIT 1`,
        [input.connectorId, status.scheduler.quarantineId],
      );
      if (existingCanary) throw new SyncOperatorError('sync_canary_already_invoked');
      if (!status.readiness.ready) {
        throw new SyncOperatorError(status.readiness.blockers[0]);
      }
      const now = (input.now ?? new Date()).toISOString();
      const runId = randomUUID();
      await client.query(
        `INSERT INTO connector_sync_operator_runs (
           id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
           result_code, cancelled_queued_count, created_at, completed_at
         ) VALUES ($1, $2, $3, 'canary', $4, $5, 'operator_canary_queued', 0, $6, NULL)`,
        [
          runId,
          input.connectorId,
          status.scheduler.quarantineId,
          input.actorType,
          idempotencyKey,
          now,
        ],
      );
      const job = await this.jobs.enqueueWithClient(client, input.connectorId, {
        full: true,
        source: 'operator-canary',
        maxAttempts: 1,
        operatorCanaryRunId: runId,
      });
      const linked = await client.query(
        `UPDATE connector_sync_operator_runs
         SET job_id = $1
         WHERE id = $2 AND job_id IS NULL`,
        [job.id, runId],
      );
      if (linked.rowCount !== 1) {
        throw new Error(`Operator canary run ${runId} could not be linked to job ${job.id}`);
      }
      return { job, replayed: false };
    });
    logger.info({
      connectorId: input.connectorId,
      jobId: result.job.id,
      operation: 'financeOperatorCanary',
    }, 'Finance operator canary authorized');
    return result;
  }

  async release(
    input: SyncOperatorInput,
  ): Promise<ReleaseFinanceConnectorQuarantineResult> {
    const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
    const result = await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.connectorId]);
      const connector = await this.connectorRow(client, input.connectorId, true);
      const replay = await this.replayOrConflict(
        client,
        input.connectorId,
        idempotencyKey,
        'release',
      );
      if (replay) return { status: 'released' as const, replayed: true };
      const control = await queryOne<{ quarantineId: string | null }>(
        client,
        `SELECT quarantine_id AS "quarantineId"
         FROM connector_sync_controls
         WHERE connector_id = $1 AND scheduler_state = 'quarantined'
         FOR UPDATE`,
        [input.connectorId],
      );
      if (!control) throw new SyncOperatorError('sync_quarantine_required');
      const active = await queryOne(
        client,
        `SELECT 1 FROM sync_jobs
         WHERE connector_id = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [input.connectorId],
      );
      if (active) throw new SyncOperatorError('sync_job_active');
      const canary = await queryOne<{ status: SyncJobStatus }>(
        client,
        `SELECT jobs.status
         FROM connector_sync_operator_runs runs
         INNER JOIN sync_jobs jobs ON jobs.id = runs.job_id
         WHERE runs.connector_id = $1
           AND runs.quarantine_id IS NOT DISTINCT FROM $2
           AND runs.operation = 'canary'
         LIMIT 1`,
        [input.connectorId, control.quarantineId],
      );
      if (canary?.status !== 'succeeded') {
        throw new SyncOperatorError('sync_canary_not_successful');
      }
      const now = (input.now ?? new Date()).toISOString();
      const released = await client.query(
        `UPDATE connector_sync_controls
         SET scheduler_state = 'scheduled', released_at = $1, updated_at = $1
         WHERE connector_id = $2 AND quarantine_id IS NOT DISTINCT FROM $3`,
        [now, input.connectorId, control.quarantineId],
      );
      if (released.rowCount !== 1) {
        throw new SyncOperatorError('sync_quarantine_required');
      }
      if (connector.enabled && connector.syncMode === 'poll' && connector.pollIntervalMinutes) {
        await this.jobs.registerScheduleWithClient(
          client,
          input.connectorId,
          connector.pollIntervalMinutes,
        );
      }
      await client.query(
        `INSERT INTO connector_sync_operator_runs (
           id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
           result_code, cancelled_queued_count, created_at, completed_at
         ) VALUES ($1, $2, $3, 'release', $4, $5, 'sync_quarantine_released', 0, $6, $6)`,
        [
          randomUUID(),
          input.connectorId,
          control.quarantineId,
          input.actorType,
          idempotencyKey,
          now,
        ],
      );
      return { status: 'released' as const, replayed: false };
    });
    logger.info({
      connectorId: input.connectorId,
      operation: 'financeSyncQuarantineRelease',
    }, 'Finance connector scheduler quarantine released');
    return result;
  }

  async rollback(
    input: SyncOperatorInput,
  ): Promise<RollbackFinanceOperatorCanaryResult> {
    const idempotencyKey = normalizeSyncOperatorIdempotencyKey(input.idempotencyKey);
    const result = await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.connectorId]);
      await this.connectorRow(client, input.connectorId, true);
      const replay = await this.replayOrConflict(
        client,
        input.connectorId,
        idempotencyKey,
        'rollback',
      );
      if (replay) {
        return {
          status: 'quarantined' as const,
          cancelledQueuedCount: replay.cancelledQueuedCount,
          cancellationRequestedCount: 0,
          replayed: true,
        };
      }
      const control = await queryOne<{ quarantineId: string | null }>(
        client,
        `SELECT quarantine_id AS "quarantineId"
         FROM connector_sync_controls
         WHERE connector_id = $1 AND scheduler_state = 'quarantined'
         FOR UPDATE`,
        [input.connectorId],
      );
      if (!control) throw new SyncOperatorError('sync_quarantine_required');
      const now = (input.now ?? new Date()).toISOString();
      const cancelled = await client.query(
        `UPDATE sync_jobs
         SET status = 'cancelled',
             completed_at = $1,
             updated_at = $1,
             error = 'Cancelled by operator canary rollback'
         WHERE connector_id = $2
           AND source = 'operator-canary'
           AND status = 'queued'`,
        [now, input.connectorId],
      );
      const requested = await client.query(
        `UPDATE sync_jobs
         SET cancel_requested_at = $1, updated_at = $1
         WHERE connector_id = $2
           AND source = 'operator-canary'
           AND status = 'running'
           AND cancel_requested_at IS NULL`,
        [now, input.connectorId],
      );
      const nextQuarantineId = randomUUID();
      const updated = await client.query(
        `UPDATE connector_sync_controls
         SET quarantine_id = $1,
             quarantined_at = $2,
             released_at = NULL,
             updated_at = $2
         WHERE connector_id = $3
           AND quarantine_id IS NOT DISTINCT FROM $4`,
        [nextQuarantineId, now, input.connectorId, control.quarantineId],
      );
      if (updated.rowCount !== 1) {
        throw new SyncOperatorError('sync_quarantine_required');
      }
      await client.query(
        `INSERT INTO connector_sync_operator_runs (
           id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
           result_code, cancelled_queued_count, created_at, completed_at
         ) VALUES ($1, $2, $3, 'rollback', $4, $5, 'operator_canary_rolled_back', $6, $7, $7)`,
        [
          randomUUID(),
          input.connectorId,
          control.quarantineId,
          input.actorType,
          idempotencyKey,
          cancelled.rowCount ?? 0,
          now,
        ],
      );
      return {
        status: 'quarantined' as const,
        cancelledQueuedCount: cancelled.rowCount ?? 0,
        cancellationRequestedCount: requested.rowCount ?? 0,
        quarantineId: nextQuarantineId,
        replayed: false,
      };
    });
    logger.warn({
      connectorId: input.connectorId,
      cancelledQueuedCount: result.cancelledQueuedCount,
      cancellationRequestedCount: result.cancellationRequestedCount,
      operation: 'financeOperatorCanaryRollback',
    }, 'Finance operator canary rolled back');
    return result;
  }
}

export function createPostgresSyncOperatorControlRepository(
  pool: Pool,
  jobs: PostgresSyncJobRepository,
): SyncOperatorControlRepository {
  return new PostgresSyncOperatorControlRepository(pool, jobs);
}
