import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import {
  ProviderSessionProtector,
  type EncryptedProviderSessionReference,
} from './provider-session-crypto';
import {
  redactDurableAiText,
  sanitizeDurableAiEventPayload,
  sanitizeDurableAiState,
} from './redaction';
import {
  DURABLE_AI_RUN_TERMINAL_STATUSES,
  type AppendDurableAiRunEventInput,
  type ClaimedDurableAiRun,
  type CreateDurableAiRunInput,
  type DurableAiRun,
  type DurableAiRunEvent,
  type DurableAiRunFallbackState,
  type DurableAiRunHistoryFilter,
  type DurableAiRunRetentionResult,
  type DurableAiRunRouteOutcome,
  type DurableAiRunStatus,
  type ProtectedProviderSession,
} from './types';

interface AiRunDatabaseRow {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  featureId: string;
  sensitivity: DurableAiRun['sensitivity'];
  status: DurableAiRunStatus;
  executionRoute: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  provider: string | null;
  model: string | null;
  fallbackState: DurableAiRunFallbackState;
  correlationId: string;
  traceparent: string | null;
  tracestate: string | null;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  timeoutAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  notifyOnCompletion: number;
  cleanupStatus: DurableAiRun['cleanupStatus'];
  executionState: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface ProviderSessionDatabaseRow extends EncryptedProviderSessionReference {
  provider: string;
  state: 'active' | 'revoked';
  expiresAt: string;
}

interface AddedDurableAiRunEvent {
  event: DurableAiRunEvent;
  inserted: boolean;
}

export interface InternalDurableAiRun extends DurableAiRun {
  idempotencyKey: string;
  requestFingerprint: string;
  traceparent: string | null;
  tracestate: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  executionState: Record<string, unknown> | null;
}

const RUN_COLUMNS = `
  id,
  idempotency_key AS idempotencyKey,
  request_fingerprint AS requestFingerprint,
  feature_id AS featureId,
  sensitivity,
  status,
  execution_route AS executionRoute,
  requested_provider AS requestedProvider,
  requested_model AS requestedModel,
  provider,
  model,
  fallback_state AS fallbackState,
  correlation_id AS correlationId,
  traceparent,
  tracestate,
  attempt,
  max_attempts AS maxAttempts,
  available_at AS availableAt,
  timeout_at AS timeoutAt,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  cancel_requested_at AS cancelRequestedAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  last_error_code AS lastErrorCode,
  last_error_message AS lastErrorMessage,
  notify_on_completion AS notifyOnCompletion,
  cleanup_status AS cleanupStatus,
  execution_state AS executionState,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt,
  expires_at AS expiresAt
`;

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_PROVIDER_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETENTION_DAYS = {
  standard: 30,
  restricted: 7,
  'local-only': 1,
} as const;
const TRACEPARENT_PATTERN =
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function boundedIdentifier(value: string, field: string, maxLength = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function parseExecutionState(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function deserializeInternalRun(row: AiRunDatabaseRow): InternalDurableAiRun {
  return {
    ...row,
    notifyOnCompletion: row.notifyOnCompletion === 1,
    executionState: parseExecutionState(row.executionState),
  };
}

function toPublicRun(run: InternalDurableAiRun): DurableAiRun {
  return {
    id: run.id,
    featureId: run.featureId,
    sensitivity: run.sensitivity,
    status: run.status,
    executionRoute: run.executionRoute,
    requestedProvider: run.requestedProvider,
    requestedModel: run.requestedModel,
    provider: run.provider,
    model: run.model,
    fallbackState: run.fallbackState,
    correlationId: run.correlationId,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    availableAt: run.availableAt,
    timeoutAt: run.timeoutAt,
    cancelRequestedAt: run.cancelRequestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    lastErrorCode: run.lastErrorCode,
    lastErrorMessage: run.lastErrorMessage,
    notifyOnCompletion: run.notifyOnCompletion,
    cleanupStatus: run.cleanupStatus,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    expiresAt: run.expiresAt,
  };
}

function requestFingerprint(input: CreateDurableAiRunInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.featureId.trim(),
    input.sensitivity,
    input.executionRoute.trim(),
    input.requestedProvider?.trim() || null,
    input.requestedModel?.trim() || null,
  ])).digest('hex');
}

function retentionDays(sensitivity: DurableAiRun['sensitivity']): number {
  const configured = Number.parseInt(
    process.env[`MC_AI_RUN_RETENTION_DAYS_${sensitivity.replace('-', '_').toUpperCase()}`]
      ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_DAYS[sensitivity];
}

function resolveTraceparent(value: string | undefined): string {
  if (!value) {
    return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  }
  const normalized = value.trim().toLowerCase();
  if (!TRACEPARENT_PATTERN.test(normalized)) {
    throw new TypeError('traceparent must use the W3C version 00 format.');
  }
  return normalized;
}

function addEvent(
  runId: string,
  input: AppendDurableAiRunEventInput,
): AddedDurableAiRunEvent {
  const idempotencyKey = boundedIdentifier(
    input.idempotencyKey,
    'event idempotencyKey',
    300,
  );
  const existing = sqlite.prepare(`
    SELECT
      id AS cursor,
      event_id AS eventId,
      run_id AS runId,
      sequence,
      kind,
      payload,
      created_at AS createdAt
    FROM ai_run_events
    WHERE run_id = ? AND idempotency_key = ?
  `).get(runId, idempotencyKey) as {
    cursor: number;
    eventId: string;
    runId: string;
    sequence: number;
    kind: string;
    payload: string;
    createdAt: string;
  } | undefined;
  if (existing) {
    return {
      event: {
        ...existing,
        payload: JSON.parse(existing.payload) as Record<string, unknown>,
      },
      inserted: false,
    };
  }

  const sequence = (sqlite.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM ai_run_events
    WHERE run_id = ?
  `).get(runId) as { sequence: number }).sequence;
  const eventId = input.eventId ?? randomUUID();
  const createdAt = (input.now ?? new Date()).toISOString();
  const payload = sanitizeDurableAiEventPayload(input.kind, input.payload);
  const result = sqlite.prepare(`
    INSERT INTO ai_run_events (
      event_id, run_id, sequence, idempotency_key, kind, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    runId,
    sequence,
    idempotencyKey,
    boundedIdentifier(input.kind, 'event kind', 120),
    JSON.stringify(payload),
    createdAt,
  );
  return {
    event: {
      cursor: Number(result.lastInsertRowid),
      eventId,
      runId,
      sequence,
      kind: input.kind,
      payload,
      createdAt,
    },
    inserted: true,
  };
}

function getInternalRunBy(
  column: 'id' | 'idempotency_key',
  value: string,
): InternalDurableAiRun | null {
  const row = sqlite.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM ai_runs
    WHERE ${column} = ?
  `).get(value) as AiRunDatabaseRow | undefined;
  return row ? deserializeInternalRun(row) : null;
}

function hasActiveProviderSession(runId: string, now = new Date()): boolean {
  return Boolean(sqlite.prepare(`
    SELECT 1 FROM ai_provider_sessions
    WHERE run_id = ? AND state = 'active' AND expires_at > ?
  `).get(runId, now.toISOString()));
}

function cleanupStatusForTerminal(
  runId: string,
  now = new Date(),
): DurableAiRun['cleanupStatus'] {
  return hasActiveProviderSession(runId, now) ? 'pending' : 'none';
}

export class DurableAiRunStore {
  constructor(
    private readonly sessionProtectorFactory:
      () => ProviderSessionProtector = ProviderSessionProtector.fromEnvironment,
  ) {}

  createRun(input: CreateDurableAiRunInput): {
    run: DurableAiRun;
    created: boolean;
  } {
    const idempotencyKey = boundedIdentifier(
      input.idempotencyKey,
      'idempotencyKey',
      300,
    );
    const fingerprint = requestFingerprint(input);
    const transaction = sqlite.transaction(() => {
      const existing = getInternalRunBy('idempotency_key', idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error(
            'The durable AI run idempotency key is already bound to a different request.',
          );
        }
        return { run: toPublicRun(existing), created: false };
      }

      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const timeoutMs = positiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
      const expiresAt = new Date(
        now.getTime() + retentionDays(input.sensitivity) * 24 * 60 * 60_000,
      ).toISOString();
      const runId = input.id ?? randomUUID();
      const correlationId = input.correlationId?.trim() || runId;
      const maxAttempts = positiveInteger(input.maxAttempts, 3);

      sqlite.prepare(`
        INSERT INTO ai_runs (
          id, idempotency_key, request_fingerprint, feature_id, sensitivity,
          status, execution_route, requested_provider, requested_model,
          fallback_state, correlation_id, traceparent, tracestate, attempt,
          max_attempts, available_at, timeout_at, notify_on_completion,
          cleanup_status, revision, created_at, updated_at, expires_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 'not_requested', ?, ?, ?, 0,
          ?, ?, ?, ?, 'none', 0, ?, ?, ?
        )
      `).run(
        boundedIdentifier(runId, 'run id', 200),
        idempotencyKey,
        fingerprint,
        boundedIdentifier(input.featureId, 'featureId'),
        input.sensitivity,
        boundedIdentifier(input.executionRoute, 'executionRoute'),
        input.requestedProvider?.trim() || null,
        input.requestedModel?.trim() || null,
        boundedIdentifier(correlationId, 'correlationId', 300),
        resolveTraceparent(input.traceparent),
        input.tracestate?.trim() || null,
        maxAttempts,
        nowIso,
        new Date(now.getTime() + timeoutMs).toISOString(),
        input.notifyOnCompletion ? 1 : 0,
        nowIso,
        nowIso,
        expiresAt,
      );
      addEvent(runId, {
        idempotencyKey: 'run:queued',
        kind: 'run.queued',
        payload: {
          featureId: input.featureId,
          executionRoute: input.executionRoute,
        },
        now,
      });
      return { run: this.getRunOrThrow(runId), created: true };
    });
    return transaction.immediate();
  }

  getRun(runId: string): DurableAiRun | null {
    const run = getInternalRunBy('id', runId);
    return run ? toPublicRun(run) : null;
  }

  getInternalRun(runId: string): InternalDurableAiRun | null {
    return getInternalRunBy('id', runId);
  }

  listInternalRunsByRoute(executionRoute: string): InternalDurableAiRun[] {
    const rows = sqlite.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM ai_runs
      WHERE execution_route = ?
      ORDER BY created_at DESC, id DESC
    `).all(executionRoute) as AiRunDatabaseRow[];
    return rows.map(deserializeInternalRun);
  }

  private getRunOrThrow(runId: string): DurableAiRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Durable AI run ${runId} was not found.`);
    return run;
  }

  listRuns(filter: DurableAiRunHistoryFilter = {}): DurableAiRun[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filter.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter.featureId) {
      conditions.push('feature_id = ?');
      values.push(filter.featureId);
    }
    if (filter.before) {
      const separator = filter.before.indexOf('|');
      if (separator > 0) {
        const createdAt = filter.before.slice(0, separator);
        const id = filter.before.slice(separator + 1);
        conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
        values.push(createdAt, createdAt, id);
      } else {
        conditions.push('created_at < ?');
        values.push(filter.before);
      }
    }
    const limit = Math.min(100, positiveInteger(filter.limit, 25));
    values.push(limit);
    const rows = sqlite.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM ai_runs
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...values) as AiRunDatabaseRow[];
    return rows.map((row) => toPublicRun(deserializeInternalRun(row)));
  }

  getEventsAfter(runId: string, cursor = 0, limit = 100): DurableAiRunEvent[] {
    const rows = sqlite.prepare(`
      SELECT
        id AS cursor,
        event_id AS eventId,
        run_id AS runId,
        sequence,
        kind,
        payload,
        created_at AS createdAt
      FROM ai_run_events
      WHERE run_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(runId, Math.max(0, cursor), Math.min(1_000, positiveInteger(limit, 100))) as Array<{
      cursor: number;
      eventId: string;
      runId: string;
      sequence: number;
      kind: string;
      payload: string;
      createdAt: string;
    }>;
    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  getEventIdempotencyKeys(runId: string): string[] {
    const rows = sqlite.prepare(`
      SELECT idempotency_key AS idempotencyKey
      FROM ai_run_events
      WHERE run_id = ?
      ORDER BY id ASC
    `).all(runId) as Array<{
      idempotencyKey: string;
    }>;
    return rows.map((row) => row.idempotencyKey);
  }

  appendEvent(
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): DurableAiRunEvent {
    const transaction = sqlite.transaction(() =>
      this.appendEventInTransaction(runId, input));
    return transaction.immediate();
  }

  appendEventForClaim(
    runId: string,
    owner: string,
    attempt: number,
    input: AppendDurableAiRunEventInput,
  ): DurableAiRunEvent {
    const now = input.now ?? new Date();
    const transaction = sqlite.transaction(() => {
      this.assertOwnedClaim(runId, owner, attempt, now);
      return this.appendEventInTransaction(runId, { ...input, now });
    });
    return transaction.immediate();
  }

  appendEventForExecutionOwner(
    runId: string,
    owner: string,
    input: AppendDurableAiRunEventInput,
    receivedAt = new Date(),
  ): DurableAiRunEvent {
    const transaction = sqlite.transaction(() => {
      const run = getInternalRunBy('id', runId);
      const executionState = run?.executionState;
      const executionStateName = typeof executionState?.state === 'string'
        ? executionState.state
        : null;
      if (
        !executionState
        || executionState.ownerId !== owner
        || (
          ['running', 'cancelling'].includes(run.status)
          && (
            run.leaseOwner !== owner
            || !run.leaseExpiresAt
            || run.leaseExpiresAt <= receivedAt.toISOString()
          )
        )
        || (
          DURABLE_AI_RUN_TERMINAL_STATUSES.has(run.status)
          && !['completed', 'failed', 'timed_out', 'cleaned_up'].includes(
            executionStateName ?? '',
          )
        )
        || run.status === 'queued'
      ) {
        throw new Error(`Durable AI run ${runId} execution ownership was lost.`);
      }
      return this.appendEventInTransaction(runId, input);
    });
    return transaction.immediate();
  }

  private appendEventInTransaction(
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): DurableAiRunEvent {
    const run = getInternalRunBy('id', runId);
    if (!run) throw new Error(`Durable AI run ${runId} was not found.`);
    const added = addEvent(runId, input);
    if (
      added.inserted
      && (input.provider || input.model || input.fallbackState)
    ) {
      sqlite.prepare(`
        UPDATE ai_runs
        SET provider = COALESCE(?, provider),
            model = COALESCE(?, model),
            fallback_state = COALESCE(?, fallback_state),
            updated_at = ?,
            revision = revision + 1
        WHERE id = ?
      `).run(
        input.provider?.trim() || null,
        input.model?.trim() || null,
        input.fallbackState ?? null,
        (input.now ?? new Date()).toISOString(),
        runId,
      );
    }
    return added.event;
  }

  private assertOwnedClaim(
    runId: string,
    owner: string,
    attempt: number,
    now: Date,
  ): void {
    const owned = sqlite.prepare(`
      SELECT 1
      FROM ai_runs
      WHERE id = ?
        AND lease_owner = ?
        AND attempt = ?
        AND status IN ('running', 'cancelling')
        AND lease_expires_at > ?
    `).get(runId, owner, attempt, now.toISOString());
    if (!owned) {
      throw new Error(`Durable AI run ${runId} ownership was lost.`);
    }
  }

  claimNextRun(
    owner: string,
    routes: readonly string[],
    leaseMs = 120_000,
    now = new Date(),
  ): ClaimedDurableAiRun | null {
    if (routes.length === 0) return null;
    const normalizedOwner = boundedIdentifier(owner, 'lease owner', 300);
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + positiveInteger(leaseMs, 120_000),
    ).toISOString();
    const placeholders = routes.map(() => '?').join(', ');
    const transaction = sqlite.transaction(() => {
      this.recoverExpiredRuns(now, routes);
      this.expireTimedOutQueuedRunsInTransaction(now);

      const candidate = sqlite.prepare(`
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        WHERE status = 'queued'
          AND cancel_requested_at IS NULL
          AND available_at <= ?
          AND timeout_at > ?
          AND execution_route IN (${placeholders})
        ORDER BY available_at ASC, created_at ASC
        LIMIT 1
      `).get(nowIso, nowIso, ...routes) as AiRunDatabaseRow | undefined;
      if (!candidate) return null;

      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET status = 'running',
            attempt = attempt + 1,
            lease_owner = ?,
            lease_expires_at = ?,
            started_at = COALESCE(started_at, ?),
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND status = 'queued' AND revision = ?
      `).run(
        normalizedOwner,
        leaseExpiresAt,
        nowIso,
        nowIso,
        candidate.id,
        candidate.revision,
      );
      if (update.changes !== 1) return null;
      addEvent(candidate.id, {
        idempotencyKey: `run:attempt:${candidate.attempt + 1}:started`,
        kind: 'run.started',
        payload: { attempt: candidate.attempt + 1 },
        now,
      });
      const claimed = getInternalRunBy('id', candidate.id);
      if (!claimed?.leaseOwner || !claimed.leaseExpiresAt) return null;
      return {
        ...toPublicRun(claimed),
        leaseOwner: claimed.leaseOwner,
        leaseExpiresAt: claimed.leaseExpiresAt,
        traceparent: claimed.traceparent,
        tracestate: claimed.tracestate,
      };
    });
    return transaction.immediate();
  }

  renewLease(
    runId: string,
    owner: string,
    leaseMs = 120_000,
    now = new Date(),
  ): boolean {
    const nowIso = now.toISOString();
    const result = sqlite.prepare(`
      UPDATE ai_runs
      SET lease_expires_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
        AND status IN ('running', 'cancelling')
        AND lease_owner = ?
        AND lease_expires_at > ?
    `).run(
      new Date(now.getTime() + positiveInteger(leaseMs, 120_000)).toISOString(),
      nowIso,
      runId,
      owner,
      nowIso,
    );
    return result.changes === 1;
  }

  isCancellationRequested(runId: string, owner?: string): boolean {
    const row = sqlite.prepare(`
      SELECT cancel_requested_at AS cancelRequestedAt
      FROM ai_runs
      WHERE id = ?
        AND status IN ('running', 'cancelling')
        ${owner ? 'AND lease_owner = ?' : ''}
    `).get(...(owner ? [runId, owner] : [runId])) as {
      cancelRequestedAt: string | null;
    } | undefined;
    return Boolean(row?.cancelRequestedAt);
  }

  requestCancellation(runId: string, now = new Date()): DurableAiRun | null {
    const nowIso = now.toISOString();
    const transaction = sqlite.transaction(() => {
      const current = getInternalRunBy('id', runId);
      if (!current) return null;
      if (DURABLE_AI_RUN_TERMINAL_STATUSES.has(current.status)) {
        return toPublicRun(current);
      }
      const status = current.status === 'queued' ? 'cancelled' : 'cancelling';
      const terminal = status === 'cancelled';
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET status = ?,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
            cleanup_status = CASE WHEN ? THEN ? ELSE cleanup_status END,
            lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(
        status,
        nowIso,
        terminal ? 1 : 0,
        nowIso,
        terminal ? 1 : 0,
        terminal ? cleanupStatusForTerminal(runId) : current.cleanupStatus,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        nowIso,
        runId,
        current.revision,
      );
      if (update.changes !== 1) {
        throw new Error(`Durable AI run ${runId} changed during cancellation.`);
      }
      addEvent(runId, {
        idempotencyKey: 'command:cancel',
        kind: terminal ? 'run.cancelled' : 'run.cancellation_requested',
        now,
      });
      return this.getRunOrThrow(runId);
    });
    return transaction.immediate();
  }

  retryRun(
    runId: string,
    commandIdempotencyKey: string,
    now = new Date(),
  ): DurableAiRun | null {
    const commandKey = boundedIdentifier(
      commandIdempotencyKey,
      'retry idempotencyKey',
      300,
    );
    const transaction = sqlite.transaction(() => {
      const current = getInternalRunBy('id', runId);
      if (!current) return null;
      const existingEvent = sqlite.prepare(`
        SELECT 1 FROM ai_run_events
        WHERE run_id = ? AND idempotency_key = ?
      `).get(runId, `command:retry:${commandKey}`);
      if (existingEvent) return toPublicRun(current);
      if (!['failed', 'timed_out'].includes(current.status)) {
        throw new Error('Only failed or timed-out durable AI runs can be retried.');
      }
      if (current.cleanupStatus === 'running') {
        throw new Error(
          'The durable AI run cannot be retried while provider cleanup is running.',
        );
      }
      const nowIso = now.toISOString();
      const timeoutMs = positiveInteger(
        Number.parseInt(process.env.MC_AI_RUN_RETRY_TIMEOUT_MS ?? '', 10),
        DEFAULT_TIMEOUT_MS,
      );
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET status = 'queued',
            max_attempts = CASE
              WHEN attempt >= max_attempts THEN attempt + 1
              ELSE max_attempts
            END,
            available_at = ?,
            timeout_at = ?,
            completed_at = NULL,
            cancel_requested_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            cleanup_status = CASE
              WHEN cleanup_status = 'running' THEN cleanup_status
              ELSE 'none'
            END,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(
        nowIso,
        new Date(now.getTime() + timeoutMs).toISOString(),
        nowIso,
        runId,
        current.revision,
      );
      if (update.changes !== 1) {
        throw new Error(`Durable AI run ${runId} changed during retry.`);
      }
      addEvent(runId, {
        idempotencyKey: `command:retry:${commandKey}`,
        kind: 'run.retry_requested',
        payload: { previousStatus: current.status },
        now,
      });
      return this.getRunOrThrow(runId);
    });
    return transaction.immediate();
  }

  completeRun(
    runId: string,
    owner: string,
    outcome: DurableAiRunRouteOutcome = {},
    now = new Date(),
  ): DurableAiRun {
    return this.finishOwnedRun(runId, owner, 'succeeded', outcome, now);
  }

  cancelRun(runId: string, owner: string, now = new Date()): DurableAiRun {
    return this.finishOwnedRun(runId, owner, 'cancelled', {}, now);
  }

  timeOutRun(runId: string, owner: string, now = new Date()): DurableAiRun {
    return this.finishOwnedRun(
      runId,
      owner,
      'timed_out',
      {},
      now,
      'run_timeout',
      'The durable AI run exceeded its execution deadline.',
    );
  }

  failRun(
    runId: string,
    owner: string,
    error: unknown,
    options: {
      retryable?: boolean;
      code?: string;
      outcome?: DurableAiRunRouteOutcome;
      now?: Date;
    } = {},
  ): DurableAiRun {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const message = redactDurableAiText(
      error instanceof Error ? error.message : String(error),
    );
    const code = redactDurableAiText(options.code ?? 'provider_error', 100);
    const transaction = sqlite.transaction(() => {
      const current = getInternalRunBy('id', runId);
      if (
        !current
        || current.leaseOwner !== owner
        || !['running', 'cancelling'].includes(current.status)
        || !current.leaseExpiresAt
        || current.leaseExpiresAt <= nowIso
      ) {
        throw new Error(`Durable AI run ${runId} ownership was lost.`);
      }
      const retry = options.retryable !== false
        && current.status !== 'cancelling'
        && current.attempt < current.maxAttempts
        && current.timeoutAt > nowIso;
      if (!retry) {
        return this.finishOwnedRun(
          runId,
          owner,
          current.status === 'cancelling' ? 'cancelled' : 'failed',
          options.outcome ?? {},
          now,
          code,
          message,
        );
      }
      const retryBaseMs = positiveInteger(
        Number.parseInt(process.env.MC_AI_RUN_RETRY_BASE_MS ?? '', 10),
        5_000,
      );
      const availableAt = new Date(
        now.getTime() + Math.min(
          retryBaseMs * (2 ** Math.max(0, current.attempt - 1)),
          5 * 60_000,
        ),
      ).toISOString();
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET status = 'queued',
            available_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = ?,
            last_error_message = ?,
            provider = COALESCE(?, provider),
            model = COALESCE(?, model),
            fallback_state = COALESCE(?, fallback_state),
            updated_at = ?,
            revision = revision + 1
        WHERE id = ?
          AND revision = ?
          AND lease_owner = ?
          AND lease_expires_at > ?
      `).run(
        availableAt,
        code,
        message,
        options.outcome?.provider ?? null,
        options.outcome?.model ?? null,
        options.outcome?.fallbackState ?? null,
        nowIso,
        runId,
        current.revision,
        owner,
        nowIso,
      );
      if (update.changes !== 1) {
        throw new Error(`Durable AI run ${runId} ownership was lost.`);
      }
      addEvent(runId, {
        idempotencyKey: `run:attempt:${current.attempt}:retry`,
        kind: 'run.retry_scheduled',
        payload: { attempt: current.attempt, code, availableAt },
        now,
      });
      return this.getRunOrThrow(runId);
    });
    return transaction.immediate();
  }

  private finishOwnedRun(
    runId: string,
    owner: string,
    status: Extract<DurableAiRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>,
    outcome: DurableAiRunRouteOutcome,
    now: Date,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): DurableAiRun {
    const transaction = sqlite.transaction(() => {
      const current = getInternalRunBy('id', runId);
      if (
        !current
        || current.leaseOwner !== owner
        || !['running', 'cancelling'].includes(current.status)
        || !current.leaseExpiresAt
        || current.leaseExpiresAt <= now.toISOString()
      ) {
        throw new Error(`Durable AI run ${runId} ownership was lost.`);
      }
      const nowIso = now.toISOString();
      if (
        status === 'succeeded'
        && (current.status !== 'running' || current.cancelRequestedAt)
      ) {
        throw new Error(`Durable AI run ${runId} cancellation took precedence.`);
      }
      const effectiveStatus = status === 'timed_out' && current.status === 'cancelling'
        ? 'cancelled'
        : status;
      const effectiveErrorCode = effectiveStatus === status ? errorCode : null;
      const effectiveErrorMessage = effectiveStatus === status ? errorMessage : null;
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET status = ?,
            provider = COALESCE(?, provider),
            model = COALESCE(?, model),
            fallback_state = COALESCE(?, fallback_state),
            completed_at = ?,
            last_error_code = ?,
            last_error_message = ?,
            cleanup_status = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ?
          AND revision = ?
          AND lease_owner = ?
          AND lease_expires_at > ?
      `).run(
        effectiveStatus,
        outcome.provider?.trim() || null,
        outcome.model?.trim() || null,
        outcome.fallbackState ?? null,
        nowIso,
        effectiveErrorCode,
        effectiveErrorMessage,
        cleanupStatusForTerminal(runId, now),
        nowIso,
        runId,
        current.revision,
        owner,
        nowIso,
      );
      if (update.changes !== 1) {
        throw new Error(`Durable AI run ${runId} ownership was lost.`);
      }
      addEvent(runId, {
        idempotencyKey:
          `run:terminal:${effectiveStatus}:attempt:${current.attempt}`,
        kind: `run.${effectiveStatus}`,
        payload: {
          attempt: current.attempt,
          ...(effectiveErrorCode
            ? {
                error: {
                  code: effectiveErrorCode,
                  message: effectiveErrorMessage,
                },
              }
            : {}),
        },
        now,
      });
      return this.getRunOrThrow(runId);
    });
    return transaction.immediate();
  }

  private markTerminalInTransaction(
    runId: string,
    status: Extract<DurableAiRunStatus, 'failed' | 'timed_out'>,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): void {
    const nowIso = now.toISOString();
    const current = getInternalRunBy('id', runId);
    if (!current) return;
    sqlite.prepare(`
      UPDATE ai_runs
      SET status = ?,
          completed_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          cleanup_status = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          revision = revision + 1
      WHERE id = ? AND status IN ('queued', 'running', 'cancelling')
    `).run(
      status,
      nowIso,
      errorCode,
      redactDurableAiText(errorMessage),
      cleanupStatusForTerminal(runId, now),
      nowIso,
      runId,
    );
    addEvent(runId, {
      idempotencyKey:
        `run:terminal:${status}:attempt:${current.attempt}:revision:${current.revision}`,
      kind: `run.${status}`,
      payload: { error: { code: errorCode, message: errorMessage } },
      now,
    });
  }

  private expireTimedOutQueuedRunsInTransaction(now: Date): number {
    const nowIso = now.toISOString();
    const expired = sqlite.prepare(`
      SELECT id
      FROM ai_runs
      WHERE status = 'queued' AND timeout_at <= ?
    `).all(nowIso) as Array<{ id: string }>;
    for (const run of expired) {
      this.markTerminalInTransaction(
        run.id,
        'timed_out',
        'run_timeout',
        'The durable AI run exceeded its execution deadline before it was claimed.',
        now,
      );
    }
    return expired.length;
  }

  expireTimedOutQueuedRuns(now = new Date()): number {
    const transaction = sqlite.transaction(() =>
      this.expireTimedOutQueuedRunsInTransaction(now));
    return transaction.immediate();
  }

  recoverExpiredRuns(
    now = new Date(),
    routes?: readonly string[],
  ): number {
    if (routes && routes.length === 0) return 0;
    const nowIso = now.toISOString();
    const routeCondition = routes
      ? `AND execution_route IN (${routes.map(() => '?').join(', ')})`
      : '';
    const transaction = sqlite.transaction(() => {
      const expired = sqlite.prepare(`
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        WHERE status IN ('running', 'cancelling')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
          ${routeCondition}
      `).all(nowIso, ...(routes ?? [])) as AiRunDatabaseRow[];
      for (const row of expired) {
        const run = deserializeInternalRun(row);
        if (run.status === 'cancelling') {
          this.markTerminalInTransaction(
            run.id,
            'failed',
            'cancellation_owner_lost',
            'Cancellation could not be confirmed after the worker lease expired.',
            now,
          );
        } else if (run.timeoutAt <= nowIso) {
          this.markTerminalInTransaction(
            run.id,
            'timed_out',
            'run_timeout',
            'The durable AI run exceeded its execution deadline.',
            now,
          );
        } else if (run.attempt < run.maxAttempts) {
          sqlite.prepare(`
            UPDATE ai_runs
            SET status = 'queued',
                available_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = 'worker_lease_expired',
                last_error_message = 'The worker lease expired; execution will resume.',
                updated_at = ?,
                revision = revision + 1
            WHERE id = ? AND revision = ?
          `).run(nowIso, nowIso, run.id, run.revision);
          addEvent(run.id, {
            idempotencyKey: `run:attempt:${run.attempt}:lease-expired`,
            kind: 'run.recovered',
            payload: { attempt: run.attempt },
            now,
          });
        } else {
          this.markTerminalInTransaction(
            run.id,
            'failed',
            'worker_lease_expired',
            'The worker lease expired after the final attempt.',
            now,
          );
        }
      }
      return expired.length;
    });
    return transaction.immediate();
  }

  setProviderSession(
    runId: string,
    provider: string,
    reference: string,
    options: { expiresAt?: Date; now?: Date } = {},
  ): ProtectedProviderSession {
    const transaction = sqlite.transaction(() =>
      this.setProviderSessionInTransaction(runId, provider, reference, options));
    return transaction.immediate();
  }

  setProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    provider: string,
    reference: string,
    options: { expiresAt?: Date; now?: Date } = {},
  ): ProtectedProviderSession {
    const now = options.now ?? new Date();
    const transaction = sqlite.transaction(() => {
      this.assertOwnedClaim(runId, owner, attempt, now);
      return this.setProviderSessionInTransaction(
        runId,
        provider,
        reference,
        options.expiresAt ? { expiresAt: options.expiresAt, now } : { now },
      );
    });
    return transaction.immediate();
  }

  private setProviderSessionInTransaction(
    runId: string,
    provider: string,
    reference: string,
    options: { expiresAt?: Date; now?: Date } = {},
  ): ProtectedProviderSession {
    const current = getInternalRunBy('id', runId);
    if (!current) throw new Error(`Durable AI run ${runId} was not found.`);
    const normalizedProvider = boundedIdentifier(provider, 'provider');
    const normalizedReference = boundedIdentifier(
      reference,
      'provider session reference',
      2_000,
    );
    const now = options.now ?? new Date();
    const requestedExpiry = options.expiresAt?.getTime()
      ?? now.getTime() + DEFAULT_PROVIDER_SESSION_TTL_MS;
    const expiresAt = new Date(Math.min(
      requestedExpiry,
      Date.parse(current.expiresAt),
      now.getTime() + DEFAULT_PROVIDER_SESSION_TTL_MS,
    ));
    if (expiresAt.getTime() <= now.getTime()) {
      throw new Error('Provider session expiry must be in the future.');
    }
    const protector = this.sessionProtectorFactory();
    const protectedReference = protector.encrypt(
      runId,
      normalizedProvider,
      normalizedReference,
    );
    const existing = this.getProviderSession(runId, now);
    if (existing) {
      if (
        existing.provider !== normalizedProvider
        || existing.reference !== normalizedReference
      ) {
        throw new Error(
          `Durable AI run ${runId} already owns a different provider session.`,
        );
      }
      return existing;
    }
    const nowIso = now.toISOString();
    const write = sqlite.prepare(`
      INSERT INTO ai_provider_sessions (
        run_id, provider, encrypted_reference, initialization_vector,
        auth_tag, key_version, state, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        provider = excluded.provider,
        encrypted_reference = excluded.encrypted_reference,
        initialization_vector = excluded.initialization_vector,
        auth_tag = excluded.auth_tag,
        key_version = excluded.key_version,
        state = 'active',
        expires_at = excluded.expires_at,
        revoked_at = NULL,
        updated_at = excluded.updated_at
      WHERE ai_provider_sessions.state = 'revoked'
         OR ai_provider_sessions.expires_at <= ?
    `).run(
      runId,
      normalizedProvider,
      protectedReference.encryptedReference,
      protectedReference.initializationVector,
      protectedReference.authTag,
      protectedReference.keyVersion,
      expiresAt.toISOString(),
      nowIso,
      nowIso,
      nowIso,
    );
    if (write.changes !== 1) {
      throw new Error(
        `Durable AI run ${runId} already owns a different provider session.`,
      );
    }
    return {
      provider: normalizedProvider,
      reference: normalizedReference,
      expiresAt: expiresAt.toISOString(),
    };
  }

  getProviderSession(
    runId: string,
    now = new Date(),
  ): ProtectedProviderSession | null {
    const row = sqlite.prepare(`
      SELECT
        provider,
        encrypted_reference AS encryptedReference,
        initialization_vector AS initializationVector,
        auth_tag AS authTag,
        key_version AS keyVersion,
        state,
        expires_at AS expiresAt
      FROM ai_provider_sessions
      WHERE run_id = ?
    `).get(runId) as ProviderSessionDatabaseRow | undefined;
    if (!row || row.state !== 'active' || row.expiresAt <= now.toISOString()) {
      return null;
    }
    return {
      provider: row.provider,
      reference: this.sessionProtectorFactory().decrypt(runId, row.provider, row),
      expiresAt: row.expiresAt,
    };
  }

  getProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now = new Date(),
  ): ProtectedProviderSession | null {
    const transaction = sqlite.transaction(() => {
      this.assertOwnedClaim(runId, owner, attempt, now);
      return this.getProviderSession(runId, now);
    });
    return transaction.immediate();
  }

  revokeProviderSession(runId: string, now = new Date()): boolean {
    const nowIso = now.toISOString();
    return sqlite.prepare(`
      UPDATE ai_provider_sessions
      SET state = 'revoked',
          encrypted_reference = '',
          initialization_vector = '',
          auth_tag = '',
          revoked_at = ?,
          updated_at = ?
      WHERE run_id = ? AND state = 'active'
    `).run(nowIso, nowIso, runId).changes === 1;
  }

  revokeProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now = new Date(),
  ): boolean {
    const transaction = sqlite.transaction(() => {
      this.assertOwnedClaim(runId, owner, attempt, now);
      return this.revokeProviderSession(runId, now);
    });
    return transaction.immediate();
  }

  claimCleanup(
    owner: string,
    routes: readonly string[],
    leaseMs = 120_000,
    now = new Date(),
  ): ClaimedDurableAiRun | null {
    if (routes.length === 0) return null;
    const nowIso = now.toISOString();
    const placeholders = routes.map(() => '?').join(', ');
    const transaction = sqlite.transaction(() => {
      const candidate = sqlite.prepare(`
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        WHERE cleanup_status IN ('pending', 'failed', 'running')
          AND execution_route IN (${placeholders})
          AND available_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY updated_at ASC
        LIMIT 1
      `).get(...routes, nowIso, nowIso) as AiRunDatabaseRow | undefined;
      if (!candidate) return null;
      const leaseExpiresAt = new Date(
        now.getTime() + positiveInteger(leaseMs, 120_000),
      ).toISOString();
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET cleanup_status = 'running',
            lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(owner, leaseExpiresAt, nowIso, candidate.id, candidate.revision);
      if (update.changes !== 1) return null;
      addEvent(candidate.id, {
        idempotencyKey: `cleanup:started:${candidate.revision + 1}`,
        kind: 'run.cleanup_started',
        now,
      });
      const claimed = getInternalRunBy('id', candidate.id);
      if (!claimed?.leaseOwner || !claimed.leaseExpiresAt) return null;
      return {
        ...toPublicRun(claimed),
        leaseOwner: claimed.leaseOwner,
        leaseExpiresAt: claimed.leaseExpiresAt,
        traceparent: claimed.traceparent,
        tracestate: claimed.tracestate,
      };
    });
    return transaction.immediate();
  }

  renewCleanupLease(
    runId: string,
    owner: string,
    leaseMs = 120_000,
    now = new Date(),
  ): boolean {
    const leaseExpiresAt = new Date(
      now.getTime() + positiveInteger(leaseMs, 120_000),
    ).toISOString();
    return sqlite.prepare(`
      UPDATE ai_runs
      SET lease_expires_at = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE id = ?
        AND cleanup_status = 'running'
        AND lease_owner = ?
        AND lease_expires_at > ?
    `).run(
      leaseExpiresAt,
      now.toISOString(),
      runId,
      owner,
      now.toISOString(),
    ).changes === 1;
  }

  finishCleanup(
    runId: string,
    owner: string,
    error?: unknown,
    now = new Date(),
  ): DurableAiRun {
    const current = getInternalRunBy('id', runId);
    if (
      !current
      || current.cleanupStatus !== 'running'
      || current.leaseOwner !== owner
      || !current.leaseExpiresAt
      || current.leaseExpiresAt <= now.toISOString()
    ) {
      throw new Error(`Durable AI run ${runId} cleanup ownership was lost.`);
    }
    const nowIso = now.toISOString();
    const failed = error !== undefined;
    const message = failed
      ? redactDurableAiText(error instanceof Error ? error.message : String(error))
      : null;
    const transaction = sqlite.transaction(() => {
      const update = sqlite.prepare(`
        UPDATE ai_runs
        SET cleanup_status = ?,
            last_error_code = CASE
              WHEN ? THEN 'provider_cleanup_failed'
              ELSE last_error_code
            END,
            last_error_message = CASE
              WHEN ? THEN ?
              ELSE last_error_message
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            available_at = CASE
              WHEN ? THEN ?
              ELSE available_at
            END,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ?
          AND revision = ?
          AND lease_owner = ?
          AND lease_expires_at > ?
      `).run(
        failed ? 'failed' : 'completed',
        failed ? 1 : 0,
        failed ? 1 : 0,
        message,
        failed ? 1 : 0,
        new Date(now.getTime() + 5 * 60_000).toISOString(),
        nowIso,
        runId,
        current.revision,
        owner,
        nowIso,
      );
      if (update.changes !== 1) {
        throw new Error(`Durable AI run ${runId} cleanup ownership was lost.`);
      }
      if (!failed) this.revokeProviderSession(runId, now);
      addEvent(runId, {
        idempotencyKey: `cleanup:${failed ? 'failed' : 'completed'}:${current.revision + 1}`,
        kind: failed ? 'run.cleanup_failed' : 'run.cleanup_completed',
        payload: failed ? { error: { message } } : {},
        now,
      });
      return this.getRunOrThrow(runId);
    });
    return transaction.immediate();
  }

  initializeExecutionState(
    runId: string,
    state: Record<string, unknown>,
    options: {
      expectedRevision: number;
      status?: DurableAiRunStatus;
      traceparent?: string;
      tracestate?: string;
      owner?: string;
      leaseExpiresAt?: string;
      providerSession?: {
        provider: string;
        reference: string;
        expiresAt?: Date;
      };
      now?: Date;
    },
  ): boolean {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const transaction = sqlite.transaction(() => {
      const updated = sqlite.prepare(`
        UPDATE ai_runs
        SET execution_state = ?,
            status = COALESCE(?, status),
            traceparent = COALESCE(?, traceparent),
            tracestate = COALESCE(?, tracestate),
            lease_owner = COALESCE(?, lease_owner),
            lease_expires_at = COALESCE(?, lease_expires_at),
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND revision = ? AND execution_state IS NULL
      `).run(
        JSON.stringify(sanitizeDurableAiState(state)),
        options.status ?? null,
        options.traceparent ?? null,
        options.tracestate ?? null,
        options.owner ?? null,
        options.leaseExpiresAt ?? null,
        nowIso,
        runId,
        options.expectedRevision,
      ).changes === 1;
      if (updated && options.providerSession) {
        this.setProviderSessionInTransaction(
          runId,
          options.providerSession.provider,
          options.providerSession.reference,
          options.providerSession.expiresAt
            ? { expiresAt: options.providerSession.expiresAt, now }
            : { now },
        );
      }
      return updated;
    });
    return transaction.immediate();
  }

  compareAndSetExecutionState(
    runId: string,
    expectedRevision: number,
    state: Record<string, unknown>,
    options: {
      status?: DurableAiRunStatus;
      traceparent?: string;
      tracestate?: string;
      owner?: string | null;
      leaseExpiresAt?: string | null;
      completedAt?: string | null;
      cleanupStatus?: DurableAiRun['cleanupStatus'];
      provider?: string;
      model?: string;
      fallbackState?: DurableAiRunFallbackState;
      providerSession?: {
        provider: string;
        reference: string;
        expiresAt?: Date;
      };
      revokeProviderSession?: boolean;
      allowedCurrentStatuses?: readonly DurableAiRunStatus[];
      cancellation?: 'absent' | 'requested';
      requiredLeaseOwner?: string;
      leaseState?: 'active' | 'expired';
      now?: Date;
    } = {},
  ): boolean {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const transaction = sqlite.transaction(() => {
      const conditions = ['id = ?', 'revision = ?'];
      const conditionValues: Array<string | number> = [runId, expectedRevision];
      if (options.allowedCurrentStatuses?.length) {
        conditions.push(
          `status IN (${options.allowedCurrentStatuses.map(() => '?').join(', ')})`,
        );
        conditionValues.push(...options.allowedCurrentStatuses);
      }
      if (options.cancellation === 'absent') {
        conditions.push('cancel_requested_at IS NULL');
      } else if (options.cancellation === 'requested') {
        conditions.push('cancel_requested_at IS NOT NULL');
      }
      if (options.requiredLeaseOwner) {
        conditions.push('lease_owner = ?');
        conditionValues.push(options.requiredLeaseOwner);
      }
      if (options.leaseState === 'active') {
        conditions.push('lease_expires_at > ?');
        conditionValues.push(nowIso);
      } else if (options.leaseState === 'expired') {
        conditions.push('lease_expires_at <= ?');
        conditionValues.push(nowIso);
      }
      const updated = sqlite.prepare(`
        UPDATE ai_runs
        SET execution_state = ?,
            status = COALESCE(?, status),
            traceparent = COALESCE(?, traceparent),
            tracestate = COALESCE(?, tracestate),
            lease_owner = ?,
            lease_expires_at = ?,
            completed_at = COALESCE(?, completed_at),
            cleanup_status = COALESCE(?, cleanup_status),
            provider = COALESCE(?, provider),
            model = COALESCE(?, model),
            fallback_state = COALESCE(?, fallback_state),
            updated_at = ?,
            revision = revision + 1
        WHERE ${conditions.join(' AND ')}
      `).run(
        JSON.stringify(sanitizeDurableAiState(state)),
        options.status ?? null,
        options.traceparent ?? null,
        options.tracestate ?? null,
        options.owner ?? null,
        options.leaseExpiresAt ?? null,
        options.completedAt ?? null,
        options.cleanupStatus ?? null,
        options.provider ?? null,
        options.model ?? null,
        options.fallbackState ?? null,
        nowIso,
        ...conditionValues,
      ).changes === 1;
      if (!updated) return false;
      if (options.providerSession) {
        this.setProviderSessionInTransaction(
          runId,
          options.providerSession.provider,
          options.providerSession.reference,
          options.providerSession.expiresAt
            ? { expiresAt: options.providerSession.expiresAt, now }
            : { now },
        );
      }
      if (options.revokeProviderSession) {
        this.revokeProviderSession(runId, now);
      }
      return true;
    });
    return transaction.immediate();
  }

  pruneExpired(now = new Date()): DurableAiRunRetentionResult {
    const nowIso = now.toISOString();
    const transaction = sqlite.transaction(() => {
      this.expireTimedOutQueuedRunsInTransaction(now);
      const revokedProviderSessions = sqlite.prepare(`
        UPDATE ai_provider_sessions
        SET state = 'revoked',
            encrypted_reference = '',
            initialization_vector = '',
            auth_tag = '',
            revoked_at = ?,
            updated_at = ?
        WHERE state = 'active' AND expires_at <= ?
      `).run(nowIso, nowIso, nowIso).changes;
      const deletedRuns = sqlite.prepare(`
        DELETE FROM ai_runs
        WHERE status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
          AND expires_at <= ?
      `).run(nowIso).changes;
      return { deletedRuns, revokedProviderSessions };
    });
    return transaction.immediate();
  }
}
