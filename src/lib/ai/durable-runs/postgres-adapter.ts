import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
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
  type DurableAiRunHistoryFilter,
  type DurableAiRunRetentionResult,
  type DurableAiRunRouteOutcome,
  type DurableAiRunStatus,
  type ProtectedProviderSession,
} from './types';
import type {
  DurableAiRunCompareAndSetOptions,
  DurableAiRunFailureOptions,
  DurableAiRunInitializeStateOptions,
  DurableAiRunRepository,
  InternalDurableAiRun,
  ProviderSessionWriteOptions,
} from './repository';

/**
 * PostgreSQL adapter for the durable AI run persistence contract.
 *
 * The SQLite adapter relies on `better-sqlite3`'s whole-database `IMMEDIATE`
 * transactions for atomicity, which serializes every writer. PostgreSQL has no
 * such global writer lock, so each externally observable operation here runs in
 * an explicit transaction that
 *
 *  - takes a `FOR UPDATE` row lock on the owning `ai_runs` row before any
 *    read-then-write sequence (this both serializes event-sequence allocation
 *    per run and makes the optimistic `revision` compare-and-set exact),
 *  - claims queue work with `FOR UPDATE SKIP LOCKED` so concurrent workers
 *    never hand the same run to two owners and never block on each other, and
 *  - keeps a single lock order (`ai_runs` → `ai_run_events` →
 *    `ai_provider_sessions`) so cleanup, retention, and execution paths cannot
 *    deadlock against each other.
 *
 * Every mutation stays fenced by run id, lease owner, attempt, and expected
 * revision exactly like the SQLite adapter, and all events commit atomically
 * with the run-state change that produced them. This module never imports or
 * evaluates any SQLite code path.
 */

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
  fallbackState: DurableAiRun['fallbackState'];
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
  notifyOnCompletion: boolean;
  cleanupStatus: DurableAiRun['cleanupStatus'];
  executionState: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface AiRunEventDatabaseRow {
  cursor: number;
  eventId: string;
  runId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
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

type DurableAiRunClient = Pool | PoolClient;

const RUN_COLUMNS = `
  id,
  idempotency_key AS "idempotencyKey",
  request_fingerprint AS "requestFingerprint",
  feature_id AS "featureId",
  sensitivity,
  status,
  execution_route AS "executionRoute",
  requested_provider AS "requestedProvider",
  requested_model AS "requestedModel",
  provider,
  model,
  fallback_state AS "fallbackState",
  correlation_id AS "correlationId",
  traceparent,
  tracestate,
  attempt,
  max_attempts AS "maxAttempts",
  available_at AS "availableAt",
  timeout_at AS "timeoutAt",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  cancel_requested_at AS "cancelRequestedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  last_error_code AS "lastErrorCode",
  last_error_message AS "lastErrorMessage",
  notify_on_completion AS "notifyOnCompletion",
  cleanup_status AS "cleanupStatus",
  execution_state AS "executionState",
  revision,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  expires_at AS "expiresAt"
`;

const EVENT_COLUMNS = `
  id AS cursor,
  event_id AS "eventId",
  run_id AS "runId",
  sequence,
  kind,
  payload,
  created_at AS "createdAt"
`;

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_PROVIDER_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETENTION_DAYS = {
  standard: 30,
  restricted: 7,
  'local-only': 1,
} as const;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const OWNED_CLAIM_STATUSES: readonly DurableAiRunStatus[] = ['running', 'cancelling'];

export function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function boundedIdentifier(
  value: string,
  field: string,
  maxLength = 200,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `execution_state` is `jsonb`, so `pg` already deserializes it. Older rows
 * imported from the SQLite backend can still arrive as JSON text, which is
 * parsed here rather than silently discarded.
 */
export function normalizeDurableAiExecutionState(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  }
  return isPlainRecord(value) ? value : null;
}

export function deserializeInternalDurableAiRun(
  row: AiRunDatabaseRow,
): InternalDurableAiRun {
  return {
    ...row,
    notifyOnCompletion: row.notifyOnCompletion === true,
    executionState: normalizeDurableAiExecutionState(row.executionState),
  };
}

export function toPublicDurableAiRun(run: InternalDurableAiRun): DurableAiRun {
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

function toClaimedRun(run: InternalDurableAiRun): ClaimedDurableAiRun | null {
  if (!run.leaseOwner || !run.leaseExpiresAt) return null;
  return {
    ...toPublicDurableAiRun(run),
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: run.leaseExpiresAt,
    traceparent: run.traceparent,
    tracestate: run.tracestate,
  };
}

export function durableAiRequestFingerprint(input: CreateDurableAiRunInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.featureId.trim(),
    input.sensitivity,
    input.executionRoute.trim(),
    input.requestedProvider?.trim() || null,
    input.requestedModel?.trim() || null,
  ])).digest('hex');
}

export function durableAiRetentionDays(
  sensitivity: DurableAiRun['sensitivity'],
): number {
  const configured = Number.parseInt(
    process.env[`MC_AI_RUN_RETENTION_DAYS_${sensitivity.replace('-', '_').toUpperCase()}`]
      ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_DAYS[sensitivity];
}

export function resolveDurableAiTraceparent(value: string | undefined): string {
  if (!value) {
    return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  }
  const normalized = value.trim().toLowerCase();
  if (!TRACEPARENT_PATTERN.test(normalized)) {
    throw new TypeError('traceparent must use the W3C version 00 format.');
  }
  return normalized;
}

/**
 * Exponential retry backoff for a failed attempt, capped at five minutes —
 * the same schedule the SQLite adapter applies.
 */
export function computeDurableAiRetryAvailableAt(
  now: Date,
  attempt: number,
  retryBaseMs = positiveInteger(
    Number.parseInt(process.env.MC_AI_RUN_RETRY_BASE_MS ?? '', 10),
    5_000,
  ),
): string {
  return new Date(now.getTime() + Math.min(
    retryBaseMs * (2 ** Math.max(0, attempt - 1)),
    5 * 60_000,
  )).toISOString();
}

/**
 * Builds the parameterized `WHERE` fragment for `listRuns`, starting at
 * `startIndex`. Pure and unit-testable without a database.
 */
export function buildDurableAiRunHistoryConditions(
  filter: DurableAiRunHistoryFilter,
  startIndex: number,
): { clause: string; params: Array<string> } {
  const conditions: string[] = [];
  const params: string[] = [];
  const push = (value: string): string => {
    params.push(value);
    return `$${startIndex + params.length - 1}`;
  };
  if (filter.status) conditions.push(`status = ${push(filter.status)}`);
  if (filter.featureId) conditions.push(`feature_id = ${push(filter.featureId)}`);
  if (filter.before) {
    const separator = filter.before.indexOf('|');
    if (separator > 0) {
      const createdAt = filter.before.slice(0, separator);
      const id = filter.before.slice(separator + 1);
      conditions.push(
        `(created_at < ${push(createdAt)} OR (created_at = ${push(createdAt)} `
        + `AND id < ${push(id)}))`,
      );
    } else {
      conditions.push(`created_at < ${push(filter.before)}`);
    }
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Builds the fencing predicate for `compareAndSetExecutionState`. The run id
 * and expected revision are always required; the optional guards mirror the
 * SQLite adapter one-for-one.
 */
export function buildDurableAiCompareAndSetConditions(
  runId: string,
  expectedRevision: number,
  options: DurableAiRunCompareAndSetOptions,
  nowIso: string,
  startIndex: number,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${startIndex + params.length - 1}`;
  };
  const conditions = [`id = ${push(runId)}`, `revision = ${push(expectedRevision)}`];
  if (options.allowedCurrentStatuses?.length) {
    conditions.push(`status = ANY(${push([...options.allowedCurrentStatuses])}::text[])`);
  }
  if (options.cancellation === 'absent') {
    conditions.push('cancel_requested_at IS NULL');
  } else if (options.cancellation === 'requested') {
    conditions.push('cancel_requested_at IS NOT NULL');
  }
  if (options.requiredLeaseOwner) {
    conditions.push(`lease_owner = ${push(options.requiredLeaseOwner)}`);
  }
  if (options.requiredAttempt !== undefined) {
    conditions.push(`attempt = ${push(options.requiredAttempt)}`);
  }
  if (options.leaseState === 'active') {
    conditions.push(`lease_expires_at > ${push(nowIso)}`);
  } else if (options.leaseState === 'expired') {
    conditions.push(`lease_expires_at <= ${push(nowIso)}`);
  }
  return { clause: conditions.join(' AND '), params };
}

async function query<T>(
  client: DurableAiRunClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows as T[];
}

async function execute(
  client: DurableAiRunClient,
  text: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await client.query(text, params);
  return result.rowCount ?? 0;
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
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Surface both failures: a rollback that cannot be issued (a broken
        // connection, for example) must never hide the error that aborted the
        // durable AI run transaction in the first place.
        throw new AggregateError(
          [error, rollbackError],
          'The durable AI run transaction failed and could not be rolled back.',
        );
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

export class PostgresDurableAiRunRepository implements DurableAiRunRepository {
  constructor(
    private readonly pool: Pool,
    private readonly sessionProtectorFactory:
      () => ProviderSessionProtector = ProviderSessionProtector.fromEnvironment,
  ) {}

  // ─── Run reads ──────────────────────────────────────────────────────────

  private async readRun(
    client: DurableAiRunClient,
    column: 'id' | 'idempotency_key',
    value: string,
  ): Promise<InternalDurableAiRun | null> {
    const [row] = await query<AiRunDatabaseRow>(
      client,
      `SELECT ${RUN_COLUMNS} FROM ai_runs WHERE ${column} = $1`,
      [value],
    );
    return row ? deserializeInternalDurableAiRun(row) : null;
  }

  /**
   * Takes the per-run write lock that replaces SQLite's whole-database
   * `IMMEDIATE` transaction. Every read-then-write sequence, and every event
   * sequence allocation, happens while holding it.
   */
  private async lockRun(
    client: PoolClient,
    runId: string,
  ): Promise<InternalDurableAiRun | null> {
    const [row] = await query<AiRunDatabaseRow>(
      client,
      `SELECT ${RUN_COLUMNS} FROM ai_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    return row ? deserializeInternalDurableAiRun(row) : null;
  }

  private async getRunOrThrow(
    client: DurableAiRunClient,
    runId: string,
  ): Promise<DurableAiRun> {
    const run = await this.readRun(client, 'id', runId);
    if (!run) throw new Error(`Durable AI run ${runId} was not found.`);
    return toPublicDurableAiRun(run);
  }

  async getRun(runId: string): Promise<DurableAiRun | null> {
    const run = await this.readRun(this.pool, 'id', runId);
    return run ? toPublicDurableAiRun(run) : null;
  }

  async getInternalRun(runId: string): Promise<InternalDurableAiRun | null> {
    return this.readRun(this.pool, 'id', runId);
  }

  async listInternalRunsByRoute(
    executionRoute: string,
  ): Promise<InternalDurableAiRun[]> {
    const rows = await query<AiRunDatabaseRow>(
      this.pool,
      `
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        WHERE execution_route = $1
        ORDER BY created_at DESC, id DESC
      `,
      [executionRoute],
    );
    return rows.map(deserializeInternalDurableAiRun);
  }

  async listRuns(filter: DurableAiRunHistoryFilter = {}): Promise<DurableAiRun[]> {
    const { clause, params } = buildDurableAiRunHistoryConditions(filter, 1);
    const limit = Math.min(100, positiveInteger(filter.limit, 25));
    const rows = await query<AiRunDatabaseRow>(
      this.pool,
      `
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1}
      `,
      [...params, limit],
    );
    return rows.map((row) => toPublicDurableAiRun(deserializeInternalDurableAiRun(row)));
  }

  // ─── Run creation ───────────────────────────────────────────────────────

  async createRun(input: CreateDurableAiRunInput): Promise<{
    run: DurableAiRun;
    created: boolean;
  }> {
    const idempotencyKey = boundedIdentifier(
      input.idempotencyKey,
      'idempotencyKey',
      300,
    );
    const fingerprint = durableAiRequestFingerprint(input);
    return withTransaction(this.pool, async (client) => {
      // Serialize concurrent creations for the same idempotency key. Without
      // it, two transactions could both observe "no existing run" and race on
      // the unique idempotency index, turning a graceful de-duplication into
      // an unhandled unique violation. Released at transaction end.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);

      const existing = await this.readRun(client, 'idempotency_key', idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new Error(
            'The durable AI run idempotency key is already bound to a different request.',
          );
        }
        return { run: toPublicDurableAiRun(existing), created: false };
      }

      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const timeoutMs = positiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
      const expiresAt = new Date(
        now.getTime() + durableAiRetentionDays(input.sensitivity) * 24 * 60 * 60_000,
      ).toISOString();
      const runId = input.id ?? randomUUID();
      const correlationId = input.correlationId?.trim() || runId;
      const maxAttempts = positiveInteger(input.maxAttempts, 3);

      await client.query(
        `
          INSERT INTO ai_runs (
            id, idempotency_key, request_fingerprint, feature_id, sensitivity,
            status, execution_route, requested_provider, requested_model,
            fallback_state, correlation_id, traceparent, tracestate, attempt,
            max_attempts, available_at, timeout_at, notify_on_completion,
            cleanup_status, revision, created_at, updated_at, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'queued', $6, $7, $8, 'not_requested', $9, $10,
            $11, 0, $12, $13, $14, $15, 'none', 0, $13, $13, $16
          )
        `,
        [
          boundedIdentifier(runId, 'run id', 200),
          idempotencyKey,
          fingerprint,
          boundedIdentifier(input.featureId, 'featureId'),
          input.sensitivity,
          boundedIdentifier(input.executionRoute, 'executionRoute'),
          input.requestedProvider?.trim() || null,
          input.requestedModel?.trim() || null,
          boundedIdentifier(correlationId, 'correlationId', 300),
          resolveDurableAiTraceparent(input.traceparent),
          input.tracestate?.trim() || null,
          maxAttempts,
          nowIso,
          new Date(now.getTime() + timeoutMs).toISOString(),
          input.notifyOnCompletion === true,
          expiresAt,
        ],
      );
      await this.addEvent(client, runId, {
        idempotencyKey: 'run:queued',
        kind: 'run.queued',
        payload: {
          featureId: input.featureId,
          executionRoute: input.executionRoute,
        },
        now,
      });
      return { run: await this.getRunOrThrow(client, runId), created: true };
    });
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  /**
   * Appends one event. The caller must already hold the `ai_runs` row lock for
   * `runId`: that lock is what makes the `MAX(sequence) + 1` allocation
   * concurrency-safe and makes the idempotency probe below race-free, so the
   * insert can never collide on `(run_id, sequence)` or `(run_id,
   * idempotency_key)`.
   */
  private async addEvent(
    client: PoolClient,
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): Promise<AddedDurableAiRunEvent> {
    const idempotencyKey = boundedIdentifier(
      input.idempotencyKey,
      'event idempotencyKey',
      300,
    );
    const [existing] = await query<AiRunEventDatabaseRow>(
      client,
      `
        SELECT ${EVENT_COLUMNS}
        FROM ai_run_events
        WHERE run_id = $1 AND idempotency_key = $2
      `,
      [runId, idempotencyKey],
    );
    if (existing) return { event: { ...existing }, inserted: false };

    const [{ sequence }] = await query<{ sequence: number }>(
      client,
      `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM ai_run_events
        WHERE run_id = $1
      `,
      [runId],
    );
    const eventId = input.eventId ?? randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    const payload = sanitizeDurableAiEventPayload(input.kind, input.payload);
    const [inserted] = await query<{ cursor: number }>(
      client,
      `
        INSERT INTO ai_run_events (
          event_id, run_id, sequence, idempotency_key, kind, payload, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING id AS cursor
      `,
      [
        eventId,
        runId,
        sequence,
        idempotencyKey,
        boundedIdentifier(input.kind, 'event kind', 120),
        JSON.stringify(payload),
        createdAt,
      ],
    );
    return {
      event: {
        cursor: inserted.cursor,
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

  async getEventsAfter(
    runId: string,
    cursor = 0,
    limit = 100,
  ): Promise<DurableAiRunEvent[]> {
    const rows = await query<AiRunEventDatabaseRow>(
      this.pool,
      `
        SELECT ${EVENT_COLUMNS}
        FROM ai_run_events
        WHERE run_id = $1 AND id > $2
        ORDER BY id ASC
        LIMIT $3
      `,
      [
        runId,
        Math.max(0, cursor),
        Math.min(1_000, positiveInteger(limit, 100)),
      ],
    );
    return rows.map((row) => ({ ...row }));
  }

  async getEventIdempotencyKeys(runId: string): Promise<string[]> {
    const rows = await query<{ idempotencyKey: string }>(
      this.pool,
      `
        SELECT idempotency_key AS "idempotencyKey"
        FROM ai_run_events
        WHERE run_id = $1
        ORDER BY id ASC
      `,
      [runId],
    );
    return rows.map((row) => row.idempotencyKey);
  }

  private async appendEventWithClient(
    client: PoolClient,
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): Promise<DurableAiRunEvent> {
    const run = await this.lockRun(client, runId);
    if (!run) throw new Error(`Durable AI run ${runId} was not found.`);
    const added = await this.addEvent(client, runId, input);
    if (added.inserted && (input.provider || input.model || input.fallbackState)) {
      await client.query(
        `
          UPDATE ai_runs
          SET provider = COALESCE($1::text, provider),
              model = COALESCE($2::text, model),
              fallback_state = COALESCE($3::text, fallback_state),
              updated_at = $4,
              revision = revision + 1
          WHERE id = $5
        `,
        [
          input.provider?.trim() || null,
          input.model?.trim() || null,
          input.fallbackState ?? null,
          (input.now ?? new Date()).toISOString(),
          runId,
        ],
      );
    }
    return added.event;
  }

  async appendEvent(
    runId: string,
    input: AppendDurableAiRunEventInput,
  ): Promise<DurableAiRunEvent> {
    return withTransaction(
      this.pool,
      (client) => this.appendEventWithClient(client, runId, input),
    );
  }

  async appendEventForClaim(
    runId: string,
    owner: string,
    attempt: number,
    input: AppendDurableAiRunEventInput,
  ): Promise<DurableAiRunEvent> {
    const now = input.now ?? new Date();
    return withTransaction(this.pool, async (client) => {
      await this.assertOwnedClaim(client, runId, owner, attempt, now);
      return this.appendEventWithClient(client, runId, { ...input, now });
    });
  }

  async appendEventForExecutionOwner(
    runId: string,
    owner: string,
    input: AppendDurableAiRunEventInput,
    receivedAt = new Date(),
    attempt?: number,
  ): Promise<DurableAiRunEvent> {
    return withTransaction(this.pool, async (client) => {
      const run = await this.lockRun(client, runId);
      const executionState = run?.executionState;
      const executionStateName = typeof executionState?.state === 'string'
        ? executionState.state
        : null;
      if (
        !run
        || !executionState
        || executionState.ownerId !== owner
        || (
          attempt !== undefined
          && (
            run.attempt !== attempt
            || run.leaseOwner !== owner
            || !run.leaseExpiresAt
            || run.leaseExpiresAt <= receivedAt.toISOString()
          )
        )
        || (
          OWNED_CLAIM_STATUSES.includes(run.status)
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
      return this.appendEventWithClient(client, runId, input);
    });
  }

  /**
   * Fences an executor by run id, lease owner, attempt, and lease liveness.
   * The row lock is taken here so the caller's follow-up write cannot observe
   * a lease that expired or moved between the check and the write.
   */
  private async assertOwnedClaim(
    client: PoolClient,
    runId: string,
    owner: string,
    attempt: number,
    now: Date,
  ): Promise<InternalDurableAiRun> {
    const run = await this.lockRun(client, runId);
    if (
      !run
      || run.leaseOwner !== owner
      || run.attempt !== attempt
      || !OWNED_CLAIM_STATUSES.includes(run.status)
      || !run.leaseExpiresAt
      || run.leaseExpiresAt <= now.toISOString()
    ) {
      throw new Error(`Durable AI run ${runId} ownership was lost.`);
    }
    return run;
  }

  // ─── Claiming and leases ────────────────────────────────────────────────

  async claimNextRun(
    owner: string,
    routes: readonly string[],
    leaseMs = DEFAULT_LEASE_MS,
    now = new Date(),
  ): Promise<ClaimedDurableAiRun | null> {
    if (routes.length === 0) return null;
    const normalizedOwner = boundedIdentifier(owner, 'lease owner', 300);
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + positiveInteger(leaseMs, DEFAULT_LEASE_MS),
    ).toISOString();
    return withTransaction(this.pool, async (client) => {
      await this.recoverExpiredRunsWithClient(client, now, routes);
      await this.expireTimedOutQueuedRunsWithClient(client, now);

      const [candidate] = await query<AiRunDatabaseRow>(
        client,
        `
          SELECT ${RUN_COLUMNS}
          FROM ai_runs
          WHERE status = 'queued'
            AND cancel_requested_at IS NULL
            AND available_at <= $1
            AND timeout_at > $1
            AND execution_route = ANY($2::text[])
          ORDER BY available_at ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [nowIso, [...routes]],
      );
      if (!candidate) return null;

      const claimed = await execute(
        client,
        `
          UPDATE ai_runs
          SET status = 'running',
              attempt = attempt + 1,
              lease_owner = $1,
              lease_expires_at = $2,
              started_at = COALESCE(started_at, $3),
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = $3,
              revision = revision + 1
          WHERE id = $4 AND status = 'queued' AND revision = $5
        `,
        [normalizedOwner, leaseExpiresAt, nowIso, candidate.id, candidate.revision],
      );
      if (claimed !== 1) return null;
      await this.addEvent(client, candidate.id, {
        idempotencyKey: `run:attempt:${candidate.attempt + 1}:started`,
        kind: 'run.started',
        payload: { attempt: candidate.attempt + 1 },
        now,
      });
      const run = await this.readRun(client, 'id', candidate.id);
      return run ? toClaimedRun(run) : null;
    });
  }

  async renewLease(
    runId: string,
    owner: string,
    leaseMs = DEFAULT_LEASE_MS,
    now = new Date(),
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const renewed = await execute(
      this.pool,
      `
        UPDATE ai_runs
        SET lease_expires_at = $1, updated_at = $2, revision = revision + 1
        WHERE id = $3
          AND status = ANY($4::text[])
          AND lease_owner = $5
          AND lease_expires_at > $2
      `,
      [
        new Date(
          now.getTime() + positiveInteger(leaseMs, DEFAULT_LEASE_MS),
        ).toISOString(),
        nowIso,
        runId,
        [...OWNED_CLAIM_STATUSES],
        owner,
      ],
    );
    return renewed === 1;
  }

  // ─── Cancellation and retry ─────────────────────────────────────────────

  async isCancellationRequested(runId: string, owner?: string): Promise<boolean> {
    const [row] = await query<{ cancelRequestedAt: string | null }>(
      this.pool,
      `
        SELECT cancel_requested_at AS "cancelRequestedAt"
        FROM ai_runs
        WHERE id = $1
          AND status = ANY($2::text[])
          ${owner ? 'AND lease_owner = $3' : ''}
      `,
      owner
        ? [runId, [...OWNED_CLAIM_STATUSES], owner]
        : [runId, [...OWNED_CLAIM_STATUSES]],
    );
    return Boolean(row?.cancelRequestedAt);
  }

  async requestCancellation(
    runId: string,
    now = new Date(),
  ): Promise<DurableAiRun | null> {
    const nowIso = now.toISOString();
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) return null;
      if (DURABLE_AI_RUN_TERMINAL_STATUSES.has(current.status)) {
        return toPublicDurableAiRun(current);
      }
      const status = current.status === 'queued' ? 'cancelled' : 'cancelling';
      const terminal = status === 'cancelled';
      const changed = await execute(
        client,
        `
          UPDATE ai_runs
          SET status = $1,
              cancel_requested_at = COALESCE(cancel_requested_at, $2),
              completed_at = $3,
              cleanup_status = $4,
              lease_owner = $5,
              lease_expires_at = $6,
              updated_at = $2,
              revision = revision + 1
          WHERE id = $7 AND revision = $8
        `,
        [
          status,
          nowIso,
          terminal ? nowIso : current.completedAt,
          terminal
            ? await this.cleanupStatusForTerminal(client, runId, now)
            : current.cleanupStatus,
          terminal ? null : current.leaseOwner,
          terminal ? null : current.leaseExpiresAt,
          runId,
          current.revision,
        ],
      );
      if (changed !== 1) {
        throw new Error(`Durable AI run ${runId} changed during cancellation.`);
      }
      await this.addEvent(client, runId, {
        idempotencyKey: 'command:cancel',
        kind: terminal ? 'run.cancelled' : 'run.cancellation_requested',
        now,
      });
      return this.getRunOrThrow(client, runId);
    });
  }

  async retryRun(
    runId: string,
    commandIdempotencyKey: string,
    now = new Date(),
  ): Promise<DurableAiRun | null> {
    const commandKey = boundedIdentifier(
      commandIdempotencyKey,
      'retry idempotencyKey',
      300,
    );
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) return null;
      const [existingEvent] = await query(
        client,
        `SELECT 1 FROM ai_run_events WHERE run_id = $1 AND idempotency_key = $2`,
        [runId, `command:retry:${commandKey}`],
      );
      if (existingEvent) return toPublicDurableAiRun(current);
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
      const updated = await execute(
        client,
        `
          UPDATE ai_runs
          SET status = 'queued',
              max_attempts = CASE
                WHEN attempt >= max_attempts THEN attempt + 1
                ELSE max_attempts
              END,
              available_at = $1,
              timeout_at = $2,
              completed_at = NULL,
              cancel_requested_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              cleanup_status = CASE
                WHEN cleanup_status = 'running' THEN cleanup_status
                ELSE 'none'
              END,
              updated_at = $1,
              revision = revision + 1
          WHERE id = $3 AND revision = $4
        `,
        [
          nowIso,
          new Date(now.getTime() + timeoutMs).toISOString(),
          runId,
          current.revision,
        ],
      );
      if (updated !== 1) {
        throw new Error(`Durable AI run ${runId} changed during retry.`);
      }
      await this.addEvent(client, runId, {
        idempotencyKey: `command:retry:${commandKey}`,
        kind: 'run.retry_requested',
        payload: { previousStatus: current.status },
        now,
      });
      return this.getRunOrThrow(client, runId);
    });
  }

  // ─── Terminal transitions ───────────────────────────────────────────────

  async completeRun(
    runId: string,
    owner: string,
    outcome: DurableAiRunRouteOutcome = {},
    now = new Date(),
  ): Promise<DurableAiRun> {
    return withTransaction(this.pool, (client) =>
      this.finishOwnedRun(client, runId, owner, 'succeeded', outcome, now));
  }

  async cancelRun(
    runId: string,
    owner: string,
    now = new Date(),
  ): Promise<DurableAiRun> {
    return withTransaction(this.pool, (client) =>
      this.finishOwnedRun(client, runId, owner, 'cancelled', {}, now));
  }

  async timeOutRun(
    runId: string,
    owner: string,
    now = new Date(),
  ): Promise<DurableAiRun> {
    return withTransaction(this.pool, (client) => this.finishOwnedRun(
      client,
      runId,
      owner,
      'timed_out',
      {},
      now,
      'run_timeout',
      'The durable AI run exceeded its execution deadline.',
    ));
  }

  async failRun(
    runId: string,
    owner: string,
    error: unknown,
    options: DurableAiRunFailureOptions = {},
  ): Promise<DurableAiRun> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const message = redactDurableAiText(
      error instanceof Error ? error.message : String(error),
    );
    const code = redactDurableAiText(options.code ?? 'provider_error', 100);
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRun(client, runId);
      if (
        !current
        || current.leaseOwner !== owner
        || !OWNED_CLAIM_STATUSES.includes(current.status)
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
          client,
          runId,
          owner,
          current.status === 'cancelling' ? 'cancelled' : 'failed',
          options.outcome ?? {},
          now,
          code,
          message,
        );
      }
      const availableAt = computeDurableAiRetryAvailableAt(now, current.attempt);
      const requeued = await execute(
        client,
        `
          UPDATE ai_runs
          SET status = 'queued',
              available_at = $1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error_code = $2,
              last_error_message = $3,
              provider = COALESCE($4::text, provider),
              model = COALESCE($5::text, model),
              fallback_state = COALESCE($6::text, fallback_state),
              updated_at = $7,
              revision = revision + 1
          WHERE id = $8
            AND revision = $9
            AND lease_owner = $10
            AND lease_expires_at > $7
        `,
        [
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
        ],
      );
      if (requeued !== 1) {
        throw new Error(`Durable AI run ${runId} ownership was lost.`);
      }
      await this.addEvent(client, runId, {
        idempotencyKey: `run:attempt:${current.attempt}:retry`,
        kind: 'run.retry_scheduled',
        payload: { attempt: current.attempt, code, availableAt },
        now,
      });
      return this.getRunOrThrow(client, runId);
    });
  }

  private async finishOwnedRun(
    client: PoolClient,
    runId: string,
    owner: string,
    status: Extract<
      DurableAiRunStatus,
      'succeeded' | 'failed' | 'cancelled' | 'timed_out'
    >,
    outcome: DurableAiRunRouteOutcome,
    now: Date,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): Promise<DurableAiRun> {
    const nowIso = now.toISOString();
    const current = await this.lockRun(client, runId);
    if (
      !current
      || current.leaseOwner !== owner
      || !OWNED_CLAIM_STATUSES.includes(current.status)
      || !current.leaseExpiresAt
      || current.leaseExpiresAt <= nowIso
    ) {
      throw new Error(`Durable AI run ${runId} ownership was lost.`);
    }
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
    const finished = await execute(
      client,
      `
        UPDATE ai_runs
        SET status = $1,
            provider = COALESCE($2::text, provider),
            model = COALESCE($3::text, model),
            fallback_state = COALESCE($4::text, fallback_state),
            completed_at = $5,
            last_error_code = $6,
            last_error_message = $7,
            cleanup_status = $8,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $5,
            revision = revision + 1
        WHERE id = $9
          AND revision = $10
          AND lease_owner = $11
          AND lease_expires_at > $5
      `,
      [
        effectiveStatus,
        outcome.provider?.trim() || null,
        outcome.model?.trim() || null,
        outcome.fallbackState ?? null,
        nowIso,
        effectiveErrorCode,
        effectiveErrorMessage,
        await this.cleanupStatusForTerminal(client, runId, now),
        runId,
        current.revision,
        owner,
      ],
    );
    if (finished !== 1) {
      throw new Error(`Durable AI run ${runId} ownership was lost.`);
    }
    await this.addEvent(client, runId, {
      idempotencyKey: `run:terminal:${effectiveStatus}:attempt:${current.attempt}`,
      kind: `run.${effectiveStatus}`,
      payload: {
        attempt: current.attempt,
        ...(effectiveErrorCode
          ? { error: { code: effectiveErrorCode, message: effectiveErrorMessage } }
          : {}),
      },
      now,
    });
    return this.getRunOrThrow(client, runId);
  }

  /**
   * Drives a run to a terminal state without an owning lease. The terminal
   * event's idempotency key carries the observed attempt *and* revision, so a
   * run that times out again after an explicit retry records a distinct
   * event instead of silently de-duplicating against the earlier one.
   */
  private async markTerminalWithClient(
    client: PoolClient,
    runId: string,
    status: Extract<DurableAiRunStatus, 'failed' | 'timed_out'>,
    errorCode: string,
    errorMessage: string,
    now: Date,
  ): Promise<void> {
    const nowIso = now.toISOString();
    const current = await this.lockRun(client, runId);
    if (!current) return;
    await client.query(
      `
        UPDATE ai_runs
        SET status = $1,
            completed_at = $2,
            last_error_code = $3,
            last_error_message = $4,
            cleanup_status = $5,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $2,
            revision = revision + 1
        WHERE id = $6 AND status = ANY($7::text[])
      `,
      [
        status,
        nowIso,
        errorCode,
        redactDurableAiText(errorMessage),
        await this.cleanupStatusForTerminal(client, runId, now),
        runId,
        ['queued', 'running', 'cancelling'],
      ],
    );
    await this.addEvent(client, runId, {
      idempotencyKey:
        `run:terminal:${status}:attempt:${current.attempt}:revision:${current.revision}`,
      kind: `run.${status}`,
      payload: { error: { code: errorCode, message: errorMessage } },
      now,
    });
  }

  // ─── Timeout, recovery, and retention ───────────────────────────────────

  private async expireTimedOutQueuedRunsWithClient(
    client: PoolClient,
    now: Date,
  ): Promise<number> {
    // SKIP LOCKED keeps concurrent workers from serializing on the same
    // backlog: a run another worker is already expiring is that worker's to
    // finish, and it is expired exactly once either way.
    const expired = await query<{ id: string }>(
      client,
      `
        SELECT id
        FROM ai_runs
        WHERE status = 'queued' AND timeout_at <= $1
        FOR UPDATE SKIP LOCKED
      `,
      [now.toISOString()],
    );
    for (const run of expired) {
      await this.markTerminalWithClient(
        client,
        run.id,
        'timed_out',
        'run_timeout',
        'The durable AI run exceeded its execution deadline before it was claimed.',
        now,
      );
    }
    return expired.length;
  }

  async expireTimedOutQueuedRuns(now = new Date()): Promise<number> {
    return withTransaction(
      this.pool,
      (client) => this.expireTimedOutQueuedRunsWithClient(client, now),
    );
  }

  /**
   * Reclaims runs whose execution lease expired. Recovery consumes the run's
   * persisted attempt budget (the attempt was already spent when the lease was
   * taken), so a worker that dies mid-attempt cannot loop forever and no
   * process-local bookkeeping is required: the decision is derived entirely
   * from `attempt`, `max_attempts`, `timeout_at`, and `status`.
   */
  private async recoverExpiredRunsWithClient(
    client: PoolClient,
    now: Date,
    routes?: readonly string[],
  ): Promise<number> {
    const nowIso = now.toISOString();
    const rows = await query<AiRunDatabaseRow>(
      client,
      `
        SELECT ${RUN_COLUMNS}
        FROM ai_runs
        WHERE status = ANY($1::text[])
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= $2
          ${routes ? 'AND execution_route = ANY($3::text[])' : ''}
        FOR UPDATE SKIP LOCKED
      `,
      routes
        ? [[...OWNED_CLAIM_STATUSES], nowIso, [...routes]]
        : [[...OWNED_CLAIM_STATUSES], nowIso],
    );
    for (const row of rows) {
      const run = deserializeInternalDurableAiRun(row);
      if (run.status === 'cancelling') {
        await this.markTerminalWithClient(
          client,
          run.id,
          'failed',
          'cancellation_owner_lost',
          'Cancellation could not be confirmed after the worker lease expired.',
          now,
        );
      } else if (run.timeoutAt <= nowIso) {
        await this.markTerminalWithClient(
          client,
          run.id,
          'timed_out',
          'run_timeout',
          'The durable AI run exceeded its execution deadline.',
          now,
        );
      } else if (run.attempt < run.maxAttempts) {
        await client.query(
          `
            UPDATE ai_runs
            SET status = 'queued',
                available_at = $1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error_code = 'worker_lease_expired',
                last_error_message = 'The worker lease expired; execution will resume.',
                updated_at = $1,
                revision = revision + 1
            WHERE id = $2 AND revision = $3
          `,
          [nowIso, run.id, run.revision],
        );
        await this.addEvent(client, run.id, {
          idempotencyKey: `run:attempt:${run.attempt}:lease-expired`,
          kind: 'run.recovered',
          payload: { attempt: run.attempt },
          now,
        });
      } else {
        await this.markTerminalWithClient(
          client,
          run.id,
          'failed',
          'worker_lease_expired',
          'The worker lease expired after the final attempt.',
          now,
        );
      }
    }
    return rows.length;
  }

  async recoverExpiredRuns(
    now = new Date(),
    routes?: readonly string[],
  ): Promise<number> {
    if (routes && routes.length === 0) return 0;
    return withTransaction(
      this.pool,
      (client) => this.recoverExpiredRunsWithClient(client, now, routes),
    );
  }

  async pruneExpired(now = new Date()): Promise<DurableAiRunRetentionResult> {
    const nowIso = now.toISOString();
    return withTransaction(this.pool, async (client) => {
      await this.expireTimedOutQueuedRunsWithClient(client, now);
      // Lock the owning runs (in a deterministic order) before touching their
      // provider sessions so retention takes the same ai_runs →
      // ai_provider_sessions lock order as every execution path.
      await client.query(
        `
          SELECT id
          FROM ai_runs
          WHERE id IN (
            SELECT run_id FROM ai_provider_sessions
            WHERE state = 'active' AND expires_at <= $1
          )
          ORDER BY id
          FOR UPDATE
        `,
        [nowIso],
      );
      const revokedProviderSessions = await execute(
        client,
        `
          UPDATE ai_provider_sessions
          SET state = 'revoked',
              encrypted_reference = '',
              initialization_vector = '',
              auth_tag = '',
              revoked_at = $1,
              updated_at = $1
          WHERE state = 'active' AND expires_at <= $1
        `,
        [nowIso],
      );
      const deletedRuns = await execute(
        client,
        `
          DELETE FROM ai_runs
          WHERE status = ANY($1::text[]) AND expires_at <= $2
        `,
        [['succeeded', 'failed', 'cancelled', 'timed_out'], nowIso],
      );
      return { deletedRuns, revokedProviderSessions };
    });
  }

  // ─── Provider sessions ──────────────────────────────────────────────────

  private async readProviderSession(
    client: DurableAiRunClient,
    runId: string,
    now: Date,
  ): Promise<ProtectedProviderSession | null> {
    const [row] = await query<ProviderSessionDatabaseRow>(
      client,
      `
        SELECT
          provider,
          encrypted_reference AS "encryptedReference",
          initialization_vector AS "initializationVector",
          auth_tag AS "authTag",
          key_version AS "keyVersion",
          state,
          expires_at AS "expiresAt"
        FROM ai_provider_sessions
        WHERE run_id = $1
      `,
      [runId],
    );
    if (!row || row.state !== 'active' || row.expiresAt <= now.toISOString()) {
      return null;
    }
    return {
      provider: row.provider,
      reference: this.sessionProtectorFactory().decrypt(runId, row.provider, row),
      expiresAt: row.expiresAt,
    };
  }

  private async cleanupStatusForTerminal(
    client: DurableAiRunClient,
    runId: string,
    now = new Date(),
  ): Promise<DurableAiRun['cleanupStatus']> {
    const [active] = await query(
      client,
      `
        SELECT 1 FROM ai_provider_sessions
        WHERE run_id = $1 AND state = 'active' AND expires_at > $2
      `,
      [runId, now.toISOString()],
    );
    return active ? 'pending' : 'none';
  }

  private async setProviderSessionWithClient(
    client: PoolClient,
    runId: string,
    provider: string,
    reference: string,
    options: ProviderSessionWriteOptions = {},
  ): Promise<ProtectedProviderSession> {
    const current = await this.lockRun(client, runId);
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
    const protectedReference = this.sessionProtectorFactory().encrypt(
      runId,
      normalizedProvider,
      normalizedReference,
    );
    const existing = await this.readProviderSession(client, runId, now);
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
    const written = await execute(
      client,
      `
        INSERT INTO ai_provider_sessions (
          run_id, provider, encrypted_reference, initialization_vector,
          auth_tag, key_version, state, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
        ON CONFLICT (run_id) DO UPDATE SET
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
           OR ai_provider_sessions.expires_at <= $8
      `,
      [
        runId,
        normalizedProvider,
        protectedReference.encryptedReference,
        protectedReference.initializationVector,
        protectedReference.authTag,
        protectedReference.keyVersion,
        expiresAt.toISOString(),
        nowIso,
      ],
    );
    if (written !== 1) {
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

  async setProviderSession(
    runId: string,
    provider: string,
    reference: string,
    options: ProviderSessionWriteOptions = {},
  ): Promise<ProtectedProviderSession> {
    return withTransaction(this.pool, (client) =>
      this.setProviderSessionWithClient(client, runId, provider, reference, options));
  }

  async setProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    provider: string,
    reference: string,
    options: ProviderSessionWriteOptions = {},
  ): Promise<ProtectedProviderSession> {
    const now = options.now ?? new Date();
    return withTransaction(this.pool, async (client) => {
      await this.assertOwnedClaim(client, runId, owner, attempt, now);
      return this.setProviderSessionWithClient(
        client,
        runId,
        provider,
        reference,
        options.expiresAt ? { expiresAt: options.expiresAt, now } : { now },
      );
    });
  }

  async getProviderSession(
    runId: string,
    now = new Date(),
  ): Promise<ProtectedProviderSession | null> {
    return this.readProviderSession(this.pool, runId, now);
  }

  async getProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now = new Date(),
  ): Promise<ProtectedProviderSession | null> {
    return withTransaction(this.pool, async (client) => {
      await this.assertOwnedClaim(client, runId, owner, attempt, now);
      return this.readProviderSession(client, runId, now);
    });
  }

  private async revokeProviderSessionWithClient(
    client: PoolClient,
    runId: string,
    now: Date,
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const revoked = await execute(
      client,
      `
        UPDATE ai_provider_sessions
        SET state = 'revoked',
            encrypted_reference = '',
            initialization_vector = '',
            auth_tag = '',
            revoked_at = $1,
            updated_at = $1
        WHERE run_id = $2 AND state = 'active'
      `,
      [nowIso, runId],
    );
    return revoked === 1;
  }

  async revokeProviderSession(runId: string, now = new Date()): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      // Take the run lock first so a standalone revocation observes the same
      // lock order as the write paths that own the run.
      await this.lockRun(client, runId);
      return this.revokeProviderSessionWithClient(client, runId, now);
    });
  }

  async revokeProviderSessionForClaim(
    runId: string,
    owner: string,
    attempt: number,
    now = new Date(),
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await this.assertOwnedClaim(client, runId, owner, attempt, now);
      return this.revokeProviderSessionWithClient(client, runId, now);
    });
  }

  // ─── Provider cleanup ───────────────────────────────────────────────────

  async claimCleanup(
    owner: string,
    routes: readonly string[],
    leaseMs = DEFAULT_LEASE_MS,
    now = new Date(),
  ): Promise<ClaimedDurableAiRun | null> {
    if (routes.length === 0) return null;
    const nowIso = now.toISOString();
    return withTransaction(this.pool, async (client) => {
      // An expired cleanup lease is reclaimable by any worker: the candidate
      // filter reads the persisted lease, so a crashed cleaner consumes its
      // budget through `available_at`/`updated_at` alone, with no in-process
      // bookkeeping.
      const [candidate] = await query<AiRunDatabaseRow>(
        client,
        `
          SELECT ${RUN_COLUMNS}
          FROM ai_runs
          WHERE cleanup_status = ANY($1::text[])
            AND execution_route = ANY($2::text[])
            AND available_at <= $3
            AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
          ORDER BY updated_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [['pending', 'failed', 'running'], [...routes], nowIso],
      );
      if (!candidate) return null;
      const leaseExpiresAt = new Date(
        now.getTime() + positiveInteger(leaseMs, DEFAULT_LEASE_MS),
      ).toISOString();
      const claimed = await execute(
        client,
        `
          UPDATE ai_runs
          SET cleanup_status = 'running',
              lease_owner = $1,
              lease_expires_at = $2,
              updated_at = $3,
              revision = revision + 1
          WHERE id = $4 AND revision = $5
        `,
        [owner, leaseExpiresAt, nowIso, candidate.id, candidate.revision],
      );
      if (claimed !== 1) return null;
      await this.addEvent(client, candidate.id, {
        idempotencyKey: `cleanup:started:${candidate.revision + 1}`,
        kind: 'run.cleanup_started',
        now,
      });
      const run = await this.readRun(client, 'id', candidate.id);
      return run ? toClaimedRun(run) : null;
    });
  }

  async renewCleanupLease(
    runId: string,
    owner: string,
    leaseMs = DEFAULT_LEASE_MS,
    now = new Date(),
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    const renewed = await execute(
      this.pool,
      `
        UPDATE ai_runs
        SET lease_expires_at = $1,
            updated_at = $2,
            revision = revision + 1
        WHERE id = $3
          AND cleanup_status = 'running'
          AND lease_owner = $4
          AND lease_expires_at > $2
      `,
      [
        new Date(
          now.getTime() + positiveInteger(leaseMs, DEFAULT_LEASE_MS),
        ).toISOString(),
        nowIso,
        runId,
        owner,
      ],
    );
    return renewed === 1;
  }

  async finishCleanup(
    runId: string,
    owner: string,
    error?: unknown,
    now = new Date(),
  ): Promise<DurableAiRun> {
    const nowIso = now.toISOString();
    const failed = error !== undefined;
    const message = failed
      ? redactDurableAiText(error instanceof Error ? error.message : String(error))
      : null;
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockRun(client, runId);
      if (
        !current
        || current.cleanupStatus !== 'running'
        || current.leaseOwner !== owner
        || !current.leaseExpiresAt
        || current.leaseExpiresAt <= nowIso
      ) {
        throw new Error(`Durable AI run ${runId} cleanup ownership was lost.`);
      }
      const finished = await execute(
        client,
        `
          UPDATE ai_runs
          SET cleanup_status = $1,
              last_error_code = $2,
              last_error_message = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              available_at = $4,
              updated_at = $5,
              revision = revision + 1
          WHERE id = $6
            AND revision = $7
            AND lease_owner = $8
            AND lease_expires_at > $5
        `,
        [
          failed ? 'failed' : 'completed',
          failed ? 'provider_cleanup_failed' : current.lastErrorCode,
          failed ? message : current.lastErrorMessage,
          failed
            ? new Date(now.getTime() + 5 * 60_000).toISOString()
            : current.availableAt,
          nowIso,
          runId,
          current.revision,
          owner,
        ],
      );
      if (finished !== 1) {
        throw new Error(`Durable AI run ${runId} cleanup ownership was lost.`);
      }
      if (!failed) await this.revokeProviderSessionWithClient(client, runId, now);
      await this.addEvent(client, runId, {
        idempotencyKey:
          `cleanup:${failed ? 'failed' : 'completed'}:${current.revision + 1}`,
        kind: failed ? 'run.cleanup_failed' : 'run.cleanup_completed',
        payload: failed ? { error: { message } } : {},
        now,
      });
      return this.getRunOrThrow(client, runId);
    });
  }

  // ─── Execution state ────────────────────────────────────────────────────

  async initializeExecutionState(
    runId: string,
    state: Record<string, unknown>,
    options: DurableAiRunInitializeStateOptions,
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    return withTransaction(this.pool, async (client) => {
      const conditions: string[] = [
        'id = $8',
        'revision = $9',
        'execution_state IS NULL',
      ];
      const conditionValues: unknown[] = [];
      const pushCondition = (condition: string, value: unknown): void => {
        conditionValues.push(value);
        conditions.push(`${condition} $${9 + conditionValues.length}`);
      };
      if (options.requiredLeaseOwner) {
        pushCondition('lease_owner =', options.requiredLeaseOwner);
      }
      if (options.requiredAttempt !== undefined) {
        pushCondition('attempt =', options.requiredAttempt);
      }
      if (options.leaseState === 'active') {
        pushCondition('lease_expires_at >', nowIso);
      } else if (options.leaseState === 'expired') {
        pushCondition('lease_expires_at <=', nowIso);
      }
      const initialized = await execute(
        client,
        `
          UPDATE ai_runs
          SET execution_state = $1::jsonb,
              status = COALESCE($2::text, status),
              traceparent = COALESCE($3::text, traceparent),
              tracestate = COALESCE($4::text, tracestate),
              lease_owner = COALESCE($5::text, lease_owner),
              lease_expires_at = COALESCE($6::text, lease_expires_at),
              updated_at = $7,
              revision = revision + 1
          WHERE ${conditions.join(' AND ')}
        `,
        [
          JSON.stringify(sanitizeDurableAiState(state)),
          options.status ?? null,
          options.traceparent ?? null,
          options.tracestate ?? null,
          options.owner ?? null,
          options.leaseExpiresAt ?? null,
          nowIso,
          runId,
          options.expectedRevision,
          ...conditionValues,
        ],
      ) === 1;
      if (initialized && options.providerSession) {
        await this.setProviderSessionWithClient(
          client,
          runId,
          options.providerSession.provider,
          options.providerSession.reference,
          options.providerSession.expiresAt
            ? { expiresAt: options.providerSession.expiresAt, now }
            : { now },
        );
      }
      return initialized;
    });
  }

  async compareAndSetExecutionState(
    runId: string,
    expectedRevision: number,
    state: Record<string, unknown>,
    options: DurableAiRunCompareAndSetOptions = {},
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const assignments: unknown[] = [
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
    ];
    const { clause, params } = buildDurableAiCompareAndSetConditions(
      runId,
      expectedRevision,
      options,
      nowIso,
      assignments.length + 1,
    );
    return withTransaction(this.pool, async (client) => {
      const updated = await execute(
        client,
        `
          UPDATE ai_runs
          SET execution_state = $1::jsonb,
              status = COALESCE($2::text, status),
              traceparent = COALESCE($3::text, traceparent),
              tracestate = COALESCE($4::text, tracestate),
              lease_owner = $5::text,
              lease_expires_at = $6::text,
              completed_at = COALESCE($7::text, completed_at),
              cleanup_status = COALESCE($8::text, cleanup_status),
              provider = COALESCE($9::text, provider),
              model = COALESCE($10::text, model),
              fallback_state = COALESCE($11::text, fallback_state),
              updated_at = $12,
              revision = revision + 1
          WHERE ${clause}
        `,
        [...assignments, ...params],
      ) === 1;
      if (!updated) return false;
      if (options.providerSession) {
        await this.setProviderSessionWithClient(
          client,
          runId,
          options.providerSession.provider,
          options.providerSession.reference,
          options.providerSession.expiresAt
            ? { expiresAt: options.providerSession.expiresAt, now }
            : { now },
        );
      }
      if (options.revokeProviderSession) {
        await this.revokeProviderSessionWithClient(client, runId, now);
      }
      return true;
    });
  }
}

/**
 * Builds the PostgreSQL durable AI run repository for a `pg` pool (typically
 * `PostgresPersistenceBackend#context.pool` from `@/db/postgres/runtime`).
 */
export function createPostgresDurableAiRunRepository(
  pool: Pool,
  sessionProtectorFactory?: () => ProviderSessionProtector,
): DurableAiRunRepository {
  return new PostgresDurableAiRunRepository(pool, sessionProtectorFactory);
}
