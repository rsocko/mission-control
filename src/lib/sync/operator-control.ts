import 'server-only';

import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import logger from '@/lib/logger';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
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
  enqueueSyncJobInCurrentTransaction,
  getSyncJob,
  registerSyncSchedule,
  type SyncJob,
} from './job-queue';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/;

export type SyncOperatorErrorCode =
  | 'invalid_operator_idempotency_key'
  | 'finance_connector_not_found'
  | 'invalid_finance_connector_type'
  | 'sync_quarantine_active_job'
  | 'sync_quarantine_already_active'
  | 'sync_quarantine_required'
  | 'sync_canary_already_invoked'
  | 'sync_canary_not_successful'
  | 'sync_job_active'
  | 'household_currency_unavailable'
  | 'finance_service_token_unavailable'
  | 'attribution_policy_fence_unavailable'
  | 'finance_insight_shadow_ingest_disabled'
  | 'finance_delivery_gate_enabled'
  | 'finance_notification_gate_enabled'
  | 'operator_idempotency_conflict';

export class SyncOperatorError extends Error {
  constructor(
    readonly code: SyncOperatorErrorCode,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'SyncOperatorError';
  }
}

interface ConnectorRow {
  id: string;
  type: string;
  enabled: number;
  syncMode: string;
  pollIntervalMinutes: number | null;
  credentials: string;
  settings: string;
}

interface OperatorRunRow {
  id: string;
  operation: string;
  quarantineId: string | null;
  jobId: string | null;
  resultCode: string;
  cancelledQueuedCount: number;
}

function connectorRow(connectorId: string): ConnectorRow {
  const row = sqlite.prepare(`
    SELECT id, type, enabled, sync_mode AS syncMode,
           poll_interval_minutes AS pollIntervalMinutes, credentials, settings
    FROM connector_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(connectorId) as ConnectorRow | undefined;
  if (!row) throw new SyncOperatorError('finance_connector_not_found', 404);
  if (!isFinanceConnectorType(row.type)) {
    throw new SyncOperatorError('invalid_finance_connector_type', 400);
  }
  return row;
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function requireIdempotencyKey(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new SyncOperatorError('invalid_operator_idempotency_key', 400);
  }
  return normalized;
}

function existingRun(connectorId: string, idempotencyKey: string): OperatorRunRow | undefined {
  return sqlite.prepare(`
    SELECT id, operation, quarantine_id AS quarantineId, job_id AS jobId,
           result_code AS resultCode, cancelled_queued_count AS cancelledQueuedCount
    FROM connector_sync_operator_runs
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as OperatorRunRow | undefined;
}

function replayOrConflict(
  connectorId: string,
  idempotencyKey: string,
  operation: OperatorRunRow['operation'],
): OperatorRunRow | undefined {
  const existing = existingRun(connectorId, idempotencyKey);
  if (!existing) return undefined;
  if (existing.operation !== operation) {
    throw new SyncOperatorError('operator_idempotency_conflict');
  }
  return existing;
}

function gateEnabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function policyFenceConfigured(): boolean {
  const value = Number(process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION);
  return Number.isSafeInteger(value) && value > 0;
}

function metadataResult(job: SyncJob | null): {
  status: 'not-started' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  jobId: string | null;
  counts: {
    tasksAdded: number;
    tasksUpdated: number;
    tasksRemoved: number;
    notificationsAdded: number;
  } | null;
  resultCode: string | null;
} {
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

export function getFinanceSyncControlStatus(connectorId: string) {
  const connector = connectorRow(connectorId);
  const settings = parseRecord(connector.settings);
  const credentials = parseRecord(connector.credentials) as Record<string, string>;
  const control = sqlite.prepare(`
    SELECT scheduler_state AS schedulerState, quarantine_id AS quarantineId,
           quarantined_at AS quarantinedAt, released_at AS releasedAt
    FROM connector_sync_controls WHERE connector_id = ?
  `).get(connectorId) as {
    schedulerState: 'scheduled' | 'quarantined';
    quarantineId: string | null;
    quarantinedAt: string | null;
    releasedAt: string | null;
  } | undefined;
  const jobs = sqlite.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM sync_jobs
    WHERE connector_id = ? AND status IN ('queued', 'running')
  `).get(connectorId) as { queued: number | null; running: number | null };
  const lastCanary = sqlite.prepare(`
    SELECT job_id AS jobId
    FROM connector_sync_operator_runs
    WHERE connector_id = ? AND operation = 'canary'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(connectorId) as { jobId: string | null } | undefined;
  const cutover = sqlite.prepare(`
    SELECT delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers
    WHERE connector_id = ?
  `).get(connectorId) as { deliveryEnabled: number } | undefined;
  const immediateNotificationsEnabled = gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE);
  const monthlyDigestEnabled = gateEnabled(FINANCE_MONTHLY_DIGEST_GATE);
  const deliveryEnabled = cutover?.deliveryEnabled === 1;
  const queued = jobs.queued ?? 0;
  const running = jobs.running ?? 0;
  const configurationState = getFinanceConnectorConfigurationState(settings);
  const tokenConfigured = Boolean(
    getPersistedFinanceManagerServiceToken({ credentials })
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
  const canaryJob = lastCanary?.jobId ? getSyncJob(lastCanary.jobId) ?? null : null;

  return {
    connector: {
      id: connector.id,
      enabled: connector.enabled === 1,
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
    canary: metadataResult(canaryJob),
    readiness: {
      ready: blockers.length === 0,
      blockers,
    },
  };
}

export function quarantineFinanceConnectorSync(input: {
  connectorId: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  connectorRow(input.connectorId);
  return sqlite.transaction(() => {
    const replay = replayOrConflict(input.connectorId, idempotencyKey, 'quarantine');
    if (replay) {
      return {
        status: 'quarantined' as const,
        quarantineId: replay.quarantineId,
        cancelledQueuedCount: replay.cancelledQueuedCount,
        replayed: true,
      };
    }
    const activeControl = sqlite.prepare(`
      SELECT quarantine_id AS quarantineId
      FROM connector_sync_controls
      WHERE connector_id = ? AND scheduler_state = 'quarantined'
    `).get(input.connectorId);
    if (activeControl) throw new SyncOperatorError('sync_quarantine_already_active');
    const running = sqlite.prepare(`
      SELECT 1 FROM sync_jobs
      WHERE connector_id = ? AND status = 'running'
      LIMIT 1
    `).get(input.connectorId);
    if (running) throw new SyncOperatorError('sync_quarantine_active_job');

    const now = (input.now ?? new Date()).toISOString();
    const quarantineId = randomUUID();
    const cancelled = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'cancelled',
          completed_at = ?,
          updated_at = ?,
          error = 'Cancelled by operator scheduler quarantine'
      WHERE connector_id = ? AND status = 'queued'
    `).run(now, now, input.connectorId);
    sqlite.prepare(`
      INSERT INTO connector_sync_controls (
        connector_id, scheduler_state, quarantine_id, quarantined_at, released_at, updated_at
      ) VALUES (?, 'quarantined', ?, ?, NULL, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        scheduler_state = 'quarantined',
        quarantine_id = excluded.quarantine_id,
        quarantined_at = excluded.quarantined_at,
        released_at = NULL,
        updated_at = excluded.updated_at
    `).run(input.connectorId, quarantineId, now, now);
    sqlite.prepare(`DELETE FROM sync_schedules WHERE connector_id = ?`).run(input.connectorId);
    sqlite.prepare(`
      INSERT INTO connector_sync_operator_runs (
        id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
        result_code, cancelled_queued_count, created_at, completed_at
      ) VALUES (?, ?, ?, 'quarantine', ?, ?, 'sync_quarantined', ?, ?, ?)
    `).run(
      randomUUID(),
      input.connectorId,
      quarantineId,
      input.actorType,
      idempotencyKey,
      cancelled.changes,
      now,
      now,
    );
    const result = {
      status: 'quarantined' as const,
      quarantineId,
      cancelledQueuedCount: Number(cancelled.changes),
      replayed: false,
    };
    logger.info({
      connectorId: input.connectorId,
      quarantineId,
      cancelledQueuedCount: result.cancelledQueuedCount,
      operation: 'financeSyncQuarantine',
    }, 'Finance connector scheduler quarantined');
    return result;
  }).immediate();
}

export function enqueueFinanceOperatorCanary(input: {
  connectorId: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}): { job: SyncJob; replayed: boolean } {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  connectorRow(input.connectorId);
  return sqlite.transaction(() => {
    const replay = replayOrConflict(input.connectorId, idempotencyKey, 'canary');
    if (replay?.jobId) {
      const job = getSyncJob(replay.jobId);
      if (!job) throw new SyncOperatorError('sync_canary_already_invoked');
      return { job, replayed: true };
    }
    const status = getFinanceSyncControlStatus(input.connectorId);
    const existingCanary = sqlite.prepare(`
      SELECT 1
      FROM connector_sync_operator_runs
      WHERE connector_id = ?
        AND quarantine_id = ?
        AND operation = 'canary'
      LIMIT 1
    `).get(input.connectorId, status.scheduler.quarantineId);
    if (existingCanary) throw new SyncOperatorError('sync_canary_already_invoked');
    if (!status.readiness.ready) {
      throw new SyncOperatorError(status.readiness.blockers[0]);
    }
    const now = (input.now ?? new Date()).toISOString();
    const runId = randomUUID();
    sqlite.prepare(`
      INSERT INTO connector_sync_operator_runs (
        id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
        result_code, cancelled_queued_count, created_at, completed_at
      ) VALUES (?, ?, ?, 'canary', ?, ?, 'operator_canary_queued', 0, ?, NULL)
    `).run(
      runId,
      input.connectorId,
      status.scheduler.quarantineId,
      input.actorType,
      idempotencyKey,
      now,
    );
    const job = enqueueSyncJobInCurrentTransaction(input.connectorId, {
      full: true,
      source: 'operator-canary',
      maxAttempts: 1,
      operatorCanaryRunId: runId,
    });
    sqlite.prepare(`
      UPDATE connector_sync_operator_runs
      SET job_id = ?
      WHERE id = ? AND job_id IS NULL
    `).run(job.id, runId);
    logger.info({
      connectorId: input.connectorId,
      quarantineId: status.scheduler.quarantineId,
      runId,
      jobId: job.id,
      operation: 'financeOperatorCanary',
    }, 'Finance operator canary authorized');
    return { job, replayed: false };
  }).immediate();
}

export function releaseFinanceConnectorQuarantine(input: {
  connectorId: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  connectorRow(input.connectorId);
  return sqlite.transaction(() => {
    const replay = replayOrConflict(input.connectorId, idempotencyKey, 'release');
    if (replay) return { status: 'released' as const, replayed: true };
    const control = sqlite.prepare(`
      SELECT quarantine_id AS quarantineId
      FROM connector_sync_controls
      WHERE connector_id = ? AND scheduler_state = 'quarantined'
    `).get(input.connectorId) as { quarantineId: string | null } | undefined;
    if (!control) throw new SyncOperatorError('sync_quarantine_required');
    const active = sqlite.prepare(`
      SELECT 1 FROM sync_jobs
      WHERE connector_id = ? AND status IN ('queued', 'running')
      LIMIT 1
    `).get(input.connectorId);
    if (active) throw new SyncOperatorError('sync_job_active');
    const canary = sqlite.prepare(`
      SELECT jobs.status
      FROM connector_sync_operator_runs runs
      INNER JOIN sync_jobs jobs ON jobs.id = runs.job_id
      WHERE runs.connector_id = ?
        AND runs.quarantine_id IS ?
        AND runs.operation = 'canary'
      LIMIT 1
    `).get(input.connectorId, control.quarantineId) as { status: string } | undefined;
    if (canary?.status !== 'succeeded') {
      throw new SyncOperatorError('sync_canary_not_successful');
    }
    const now = (input.now ?? new Date()).toISOString();
    sqlite.prepare(`
      UPDATE connector_sync_controls
      SET scheduler_state = 'scheduled', released_at = ?, updated_at = ?
      WHERE connector_id = ? AND quarantine_id IS ?
    `).run(now, now, input.connectorId, control.quarantineId);
    const connector = connectorRow(input.connectorId);
    if (
      connector.enabled === 1
      && connector.syncMode === 'poll'
      && connector.pollIntervalMinutes
    ) {
      registerSyncSchedule(input.connectorId, connector.pollIntervalMinutes);
    }
    sqlite.prepare(`
      INSERT INTO connector_sync_operator_runs (
        id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
        result_code, cancelled_queued_count, created_at, completed_at
      ) VALUES (?, ?, ?, 'release', ?, ?, 'sync_quarantine_released', 0, ?, ?)
    `).run(
      randomUUID(),
      input.connectorId,
      control.quarantineId,
      input.actorType,
      idempotencyKey,
      now,
      now,
    );
    logger.info({
      connectorId: input.connectorId,
      quarantineId: control.quarantineId,
      operation: 'financeSyncQuarantineRelease',
    }, 'Finance connector scheduler quarantine released');
    return { status: 'released' as const, replayed: false };
  }).immediate();
}

export function rollbackFinanceOperatorCanary(input: {
  connectorId: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  connectorRow(input.connectorId);
  return sqlite.transaction(() => {
    const replay = replayOrConflict(input.connectorId, idempotencyKey, 'rollback');
    if (replay) {
      return {
        status: 'quarantined' as const,
        cancelledQueuedCount: replay.cancelledQueuedCount,
        cancellationRequestedCount: 0,
        replayed: true,
      };
    }
    const control = sqlite.prepare(`
      SELECT quarantine_id AS quarantineId
      FROM connector_sync_controls
      WHERE connector_id = ? AND scheduler_state = 'quarantined'
    `).get(input.connectorId) as { quarantineId: string | null } | undefined;
    if (!control) throw new SyncOperatorError('sync_quarantine_required');
    const now = (input.now ?? new Date()).toISOString();
    const cancelled = sqlite.prepare(`
      UPDATE sync_jobs
      SET status = 'cancelled', completed_at = ?, updated_at = ?,
          error = 'Cancelled by operator canary rollback'
      WHERE connector_id = ? AND source = 'operator-canary' AND status = 'queued'
    `).run(now, now, input.connectorId);
    const requested = sqlite.prepare(`
      UPDATE sync_jobs
      SET cancel_requested_at = ?, updated_at = ?
      WHERE connector_id = ? AND source = 'operator-canary' AND status = 'running'
        AND cancel_requested_at IS NULL
    `).run(now, now, input.connectorId);
    const nextQuarantineId = randomUUID();
    sqlite.prepare(`
      UPDATE connector_sync_controls
      SET quarantine_id = ?, quarantined_at = ?, released_at = NULL, updated_at = ?
      WHERE connector_id = ? AND quarantine_id IS ?
    `).run(
      nextQuarantineId,
      now,
      now,
      input.connectorId,
      control.quarantineId,
    );
    sqlite.prepare(`
      INSERT INTO connector_sync_operator_runs (
        id, connector_id, quarantine_id, operation, actor_type, idempotency_key,
        result_code, cancelled_queued_count, created_at, completed_at
      ) VALUES (?, ?, ?, 'rollback', ?, ?, 'operator_canary_rolled_back', ?, ?, ?)
    `).run(
      randomUUID(),
      input.connectorId,
      control.quarantineId,
      input.actorType,
      idempotencyKey,
      cancelled.changes,
      now,
      now,
    );
    const result = {
      status: 'quarantined' as const,
      cancelledQueuedCount: Number(cancelled.changes),
      cancellationRequestedCount: Number(requested.changes),
      quarantineId: nextQuarantineId,
      replayed: false,
    };
    logger.warn({
      connectorId: input.connectorId,
      quarantineId: nextQuarantineId,
      cancelledQueuedCount: result.cancelledQueuedCount,
      cancellationRequestedCount: result.cancellationRequestedCount,
      operation: 'financeOperatorCanaryRollback',
    }, 'Finance operator canary rolled back');
    return result;
  }).immediate();
}
