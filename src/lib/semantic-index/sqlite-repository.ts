import type Database from 'better-sqlite3';
import {
  SEMANTIC_ENTITY_TYPES,
  SEMANTIC_RETRYABLE_TERMINAL_RUN_STATUSES,
  SEMANTIC_RUN_KINDS,
  SEMANTIC_TERMINAL_INTENT_STATUSES,
  SEMANTIC_WRITABLE_IDENTITY_STATUSES,
  SemanticIndexValidationError,
  type SemanticActivationGate,
  type SemanticActivationResult,
  type SemanticCleanupResult,
  type SemanticDocumentDeleteResult,
  type SemanticDocumentListRequest,
  type SemanticDocumentRecord,
  type SemanticDocumentSummary,
  type SemanticDocumentWrite,
  type SemanticDocumentWriteResult,
  type SemanticEntityKindReadiness,
  type SemanticEntityType,
  type SemanticIndexIdentity,
  type SemanticIndexIdentityInput,
  type SemanticIndexMetrics,
  type SemanticIndexReadiness,
  type SemanticIndexRepository,
  type SemanticIndexStatus,
  type SemanticIntent,
  type SemanticIntentClaimRequest,
  type SemanticIntentCompletion,
  type SemanticIntentEnqueue,
  type SemanticIntentEnqueueResult,
  type SemanticIntentFailure,
  type SemanticIntentKind,
  type SemanticIntentQueueMetrics,
  type SemanticIntentStatus,
  type SemanticQueryRequest,
  type SemanticQueryResponse,
  type SemanticQueryResult,
  type SemanticRollbackResult,
  type SemanticRun,
  type SemanticRunCheckpoint,
  type SemanticRunCompletion,
  type SemanticRunCreate,
  type SemanticRunCreateResult,
  type SemanticRunFailure,
  type SemanticRunKind,
  type SemanticRunMetrics,
  type SemanticRunProgress,
  type SemanticRunClaimRequest,
  type SemanticRunStatus,
  type SemanticScanCapability,
  type SemanticSensitivity,
  type SemanticVectorRecord,
  type SemanticVectorWrite,
  type SemanticVectorWriteResult,
} from './contracts';
import {
  addMs,
  ageMs,
  assertPositiveInteger,
  compareQueryResults,
  computeSemanticRetryAt,
  cosineSimilarity,
  getSemanticIntentMaxAttempts,
  getSemanticRunMaxAttempts,
  getSemanticScanLimit,
  identityDescriptor,
  isStaleSourceUpdate,
  jsonEquals,
  jsonOrDefault,
  normalizeMetadataFilters,
  parseEmbedding,
  resolveIntentFailureStatus,
  runProgress,
  serializeEmbedding,
  supersededRunIdempotencyKey,
  validateDocumentWrite,
  validateQueryEmbedding,
  validateVectorWrite,
} from './validation';

type SqliteDatabase = Database.Database;

// ─── Row shapes ─────────────────────────────────────────────────────────────

interface IdentityRow {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  projection_version: number;
  status: string;
  document_count: number;
  vector_count: number;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
  failure_reason: string | null;
}

interface DocumentRow {
  id: string;
  index_id: string;
  entity_type: string;
  entity_id: string;
  version: number;
  title: string;
  body: string;
  keywords: string;
  metadata: string;
  source_revision: string;
  content_fingerprint: string;
  projection_version: number;
  sensitivity: string;
  retain_until: string | null;
  source_updated_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VectorRow {
  id: string;
  index_id: string;
  document_id: string;
  document_version: number;
  entity_type: string;
  entity_id: string;
  source_revision: string;
  content_fingerprint: string;
  projection_version: number;
  provider: string;
  model: string;
  dimensions: number;
  sensitivity: string;
  embedding: string;
  norm: string;
  source_updated_at: string;
  embedded_at: string;
  index_run_id: string | null;
  intent_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IntentRow {
  id: string;
  idempotency_key: string;
  index_id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  source_revision: string | null;
  content_fingerprint: string | null;
  projection_version: number | null;
  requested_at: string;
  status: string;
  attempt: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  retry_after: string | null;
  last_error: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RunRow {
  id: string;
  index_id: string;
  kind: string;
  idempotency_key: string;
  status: string;
  checkpoint: string | null;
  processed_count: number;
  failed_count: number;
  skipped_count: number;
  attempt: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToIdentity(row: IdentityRow): SemanticIndexIdentity {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    projectionVersion: row.projection_version,
    status: row.status as SemanticIndexStatus,
    documentCount: row.document_count,
    vectorCount: row.vector_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    failureReason: row.failure_reason,
  };
}

function rowToDocument(row: DocumentRow): SemanticDocumentRecord {
  return {
    id: row.id,
    indexId: row.index_id,
    entityType: row.entity_type as SemanticEntityType,
    entityId: row.entity_id,
    version: row.version,
    title: row.title,
    body: row.body,
    keywords: jsonOrDefault<string[]>(row.keywords, []),
    metadata: jsonOrDefault<SemanticDocumentRecord['metadata']>(row.metadata, {}),
    sourceRevision: row.source_revision,
    contentFingerprint: row.content_fingerprint,
    projectionVersion: row.projection_version,
    sensitivity: row.sensitivity as SemanticSensitivity,
    retainUntil: row.retain_until,
    sourceUpdatedAt: row.source_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function rowToVector(row: VectorRow): SemanticVectorRecord {
  return {
    id: row.id,
    indexId: row.index_id,
    documentId: row.document_id,
    documentVersion: row.document_version,
    entityType: row.entity_type as SemanticEntityType,
    entityId: row.entity_id,
    sourceRevision: row.source_revision,
    contentFingerprint: row.content_fingerprint,
    projectionVersion: row.projection_version,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    sensitivity: row.sensitivity as SemanticSensitivity,
    embedding: parseEmbedding(row.embedding) ?? new Float32Array(0),
    norm: Number.parseFloat(row.norm),
    sourceUpdatedAt: row.source_updated_at,
    embeddedAt: row.embedded_at,
    indexRunId: row.index_run_id,
    intentId: row.intent_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToIntent(row: IntentRow): SemanticIntent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    indexId: row.index_id,
    kind: row.kind as SemanticIntentKind,
    entityType: row.entity_type as SemanticEntityType,
    entityId: row.entity_id,
    sourceRevision: row.source_revision,
    contentFingerprint: row.content_fingerprint,
    projectionVersion: row.projection_version,
    requestedAt: row.requested_at,
    status: row.status as SemanticIntentStatus,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    retryAfter: row.retry_after,
    lastError: row.last_error,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToRun(row: RunRow): SemanticRun {
  return {
    id: row.id,
    indexId: row.index_id,
    kind: row.kind as SemanticRunKind,
    idempotencyKey: row.idempotency_key,
    status: row.status as SemanticRunStatus,
    checkpoint: row.checkpoint,
    processedCount: row.processed_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

const TERMINAL_INTENT_LIST = SEMANTIC_TERMINAL_INTENT_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');

/**
 * Compares stored JSON text against an incoming projection.
 *
 * The byte comparison is the fast path (the normalized projection serializes
 * deterministically), and the canonical comparison is the fallback so a row
 * persisted with a different key order — an adopted legacy row, say — is not
 * mistaken for a content change and given a pointless new version.
 */
function sameStoredJson(storedText: string, incomingText: string, incoming: unknown): boolean {
  return storedText === incomingText
    || jsonEquals(jsonOrDefault<unknown>(storedText, null), incoming);
}

/**
 * Renders one metadata value as PostgreSQL's `->>` operator would.
 *
 * SQLite's `json_extract` yields *native* values — INTEGER/REAL for numbers and
 * `1`/`0` for booleans — while `->>` yields text (`'3'`, `'true'`, `'false'`),
 * so a portable filter such as `isChecklistItem = 'true'` would match on one
 * backend and not the other. `json_type` returns NULL for an absent path, which
 * falls through to `json_extract` and stays NULL, so "key missing" and "key is
 * JSON null" are both SQL NULL on both backends.
 *
 * Placeholders are appended to `params` in the exact order they appear in the
 * emitted fragment; callers must bind any further values *after* calling this.
 */
function metadataAccessor(key: string, caseInsensitive: boolean, params: unknown[]): string {
  const path = `$."${key}"`;
  params.push(path, path);
  const expression = "CASE json_type(d.metadata, ?)"
    + " WHEN 'true' THEN 'true'"
    + " WHEN 'false' THEN 'false'"
    + " WHEN 'null' THEN NULL"
    + ' ELSE CAST(json_extract(d.metadata, ?) AS TEXT) END';
  return caseInsensitive ? `LOWER(${expression})` : expression;
}

interface DocumentSummaryRow {
  id: string;
  index_id: string;
  entity_type: string;
  entity_id: string;
  version: number;
  source_revision: string;
  content_fingerprint: string;
  projection_version: number;
  sensitivity: string;
  retain_until: string | null;
  source_updated_at: string;
  updated_at: string;
  deleted_at: string | null;
  vector_id: string | null;
  vector_document_id: string | null;
  vector_document_version: number | null;
  vector_source_revision: string | null;
  vector_content_fingerprint: string | null;
  vector_projection_version: number | null;
  vector_provider: string | null;
  vector_model: string | null;
  vector_dimensions: number | null;
  vector_sensitivity: string | null;
  vector_expires_at: string | null;
  vector_embedded_at: string | null;
}

function rowToDocumentSummary(row: DocumentSummaryRow): SemanticDocumentSummary {
  return {
    id: row.id,
    indexId: row.index_id,
    entityType: row.entity_type as SemanticEntityType,
    entityId: row.entity_id,
    version: row.version,
    sourceRevision: row.source_revision,
    contentFingerprint: row.content_fingerprint,
    projectionVersion: row.projection_version,
    sensitivity: row.sensitivity as SemanticSensitivity,
    retainUntil: row.retain_until,
    sourceUpdatedAt: row.source_updated_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    vector: row.vector_id === null ? null : {
      id: row.vector_id,
      documentId: row.vector_document_id!,
      documentVersion: row.vector_document_version!,
      sourceRevision: row.vector_source_revision!,
      contentFingerprint: row.vector_content_fingerprint!,
      projectionVersion: row.vector_projection_version!,
      provider: row.vector_provider!,
      model: row.vector_model!,
      dimensions: row.vector_dimensions!,
      sensitivity: row.vector_sensitivity as SemanticSensitivity,
      expiresAt: row.vector_expires_at,
      embeddedAt: row.vector_embedded_at!,
    },
  };
}

/**
 * SQLite-backed `SemanticIndexRepository`.
 *
 * `better-sqlite3` is synchronous and serializes statements within the process,
 * so every multi-step operation is wrapped in `db.transaction(...)` and every
 * state transition is additionally guarded by a `WHERE ... AND status = ?`
 * predicate. That combination makes claims, cutover, and counter maintenance
 * atomic without relying on the caller to sequence calls.
 *
 * Retrieval uses a bounded, ordered in-process scan. It is a compatibility path
 * for small corpora and reports `guaranteesFullRecall: false` — it is not the
 * 100,000-entity target described in the architecture.
 */
export class SqliteSemanticIndexRepository implements SemanticIndexRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly scanLimit: number = getSemanticScanLimit(),
  ) {}

  // ─── Internal helpers ───────────────────────────────────────────────

  private identityRow(id: string): IdentityRow | undefined {
    return this.db
      .prepare('SELECT * FROM semantic_index_identities WHERE id = ?')
      .get(id) as IdentityRow | undefined;
  }

  private requireIdentity(id: string): SemanticIndexIdentity {
    const row = this.identityRow(id);
    if (!row) {
      throw new SemanticIndexValidationError(
        'identity-not-found',
        `Semantic index identity ${id} does not exist`,
      );
    }
    return rowToIdentity(row);
  }

  private requireWritableIdentity(id: string): SemanticIndexIdentity {
    const identity = this.requireIdentity(id);
    if (!SEMANTIC_WRITABLE_IDENTITY_STATUSES.includes(identity.status)) {
      throw new SemanticIndexValidationError(
        'identity-not-writable',
        `Semantic index identity ${id} is ${identity.status} and does not accept writes`,
      );
    }
    return identity;
  }

  private documentRow(
    indexId: string,
    entityType: string,
    entityId: string,
  ): DocumentRow | undefined {
    return this.db.prepare(`
      SELECT * FROM semantic_documents
      WHERE index_id = ? AND entity_type = ? AND entity_id = ?
    `).get(indexId, entityType, entityId) as DocumentRow | undefined;
  }

  private vectorRow(
    indexId: string,
    entityType: string,
    entityId: string,
  ): VectorRow | undefined {
    return this.db.prepare(`
      SELECT * FROM semantic_vectors
      WHERE index_id = ? AND entity_type = ? AND entity_id = ?
    `).get(indexId, entityType, entityId) as VectorRow | undefined;
  }

  private adjustCounts(indexId: string, documents: number, vectors: number, now: string): void {
    if (documents === 0 && vectors === 0) return;
    this.db.prepare(`
      UPDATE semantic_index_identities
      SET document_count = MAX(0, document_count + ?),
          vector_count = MAX(0, vector_count + ?),
          updated_at = ?
      WHERE id = ?
    `).run(documents, vectors, now, indexId);
  }

  private countStaleDocuments(indexId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_documents d
      LEFT JOIN semantic_vectors v
        ON v.index_id = d.index_id
        AND v.entity_type = d.entity_type
        AND v.entity_id = d.entity_id
        AND v.source_revision = d.source_revision
        AND v.document_version = d.version
      WHERE d.index_id = ? AND d.deleted_at IS NULL AND v.id IS NULL
    `).get(indexId) as { count: number };
    return row.count;
  }

  private countIncompatibleVectors(indexId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_vectors v
      INNER JOIN semantic_index_identities i ON i.id = v.index_id
      WHERE v.index_id = ?
        AND (
          v.provider <> i.provider
          OR v.model <> i.model
          OR v.dimensions <> i.dimensions
          OR v.projection_version <> i.projection_version
        )
    `).get(indexId) as { count: number };
    return row.count;
  }

  private entityKindReadiness(indexId: string, now: string): SemanticEntityKindReadiness[] {
    const documents = this.db.prepare(`
      SELECT entity_type AS entityType, COUNT(*) AS count
      FROM semantic_documents
      WHERE index_id = ? AND deleted_at IS NULL
      GROUP BY entity_type
    `).all(indexId) as Array<{ entityType: string; count: number }>;

    const vectors = this.db.prepare(`
      SELECT entity_type AS entityType, COUNT(*) AS count
      FROM semantic_vectors
      WHERE index_id = ?
      GROUP BY entity_type
    `).all(indexId) as Array<{ entityType: string; count: number }>;

    const stale = this.db.prepare(`
      SELECT d.entity_type AS entityType, COUNT(*) AS count
      FROM semantic_documents d
      LEFT JOIN semantic_vectors v
        ON v.index_id = d.index_id
        AND v.entity_type = d.entity_type
        AND v.entity_id = d.entity_id
        AND v.source_revision = d.source_revision
        AND v.document_version = d.version
      WHERE d.index_id = ? AND d.deleted_at IS NULL AND v.id IS NULL
      GROUP BY d.entity_type
    `).all(indexId) as Array<{ entityType: string; count: number }>;

    const incompatible = this.db.prepare(`
      SELECT v.entity_type AS entityType, COUNT(*) AS count
      FROM semantic_vectors v
      INNER JOIN semantic_index_identities i ON i.id = v.index_id
      WHERE v.index_id = ?
        AND (
          v.provider <> i.provider
          OR v.model <> i.model
          OR v.dimensions <> i.dimensions
          OR v.projection_version <> i.projection_version
        )
      GROUP BY v.entity_type
    `).all(indexId) as Array<{ entityType: string; count: number }>;

    const expired = this.db.prepare(`
      SELECT entity_type AS entityType, COUNT(*) AS count
      FROM semantic_documents
      WHERE index_id = ?
        AND deleted_at IS NULL
        AND retain_until IS NOT NULL
        AND retain_until <= ?
      GROUP BY entity_type
    `).all(indexId, now) as Array<{ entityType: string; count: number }>;

    const lookup = (rows: Array<{ entityType: string; count: number }>, kind: string) =>
      rows.find((row) => row.entityType === kind)?.count ?? 0;

    return SEMANTIC_ENTITY_TYPES.map((entityType) => ({
      entityType,
      documents: lookup(documents, entityType),
      vectors: lookup(vectors, entityType),
      stale: lookup(stale, entityType),
      incompatible: lookup(incompatible, entityType),
      expired: lookup(expired, entityType),
    }));
  }

  // ─── Identity lifecycle ─────────────────────────────────────────────

  async createIdentity(input: SemanticIndexIdentityInput): Promise<SemanticIndexIdentity> {
    if (!Number.isSafeInteger(input.dimensions) || input.dimensions <= 0) {
      throw new SemanticIndexValidationError(
        'invalid-argument',
        `Identity dimensions must be a positive integer, received ${String(input.dimensions)}`,
      );
    }
    if (!Number.isSafeInteger(input.projectionVersion) || input.projectionVersion <= 0) {
      throw new SemanticIndexValidationError(
        'invalid-argument',
        'Identity projectionVersion must be a positive integer',
      );
    }
    const status = input.status ?? 'building';
    this.db.prepare(`
      INSERT INTO semantic_index_identities (
        id, provider, model, dimensions, projection_version, status,
        document_count, vector_count, created_at, updated_at,
        ready_at, activated_at, retired_at, failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      input.id,
      input.provider,
      input.model,
      input.dimensions,
      input.projectionVersion,
      status,
      input.now,
      input.now,
      status === 'ready' ? input.now : null,
    );
    return this.requireIdentity(input.id);
  }

  async getIdentity(id: string): Promise<SemanticIndexIdentity | null> {
    const row = this.identityRow(id);
    return row ? rowToIdentity(row) : null;
  }

  async getActiveIdentity(): Promise<SemanticIndexIdentity | null> {
    const row = this.db
      .prepare("SELECT * FROM semantic_index_identities WHERE status = 'active' LIMIT 1")
      .get() as IdentityRow | undefined;
    return row ? rowToIdentity(row) : null;
  }

  async listIdentities(status?: SemanticIndexStatus): Promise<SemanticIndexIdentity[]> {
    const rows = status
      ? this.db.prepare(`
          SELECT * FROM semantic_index_identities
          WHERE status = ?
          ORDER BY COALESCE(ready_at, created_at) DESC, id ASC
        `).all(status) as IdentityRow[]
      : this.db.prepare(`
          SELECT * FROM semantic_index_identities
          ORDER BY created_at DESC, id ASC
        `).all() as IdentityRow[];
    return rows.map(rowToIdentity);
  }

  async markIdentityReady(id: string, now: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_index_identities
      SET status = 'ready',
          ready_at = COALESCE(ready_at, ?),
          failure_reason = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'building'
    `).run(now, now, id);
    return result.changes > 0;
  }

  async markIdentityFailed(id: string, reason: string, now: string): Promise<boolean> {
    // The active identity is never failed in place — that would leave retrieval
    // with no readable identity. Roll back or retire it explicitly instead.
    const result = this.db.prepare(`
      UPDATE semantic_index_identities
      SET status = 'failed', failure_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('building', 'ready')
    `).run(reason, now, id);
    return result.changes > 0;
  }

  async activateIdentity(
    id: string,
    now: string,
    gate: SemanticActivationGate = {},
  ): Promise<SemanticActivationResult> {
    const minVectorCount = gate.minVectorCount ?? 1;
    const maxStaleDocuments = gate.maxStaleDocuments ?? 0;
    const maxIncompatibleVectors = gate.maxIncompatibleVectors ?? 0;

    return this.db.transaction((): SemanticActivationResult => {
      const target = this.identityRow(id);
      if (!target) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'identity-not-found' };
      }
      if (target.status === 'active') {
        return { status: 'rejected', activatedId: null, previousActiveId: id, reason: 'already-active' };
      }
      if (target.status !== 'ready') {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'identity-not-ready' };
      }
      if (target.vector_count < minVectorCount) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-vector-count' };
      }
      if (this.countStaleDocuments(id) > maxStaleDocuments) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-stale-documents' };
      }
      if (this.countIncompatibleVectors(id) > maxIncompatibleVectors) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-incompatible-vectors' };
      }

      const current = this.db
        .prepare("SELECT * FROM semantic_index_identities WHERE status = 'active' LIMIT 1")
        .get() as IdentityRow | undefined;

      // The former active stays `ready` so rollback has a compatible target.
      if (current) {
        this.db.prepare(`
          UPDATE semantic_index_identities
          SET status = 'ready', updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(now, current.id);
      }

      const promoted = this.db.prepare(`
        UPDATE semantic_index_identities
        SET status = 'active', activated_at = ?, ready_at = COALESCE(ready_at, ?), updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(now, now, now, id);
      if (promoted.changes !== 1) {
        throw new Error(`Cutover to semantic index identity ${id} did not apply`);
      }

      return {
        status: 'activated',
        activatedId: id,
        previousActiveId: current?.id ?? null,
      };
    })();
  }

  async rollbackToIdentity(id: string, now: string): Promise<SemanticRollbackResult> {
    return this.db.transaction((): SemanticRollbackResult => {
      const current = this.db
        .prepare("SELECT * FROM semantic_index_identities WHERE status = 'active' LIMIT 1")
        .get() as IdentityRow | undefined;
      if (!current) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'no-active-identity' };
      }
      if (current.id === id) {
        return { status: 'rejected', activatedId: null, previousActiveId: id, reason: 'already-active' };
      }

      const target = this.identityRow(id);
      if (!target) {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'identity-not-found' };
      }
      if (target.status !== 'ready') {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'identity-not-ready' };
      }
      // "Compatible" means the identity is genuinely servable: it holds vectors,
      // and none of them disagree with its declared vector space. Rollback
      // selects a prior identity; it never reinterprets vectors.
      if (target.vector_count <= 0 || this.countIncompatibleVectors(id) > 0) {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'incompatible-identity' };
      }

      this.db.prepare(`
        UPDATE semantic_index_identities
        SET status = 'ready', updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(now, current.id);

      const promoted = this.db.prepare(`
        UPDATE semantic_index_identities
        SET status = 'active', activated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(now, now, id);
      if (promoted.changes !== 1) {
        throw new Error(`Rollback to semantic index identity ${id} did not apply`);
      }

      return { status: 'rolled-back', activatedId: id, previousActiveId: current.id };
    })();
  }

  async retireIdentity(id: string, now: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_index_identities
      SET status = 'retired', retired_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('building', 'ready', 'failed')
    `).run(now, now, id);
    return result.changes > 0;
  }

  async cleanupIdentities(input: { before: string; now: string }): Promise<SemanticCleanupResult> {
    return this.db.transaction((): SemanticCleanupResult => {
      const candidates = this.db.prepare(`
        SELECT id, COALESCE(retired_at, updated_at) AS eligibleAt
        FROM semantic_index_identities
        WHERE status IN ('retired', 'failed')
      `).all() as Array<{ id: string; eligibleAt: string }>;

      const removable = candidates.filter((row) => row.eligibleAt < input.before);
      const skippedIds = candidates
        .filter((row) => row.eligibleAt >= input.before)
        .map((row) => row.id);

      const result: SemanticCleanupResult = {
        identitiesRemoved: 0,
        documentsRemoved: 0,
        vectorsRemoved: 0,
        intentsRemoved: 0,
        runsRemoved: 0,
        skippedIds,
      };

      for (const { id } of removable) {
        // Re-check under the transaction: never delete an identity that became
        // active between selection and deletion.
        const guard = this.db.prepare(`
          SELECT status FROM semantic_index_identities WHERE id = ?
        `).get(id) as { status: string } | undefined;
        if (!guard || (guard.status !== 'retired' && guard.status !== 'failed')) {
          result.skippedIds.push(id);
          continue;
        }
        // Children are removed explicitly rather than relying on the
        // `foreign_keys` pragma being enabled on this connection.
        result.vectorsRemoved += this.db
          .prepare('DELETE FROM semantic_vectors WHERE index_id = ?').run(id).changes;
        result.documentsRemoved += this.db
          .prepare('DELETE FROM semantic_documents WHERE index_id = ?').run(id).changes;
        result.intentsRemoved += this.db
          .prepare('DELETE FROM semantic_intents WHERE index_id = ?').run(id).changes;
        result.runsRemoved += this.db
          .prepare('DELETE FROM semantic_runs WHERE index_id = ?').run(id).changes;
        result.identitiesRemoved += this.db.prepare(`
          DELETE FROM semantic_index_identities
          WHERE id = ? AND status IN ('retired', 'failed')
        `).run(id).changes;
      }

      return result;
    })();
  }

  // ─── Documents ──────────────────────────────────────────────────────

  async upsertDocument(document: SemanticDocumentWrite): Promise<SemanticDocumentWriteResult> {
    return this.db.transaction((): SemanticDocumentWriteResult => {
      const identity = this.requireWritableIdentity(document.indexId);
      validateDocumentWrite(document, identity);

      const keywords = JSON.stringify(document.keywords ?? []);
      const metadata = JSON.stringify(document.metadata ?? {});
      const retainUntil = document.retainUntil ?? null;
      const existing = this.documentRow(document.indexId, document.entityType, document.entityId);

      if (!existing) {
        this.db.prepare(`
          INSERT INTO semantic_documents (
            id, index_id, entity_type, entity_id, version, title, body,
            keywords, metadata, source_revision, content_fingerprint,
            projection_version, sensitivity, retain_until, source_updated_at,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          document.id, document.indexId, document.entityType, document.entityId,
          document.title, document.body, keywords, metadata,
          document.sourceRevision, document.contentFingerprint,
          document.projectionVersion, document.sensitivity, retainUntil,
          document.sourceUpdatedAt, document.now, document.now,
        );
        this.adjustCounts(document.indexId, 1, 0, document.now);
        return {
          status: 'created',
          document: rowToDocument(
            this.documentRow(document.indexId, document.entityType, document.entityId)!,
          ),
        };
      }

      const resurrecting = existing.deleted_at !== null;

      // The monotonic source guard applies to tombstoned rows too: `delete`
      // bumps `source_updated_at`, so a delayed upsert carrying an older
      // projection cannot resurrect an entity the domain already removed.
      if (isStaleSourceUpdate(document.sourceUpdatedAt, existing.source_updated_at)) {
        return {
          status: 'stale',
          document: rowToDocument(existing),
          reason: 'older-source-update',
        };
      }

      const unchanged = !resurrecting
        && existing.source_revision === document.sourceRevision
        && existing.content_fingerprint === document.contentFingerprint
        && existing.projection_version === document.projectionVersion
        && existing.sensitivity === document.sensitivity
        && existing.retain_until === retainUntil
        && existing.source_updated_at === document.sourceUpdatedAt
        && existing.title === document.title
        && existing.body === document.body
        && sameStoredJson(existing.keywords, keywords, document.keywords ?? [])
        && sameStoredJson(existing.metadata, metadata, document.metadata ?? {});

      if (unchanged) {
        return { status: 'unchanged', document: rowToDocument(existing) };
      }

      this.db.prepare(`
        UPDATE semantic_documents
        SET version = version + 1,
            title = ?, body = ?, keywords = ?, metadata = ?,
            source_revision = ?, content_fingerprint = ?, projection_version = ?,
            sensitivity = ?, retain_until = ?, source_updated_at = ?,
            updated_at = ?, deleted_at = NULL
        WHERE id = ?
      `).run(
        document.title, document.body, keywords, metadata,
        document.sourceRevision, document.contentFingerprint,
        document.projectionVersion, document.sensitivity, retainUntil,
        document.sourceUpdatedAt, document.now, existing.id,
      );

      if (resurrecting) this.adjustCounts(document.indexId, 1, 0, document.now);

      return {
        status: 'updated',
        document: rowToDocument(
          this.documentRow(document.indexId, document.entityType, document.entityId)!,
        ),
      };
    })();
  }

  async getDocument(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticDocumentRecord | null> {
    const row = this.documentRow(indexId, entityType, entityId);
    return row ? rowToDocument(row) : null;
  }

  async listDocuments(request: SemanticDocumentListRequest): Promise<SemanticDocumentSummary[]> {
    const limit = assertPositiveInteger(request.limit, 'limit');
    const rows = this.db.prepare(`
      SELECT
        d.id AS id,
        d.index_id AS index_id,
        d.entity_type AS entity_type,
        d.entity_id AS entity_id,
        d.version AS version,
        d.source_revision AS source_revision,
        d.content_fingerprint AS content_fingerprint,
        d.projection_version AS projection_version,
        d.sensitivity AS sensitivity,
        d.retain_until AS retain_until,
        d.source_updated_at AS source_updated_at,
        d.updated_at AS updated_at,
        d.deleted_at AS deleted_at,
        v.id AS vector_id,
        v.document_id AS vector_document_id,
        v.document_version AS vector_document_version,
        v.source_revision AS vector_source_revision,
        v.content_fingerprint AS vector_content_fingerprint,
        v.projection_version AS vector_projection_version,
        v.provider AS vector_provider,
        v.model AS vector_model,
        v.dimensions AS vector_dimensions,
        v.sensitivity AS vector_sensitivity,
        v.expires_at AS vector_expires_at,
        v.embedded_at AS vector_embedded_at
      FROM semantic_documents d
      LEFT JOIN semantic_vectors v
        ON v.index_id = d.index_id
        AND v.entity_type = d.entity_type
        AND v.entity_id = d.entity_id
      WHERE d.index_id = ?
        AND d.entity_type = ?
        AND d.entity_id > ?
        AND (? = 1 OR d.deleted_at IS NULL)
      ORDER BY d.entity_id ASC
      LIMIT ?
    `).all(
      request.indexId,
      request.entityType,
      request.afterEntityId ?? '',
      request.includeDeleted ? 1 : 0,
      limit,
    ) as DocumentSummaryRow[];
    return rows.map(rowToDocumentSummary);
  }

  async deleteDocument(input: {
    indexId: string;
    entityType: SemanticEntityType;
    entityId: string;
    now: string;
    sourceUpdatedAt?: string;
  }): Promise<SemanticDocumentDeleteResult> {
    return this.db.transaction((): SemanticDocumentDeleteResult => {
      const existing = this.documentRow(input.indexId, input.entityType, input.entityId);
      if (!existing) return { status: 'missing', removedVectors: 0 };
      if (existing.deleted_at !== null) return { status: 'already-deleted', removedVectors: 0 };

      const removedVectors = this.db.prepare(`
        DELETE FROM semantic_vectors WHERE document_id = ?
      `).run(existing.id).changes;

      const sourceUpdatedAt = input.sourceUpdatedAt ?? input.now;
      this.db.prepare(`
        UPDATE semantic_documents
        SET deleted_at = ?, updated_at = ?,
            source_updated_at = CASE WHEN ? > source_updated_at THEN ? ELSE source_updated_at END
        WHERE id = ?
      `).run(input.now, input.now, sourceUpdatedAt, sourceUpdatedAt, existing.id);

      this.adjustCounts(input.indexId, -1, -removedVectors, input.now);
      return { status: 'deleted', removedVectors };
    })();
  }

  async expireDocuments(input: { now: string; indexId?: string; limit?: number }): Promise<{
    documentsExpired: number;
    vectorsRemoved: number;
  }> {
    const limit = input.limit ?? 500;
    return this.db.transaction(() => {
      const rows = input.indexId
        ? this.db.prepare(`
            SELECT id, index_id AS indexId FROM semantic_documents
            WHERE index_id = ? AND deleted_at IS NULL
              AND retain_until IS NOT NULL AND retain_until <= ?
            ORDER BY retain_until ASC LIMIT ?
          `).all(input.indexId, input.now, limit) as Array<{ id: string; indexId: string }>
        : this.db.prepare(`
            SELECT id, index_id AS indexId FROM semantic_documents
            WHERE deleted_at IS NULL
              AND retain_until IS NOT NULL AND retain_until <= ?
            ORDER BY retain_until ASC LIMIT ?
          `).all(input.now, limit) as Array<{ id: string; indexId: string }>;

      let documentsExpired = 0;
      let vectorsRemoved = 0;
      for (const row of rows) {
        const removed = this.db
          .prepare('DELETE FROM semantic_vectors WHERE document_id = ?').run(row.id).changes;
        const tombstoned = this.db.prepare(`
          UPDATE semantic_documents SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(input.now, input.now, row.id).changes;
        if (tombstoned > 0) {
          documentsExpired += tombstoned;
          vectorsRemoved += removed;
          this.adjustCounts(row.indexId, -1, -removed, input.now);
        }
      }
      return { documentsExpired, vectorsRemoved };
    })();
  }

  async purgeDeletedDocuments(input: { before: string; limit?: number }): Promise<number> {
    const limit = input.limit ?? 500;
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id FROM semantic_documents
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
        ORDER BY deleted_at ASC LIMIT ?
      `).all(input.before, limit) as Array<{ id: string }>;

      let purged = 0;
      for (const row of rows) {
        this.db.prepare('DELETE FROM semantic_vectors WHERE document_id = ?').run(row.id);
        purged += this.db
          .prepare('DELETE FROM semantic_documents WHERE id = ?').run(row.id).changes;
      }
      return purged;
    })();
  }

  // ─── Vectors ────────────────────────────────────────────────────────

  async upsertVector(vector: SemanticVectorWrite): Promise<SemanticVectorWriteResult> {
    return this.db.transaction((): SemanticVectorWriteResult => {
      const identity = this.requireWritableIdentity(vector.indexId);
      const norm = validateVectorWrite(vector, identity);

      const document = this.db.prepare(`
        SELECT * FROM semantic_documents WHERE id = ? AND index_id = ?
      `).get(vector.documentId, vector.indexId) as DocumentRow | undefined;

      if (!document || document.deleted_at !== null) {
        return { status: 'stale', reason: 'document-missing' };
      }
      if (
        document.entity_type !== vector.entityType
        || document.entity_id !== vector.entityId
      ) {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          `Vector ${vector.id} addresses ${vector.entityType}/${vector.entityId} but document `
          + `${vector.documentId} is ${document.entity_type}/${document.entity_id}`,
        );
      }
      // Conditional write against the source revision: a delayed worker holding
      // an older projection can never overwrite a newer document version.
      if (
        document.version !== vector.documentVersion
        || document.source_revision !== vector.sourceRevision
      ) {
        return { status: 'stale', reason: 'document-superseded' };
      }

      const existing = this.vectorRow(vector.indexId, vector.entityType, vector.entityId);
      const expiresAt = vector.expiresAt ?? null;

      if (existing) {
        if (isStaleSourceUpdate(vector.sourceUpdatedAt, existing.source_updated_at)) {
          return { status: 'stale', reason: 'older-source-update' };
        }
        if (existing.document_version > vector.documentVersion) {
          return { status: 'stale', reason: 'document-superseded' };
        }
        const unchanged = existing.document_id === vector.documentId
          && existing.document_version === vector.documentVersion
          && existing.source_revision === vector.sourceRevision
          && existing.content_fingerprint === vector.contentFingerprint
          && existing.projection_version === vector.projectionVersion
          && existing.provider === vector.provider
          && existing.model === vector.model
          && existing.dimensions === vector.dimensions
          && existing.sensitivity === vector.sensitivity
          && existing.expires_at === expiresAt
          && existing.embedding === serializeEmbedding(vector.embedding);
        if (unchanged) return { status: 'unchanged' };

        this.db.prepare(`
          UPDATE semantic_vectors
          SET document_id = ?, document_version = ?, source_revision = ?,
              content_fingerprint = ?, projection_version = ?, provider = ?,
              model = ?, dimensions = ?, sensitivity = ?, embedding = ?, norm = ?,
              source_updated_at = ?, embedded_at = ?, index_run_id = ?,
              intent_id = ?, expires_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          vector.documentId, vector.documentVersion, vector.sourceRevision,
          vector.contentFingerprint, vector.projectionVersion, vector.provider,
          vector.model, vector.dimensions, vector.sensitivity,
          serializeEmbedding(vector.embedding), String(norm),
          vector.sourceUpdatedAt, vector.embeddedAt, vector.indexRunId,
          vector.intentId, expiresAt, vector.now, existing.id,
        );
        return { status: 'updated' };
      }

      this.db.prepare(`
        INSERT INTO semantic_vectors (
          id, index_id, document_id, document_version, entity_type, entity_id,
          source_revision, content_fingerprint, projection_version,
          provider, model, dimensions, sensitivity, embedding, norm,
          source_updated_at, embedded_at, index_run_id, intent_id, expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vector.id, vector.indexId, vector.documentId, vector.documentVersion,
        vector.entityType, vector.entityId, vector.sourceRevision,
        vector.contentFingerprint, vector.projectionVersion, vector.provider,
        vector.model, vector.dimensions, vector.sensitivity,
        serializeEmbedding(vector.embedding), String(norm),
        vector.sourceUpdatedAt, vector.embeddedAt, vector.indexRunId,
        vector.intentId, expiresAt, vector.now, vector.now,
      );
      this.adjustCounts(vector.indexId, 0, 1, vector.now);
      return { status: 'created' };
    })();
  }

  async getVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticVectorRecord | null> {
    const row = this.vectorRow(indexId, entityType, entityId);
    return row ? rowToVector(row) : null;
  }

  async deleteVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<boolean> {
    return this.db.transaction(() => {
      const removed = this.db.prepare(`
        DELETE FROM semantic_vectors
        WHERE index_id = ? AND entity_type = ? AND entity_id = ?
      `).run(indexId, entityType, entityId).changes;
      if (removed > 0) {
        this.adjustCounts(indexId, 0, -removed, new Date().toISOString());
      }
      return removed > 0;
    })();
  }

  async queryVectors(request: SemanticQueryRequest): Promise<SemanticQueryResponse> {
    const now = request.now ?? new Date().toISOString();

    let identity: SemanticIndexIdentity | null;
    if (request.indexId) {
      identity = this.requireIdentity(request.indexId);
      // Retrieval reads one declared identity. `ready` is permitted so a staged
      // build can be evaluated before cutover; building/retired/failed are not.
      if (identity.status !== 'active' && identity.status !== 'ready') {
        throw new SemanticIndexValidationError(
          'identity-not-queryable',
          `Semantic index identity ${identity.id} is ${identity.status} and cannot serve queries`,
        );
      }
    } else {
      identity = await this.getActiveIdentity();
    }

    const ceiling = this.scanLimit;
    if (!identity) {
      return {
        identityId: null,
        results: [],
        scan: {
          kind: 'bounded-in-process',
          candidatesScanned: 0,
          candidateCeiling: ceiling,
          guaranteesFullRecall: false,
          guaranteedScale: ceiling,
          truncated: false,
        },
      };
    }

    const queryNorm = validateQueryEmbedding(request.queryEmbedding, identity);
    const limit = Math.max(1, Math.min(Math.trunc(request.limit) || 1, 100));
    const minScore = request.minScore ?? 0;
    const metadataFilters = normalizeMetadataFilters(request.metadataFilters);

    const params: unknown[] = [identity.id];
    let sql = `
      SELECT v.id AS id, v.entity_type AS entityType, v.entity_id AS entityId,
             v.embedding AS embedding, v.norm AS norm, v.dimensions AS dimensions,
             v.projection_version AS projectionVersion, v.sensitivity AS sensitivity,
             v.provider AS provider, v.model AS model,
             v.source_revision AS sourceRevision, v.source_updated_at AS sourceUpdatedAt,
             v.embedded_at AS embeddedAt,
             d.title AS title, d.body AS body, d.metadata AS metadata
      FROM semantic_vectors v
      INNER JOIN semantic_documents d ON d.id = v.document_id
      WHERE v.index_id = ?
        AND d.deleted_at IS NULL
        AND (v.expires_at IS NULL OR v.expires_at > ?)
        AND (d.retain_until IS NULL OR d.retain_until > ?)
    `;
    params.push(now, now);

    if (request.entityTypes && request.entityTypes.length > 0) {
      sql += ` AND v.entity_type IN (${request.entityTypes.map(() => '?').join(', ')})`;
      params.push(...request.entityTypes);
    }
    if (request.sensitivities && request.sensitivities.length > 0) {
      sql += ` AND v.sensitivity IN (${request.sensitivities.map(() => '?').join(', ')})`;
      params.push(...request.sensitivities);
    }
    if (request.excludeEntityIds && request.excludeEntityIds.length > 0) {
      sql += ` AND v.entity_id NOT IN (${request.excludeEntityIds.map(() => '?').join(', ')})`;
      params.push(...request.excludeEntityIds);
    }
    // Domain/authorization predicates run in SQL, before the candidate ceiling,
    // so an excluded row can never displace an allowed one from the scan.
    for (const filter of metadataFilters) {
      const caseInsensitive = filter.caseInsensitive === true;
      const clauses = filter.keys.map((key) => {
        const placeholders = filter.values.map(() => '?').join(', ');
        if (filter.match === 'any') {
          const accessor = metadataAccessor(key, caseInsensitive, params);
          params.push(...filter.values);
          return `${accessor} IN (${placeholders})`;
        }
        // An absent key must *pass* an exclusion filter. Without the explicit
        // null branch, three-valued logic would silently drop every row whose
        // metadata simply does not carry the key.
        const nullCheck = metadataAccessor(key, caseInsensitive, params);
        const accessor = metadataAccessor(key, caseInsensitive, params);
        params.push(...filter.values);
        return `(${nullCheck} IS NULL OR ${accessor} NOT IN (${placeholders}))`;
      });
      sql += filter.match === 'any'
        ? ` AND (${clauses.join(' OR ')})`
        : ` AND (${clauses.join(' AND ')})`;
    }

    // One extra row detects a corpus larger than the ceiling, so the response can
    // honestly report that recall is not guaranteed.
    sql += ' ORDER BY v.source_updated_at DESC, v.id ASC LIMIT ?';
    params.push(ceiling + 1);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      entityType: string;
      entityId: string;
      embedding: string;
      norm: string;
      dimensions: number;
      projectionVersion: number;
      sensitivity: string;
      provider: string;
      model: string;
      sourceRevision: string;
      sourceUpdatedAt: string;
      embeddedAt: string;
      title: string;
      body: string;
      metadata: string;
    }>;

    const truncated = rows.length > ceiling;
    const scanned = truncated ? rows.slice(0, ceiling) : rows;

    const scored: SemanticQueryResult[] = [];
    for (const row of scanned) {
      // Incompatible rows are skipped rather than scored: a different vector
      // space is not comparable, and silently scoring it would fabricate recall.
      if (row.dimensions !== identity.dimensions) continue;
      if (row.projectionVersion !== identity.projectionVersion) continue;
      const embedding = parseEmbedding(row.embedding);
      if (!embedding || embedding.length !== identity.dimensions) continue;
      const storedNorm = Number.parseFloat(row.norm);
      if (!Number.isFinite(storedNorm) || storedNorm === 0) continue;

      const score = cosineSimilarity(request.queryEmbedding, queryNorm, embedding, storedNorm);
      if (score < minScore) continue;
      scored.push({
        id: row.id,
        entityType: row.entityType as SemanticEntityType,
        entityId: row.entityId,
        score,
        title: row.title,
        body: row.body,
        metadata: jsonOrDefault<SemanticQueryResult['metadata']>(row.metadata, {}),
        sourceRevision: row.sourceRevision,
        sourceUpdatedAt: row.sourceUpdatedAt,
        embeddedAt: row.embeddedAt,
        projectionVersion: row.projectionVersion,
        sensitivity: row.sensitivity as SemanticSensitivity,
        provider: row.provider,
        model: row.model,
      });
    }

    scored.sort(compareQueryResults);

    return {
      identityId: identity.id,
      results: scored.slice(0, limit),
      scan: {
        kind: 'bounded-in-process',
        candidatesScanned: scanned.length,
        candidateCeiling: ceiling,
        guaranteesFullRecall: false,
        guaranteedScale: ceiling,
        truncated,
      },
    };
  }

  // ─── Intent queue ───────────────────────────────────────────────────

  async enqueueIntent(intent: SemanticIntentEnqueue): Promise<SemanticIntentEnqueueResult> {
    return this.db.transaction((): SemanticIntentEnqueueResult => {
      this.requireWritableIdentity(intent.indexId);
      const availableAt = intent.availableAt ?? intent.now;
      const maxAttempts = intent.maxAttempts ?? getSemanticIntentMaxAttempts();

      const queued = this.db.prepare(`
        SELECT * FROM semantic_intents
        WHERE idempotency_key = ? AND status = 'queued'
      `).get(intent.idempotencyKey) as IntentRow | undefined;

      if (queued) {
        // Never regress a queued row to older work.
        if (queued.requested_at > intent.requestedAt) {
          return { status: 'ignored', intent: rowToIntent(queued) };
        }
        this.db.prepare(`
          UPDATE semantic_intents
          SET kind = ?, entity_type = ?, entity_id = ?, source_revision = ?,
              content_fingerprint = ?, projection_version = ?, requested_at = ?,
              available_at = MIN(available_at, ?), max_attempts = ?, updated_at = ?
          WHERE id = ?
        `).run(
          intent.kind, intent.entityType, intent.entityId,
          intent.sourceRevision ?? null, intent.contentFingerprint ?? null,
          intent.projectionVersion ?? null, intent.requestedAt, availableAt,
          maxAttempts, intent.now, queued.id,
        );
        const updated = this.db
          .prepare('SELECT * FROM semantic_intents WHERE id = ?')
          .get(queued.id) as IntentRow;
        return { status: 'coalesced', intent: rowToIntent(updated) };
      }

      // An in-flight attempt is never mutated. Newer work becomes its own queued
      // row so the running attempt can finish against the projection it claimed.
      const running = this.db.prepare(`
        SELECT 1 FROM semantic_intents
        WHERE idempotency_key = ? AND status = 'running'
        LIMIT 1
      `).get(intent.idempotencyKey) as { 1: number } | undefined;

      this.db.prepare(`
        INSERT INTO semantic_intents (
          id, idempotency_key, index_id, kind, entity_type, entity_id,
          source_revision, content_fingerprint, projection_version, requested_at,
          status, attempt, max_attempts, available_at, lease_owner,
          lease_expires_at, retry_after, last_error, outcome,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        intent.id, intent.idempotencyKey, intent.indexId, intent.kind,
        intent.entityType, intent.entityId, intent.sourceRevision ?? null,
        intent.contentFingerprint ?? null, intent.projectionVersion ?? null,
        intent.requestedAt, maxAttempts, availableAt, intent.now, intent.now,
      );
      const created = this.db
        .prepare('SELECT * FROM semantic_intents WHERE id = ?')
        .get(intent.id) as IntentRow;
      return {
        status: running ? 'superseded' : 'enqueued',
        intent: rowToIntent(created),
      };
    })();
  }

  async claimIntents(request: SemanticIntentClaimRequest): Promise<SemanticIntent[]> {
    const limit = Math.max(1, Math.trunc(request.limit) || 1);
    if (request.entityTypes?.length === 0) return [];
    return this.db.transaction((): SemanticIntent[] => {
      this.recoverExpiredIntentLeasesSync(request.now);
      const leaseExpiresAt = addMs(request.now, request.leaseMs);
      const entityFilter = request.entityTypes
        ? ` AND entity_type IN (${request.entityTypes.map(() => '?').join(', ')})`
        : '';

      const candidates = this.db.prepare(`
        SELECT id FROM semantic_intents
        WHERE index_id = ? AND status = 'queued' AND available_at <= ?
          ${entityFilter}
        ORDER BY requested_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(
        request.indexId,
        request.now,
        ...(request.entityTypes ?? []),
        limit,
      ) as Array<{ id: string }>;

      const claimed: SemanticIntent[] = [];
      for (const candidate of candidates) {
        const updated = this.db.prepare(`
          UPDATE semantic_intents
          SET status = 'running', attempt = attempt + 1, lease_owner = ?,
              lease_expires_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(request.owner, leaseExpiresAt, request.now, candidate.id);
        if (updated.changes !== 1) continue;
        const row = this.db
          .prepare('SELECT * FROM semantic_intents WHERE id = ?')
          .get(candidate.id) as IntentRow;
        claimed.push(rowToIntent(row));
      }
      return claimed;
    })();
  }

  async renewIntentLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_intents
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
    `).run(addMs(input.now, input.leaseMs), input.now, input.id, input.owner, input.now);
    return result.changes > 0;
  }

  async completeIntent(input: SemanticIntentCompletion): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_intents
      SET status = 'succeeded', outcome = ?, completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(input.outcome ?? 'succeeded', input.now, input.now, input.id, input.owner);
    return result.changes > 0;
  }

  async failIntent(input: SemanticIntentFailure): Promise<SemanticIntentStatus | null> {
    return this.db.transaction((): SemanticIntentStatus | null => {
      const row = this.db.prepare(`
        SELECT * FROM semantic_intents
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).get(input.id, input.owner) as IntentRow | undefined;
      if (!row) return null;

      const next = resolveIntentFailureStatus({
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        denied: input.denied,
        terminal: input.terminal,
      });

      if (next === 'queued') {
        // A newer queued row for the same key already carries fresher work; this
        // attempt must not resurrect stale work (and cannot, given the partial
        // unique index on queued idempotency keys).
        const superseding = this.db.prepare(`
          SELECT 1 FROM semantic_intents
          WHERE idempotency_key = ? AND status = 'queued' AND id <> ?
          LIMIT 1
        `).get(row.idempotency_key, row.id) as { 1: number } | undefined;

        if (superseding) {
          this.db.prepare(`
            UPDATE semantic_intents
            SET status = 'expired', outcome = 'superseded', last_error = ?,
                completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = ?
          `).run(input.error, input.now, input.now, row.id);
          return 'expired';
        }

        const availableAt = input.retryAfter
          ?? computeSemanticRetryAt(input.now, row.attempt);
        this.db.prepare(`
          UPDATE semantic_intents
          SET status = 'queued', available_at = ?, retry_after = ?, last_error = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(availableAt, input.retryAfter ?? null, input.error, input.now, row.id);
        return 'queued';
      }

      this.db.prepare(`
        UPDATE semantic_intents
        SET status = ?, outcome = ?, last_error = ?, completed_at = ?,
            updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?
      `).run(
        next,
        next === 'denied' ? 'denied' : 'permanent-failure',
        input.error, input.now, input.now, row.id,
      );
      return next;
    })();
  }

  async getIntent(id: string): Promise<SemanticIntent | null> {
    const row = this.db
      .prepare('SELECT * FROM semantic_intents WHERE id = ?')
      .get(id) as IntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  private recoverExpiredIntentLeasesSync(now: string): { requeued: number; expired: number } {
    const rows = this.db.prepare(`
      SELECT * FROM semantic_intents
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(now) as IntentRow[];

    let requeued = 0;
    let expired = 0;
    for (const row of rows) {
      const superseding = this.db.prepare(`
        SELECT 1 FROM semantic_intents
        WHERE idempotency_key = ? AND status = 'queued' AND id <> ?
        LIMIT 1
      `).get(row.idempotency_key, row.id) as { 1: number } | undefined;

      if (!superseding && row.attempt < row.max_attempts) {
        this.db.prepare(`
          UPDATE semantic_intents
          SET status = 'queued', available_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error = 'Lease expired before completion',
              updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(computeSemanticRetryAt(now, row.attempt), now, row.id);
        requeued += 1;
        continue;
      }

      this.db.prepare(`
        UPDATE semantic_intents
        SET status = 'expired', outcome = ?, last_error = 'Lease expired before completion',
            completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'running'
      `).run(superseding ? 'superseded' : 'attempts-exhausted', now, now, row.id);
      expired += 1;
    }
    return { requeued, expired };
  }

  async recoverExpiredIntentLeases(now: string): Promise<{ requeued: number; expired: number }> {
    return this.db.transaction(() => this.recoverExpiredIntentLeasesSync(now))();
  }

  async pruneIntents(before: string): Promise<number> {
    const result = this.db.prepare(`
      DELETE FROM semantic_intents
      WHERE status IN (${TERMINAL_INTENT_LIST})
        AND completed_at IS NOT NULL AND completed_at < ?
    `).run(before);
    return result.changes;
  }

  // ─── Runs ───────────────────────────────────────────────────────────

  async createRun(run: SemanticRunCreate): Promise<SemanticRunCreateResult> {
    return this.db.transaction((): SemanticRunCreateResult => {
      this.requireIdentity(run.indexId);
      const existing = this.db.prepare(`
        SELECT * FROM semantic_runs WHERE idempotency_key = ?
      `).get(run.idempotencyKey) as RunRow | undefined;

      let checkpoint = run.checkpoint ?? null;
      if (existing) {
        if (!SEMANTIC_RETRYABLE_TERMINAL_RUN_STATUSES.includes(existing.status as SemanticRunStatus)) {
          return { status: 'existing', run: rowToRun(existing) };
        }
        // A run that failed or expired has spent its attempt budget, so the key
        // would otherwise be permanently poisoned — the fixed `backfill:initial`
        // key could never be scheduled again. The terminal row is moved aside
        // rather than deleted so its counters and error stay auditable, and its
        // checkpoint is carried forward so the replacement resumes instead of
        // restarting the corpus.
        checkpoint = run.checkpoint ?? existing.checkpoint;
        this.db.prepare(`
          UPDATE semantic_runs SET idempotency_key = ?, updated_at = ? WHERE id = ?
        `).run(supersededRunIdempotencyKey(run.idempotencyKey, existing.id), run.now, existing.id);
      }

      this.db.prepare(`
        INSERT INTO semantic_runs (
          id, index_id, kind, idempotency_key, status, checkpoint,
          processed_count, failed_count, skipped_count, attempt, max_attempts,
          available_at, lease_owner, lease_expires_at, error_message,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, 0, 0, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)
      `).run(
        run.id, run.indexId, run.kind, run.idempotencyKey, checkpoint,
        run.maxAttempts ?? getSemanticRunMaxAttempts(), run.availableAt ?? run.now,
        run.now, run.now,
      );
      const created = this.db
        .prepare('SELECT * FROM semantic_runs WHERE id = ?')
        .get(run.id) as RunRow;
      return { status: 'created', run: rowToRun(created) };
    })();
  }

  async claimRun(request: SemanticRunClaimRequest): Promise<SemanticRun | null> {
    return this.db.transaction((): SemanticRun | null => {
      this.recoverExpiredRunLeasesSync(request.now);
      const leaseExpiresAt = addMs(request.now, request.leaseMs);

      const params: unknown[] = [request.now];
      let sql = `
        SELECT id FROM semantic_runs r
        WHERE r.status = 'queued' AND r.available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM semantic_runs active
            WHERE active.index_id = r.index_id AND active.kind = r.kind
              AND active.status = 'running'
          )
      `;
      if (request.indexId) {
        sql += ' AND r.index_id = ?';
        params.push(request.indexId);
      }
      if (request.kinds && request.kinds.length > 0) {
        sql += ` AND r.kind IN (${request.kinds.map(() => '?').join(', ')})`;
        params.push(...request.kinds);
      }
      sql += ' ORDER BY r.available_at ASC, r.created_at ASC, r.id ASC LIMIT 1';

      const candidate = this.db.prepare(sql).get(...params) as { id: string } | undefined;
      if (!candidate) return null;

      const claimed = this.db.prepare(`
        UPDATE semantic_runs
        SET status = 'running', lease_owner = ?,
            lease_expires_at = ?, started_at = COALESCE(started_at, ?),
            error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(request.owner, leaseExpiresAt, request.now, request.now, candidate.id);
      if (claimed.changes !== 1) return null;

      const row = this.db
        .prepare('SELECT * FROM semantic_runs WHERE id = ?')
        .get(candidate.id) as RunRow;
      return rowToRun(row);
    })();
  }

  async renewRunLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_runs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
    `).run(addMs(input.now, input.leaseMs), input.now, input.id, input.owner, input.now);
    return result.changes > 0;
  }

  async checkpointRun(input: SemanticRunCheckpoint): Promise<boolean> {
    const leaseExpiresAt = input.leaseMs === undefined
      ? null
      : addMs(input.now, input.leaseMs);
    const result = this.db.prepare(`
      UPDATE semantic_runs
      SET checkpoint = COALESCE(?, checkpoint),
          processed_count = processed_count + ?,
          failed_count = failed_count + ?,
          skipped_count = skipped_count + ?,
          lease_expires_at = COALESCE(?, lease_expires_at),
          updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      input.checkpoint ?? null,
      input.processedDelta ?? 0,
      input.failedDelta ?? 0,
      input.skippedDelta ?? 0,
      leaseExpiresAt,
      input.now,
      input.id,
      input.owner,
    );
    return result.changes > 0;
  }

  async releaseRun(input: {
    id: string;
    owner: string;
    now: string;
    availableAt?: string;
  }): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_runs
      SET status = 'queued', available_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(input.availableAt ?? input.now, input.now, input.id, input.owner);
    return result.changes > 0;
  }

  async completeRun(input: SemanticRunCompletion): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE semantic_runs
      SET status = ?, checkpoint = COALESCE(?, checkpoint), completed_at = ?,
          updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      input.status ?? 'succeeded',
      input.checkpoint ?? null,
      input.now,
      input.now,
      input.id,
      input.owner,
    );
    return result.changes > 0;
  }

  async failRun(input: SemanticRunFailure): Promise<SemanticRunStatus | null> {
    return this.db.transaction((): SemanticRunStatus | null => {
      const row = this.db.prepare(`
        SELECT * FROM semantic_runs
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).get(input.id, input.owner) as RunRow | undefined;
      if (!row) return null;

      // `attempt` counts *failures*, not claims: a run that yields its slice and
      // is reclaimed has not consumed any budget, so the counter is incremented
      // here — atomically with the state transition that spends it.
      const attempt = row.attempt + 1;
      const retry = !input.terminal && attempt < row.max_attempts;
      if (retry) {
        this.db.prepare(`
          UPDATE semantic_runs
          SET status = 'queued', attempt = ?, available_at = ?, error_message = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          attempt,
          input.availableAt ?? computeSemanticRetryAt(input.now, attempt),
          input.error,
          input.now,
          row.id,
        );
        return 'queued';
      }

      this.db.prepare(`
        UPDATE semantic_runs
        SET status = 'failed', attempt = ?, error_message = ?, completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?
      `).run(attempt, input.error, input.now, input.now, row.id);
      return 'failed';
    })();
  }

  async getRun(id: string): Promise<SemanticRun | null> {
    const row = this.db
      .prepare('SELECT * FROM semantic_runs WHERE id = ?')
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  private recoverExpiredRunLeasesSync(now: string): { requeued: number; expired: number } {
    const rows = this.db.prepare(`
      SELECT * FROM semantic_runs
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(now) as RunRow[];

    let requeued = 0;
    let expired = 0;
    for (const row of rows) {
      // An abandoned lease is a recovery attempt, so it spends budget here —
      // atomically with the transition, exactly as `failRun` does.
      const attempt = row.attempt + 1;
      if (attempt < row.max_attempts) {
        // The checkpoint is deliberately preserved so recovery resumes rather
        // than restarting the backfill from the beginning.
        this.db.prepare(`
          UPDATE semantic_runs
          SET status = 'queued', attempt = ?, available_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, error_message = 'Lease expired before completion',
              updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(attempt, computeSemanticRetryAt(now, attempt), now, row.id);
        requeued += 1;
        continue;
      }
      this.db.prepare(`
        UPDATE semantic_runs
        SET status = 'expired', attempt = ?, error_message = 'Lease expired before completion',
            completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'running'
      `).run(attempt, now, now, row.id);
      expired += 1;
    }
    return { requeued, expired };
  }

  async recoverExpiredRunLeases(now: string): Promise<{ requeued: number; expired: number }> {
    return this.db.transaction(() => this.recoverExpiredRunLeasesSync(now))();
  }

  // ─── Observability ──────────────────────────────────────────────────

  async getMetrics(indexId: string, now?: string): Promise<SemanticIndexMetrics> {
    const at = now ?? new Date().toISOString();
    const identity = this.identityRow(indexId);

    const intentCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM semantic_intents
      WHERE index_id = ? GROUP BY status
    `).all(indexId) as Array<{ status: string; count: number }>;

    const retryAggregate = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'queued' AND attempt > 0 THEN 1 ELSE 0 END), 0) AS retrying,
        COALESCE(SUM(CASE WHEN attempt > 1 THEN attempt - 1 ELSE 0 END), 0) AS totalRetries
      FROM semantic_intents
      WHERE index_id = ? AND status IN ('queued', 'running')
    `).get(indexId) as { retrying: number; totalRetries: number };

    const oldestQueued = this.db.prepare(`
      SELECT MIN(created_at) AS oldest FROM semantic_intents
      WHERE index_id = ? AND status = 'queued'
    `).get(indexId) as { oldest: string | null };

    const oldestRunning = this.db.prepare(`
      SELECT MIN(updated_at) AS oldest FROM semantic_intents
      WHERE index_id = ? AND status = 'running'
    `).get(indexId) as { oldest: string | null };

    const count = (rows: Array<{ status: string; count: number }>, status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;

    const intents: SemanticIntentQueueMetrics = {
      queued: count(intentCounts, 'queued'),
      running: count(intentCounts, 'running'),
      retrying: retryAggregate.retrying,
      succeeded: count(intentCounts, 'succeeded'),
      failed: count(intentCounts, 'failed'),
      denied: count(intentCounts, 'denied'),
      expired: count(intentCounts, 'expired'),
      permanentFailures:
        count(intentCounts, 'failed') + count(intentCounts, 'denied') + count(intentCounts, 'expired'),
      totalRetries: retryAggregate.totalRetries,
      oldestQueuedAgeMs: ageMs(oldestQueued.oldest, at),
      oldestRunningAgeMs: ageMs(oldestRunning.oldest, at),
    };

    const runCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM semantic_runs
      WHERE index_id = ? GROUP BY status
    `).all(indexId) as Array<{ status: string; count: number }>;

    const runs: SemanticRunMetrics = {
      queued: count(runCounts, 'queued'),
      running: count(runCounts, 'running'),
      succeeded: count(runCounts, 'succeeded'),
      failed: count(runCounts, 'failed'),
      cancelled: count(runCounts, 'cancelled'),
      expired: count(runCounts, 'expired'),
    };

    // One bounded lookup per kind rather than one unbounded scan: run history
    // grows without limit, but "the newest of each kind" is all progress needs.
    const latestRuns: SemanticRunProgress[] = [];
    for (const kind of SEMANTIC_RUN_KINDS) {
      const row = this.db.prepare(`
        SELECT * FROM semantic_runs
        WHERE index_id = ? AND kind = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(indexId, kind) as RunRow | undefined;
      if (row) latestRuns.push(runProgress(rowToRun(row)));
    }

    return {
      indexId,
      identityStatus: identity ? (identity.status as SemanticIndexStatus) : null,
      documentCount: identity?.document_count ?? 0,
      vectorCount: identity?.vector_count ?? 0,
      intents,
      runs,
      latestRuns,
      byEntityType: this.entityKindReadiness(indexId, at),
    };
  }

  private scanCapability(): SemanticScanCapability {
    return {
      kind: 'bounded-in-process',
      candidateCeiling: this.scanLimit,
      guaranteesFullRecall: false,
      guaranteedScale: this.scanLimit,
    };
  }

  async getReadiness(now?: string): Promise<SemanticIndexReadiness> {
    const at = now ?? new Date().toISOString();
    const active = await this.getActiveIdentity();
    const ready = await this.listIdentities('ready');
    const building = await this.listIdentities('building');
    const staging = [...ready, ...building]
      .filter((identity) => identity.id !== active?.id)
      .map(identityDescriptor);

    if (!active) {
      return {
        available: false,
        activeIdentityId: null,
        provider: null,
        model: null,
        dimensions: null,
        projectionVersion: null,
        documentCount: 0,
        vectorCount: 0,
        readyIdentityIds: ready.map((identity) => identity.id),
        stagingIdentities: staging,
        scan: this.scanCapability(),
        byEntityType: SEMANTIC_ENTITY_TYPES.map((entityType) => ({
          entityType,
          documents: 0,
          vectors: 0,
          stale: 0,
          incompatible: 0,
          expired: 0,
        })),
      };
    }

    return {
      available: active.vectorCount > 0,
      activeIdentityId: active.id,
      provider: active.provider,
      model: active.model,
      dimensions: active.dimensions,
      projectionVersion: active.projectionVersion,
      documentCount: active.documentCount,
      vectorCount: active.vectorCount,
      readyIdentityIds: ready.map((identity) => identity.id),
      stagingIdentities: staging,
      scan: this.scanCapability(),
      byEntityType: this.entityKindReadiness(active.id, at),
    };
  }
}
