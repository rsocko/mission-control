import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export type AiRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type AiRunSensitivity = 'standard' | 'restricted' | 'local-only';
export type AiRunFallbackState =
  | 'not_requested'
  | 'not_used'
  | 'used'
  | 'exhausted';
export type AiRunCleanupStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export const aiRuns = sqliteTable('ai_runs', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  featureId: text('feature_id').notNull(),
  sensitivity: text('sensitivity').$type<AiRunSensitivity>().notNull(),
  status: text('status').$type<AiRunStatus>().notNull(),
  executionRoute: text('execution_route').notNull(),
  requestedProvider: text('requested_provider'),
  requestedModel: text('requested_model'),
  provider: text('provider'),
  model: text('model'),
  fallbackState: text('fallback_state')
    .$type<AiRunFallbackState>()
    .notNull()
    .default('not_requested'),
  correlationId: text('correlation_id').notNull(),
  traceparent: text('traceparent'),
  tracestate: text('tracestate'),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  availableAt: text('available_at').notNull(),
  timeoutAt: text('timeout_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  cancelRequestedAt: text('cancel_requested_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  notifyOnCompletion: integer('notify_on_completion', { mode: 'boolean' })
    .notNull()
    .default(false),
  cleanupStatus: text('cleanup_status')
    .$type<AiRunCleanupStatus>()
    .notNull()
    .default('none'),
  executionState: text('execution_state', { mode: 'json' })
    .$type<Record<string, unknown> | null>(),
  revision: integer('revision').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ai_runs_idempotency').on(table.idempotencyKey),
  index('idx_ai_runs_claim').on(table.status, table.availableAt, table.createdAt),
  index('idx_ai_runs_lease').on(table.status, table.leaseExpiresAt),
  index('idx_ai_runs_correlation').on(table.correlationId),
  index('idx_ai_runs_history').on(table.createdAt),
  index('idx_ai_runs_expiry').on(table.expiresAt),
  index('idx_ai_runs_cleanup').on(table.cleanupStatus, table.updatedAt),
]);

export const aiRunEvents = sqliteTable('ai_run_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull(),
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ai_run_events_event_id').on(table.eventId),
  uniqueIndex('idx_ai_run_events_sequence').on(table.runId, table.sequence),
  uniqueIndex('idx_ai_run_events_idempotency').on(
    table.runId,
    table.idempotencyKey,
  ),
  index('idx_ai_run_events_cursor').on(table.runId, table.id),
  index('idx_ai_run_events_created').on(table.createdAt),
]);

export const aiProviderSessions = sqliteTable('ai_provider_sessions', {
  runId: text('run_id')
    .primaryKey()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  encryptedReference: text('encrypted_reference').notNull(),
  initializationVector: text('initialization_vector').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: text('key_version').notNull(),
  state: text('state').$type<'active' | 'revoked'>().notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_ai_provider_sessions_expiry').on(table.state, table.expiresAt),
  index('idx_ai_provider_sessions_provider').on(table.provider, table.state),
]);
