import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * PostgreSQL mirror of `src/db/schema/semantic-index.ts`. The only additive
 * columns are the PostgreSQL key-encoding discriminators needed because PG text
 * rejects NUL; `tests/db/postgres-schema.test.ts` asserts that narrow exception.
 */

// ─── Index identities ───────────────────────────────────────────────────────

export type SemanticIndexStatus = 'building' | 'ready' | 'active' | 'retired' | 'failed';

export const semanticIndexIdentities = pgTable('semantic_index_identities', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  projectionVersion: integer('projection_version').notNull(),
  status: text('status').$type<SemanticIndexStatus>().notNull(),
  documentCount: integer('document_count').notNull().default(0),
  vectorCount: integer('vector_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  readyAt: text('ready_at'),
  activatedAt: text('activated_at'),
  retiredAt: text('retired_at'),
  failureReason: text('failure_reason'),
}, (table) => [
  uniqueIndex('idx_semantic_identities_active')
    .on(table.status)
    .where(sql`${table.status} = 'active'`),
  index('idx_semantic_identities_lifecycle')
    .on(table.status, table.updatedAt),
  index('idx_semantic_identities_space')
    .on(table.provider, table.model, table.dimensions, table.projectionVersion),
]);

// ─── Documents ──────────────────────────────────────────────────────────────

export type SemanticSensitivity = 'local-only' | 'restricted' | 'standard';

export const semanticDocuments = pgTable('semantic_documents', {
  id: text('id').primaryKey(),
  indexId: text('index_id')
    .notNull()
    .references(() => semanticIndexIdentities.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  version: integer('version').notNull().default(1),
  title: text('title').notNull(),
  body: text('body').notNull(),
  keywords: jsonb('keywords').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  sourceRevision: text('source_revision').notNull(),
  contentFingerprint: text('content_fingerprint').notNull(),
  projectionVersion: integer('projection_version').notNull(),
  sensitivity: text('sensitivity').$type<SemanticSensitivity>().notNull(),
  retainUntil: text('retain_until'),
  sourceUpdatedAt: text('source_updated_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => [
  uniqueIndex('idx_semantic_documents_entity')
    .on(table.indexId, table.entityType, table.entityId),
  index('idx_semantic_documents_kind')
    .on(table.indexId, table.entityType, table.sourceUpdatedAt),
  index('idx_semantic_documents_retention')
    .on(table.retainUntil),
  index('idx_semantic_documents_deleted')
    .on(table.deletedAt),
]);

// ─── Vectors ────────────────────────────────────────────────────────────────

export const semanticVectors = pgTable('semantic_vectors', {
  id: text('id').primaryKey(),
  indexId: text('index_id')
    .notNull()
    .references(() => semanticIndexIdentities.id, { onDelete: 'cascade' }),
  documentId: text('document_id')
    .notNull()
    .references(() => semanticDocuments.id, { onDelete: 'cascade' }),
  documentVersion: integer('document_version').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  sourceRevision: text('source_revision').notNull(),
  contentFingerprint: text('content_fingerprint').notNull(),
  projectionVersion: integer('projection_version').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  sensitivity: text('sensitivity').$type<SemanticSensitivity>().notNull(),
  embedding: text('embedding').notNull(),
  norm: text('norm').notNull(),
  sourceUpdatedAt: text('source_updated_at').notNull(),
  embeddedAt: text('embedded_at').notNull(),
  indexRunId: text('index_run_id'),
  intentId: text('intent_id'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_semantic_vectors_entity')
    .on(table.indexId, table.entityType, table.entityId),
  index('idx_semantic_vectors_scan')
    .on(table.indexId, table.entityType, table.sourceUpdatedAt),
  index('idx_semantic_vectors_document')
    .on(table.documentId, table.documentVersion),
  index('idx_semantic_vectors_expiry')
    .on(table.indexId, table.expiresAt),
  index('idx_semantic_vectors_job')
    .on(table.indexRunId),
]);

// ─── Intents ────────────────────────────────────────────────────────────────

export type SemanticIntentKind = 'upsert' | 'delete';

export type SemanticIntentStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired';

export const semanticIntents = pgTable('semantic_intents', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  idempotencyKeyVersion: integer('idempotency_key_version').notNull().default(0),
  indexId: text('index_id')
    .notNull()
    .references(() => semanticIndexIdentities.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<SemanticIntentKind>().notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  sourceRevision: text('source_revision'),
  contentFingerprint: text('content_fingerprint'),
  projectionVersion: integer('projection_version'),
  requestedAt: text('requested_at').notNull(),
  status: text('status').$type<SemanticIntentStatus>().notNull(),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  availableAt: text('available_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  retryAfter: text('retry_after'),
  lastError: text('last_error'),
  outcome: text('outcome'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_semantic_intents_pending')
    .on(table.idempotencyKeyVersion, table.idempotencyKey)
    .where(sql`${table.status} = 'queued'`),
  index('idx_semantic_intents_claim')
    .on(table.indexId, table.status, table.availableAt, table.requestedAt),
  index('idx_semantic_intents_lease')
    .on(table.status, table.leaseExpiresAt),
  index('idx_semantic_intents_entity')
    .on(table.indexId, table.entityType, table.entityId),
  index('idx_semantic_intents_history')
    .on(table.status, table.completedAt),
]);

// ─── Runs ───────────────────────────────────────────────────────────────────

export type SemanticRunKind = 'backfill' | 'reconcile' | 'cleanup';

export type SemanticRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const semanticRuns = pgTable('semantic_runs', {
  id: text('id').primaryKey(),
  indexId: text('index_id')
    .notNull()
    .references(() => semanticIndexIdentities.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<SemanticRunKind>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  idempotencyKeyVersion: integer('idempotency_key_version').notNull().default(0),
  status: text('status').$type<SemanticRunStatus>().notNull(),
  checkpoint: text('checkpoint'),
  processedCount: integer('processed_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  availableAt: text('available_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_semantic_runs_idempotency')
    .on(table.idempotencyKeyVersion, table.idempotencyKey),
  uniqueIndex('idx_semantic_runs_active')
    .on(table.indexId, table.kind)
    .where(sql`${table.status} = 'running'`),
  index('idx_semantic_runs_claim')
    .on(table.status, table.availableAt),
  index('idx_semantic_runs_lease')
    .on(table.status, table.leaseExpiresAt),
  index('idx_semantic_runs_history')
    .on(table.indexId, table.createdAt),
]);
