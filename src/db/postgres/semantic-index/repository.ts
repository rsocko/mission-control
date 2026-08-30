import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  disabledPostgresVectorCapability,
  POSTGRES_HNSW_MIN_CANDIDATES,
  POSTGRES_HNSW_VALIDATED_SCALE,
  type PostgresVectorCapability,
} from '@/db/postgres/vector-support';
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
  type SemanticIntentQueueMetrics,
  type SemanticIntentStatus,
  type SemanticQueryRequest,
  type SemanticQueryResponse,
  type SemanticQueryResult,
  type SemanticRollbackResult,
  type SemanticRun,
  type SemanticRunCheckpoint,
  type SemanticRunClaimRequest,
  type SemanticRunCompletion,
  type SemanticRunCreate,
  type SemanticRunCreateResult,
  type SemanticRunFailure,
  type SemanticRunMetrics,
  type SemanticRunProgress,
  type SemanticRunStatus,
  type SemanticScanCapability,
  type SemanticSensitivity,
  type SemanticVectorRecord,
  type SemanticVectorWrite,
  type SemanticVectorWriteResult,
} from '@/lib/semantic-index/contracts';
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
} from '@/lib/semantic-index/validation';

type Client = Pool | PoolClient;
const ANN_MAX_CANDIDATES = 1_000;
const ANN_OVERSAMPLE_FACTOR = 10;
export const POSTGRES_ANN_INDEX_PROVISION_TIMEOUT_MS = 900_000;

async function query<T>(client: Client, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows as T[];
}

async function execute(client: Client, text: string, params: unknown[] = []): Promise<number> {
  const result = await client.query(text, params);
  return result.rowCount ?? 0;
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

// ─── Column projections ─────────────────────────────────────────────────────

const IDENTITY_COLUMNS = `
  id,
  provider,
  model,
  dimensions,
  projection_version AS "projectionVersion",
  status,
  document_count AS "documentCount",
  vector_count AS "vectorCount",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  ready_at AS "readyAt",
  activated_at AS "activatedAt",
  retired_at AS "retiredAt",
  failure_reason AS "failureReason"
`;

const DOCUMENT_COLUMNS = `
  id,
  index_id AS "indexId",
  entity_type AS "entityType",
  entity_id AS "entityId",
  version,
  title,
  body,
  keywords,
  metadata,
  source_revision AS "sourceRevision",
  content_fingerprint AS "contentFingerprint",
  projection_version AS "projectionVersion",
  sensitivity,
  retain_until AS "retainUntil",
  source_updated_at AS "sourceUpdatedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt"
`;

const VECTOR_COLUMNS = `
  id,
  index_id AS "indexId",
  document_id AS "documentId",
  document_version AS "documentVersion",
  entity_type AS "entityType",
  entity_id AS "entityId",
  source_revision AS "sourceRevision",
  content_fingerprint AS "contentFingerprint",
  projection_version AS "projectionVersion",
  provider,
  model,
  dimensions,
  sensitivity,
  embedding,
  norm,
  source_updated_at AS "sourceUpdatedAt",
  embedded_at AS "embeddedAt",
  index_run_id AS "indexRunId",
  intent_id AS "intentId",
  expires_at AS "expiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const INTENT_COLUMNS = `
  id,
  idempotency_key AS "idempotencyKey",
  index_id AS "indexId",
  kind,
  entity_type AS "entityType",
  entity_id AS "entityId",
  source_revision AS "sourceRevision",
  content_fingerprint AS "contentFingerprint",
  projection_version AS "projectionVersion",
  requested_at AS "requestedAt",
  status,
  attempt,
  max_attempts AS "maxAttempts",
  available_at AS "availableAt",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  retry_after AS "retryAfter",
  last_error AS "lastError",
  outcome,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt"
`;

const RUN_COLUMNS = `
  id,
  index_id AS "indexId",
  kind,
  idempotency_key AS "idempotencyKey",
  status,
  checkpoint,
  processed_count AS "processedCount",
  failed_count AS "failedCount",
  skipped_count AS "skippedCount",
  attempt,
  max_attempts AS "maxAttempts",
  available_at AS "availableAt",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  error_message AS "errorMessage",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`;

const TERMINAL_INTENT_LIST = SEMANTIC_TERMINAL_INTENT_STATUSES
  .map((status) => `'${status}'`)
  .join(', ');

const DOCUMENT_SUMMARY_COLUMNS = `
  d.id AS id,
  d.index_id AS "indexId",
  d.entity_type AS "entityType",
  d.entity_id AS "entityId",
  d.version AS version,
  d.source_revision AS "sourceRevision",
  d.content_fingerprint AS "contentFingerprint",
  d.projection_version AS "projectionVersion",
  d.sensitivity AS sensitivity,
  d.retain_until AS "retainUntil",
  d.source_updated_at AS "sourceUpdatedAt",
  d.updated_at AS "updatedAt",
  d.deleted_at AS "deletedAt",
  v.id AS "vectorId",
  v.document_id AS "vectorDocumentId",
  v.document_version AS "vectorDocumentVersion",
  v.source_revision AS "vectorSourceRevision",
  v.content_fingerprint AS "vectorContentFingerprint",
  v.projection_version AS "vectorProjectionVersion",
  v.provider AS "vectorProvider",
  v.model AS "vectorModel",
  v.dimensions AS "vectorDimensions",
  v.sensitivity AS "vectorSensitivity",
  v.expires_at AS "vectorExpiresAt",
  v.embedded_at AS "vectorEmbeddedAt"
`;

interface DocumentSummaryRow {
  id: string;
  indexId: string;
  entityType: SemanticEntityType;
  entityId: string;
  version: number;
  sourceRevision: string;
  contentFingerprint: string;
  projectionVersion: number;
  sensitivity: SemanticSensitivity;
  retainUntil: string | null;
  sourceUpdatedAt: string;
  updatedAt: string;
  deletedAt: string | null;
  vectorId: string | null;
  vectorDocumentId: string | null;
  vectorDocumentVersion: number | null;
  vectorSourceRevision: string | null;
  vectorContentFingerprint: string | null;
  vectorProjectionVersion: number | null;
  vectorProvider: string | null;
  vectorModel: string | null;
  vectorDimensions: number | null;
  vectorSensitivity: SemanticSensitivity | null;
  vectorExpiresAt: string | null;
  vectorEmbeddedAt: string | null;
}

function hydrateDocumentSummary(row: DocumentSummaryRow): SemanticDocumentSummary {
  return {
    id: row.id,
    indexId: row.indexId,
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    sourceRevision: row.sourceRevision,
    contentFingerprint: row.contentFingerprint,
    projectionVersion: row.projectionVersion,
    sensitivity: row.sensitivity,
    retainUntil: row.retainUntil,
    sourceUpdatedAt: row.sourceUpdatedAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    vector: row.vectorId === null ? null : {
      id: row.vectorId,
      documentId: row.vectorDocumentId!,
      documentVersion: row.vectorDocumentVersion!,
      sourceRevision: row.vectorSourceRevision!,
      contentFingerprint: row.vectorContentFingerprint!,
      projectionVersion: row.vectorProjectionVersion!,
      provider: row.vectorProvider!,
      model: row.vectorModel!,
      dimensions: row.vectorDimensions!,
      sensitivity: row.vectorSensitivity!,
      expiresAt: row.vectorExpiresAt,
      embeddedAt: row.vectorEmbeddedAt!,
    },
  };
}

type DocumentRow = Omit<SemanticDocumentRecord, 'keywords' | 'metadata'> & {
  keywords: unknown;
  metadata: unknown;
};

type VectorRow = Omit<SemanticVectorRecord, 'embedding' | 'norm'> & {
  embedding: string;
  norm: string;
};

/** `jsonb` is already deserialized by `pg`; the text fallback keeps it safe. */
function hydrateDocument(row: DocumentRow): SemanticDocumentRecord {
  return {
    ...row,
    keywords: jsonOrDefault<string[]>(row.keywords, []),
    metadata: jsonOrDefault<SemanticDocumentRecord['metadata']>(row.metadata, {}),
  };
}

function hydrateVector(row: VectorRow): SemanticVectorRecord {
  return {
    ...row,
    embedding: parseEmbedding(row.embedding) ?? new Float32Array(0),
    norm: Number.parseFloat(row.norm),
  };
}

interface CountRow {
  entityType: string;
  count: string | number;
}

/** `COUNT(*)`/`SUM(...)` arrive as strings from `pg` (bigint/numeric). */
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function annIndexName(indexId: string): string {
  const digest = createHash('sha256').update(indexId).digest('hex').slice(0, 20);
  return `idx_semantic_ann_${digest}`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * PostgreSQL-backed `SemanticIndexRepository`.
 *
 * Mirrors `SqliteSemanticIndexRepository` behaviour exactly, using per-operation
 * transactions plus `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent workers
 * claim disjoint intents/runs without blocking each other or double-claiming.
 * Retrieval uses an identity-scoped pgvector HNSW index when the runtime capability
 * is available, and otherwise honestly reports the bounded in-process fallback.
 */
export class PostgresSemanticIndexRepository implements SemanticIndexRepository {
  private readonly knownAnnIndexes = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly scanLimit: number = getSemanticScanLimit(),
    private readonly vectorCapability: PostgresVectorCapability =
      disabledPostgresVectorCapability(),
  ) {}

  // ─── Internal helpers ───────────────────────────────────────────────

  private async identityRow(
    client: Client,
    id: string,
    forUpdate = false,
  ): Promise<SemanticIndexIdentity | undefined> {
    const [row] = await query<SemanticIndexIdentity>(
      client,
      `SELECT ${IDENTITY_COLUMNS} FROM semantic_index_identities WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return row;
  }

  private async requireIdentity(client: Client, id: string): Promise<SemanticIndexIdentity> {
    const identity = await this.identityRow(client, id);
    if (!identity) {
      throw new SemanticIndexValidationError(
        'identity-not-found',
        `Semantic index identity ${id} does not exist`,
      );
    }
    return identity;
  }

  private async requireWritableIdentity(
    client: Client,
    id: string,
  ): Promise<SemanticIndexIdentity> {
    const identity = await this.requireIdentity(client, id);
    if (!SEMANTIC_WRITABLE_IDENTITY_STATUSES.includes(identity.status)) {
      throw new SemanticIndexValidationError(
        'identity-not-writable',
        `Semantic index identity ${id} is ${identity.status} and does not accept writes`,
      );
    }
    return identity;
  }

  private async adjustCounts(
    client: Client,
    indexId: string,
    documents: number,
    vectors: number,
    now: string,
  ): Promise<void> {
    if (documents === 0 && vectors === 0) return;
    await execute(
      client,
      `
        UPDATE semantic_index_identities
        SET document_count = GREATEST(0, document_count + $1::int),
            vector_count = GREATEST(0, vector_count + $2::int),
            updated_at = $3
        WHERE id = $4
      `,
      [documents, vectors, now, indexId],
    );
  }

  private async countStaleDocuments(client: Client, indexId: string): Promise<number> {
    const [row] = await query<{ count: string }>(
      client,
      `
        SELECT COUNT(*) AS count
        FROM semantic_documents d
        LEFT JOIN semantic_vectors v
          ON v.index_id = d.index_id
          AND v.entity_type = d.entity_type
          AND v.entity_id = d.entity_id
          AND v.source_revision = d.source_revision
          AND v.document_version = d.version
        WHERE d.index_id = $1 AND d.deleted_at IS NULL AND v.id IS NULL
      `,
      [indexId],
    );
    return toNumber(row?.count);
  }

  private async countIncompatibleVectors(client: Client, indexId: string): Promise<number> {
    const [row] = await query<{ count: string }>(
      client,
      `
        SELECT COUNT(*) AS count
        FROM semantic_vectors v
        INNER JOIN semantic_index_identities i ON i.id = v.index_id
        WHERE v.index_id = $1
          AND (
            v.provider <> i.provider
            OR v.model <> i.model
            OR v.dimensions <> i.dimensions
            OR v.projection_version <> i.projection_version
          )
      `,
      [indexId],
    );
    return toNumber(row?.count);
  }

  private async entityKindReadiness(
    client: Client,
    indexId: string,
    now: string,
  ): Promise<SemanticEntityKindReadiness[]> {
    const documents = await query<CountRow>(
      client,
      `
        SELECT entity_type AS "entityType", COUNT(*) AS count
        FROM semantic_documents
        WHERE index_id = $1 AND deleted_at IS NULL
        GROUP BY entity_type
      `,
      [indexId],
    );
    const vectors = await query<CountRow>(
      client,
      `
        SELECT entity_type AS "entityType", COUNT(*) AS count
        FROM semantic_vectors
        WHERE index_id = $1
        GROUP BY entity_type
      `,
      [indexId],
    );
    const stale = await query<CountRow>(
      client,
      `
        SELECT d.entity_type AS "entityType", COUNT(*) AS count
        FROM semantic_documents d
        LEFT JOIN semantic_vectors v
          ON v.index_id = d.index_id
          AND v.entity_type = d.entity_type
          AND v.entity_id = d.entity_id
          AND v.source_revision = d.source_revision
          AND v.document_version = d.version
        WHERE d.index_id = $1 AND d.deleted_at IS NULL AND v.id IS NULL
        GROUP BY d.entity_type
      `,
      [indexId],
    );
    const incompatible = await query<CountRow>(
      client,
      `
        SELECT v.entity_type AS "entityType", COUNT(*) AS count
        FROM semantic_vectors v
        INNER JOIN semantic_index_identities i ON i.id = v.index_id
        WHERE v.index_id = $1
          AND (
            v.provider <> i.provider
            OR v.model <> i.model
            OR v.dimensions <> i.dimensions
            OR v.projection_version <> i.projection_version
          )
        GROUP BY v.entity_type
      `,
      [indexId],
    );
    const expired = await query<CountRow>(
      client,
      `
        SELECT entity_type AS "entityType", COUNT(*) AS count
        FROM semantic_documents
        WHERE index_id = $1
          AND deleted_at IS NULL
          AND retain_until IS NOT NULL
          AND retain_until <= $2
        GROUP BY entity_type
      `,
      [indexId, now],
    );

    const lookup = (rows: CountRow[], kind: string) =>
      toNumber(rows.find((row) => row.entityType === kind)?.count);

    return SEMANTIC_ENTITY_TYPES.map((entityType) => ({
      entityType,
      documents: lookup(documents, entityType),
      vectors: lookup(vectors, entityType),
      stale: lookup(stale, entityType),
      incompatible: lookup(incompatible, entityType),
      expired: lookup(expired, entityType),
    }));
  }

  private supportsAnnDimensions(dimensions: number): boolean {
    return this.vectorCapability.available
      && dimensions <= this.vectorCapability.maxDimensions;
  }

  private async ensureAnnIndex(
    identity: Pick<SemanticIndexIdentity, 'id' | 'dimensions'>,
  ): Promise<boolean> {
    if (!this.supportsAnnDimensions(identity.dimensions)) {
      if (this.vectorCapability.mode === 'required') {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          `Indexed PostgreSQL retrieval supports at most `
          + `${this.vectorCapability.available ? this.vectorCapability.maxDimensions : 0} dimensions`,
        );
      }
      return false;
    }

    const name = annIndexName(identity.id);
    if (this.knownAnnIndexes.has(name)) return true;
    const indexId = quoteSqlLiteral(identity.id);
    const dimensions = identity.dimensions;
    const client = await this.pool.connect();
    let operationError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await client.query(
        `SELECT set_config('statement_timeout', $1, false)`,
        [`${POSTGRES_ANN_INDEX_PROVISION_TIMEOUT_MS}ms`],
      );
      await client.query(
        `SELECT pg_advisory_lock(hashtext($1), hashtext($2))`,
        ['mission-control-semantic-ann', identity.id],
      );
      const [existing] = await query<{ valid: boolean }>(
        client,
        `
          SELECT i.indisvalid AS valid
          FROM pg_class c
          INNER JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.oid = to_regclass($1)
        `,
        [name],
      );
      if (existing && !existing.valid) {
        await client.query(`DROP INDEX CONCURRENTLY "${name}"`);
      }
      if (!existing?.valid) {
        await client.query(`
          CREATE INDEX CONCURRENTLY "${name}"
          ON semantic_vector_ann
          USING hnsw ((embedding::halfvec(${dimensions})) halfvec_cosine_ops)
          WITH (m = 16, ef_construction = 64)
          WHERE index_id = ${indexId} AND dimensions = ${dimensions}
        `);
      }
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await client.query(
          `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
          ['mission-control-semantic-ann', identity.id],
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await client.query('RESET statement_timeout');
      } catch (error) {
        cleanupErrors.push(error);
      }
      const releaseError = cleanupErrors.find(
        (error): error is Error => error instanceof Error,
      );
      client.release(releaseError);
    }
    if (operationError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `PostgreSQL HNSW index creation and advisory-lock cleanup failed`,
      );
    }
    if (operationError) throw operationError;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        `PostgreSQL HNSW advisory-lock and timeout cleanup failed`,
      );
    }
    this.knownAnnIndexes.add(name);
    return true;
  }

  private async annIndexExists(
    identity: Pick<SemanticIndexIdentity, 'id' | 'dimensions'>,
  ): Promise<boolean> {
    if (!this.supportsAnnDimensions(identity.dimensions)) return false;
    const name = annIndexName(identity.id);
    if (this.knownAnnIndexes.has(name)) return true;
    const [row] = await query<{ present: boolean }>(
      this.pool,
      `
        SELECT to_regclass($1) IS NOT NULL
          AND COALESCE((
            SELECT i.indisvalid
            FROM pg_class c
            INNER JOIN pg_index i ON i.indexrelid = c.oid
            WHERE c.oid = to_regclass($1)
          ), false) AS present
      `,
      [name],
    );
    if (row?.present) this.knownAnnIndexes.add(name);
    return row?.present === true;
  }

  private async upsertAnnVector(
    client: Client,
    vectorId: string,
    vector: SemanticVectorWrite,
    document: {
      metadata: unknown;
      retainUntil: string | null;
    },
    serialized: string,
  ): Promise<void> {
    if (!this.supportsAnnDimensions(vector.dimensions)) return;
    await execute(
      client,
      `
        INSERT INTO semantic_vector_ann (
          vector_id, index_id, document_id, entity_type, entity_id,
          sensitivity, metadata, dimensions, embedding, source_revision,
          source_updated_at, embedded_at, expires_at, retain_until
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::vector, $10, $11, $12, $13, $14
        )
        ON CONFLICT (vector_id) DO UPDATE SET
          index_id = EXCLUDED.index_id,
          document_id = EXCLUDED.document_id,
          entity_type = EXCLUDED.entity_type,
          entity_id = EXCLUDED.entity_id,
          sensitivity = EXCLUDED.sensitivity,
          metadata = EXCLUDED.metadata,
          dimensions = EXCLUDED.dimensions,
          embedding = EXCLUDED.embedding,
          source_revision = EXCLUDED.source_revision,
          source_updated_at = EXCLUDED.source_updated_at,
          embedded_at = EXCLUDED.embedded_at,
          expires_at = EXCLUDED.expires_at,
          retain_until = EXCLUDED.retain_until
      `,
      [
        vectorId, vector.indexId, vector.documentId, vector.entityType, vector.entityId,
        vector.sensitivity, JSON.stringify(document.metadata ?? {}), vector.dimensions,
        serialized, vector.sourceRevision, vector.sourceUpdatedAt, vector.embeddedAt,
        vector.expiresAt ?? null, document.retainUntil,
      ],
    );
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
    if (status === 'ready' && this.vectorCapability.mode === 'required') {
      if (!this.supportsAnnDimensions(input.dimensions)) {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          `Indexed PostgreSQL retrieval supports at most `
          + `${this.vectorCapability.available ? this.vectorCapability.maxDimensions : 0} dimensions`,
        );
      }
    }
    const provisionIndex = status === 'ready' && this.supportsAnnDimensions(input.dimensions);
    const persistedStatus = provisionIndex ? 'building' : status;
    const created = await withTransaction(this.pool, async (client) => {
      const [row] = await query<SemanticIndexIdentity>(
        client,
        `
          INSERT INTO semantic_index_identities (
            id, provider, model, dimensions, projection_version, status,
            document_count, vector_count, created_at, updated_at,
            ready_at, activated_at, retired_at, failure_reason
          ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $7, $8, NULL, NULL, NULL)
          RETURNING ${IDENTITY_COLUMNS}
        `,
        [
          input.id,
          input.provider,
          input.model,
          input.dimensions,
          input.projectionVersion,
          persistedStatus,
          input.now,
          persistedStatus === 'ready' ? input.now : null,
        ],
      );
      return row;
    });
    if (!provisionIndex) return created;
    await this.ensureAnnIndex(created);
    const changed = await this.markIdentityReady(created.id, input.now);
    if (!changed) {
      throw new Error(`Semantic identity ${created.id} could not be marked ready after HNSW creation`);
    }
    return {
      ...created,
      status: 'ready',
      readyAt: input.now,
      updatedAt: input.now,
    };
  }

  async getIdentity(id: string): Promise<SemanticIndexIdentity | null> {
    return (await this.identityRow(this.pool, id)) ?? null;
  }

  async getActiveIdentity(): Promise<SemanticIndexIdentity | null> {
    const [row] = await query<SemanticIndexIdentity>(
      this.pool,
      `SELECT ${IDENTITY_COLUMNS} FROM semantic_index_identities WHERE status = 'active' LIMIT 1`,
    );
    return row ?? null;
  }

  async listIdentities(status?: SemanticIndexStatus): Promise<SemanticIndexIdentity[]> {
    if (status) {
      return query<SemanticIndexIdentity>(
        this.pool,
        `
          SELECT ${IDENTITY_COLUMNS} FROM semantic_index_identities
          WHERE status = $1
          ORDER BY COALESCE(ready_at, created_at) DESC, id ASC
        `,
        [status],
      );
    }
    return query<SemanticIndexIdentity>(
      this.pool,
      `SELECT ${IDENTITY_COLUMNS} FROM semantic_index_identities ORDER BY created_at DESC, id ASC`,
    );
  }

  async markIdentityReady(id: string, now: string): Promise<boolean> {
    const identity = await this.identityRow(this.pool, id);
    if (!identity || identity.status !== 'building') return false;
    await this.ensureAnnIndex(identity);
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_index_identities
        SET status = 'ready', ready_at = COALESCE(ready_at, $1), failure_reason = NULL, updated_at = $1
        WHERE id = $2 AND status = 'building'
      `,
      [now, id],
    );
    return changed > 0;
  }

  async markIdentityFailed(id: string, reason: string, now: string): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_index_identities
        SET status = 'failed', failure_reason = $1, updated_at = $2
        WHERE id = $3 AND status IN ('building', 'ready')
      `,
      [reason, now, id],
    );
    return changed > 0;
  }

  async activateIdentity(
    id: string,
    now: string,
    gate: SemanticActivationGate = {},
  ): Promise<SemanticActivationResult> {
    const minVectorCount = gate.minVectorCount ?? 1;
    const maxStaleDocuments = gate.maxStaleDocuments ?? 0;
    const maxIncompatibleVectors = gate.maxIncompatibleVectors ?? 0;

    return withTransaction(this.pool, async (client): Promise<SemanticActivationResult> => {
      const target = await this.identityRow(client, id, true);
      if (!target) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'identity-not-found' };
      }
      if (target.status === 'active') {
        return { status: 'rejected', activatedId: null, previousActiveId: id, reason: 'already-active' };
      }
      if (target.status !== 'ready') {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'identity-not-ready' };
      }
      if (target.vectorCount < minVectorCount) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-vector-count' };
      }
      if ((await this.countStaleDocuments(client, id)) > maxStaleDocuments) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-stale-documents' };
      }
      if ((await this.countIncompatibleVectors(client, id)) > maxIncompatibleVectors) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'gate-incompatible-vectors' };
      }

      const [current] = await query<{ id: string }>(
        client,
        `SELECT id FROM semantic_index_identities WHERE status = 'active' LIMIT 1 FOR UPDATE`,
      );
      // The former active stays `ready` so rollback has a compatible target.
      if (current) {
        await execute(
          client,
          `
            UPDATE semantic_index_identities
            SET status = 'ready', updated_at = $1
            WHERE id = $2 AND status = 'active'
          `,
          [now, current.id],
        );
      }

      const promoted = await execute(
        client,
        `
          UPDATE semantic_index_identities
          SET status = 'active', activated_at = $1, ready_at = COALESCE(ready_at, $1), updated_at = $1
          WHERE id = $2 AND status = 'ready'
        `,
        [now, id],
      );
      if (promoted !== 1) {
        throw new Error(`Cutover to semantic index identity ${id} did not apply`);
      }

      return { status: 'activated', activatedId: id, previousActiveId: current?.id ?? null };
    });
  }

  async rollbackToIdentity(id: string, now: string): Promise<SemanticRollbackResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticRollbackResult> => {
      const [current] = await query<{ id: string }>(
        client,
        `SELECT id FROM semantic_index_identities WHERE status = 'active' LIMIT 1 FOR UPDATE`,
      );
      if (!current) {
        return { status: 'rejected', activatedId: null, previousActiveId: null, reason: 'no-active-identity' };
      }
      if (current.id === id) {
        return { status: 'rejected', activatedId: null, previousActiveId: id, reason: 'already-active' };
      }

      const target = await this.identityRow(client, id, true);
      if (!target) {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'identity-not-found' };
      }
      if (target.status !== 'ready') {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'identity-not-ready' };
      }
      // "Compatible" means genuinely servable: it holds vectors and none of them
      // disagree with its declared vector space. Rollback selects a prior
      // identity; it never reinterprets vectors.
      if (target.vectorCount <= 0 || (await this.countIncompatibleVectors(client, id)) > 0) {
        return { status: 'rejected', activatedId: null, previousActiveId: current.id, reason: 'incompatible-identity' };
      }

      await execute(
        client,
        `
          UPDATE semantic_index_identities
          SET status = 'ready', updated_at = $1
          WHERE id = $2 AND status = 'active'
        `,
        [now, current.id],
      );
      const promoted = await execute(
        client,
        `
          UPDATE semantic_index_identities
          SET status = 'active', activated_at = $1, updated_at = $1
          WHERE id = $2 AND status = 'ready'
        `,
        [now, id],
      );
      if (promoted !== 1) {
        throw new Error(`Rollback to semantic index identity ${id} did not apply`);
      }

      return { status: 'rolled-back', activatedId: id, previousActiveId: current.id };
    });
  }

  async retireIdentity(id: string, now: string): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_index_identities
        SET status = 'retired', retired_at = $1, updated_at = $1
        WHERE id = $2 AND status IN ('building', 'ready', 'failed')
      `,
      [now, id],
    );
    return changed > 0;
  }

  async cleanupIdentities(input: { before: string; now: string }): Promise<SemanticCleanupResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticCleanupResult> => {
      const candidates = await query<{ id: string; dimensions: number; eligibleAt: string }>(
        client,
        `
          SELECT id, dimensions, COALESCE(retired_at, updated_at) AS "eligibleAt"
          FROM semantic_index_identities
          WHERE status IN ('retired', 'failed')
          FOR UPDATE
        `,
      );

      const result: SemanticCleanupResult = {
        identitiesRemoved: 0,
        documentsRemoved: 0,
        vectorsRemoved: 0,
        intentsRemoved: 0,
        runsRemoved: 0,
        skippedIds: candidates.filter((row) => row.eligibleAt >= input.before).map((row) => row.id),
      };

      for (const candidate of candidates.filter((row) => row.eligibleAt < input.before)) {
        const [guard] = await query<{ status: string }>(
          client,
          `SELECT status FROM semantic_index_identities WHERE id = $1`,
          [candidate.id],
        );
        if (!guard || (guard.status !== 'retired' && guard.status !== 'failed')) {
          result.skippedIds.push(candidate.id);
          continue;
        }
        result.vectorsRemoved += await execute(
          client, `DELETE FROM semantic_vectors WHERE index_id = $1`, [candidate.id],
        );
        result.documentsRemoved += await execute(
          client, `DELETE FROM semantic_documents WHERE index_id = $1`, [candidate.id],
        );
        result.intentsRemoved += await execute(
          client, `DELETE FROM semantic_intents WHERE index_id = $1`, [candidate.id],
        );
        result.runsRemoved += await execute(
          client, `DELETE FROM semantic_runs WHERE index_id = $1`, [candidate.id],
        );
        result.identitiesRemoved += await execute(
          client,
          `DELETE FROM semantic_index_identities WHERE id = $1 AND status IN ('retired', 'failed')`,
          [candidate.id],
        );
        const indexName = annIndexName(candidate.id);
        await client.query(`DROP INDEX IF EXISTS "${indexName}"`);
        this.knownAnnIndexes.delete(indexName);
      }

      return result;
    });
  }

  // ─── Documents ──────────────────────────────────────────────────────

  async upsertDocument(document: SemanticDocumentWrite): Promise<SemanticDocumentWriteResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticDocumentWriteResult> => {
      const identity = await this.requireWritableIdentity(client, document.indexId);
      validateDocumentWrite(document, identity);

      const keywords = document.keywords ?? [];
      const metadata = document.metadata ?? {};
      const retainUntil = document.retainUntil ?? null;

      const [existing] = await query<DocumentRow>(
        client,
        `
          SELECT ${DOCUMENT_COLUMNS} FROM semantic_documents
          WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
          FOR UPDATE
        `,
        [document.indexId, document.entityType, document.entityId],
      );

      if (!existing) {
        const [created] = await query<DocumentRow>(
          client,
          `
            INSERT INTO semantic_documents (
              id, index_id, entity_type, entity_id, version, title, body,
              keywords, metadata, source_revision, content_fingerprint,
              projection_version, sensitivity, retain_until, source_updated_at,
              created_at, updated_at, deleted_at
            ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $15, NULL)
            RETURNING ${DOCUMENT_COLUMNS}
          `,
          [
            document.id, document.indexId, document.entityType, document.entityId,
            document.title, document.body, JSON.stringify(keywords), JSON.stringify(metadata),
            document.sourceRevision, document.contentFingerprint, document.projectionVersion,
            document.sensitivity, retainUntil, document.sourceUpdatedAt, document.now,
          ],
        );
        await this.adjustCounts(client, document.indexId, 1, 0, document.now);
        return { status: 'created', document: hydrateDocument(created) };
      }

      const resurrecting = existing.deletedAt !== null;

      // The monotonic source guard applies to tombstoned rows too: `delete`
      // bumps `source_updated_at`, so a delayed upsert carrying an older
      // projection cannot resurrect an entity the domain already removed.
      if (isStaleSourceUpdate(document.sourceUpdatedAt, existing.sourceUpdatedAt)) {
        return {
          status: 'stale',
          document: hydrateDocument(existing),
          reason: 'older-source-update',
        };
      }

      const hydratedExisting = hydrateDocument(existing);
      const unchanged = !resurrecting
        && hydratedExisting.sourceRevision === document.sourceRevision
        && hydratedExisting.contentFingerprint === document.contentFingerprint
        && hydratedExisting.projectionVersion === document.projectionVersion
        && hydratedExisting.sensitivity === document.sensitivity
        && hydratedExisting.retainUntil === retainUntil
        && hydratedExisting.sourceUpdatedAt === document.sourceUpdatedAt
        && hydratedExisting.title === document.title
        && hydratedExisting.body === document.body
        // `keywords` and `metadata` are jsonb: PostgreSQL keeps its own key
        // order, so these must be compared canonically. A byte comparison would
        // report every no-op rewrite as a change and bump the version — which
        // marks the entity's vector stale and pays for a re-embedding.
        && jsonEquals(hydratedExisting.keywords, keywords)
        && jsonEquals(hydratedExisting.metadata, metadata);

      if (unchanged) return { status: 'unchanged', document: hydratedExisting };

      const [updated] = await query<DocumentRow>(
        client,
        `
          UPDATE semantic_documents
          SET version = version + 1,
              title = $1, body = $2, keywords = $3::jsonb, metadata = $4::jsonb,
              source_revision = $5, content_fingerprint = $6, projection_version = $7,
              sensitivity = $8, retain_until = $9, source_updated_at = $10,
              updated_at = $11, deleted_at = NULL
          WHERE id = $12
          RETURNING ${DOCUMENT_COLUMNS}
        `,
        [
          document.title, document.body, JSON.stringify(keywords), JSON.stringify(metadata),
          document.sourceRevision, document.contentFingerprint, document.projectionVersion,
          document.sensitivity, retainUntil, document.sourceUpdatedAt, document.now, existing.id,
        ],
      );

      if (this.vectorCapability.available) {
        await execute(
          client,
          `DELETE FROM semantic_vector_ann WHERE document_id = $1`,
          [existing.id],
        );
      }
      if (resurrecting) await this.adjustCounts(client, document.indexId, 1, 0, document.now);
      return { status: 'updated', document: hydrateDocument(updated) };
    });
  }

  async getDocument(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticDocumentRecord | null> {
    const [row] = await query<DocumentRow>(
      this.pool,
      `
        SELECT ${DOCUMENT_COLUMNS} FROM semantic_documents
        WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
      `,
      [indexId, entityType, entityId],
    );
    return row ? hydrateDocument(row) : null;
  }

  async listDocuments(request: SemanticDocumentListRequest): Promise<SemanticDocumentSummary[]> {
    const limit = assertPositiveInteger(request.limit, 'limit');
    const rows = await query<DocumentSummaryRow>(
      this.pool,
      `
        SELECT ${DOCUMENT_SUMMARY_COLUMNS}
        FROM semantic_documents d
        LEFT JOIN semantic_vectors v
          ON v.index_id = d.index_id
          AND v.entity_type = d.entity_type
          AND v.entity_id = d.entity_id
        WHERE d.index_id = $1
          AND d.entity_type = $2
          AND d.entity_id > $3
          AND ($4 OR d.deleted_at IS NULL)
        ORDER BY d.entity_id ASC
        LIMIT $5
      `,
      [
        request.indexId,
        request.entityType,
        request.afterEntityId ?? '',
        request.includeDeleted === true,
        limit,
      ],
    );
    return rows.map(hydrateDocumentSummary);
  }

  async deleteDocument(input: {
    indexId: string;
    entityType: SemanticEntityType;
    entityId: string;
    now: string;
    sourceUpdatedAt?: string;
  }): Promise<SemanticDocumentDeleteResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticDocumentDeleteResult> => {
      const [existing] = await query<{ id: string; deletedAt: string | null }>(
        client,
        `
          SELECT id, deleted_at AS "deletedAt" FROM semantic_documents
          WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
          FOR UPDATE
        `,
        [input.indexId, input.entityType, input.entityId],
      );
      if (!existing) return { status: 'missing', removedVectors: 0 };
      if (existing.deletedAt !== null) return { status: 'already-deleted', removedVectors: 0 };

      const removedVectors = await execute(
        client, `DELETE FROM semantic_vectors WHERE document_id = $1`, [existing.id],
      );
      await execute(
        client,
        `
          UPDATE semantic_documents
          SET deleted_at = $1, updated_at = $1,
              source_updated_at = GREATEST(source_updated_at, $3::text)
          WHERE id = $2
        `,
        [input.now, existing.id, input.sourceUpdatedAt ?? input.now],
      );
      await this.adjustCounts(client, input.indexId, -1, -removedVectors, input.now);
      return { status: 'deleted', removedVectors };
    });
  }

  async expireDocuments(input: { now: string; indexId?: string; limit?: number }): Promise<{
    documentsExpired: number;
    vectorsRemoved: number;
  }> {
    const limit = input.limit ?? 500;
    return withTransaction(this.pool, async (client) => {
      const rows = input.indexId
        ? await query<{ id: string; indexId: string }>(
          client,
          `
            SELECT id, index_id AS "indexId" FROM semantic_documents
            WHERE index_id = $1 AND deleted_at IS NULL
              AND retain_until IS NOT NULL AND retain_until <= $2
            ORDER BY retain_until ASC LIMIT $3
            FOR UPDATE SKIP LOCKED
          `,
          [input.indexId, input.now, limit],
        )
        : await query<{ id: string; indexId: string }>(
          client,
          `
            SELECT id, index_id AS "indexId" FROM semantic_documents
            WHERE deleted_at IS NULL
              AND retain_until IS NOT NULL AND retain_until <= $1
            ORDER BY retain_until ASC LIMIT $2
            FOR UPDATE SKIP LOCKED
          `,
          [input.now, limit],
        );

      let documentsExpired = 0;
      let vectorsRemoved = 0;
      for (const row of rows) {
        const removed = await execute(
          client, `DELETE FROM semantic_vectors WHERE document_id = $1`, [row.id],
        );
        const tombstoned = await execute(
          client,
          `
            UPDATE semantic_documents SET deleted_at = $1, updated_at = $1
            WHERE id = $2 AND deleted_at IS NULL
          `,
          [input.now, row.id],
        );
        if (tombstoned > 0) {
          documentsExpired += tombstoned;
          vectorsRemoved += removed;
          await this.adjustCounts(client, row.indexId, -1, -removed, input.now);
        }
      }
      return { documentsExpired, vectorsRemoved };
    });
  }

  async purgeDeletedDocuments(input: { before: string; limit?: number }): Promise<number> {
    const limit = input.limit ?? 500;
    return withTransaction(this.pool, async (client) => {
      const rows = await query<{ id: string }>(
        client,
        `
          SELECT id FROM semantic_documents
          WHERE deleted_at IS NOT NULL AND deleted_at < $1
          ORDER BY deleted_at ASC LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [input.before, limit],
      );
      let purged = 0;
      for (const row of rows) {
        await execute(client, `DELETE FROM semantic_vectors WHERE document_id = $1`, [row.id]);
        purged += await execute(client, `DELETE FROM semantic_documents WHERE id = $1`, [row.id]);
      }
      return purged;
    });
  }

  // ─── Vectors ────────────────────────────────────────────────────────

  async upsertVector(vector: SemanticVectorWrite): Promise<SemanticVectorWriteResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticVectorWriteResult> => {
      const identity = await this.requireWritableIdentity(client, vector.indexId);
      const norm = validateVectorWrite(vector, identity);

      const [document] = await query<{
        id: string;
        entityType: string;
        entityId: string;
        version: number;
        sourceRevision: string;
        deletedAt: string | null;
        metadata: unknown;
        retainUntil: string | null;
      }>(
        client,
        `
          SELECT id, entity_type AS "entityType", entity_id AS "entityId", version,
                 source_revision AS "sourceRevision", deleted_at AS "deletedAt",
                 metadata, retain_until AS "retainUntil"
          FROM semantic_documents
          WHERE id = $1 AND index_id = $2
          FOR UPDATE
        `,
        [vector.documentId, vector.indexId],
      );

      if (!document || document.deletedAt !== null) {
        return { status: 'stale', reason: 'document-missing' };
      }
      if (document.entityType !== vector.entityType || document.entityId !== vector.entityId) {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          `Vector ${vector.id} addresses ${vector.entityType}/${vector.entityId} but document `
          + `${vector.documentId} is ${document.entityType}/${document.entityId}`,
        );
      }
      // Conditional write against the source revision: a delayed worker holding
      // an older projection can never overwrite a newer document version.
      if (document.version !== vector.documentVersion
        || document.sourceRevision !== vector.sourceRevision) {
        return { status: 'stale', reason: 'document-superseded' };
      }

      const [existing] = await query<VectorRow>(
        client,
        `
          SELECT ${VECTOR_COLUMNS} FROM semantic_vectors
          WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
          FOR UPDATE
        `,
        [vector.indexId, vector.entityType, vector.entityId],
      );
      const expiresAt = vector.expiresAt ?? null;
      const serialized = serializeEmbedding(vector.embedding);

      if (existing) {
        if (isStaleSourceUpdate(vector.sourceUpdatedAt, existing.sourceUpdatedAt)) {
          return { status: 'stale', reason: 'older-source-update' };
        }
        if (existing.documentVersion > vector.documentVersion) {
          return { status: 'stale', reason: 'document-superseded' };
        }
        const unchanged = existing.documentId === vector.documentId
          && existing.documentVersion === vector.documentVersion
          && existing.sourceRevision === vector.sourceRevision
          && existing.contentFingerprint === vector.contentFingerprint
          && existing.projectionVersion === vector.projectionVersion
          && existing.provider === vector.provider
          && existing.model === vector.model
          && existing.dimensions === vector.dimensions
          && existing.sensitivity === vector.sensitivity
          && existing.expiresAt === expiresAt
          && existing.embedding === serialized;
        if (unchanged) {
          await this.upsertAnnVector(client, existing.id, vector, document, serialized);
          return { status: 'unchanged' };
        }

        await execute(
          client,
          `
            UPDATE semantic_vectors
            SET document_id = $1, document_version = $2, source_revision = $3,
                content_fingerprint = $4, projection_version = $5, provider = $6,
                model = $7, dimensions = $8, sensitivity = $9, embedding = $10, norm = $11,
                source_updated_at = $12, embedded_at = $13, index_run_id = $14,
                intent_id = $15, expires_at = $16, updated_at = $17
            WHERE id = $18
          `,
          [
            vector.documentId, vector.documentVersion, vector.sourceRevision,
            vector.contentFingerprint, vector.projectionVersion, vector.provider,
            vector.model, vector.dimensions, vector.sensitivity, serialized, String(norm),
            vector.sourceUpdatedAt, vector.embeddedAt, vector.indexRunId,
            vector.intentId, expiresAt, vector.now, existing.id,
          ],
        );
        await this.upsertAnnVector(client, existing.id, vector, document, serialized);
        return { status: 'updated' };
      }

      await execute(
        client,
        `
          INSERT INTO semantic_vectors (
            id, index_id, document_id, document_version, entity_type, entity_id,
            source_revision, content_fingerprint, projection_version,
            provider, model, dimensions, sensitivity, embedding, norm,
            source_updated_at, embedded_at, index_run_id, intent_id, expires_at,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)
        `,
        [
          vector.id, vector.indexId, vector.documentId, vector.documentVersion,
          vector.entityType, vector.entityId, vector.sourceRevision,
          vector.contentFingerprint, vector.projectionVersion, vector.provider,
          vector.model, vector.dimensions, vector.sensitivity, serialized, String(norm),
          vector.sourceUpdatedAt, vector.embeddedAt, vector.indexRunId,
          vector.intentId, expiresAt, vector.now,
        ],
      );
      await this.upsertAnnVector(client, vector.id, vector, document, serialized);
      await this.adjustCounts(client, vector.indexId, 0, 1, vector.now);
      return { status: 'created' };
    });
  }

  async getVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticVectorRecord | null> {
    const [row] = await query<VectorRow>(
      this.pool,
      `
        SELECT ${VECTOR_COLUMNS} FROM semantic_vectors
        WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
      `,
      [indexId, entityType, entityId],
    );
    return row ? hydrateVector(row) : null;
  }

  async deleteVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const removed = await execute(
        client,
        `
          DELETE FROM semantic_vectors
          WHERE index_id = $1 AND entity_type = $2 AND entity_id = $3
        `,
        [indexId, entityType, entityId],
      );
      if (removed > 0) {
        await this.adjustCounts(client, indexId, 0, -removed, new Date().toISOString());
      }
      return removed > 0;
    });
  }

  private async queryVectorsIndexed(
    request: SemanticQueryRequest,
    identity: SemanticIndexIdentity,
    now: string,
    queryNorm: number,
    limit: number,
    minScore: number,
  ): Promise<SemanticQueryResponse> {
    if (!this.vectorCapability.available) {
      throw new Error('Indexed vector query invoked without pgvector capability');
    }
    const dimensions = identity.dimensions;
    const candidateCeiling = Math.min(
      ANN_MAX_CANDIDATES,
      Math.max(POSTGRES_HNSW_MIN_CANDIDATES, limit * ANN_OVERSAMPLE_FACTOR),
    );
    const metadataFilters = normalizeMetadataFilters(request.metadataFilters);
    const params: unknown[] = [serializeEmbedding(request.queryEmbedding), now];
    let where = `
      a.index_id = ${quoteSqlLiteral(identity.id)}
      AND a.dimensions = ${dimensions}
      AND (a.expires_at IS NULL OR a.expires_at > $2)
      AND (a.retain_until IS NULL OR a.retain_until > $2)
    `;

    if (request.entityTypes && request.entityTypes.length > 0) {
      params.push(request.entityTypes);
      where += ` AND a.entity_type = ANY($${params.length}::text[])`;
    }
    if (request.sensitivities && request.sensitivities.length > 0) {
      params.push(request.sensitivities);
      where += ` AND a.sensitivity = ANY($${params.length}::text[])`;
    }
    if (request.excludeEntityIds && request.excludeEntityIds.length > 0) {
      params.push(request.excludeEntityIds);
      where += ` AND NOT (a.entity_id = ANY($${params.length}::text[]))`;
    }
    for (const filter of metadataFilters) {
      const clauses = filter.keys.map((key) => {
        params.push(key);
        const keyParam = params.length;
        params.push(filter.values);
        const valuesParam = params.length;
        const accessor = filter.caseInsensitive
          ? `LOWER(a.metadata ->> $${keyParam})`
          : `a.metadata ->> $${keyParam}`;
        return filter.match === 'any'
          ? `${accessor} = ANY($${valuesParam}::text[])`
          : `(${accessor} IS NULL OR NOT (${accessor} = ANY($${valuesParam}::text[])))`;
      });
      where += filter.match === 'any'
        ? ` AND (${clauses.join(' OR ')})`
        : ` AND (${clauses.join(' AND ')})`;
    }
    params.push(candidateCeiling);
    const limitParam = params.length;

    const rows = await withTransaction(this.pool, async (client) => {
      await client.query(`SET LOCAL enable_seqscan = off`);
      await client.query(`SET LOCAL enable_sort = off`);
      await client.query(`SET LOCAL hnsw.ef_search = ${candidateCeiling}`);
      await client.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
      await client.query(`SET LOCAL hnsw.max_scan_tuples = 20000`);
      return query<{
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
        metadata: unknown;
      }>(
        client,
        `
          WITH nearest AS MATERIALIZED (
            SELECT a.vector_id,
                   a.embedding::halfvec(${dimensions})
                     <=> $1::halfvec(${dimensions}) AS distance
            FROM semantic_vector_ann a
            WHERE ${where}
            ORDER BY a.embedding::halfvec(${dimensions})
                     <=> $1::halfvec(${dimensions})
            LIMIT $${limitParam}
          )
          SELECT v.id AS id, v.entity_type AS "entityType", v.entity_id AS "entityId",
                 v.embedding AS embedding, v.norm AS norm, v.dimensions AS dimensions,
                 v.projection_version AS "projectionVersion", v.sensitivity AS sensitivity,
                 v.provider AS provider, v.model AS model,
                 v.source_revision AS "sourceRevision", v.source_updated_at AS "sourceUpdatedAt",
                 v.embedded_at AS "embeddedAt",
                 d.title AS title, d.body AS body, d.metadata AS metadata
          FROM nearest n
          INNER JOIN semantic_vectors v ON v.id = n.vector_id
          INNER JOIN semantic_documents d ON d.id = v.document_id
          WHERE d.deleted_at IS NULL
            AND v.document_version = d.version
            AND v.source_revision = d.source_revision
          ORDER BY n.distance ASC, v.id ASC
        `,
        params,
      );
    });

    const scored: SemanticQueryResult[] = [];
    for (const row of rows) {
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
        kind: 'postgres-hnsw',
        candidatesScanned: rows.length,
        candidateCeiling,
        guaranteesFullRecall: false,
        guaranteedScale: POSTGRES_HNSW_VALIDATED_SCALE,
        truncated: rows.length === candidateCeiling,
        extensionVersion: this.vectorCapability.extensionVersion,
        maxDimensions: this.vectorCapability.maxDimensions,
      },
    };
  }

  async queryVectors(request: SemanticQueryRequest): Promise<SemanticQueryResponse> {
    const now = request.now ?? new Date().toISOString();

    let identity: SemanticIndexIdentity | null;
    if (request.indexId) {
      identity = await this.requireIdentity(this.pool, request.indexId);
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
    if (await this.annIndexExists(identity)) {
      return this.queryVectorsIndexed(
        request,
        identity,
        now,
        queryNorm,
        limit,
        minScore,
      );
    }
    if (this.vectorCapability.mode === 'required') {
      throw new Error(
        `PostgreSQL HNSW index for semantic identity ${identity.id} is unavailable`,
      );
    }

    const params: unknown[] = [identity.id, now];
    let sql = `
      SELECT v.id AS id, v.entity_type AS "entityType", v.entity_id AS "entityId",
             v.embedding AS embedding, v.norm AS norm, v.dimensions AS dimensions,
             v.projection_version AS "projectionVersion", v.sensitivity AS sensitivity,
             v.provider AS provider, v.model AS model,
             v.source_revision AS "sourceRevision", v.source_updated_at AS "sourceUpdatedAt",
             v.embedded_at AS "embeddedAt",
             d.title AS title, d.body AS body, d.metadata AS metadata
      FROM semantic_vectors v
      INNER JOIN semantic_documents d ON d.id = v.document_id
      WHERE v.index_id = $1
        AND d.deleted_at IS NULL
        AND v.document_version = d.version
        AND v.source_revision = d.source_revision
        AND (v.expires_at IS NULL OR v.expires_at > $2)
        AND (d.retain_until IS NULL OR d.retain_until > $2)
    `;

    if (request.entityTypes && request.entityTypes.length > 0) {
      params.push(request.entityTypes);
      sql += ` AND v.entity_type = ANY($${params.length}::text[])`;
    }
    if (request.sensitivities && request.sensitivities.length > 0) {
      params.push(request.sensitivities);
      sql += ` AND v.sensitivity = ANY($${params.length}::text[])`;
    }
    if (request.excludeEntityIds && request.excludeEntityIds.length > 0) {
      params.push(request.excludeEntityIds);
      sql += ` AND NOT (v.entity_id = ANY($${params.length}::text[]))`;
    }
    // Domain/authorization predicates run in SQL, before the candidate ceiling,
    // so an excluded row can never displace an allowed one from the scan.
    for (const filter of metadataFilters) {
      const clauses = filter.keys.map((key) => {
        params.push(key);
        const keyParam = params.length;
        params.push(filter.values);
        const valuesParam = params.length;
        const accessor = filter.caseInsensitive
          ? `LOWER(d.metadata ->> $${keyParam})`
          : `d.metadata ->> $${keyParam}`;
        if (filter.match === 'any') {
          return `${accessor} = ANY($${valuesParam}::text[])`;
        }
        // An absent key must *pass* an exclusion filter. Without the explicit
        // null branch, three-valued logic would silently drop every row whose
        // metadata simply does not carry the key.
        return `(${accessor} IS NULL OR NOT (${accessor} = ANY($${valuesParam}::text[])))`;
      });
      sql += filter.match === 'any'
        ? ` AND (${clauses.join(' OR ')})`
        : ` AND (${clauses.join(' AND ')})`;
    }

    // One extra row detects a corpus larger than the ceiling, so the response can
    // honestly report that recall is not guaranteed.
    params.push(ceiling + 1);
    sql += ` ORDER BY v.source_updated_at DESC, v.id ASC LIMIT $${params.length}`;

    const rows = await query<{
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
      metadata: unknown;
    }>(this.pool, sql, params);

    const truncated = rows.length > ceiling;
    const scanned = truncated ? rows.slice(0, ceiling) : rows;

    const scored: SemanticQueryResult[] = [];
    for (const row of scanned) {
      // Incompatible rows are skipped rather than scored: a different vector
      // space is not comparable, and scoring it would fabricate recall.
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
    return withTransaction(this.pool, async (client): Promise<SemanticIntentEnqueueResult> => {
      await this.requireWritableIdentity(client, intent.indexId);
      const availableAt = intent.availableAt ?? intent.now;
      const maxAttempts = intent.maxAttempts ?? getSemanticIntentMaxAttempts();

      const [queued] = await query<SemanticIntent>(
        client,
        `
          SELECT ${INTENT_COLUMNS} FROM semantic_intents
          WHERE idempotency_key = $1 AND status = 'queued'
          FOR UPDATE
        `,
        [intent.idempotencyKey],
      );

      if (queued) {
        // Never regress a queued row to older work.
        if (queued.requestedAt > intent.requestedAt) {
          return { status: 'ignored', intent: queued };
        }
        const [updated] = await query<SemanticIntent>(
          client,
          `
            UPDATE semantic_intents
            SET kind = $1, entity_type = $2, entity_id = $3, source_revision = $4,
                content_fingerprint = $5, projection_version = $6, requested_at = $7,
                available_at = LEAST(available_at, $8::text), max_attempts = $9, updated_at = $10
            WHERE id = $11
            RETURNING ${INTENT_COLUMNS}
          `,
          [
            intent.kind, intent.entityType, intent.entityId, intent.sourceRevision ?? null,
            intent.contentFingerprint ?? null, intent.projectionVersion ?? null,
            intent.requestedAt, availableAt, maxAttempts, intent.now, queued.id,
          ],
        );
        return { status: 'coalesced', intent: updated };
      }

      // An in-flight attempt is never mutated. Newer work becomes its own queued
      // row so the running attempt can finish against the projection it claimed.
      const [running] = await query<{ id: string }>(
        client,
        `SELECT id FROM semantic_intents WHERE idempotency_key = $1 AND status = 'running' LIMIT 1`,
        [intent.idempotencyKey],
      );

      const [created] = await query<SemanticIntent>(
        client,
        `
          INSERT INTO semantic_intents (
            id, idempotency_key, index_id, kind, entity_type, entity_id,
            source_revision, content_fingerprint, projection_version, requested_at,
            status, attempt, max_attempts, available_at, lease_owner,
            lease_expires_at, retry_after, last_error, outcome,
            created_at, updated_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', 0, $11, $12,
                    NULL, NULL, NULL, NULL, NULL, $13, $13, NULL)
          RETURNING ${INTENT_COLUMNS}
        `,
        [
          intent.id, intent.idempotencyKey, intent.indexId, intent.kind,
          intent.entityType, intent.entityId, intent.sourceRevision ?? null,
          intent.contentFingerprint ?? null, intent.projectionVersion ?? null,
          intent.requestedAt, maxAttempts, availableAt, intent.now,
        ],
      );
      return { status: running ? 'superseded' : 'enqueued', intent: created };
    });
  }

  async claimIntents(request: SemanticIntentClaimRequest): Promise<SemanticIntent[]> {
    const limit = Math.max(1, Math.trunc(request.limit) || 1);
    if (request.entityTypes?.length === 0) return [];
    await this.recoverExpiredIntentLeases(request.now);
    return withTransaction(this.pool, async (client) => {
      const leaseExpiresAt = addMs(request.now, request.leaseMs);
      // `FOR UPDATE SKIP LOCKED` inside the CTE makes the claim atomic:
      // concurrent workers step over each other's locked rows instead of
      // blocking or double-claiming. The CTE aliases `id` so `RETURNING` is
      // unambiguous.
      return query<SemanticIntent>(
        client,
        `
          WITH candidates AS (
            SELECT id AS candidate_id FROM semantic_intents
            WHERE index_id = $1 AND status = 'queued' AND available_at <= $2
              AND ($3::text[] IS NULL OR entity_type = ANY($3::text[]))
            ORDER BY requested_at ASC, created_at ASC, id ASC
            LIMIT $4
            FOR UPDATE SKIP LOCKED
          )
          UPDATE semantic_intents
          SET status = 'running', attempt = attempt + 1,
              lease_owner = $5, lease_expires_at = $6, last_error = NULL, updated_at = $2
          FROM candidates
          WHERE semantic_intents.id = candidates.candidate_id
            AND semantic_intents.status = 'queued'
          RETURNING ${INTENT_COLUMNS}
        `,
        [request.indexId, request.now, request.entityTypes ?? null, limit, request.owner, leaseExpiresAt],
      );
    });
  }

  async renewIntentLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_intents
        SET lease_expires_at = $1, updated_at = $2
        WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2
      `,
      [addMs(input.now, input.leaseMs), input.now, input.id, input.owner],
    );
    return changed > 0;
  }

  async completeIntent(input: SemanticIntentCompletion): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_intents
        SET status = 'succeeded', outcome = $1, completed_at = $2, updated_at = $2,
            lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id = $3 AND status = 'running' AND lease_owner = $4
      `,
      [input.outcome ?? 'succeeded', input.now, input.id, input.owner],
    );
    return changed > 0;
  }

  async failIntent(input: SemanticIntentFailure): Promise<SemanticIntentStatus | null> {
    return withTransaction(this.pool, async (client): Promise<SemanticIntentStatus | null> => {
      const [row] = await query<SemanticIntent>(
        client,
        `
          SELECT ${INTENT_COLUMNS} FROM semantic_intents
          WHERE id = $1 AND status = 'running' AND lease_owner = $2
          FOR UPDATE
        `,
        [input.id, input.owner],
      );
      if (!row) return null;

      const next = resolveIntentFailureStatus({
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        denied: input.denied,
        terminal: input.terminal,
      });

      if (next === 'queued') {
        // A newer queued row for the same key already carries fresher work; this
        // attempt must not resurrect stale work (and cannot, given the partial
        // unique index on queued idempotency keys).
        const [superseding] = await query<{ id: string }>(
          client,
          `
            SELECT id FROM semantic_intents
            WHERE idempotency_key = $1 AND status = 'queued' AND id <> $2
            LIMIT 1
          `,
          [row.idempotencyKey, row.id],
        );
        if (superseding) {
          await execute(
            client,
            `
              UPDATE semantic_intents
              SET status = 'expired', outcome = 'superseded', last_error = $1,
                  completed_at = $2, updated_at = $2, lease_owner = NULL, lease_expires_at = NULL
              WHERE id = $3
            `,
            [input.error, input.now, row.id],
          );
          return 'expired';
        }

        await execute(
          client,
          `
            UPDATE semantic_intents
            SET status = 'queued', available_at = $1, retry_after = $2, last_error = $3,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = $4
            WHERE id = $5
          `,
          [
            input.retryAfter ?? computeSemanticRetryAt(input.now, row.attempt),
            input.retryAfter ?? null,
            input.error,
            input.now,
            row.id,
          ],
        );
        return 'queued';
      }

      await execute(
        client,
        `
          UPDATE semantic_intents
          SET status = $1, outcome = $2, last_error = $3, completed_at = $4,
              updated_at = $4, lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $5
        `,
        [next, next === 'denied' ? 'denied' : 'permanent-failure', input.error, input.now, row.id],
      );
      return next;
    });
  }

  async getIntent(id: string): Promise<SemanticIntent | null> {
    const [row] = await query<SemanticIntent>(
      this.pool,
      `SELECT ${INTENT_COLUMNS} FROM semantic_intents WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  async recoverExpiredIntentLeases(now: string): Promise<{ requeued: number; expired: number }> {
    return withTransaction(this.pool, async (client) => {
      const rows = await query<SemanticIntent>(
        client,
        `
          SELECT ${INTENT_COLUMNS} FROM semantic_intents
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
          FOR UPDATE SKIP LOCKED
        `,
        [now],
      );

      let requeued = 0;
      let expired = 0;
      for (const row of rows) {
        const [superseding] = await query<{ id: string }>(
          client,
          `
            SELECT id FROM semantic_intents
            WHERE idempotency_key = $1 AND status = 'queued' AND id <> $2
            LIMIT 1
          `,
          [row.idempotencyKey, row.id],
        );

        if (!superseding && row.attempt < row.maxAttempts) {
          requeued += await execute(
            client,
            `
              UPDATE semantic_intents
              SET status = 'queued', available_at = $1, lease_owner = NULL,
                  lease_expires_at = NULL, last_error = 'Lease expired before completion',
                  updated_at = $2
              WHERE id = $3 AND status = 'running'
            `,
            [computeSemanticRetryAt(now, row.attempt), now, row.id],
          );
          continue;
        }

        expired += await execute(
          client,
          `
            UPDATE semantic_intents
            SET status = 'expired', outcome = $1, last_error = 'Lease expired before completion',
                completed_at = $2, updated_at = $2, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $3 AND status = 'running'
          `,
          [superseding ? 'superseded' : 'attempts-exhausted', now, row.id],
        );
      }
      return { requeued, expired };
    });
  }

  async pruneIntents(before: string): Promise<number> {
    return execute(
      this.pool,
      `
        DELETE FROM semantic_intents
        WHERE status IN (${TERMINAL_INTENT_LIST})
          AND completed_at IS NOT NULL AND completed_at < $1
      `,
      [before],
    );
  }

  // ─── Runs ───────────────────────────────────────────────────────────

  async createRun(run: SemanticRunCreate): Promise<SemanticRunCreateResult> {
    return withTransaction(this.pool, async (client): Promise<SemanticRunCreateResult> => {
      await this.requireIdentity(client, run.indexId);
      const [existing] = await query<SemanticRun>(
        client,
        `SELECT ${RUN_COLUMNS} FROM semantic_runs WHERE idempotency_key = $1 FOR UPDATE`,
        [run.idempotencyKey],
      );

      let checkpoint = run.checkpoint ?? null;
      if (existing) {
        if (!SEMANTIC_RETRYABLE_TERMINAL_RUN_STATUSES.includes(existing.status)) {
          return { status: 'existing', run: existing };
        }
        // A run that failed or expired has spent its attempt budget, so the key
        // would otherwise be permanently poisoned — the fixed `backfill:initial`
        // key could never be scheduled again. The terminal row is moved aside
        // rather than deleted so its counters and error stay auditable, and its
        // checkpoint is carried forward so the replacement resumes instead of
        // restarting the corpus.
        checkpoint = run.checkpoint ?? existing.checkpoint;
        await execute(
          client,
          `UPDATE semantic_runs SET idempotency_key = $1, updated_at = $2 WHERE id = $3`,
          [supersededRunIdempotencyKey(run.idempotencyKey, existing.id), run.now, existing.id],
        );
      }

      const [created] = await query<SemanticRun>(
        client,
        `
          INSERT INTO semantic_runs (
            id, index_id, kind, idempotency_key, status, checkpoint,
            processed_count, failed_count, skipped_count, attempt, max_attempts,
            available_at, lease_owner, lease_expires_at, error_message,
            created_at, updated_at, started_at, completed_at
          ) VALUES ($1, $2, $3, $4, 'queued', $5, 0, 0, 0, 0, $6, $7, NULL, NULL, NULL, $8, $8, NULL, NULL)
          RETURNING ${RUN_COLUMNS}
        `,
        [
          run.id, run.indexId, run.kind, run.idempotencyKey, checkpoint,
          run.maxAttempts ?? getSemanticRunMaxAttempts(), run.availableAt ?? run.now, run.now,
        ],
      );
      return { status: 'created', run: created };
    });
  }

  async claimRun(request: SemanticRunClaimRequest): Promise<SemanticRun | null> {
    await this.recoverExpiredRunLeases(request.now);
    return withTransaction(this.pool, async (client) => {
      const leaseExpiresAt = addMs(request.now, request.leaseMs);
      const params: unknown[] = [request.now];
      let filters = '';
      if (request.indexId) {
        params.push(request.indexId);
        filters += ` AND r.index_id = $${params.length}`;
      }
      if (request.kinds && request.kinds.length > 0) {
        params.push(request.kinds);
        filters += ` AND r.kind = ANY($${params.length}::text[])`;
      }
      params.push(request.owner);
      const ownerParam = `$${params.length}`;
      params.push(leaseExpiresAt);
      const leaseParam = `$${params.length}`;

      const [row] = await query<SemanticRun>(
        client,
        `
          WITH candidate AS (
            SELECT r.id AS candidate_id FROM semantic_runs r
            WHERE r.status = 'queued' AND r.available_at <= $1
              AND NOT EXISTS (
                SELECT 1 FROM semantic_runs active
                WHERE active.index_id = r.index_id AND active.kind = r.kind
                  AND active.status = 'running'
              )
              ${filters}
            ORDER BY r.available_at ASC, r.created_at ASC, r.id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE semantic_runs
          SET status = 'running', lease_owner = ${ownerParam},
              lease_expires_at = ${leaseParam}, started_at = COALESCE(started_at, $1),
              error_message = NULL, updated_at = $1
          FROM candidate
          WHERE semantic_runs.id = candidate.candidate_id AND semantic_runs.status = 'queued'
          RETURNING ${RUN_COLUMNS}
        `,
        params,
      );
      return row ?? null;
    });
  }

  async renewRunLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_runs
        SET lease_expires_at = $1, updated_at = $2
        WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2
      `,
      [addMs(input.now, input.leaseMs), input.now, input.id, input.owner],
    );
    return changed > 0;
  }

  async checkpointRun(input: SemanticRunCheckpoint): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_runs
        SET checkpoint = COALESCE($1::text, checkpoint),
            processed_count = processed_count + $2,
            failed_count = failed_count + $3,
            skipped_count = skipped_count + $4,
            lease_expires_at = COALESCE($5::text, lease_expires_at),
            updated_at = $6
        WHERE id = $7 AND status = 'running' AND lease_owner = $8
      `,
      [
        input.checkpoint ?? null,
        input.processedDelta ?? 0,
        input.failedDelta ?? 0,
        input.skippedDelta ?? 0,
        input.leaseMs === undefined ? null : addMs(input.now, input.leaseMs),
        input.now,
        input.id,
        input.owner,
      ],
    );
    return changed > 0;
  }

  async releaseRun(input: {
    id: string;
    owner: string;
    now: string;
    availableAt?: string;
  }): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_runs
        SET status = 'queued', available_at = $1, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = $2
        WHERE id = $3 AND status = 'running' AND lease_owner = $4
      `,
      [input.availableAt ?? input.now, input.now, input.id, input.owner],
    );
    return changed > 0;
  }

  async completeRun(input: SemanticRunCompletion): Promise<boolean> {
    const changed = await execute(
      this.pool,
      `
        UPDATE semantic_runs
        SET status = $1, checkpoint = COALESCE($2::text, checkpoint), completed_at = $3,
            updated_at = $3, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $4 AND status = 'running' AND lease_owner = $5
      `,
      [input.status ?? 'succeeded', input.checkpoint ?? null, input.now, input.id, input.owner],
    );
    return changed > 0;
  }

  async failRun(input: SemanticRunFailure): Promise<SemanticRunStatus | null> {
    return withTransaction(this.pool, async (client): Promise<SemanticRunStatus | null> => {
      const [row] = await query<SemanticRun>(
        client,
        `
          SELECT ${RUN_COLUMNS} FROM semantic_runs
          WHERE id = $1 AND status = 'running' AND lease_owner = $2
          FOR UPDATE
        `,
        [input.id, input.owner],
      );
      if (!row) return null;

      // `attempt` counts *failures*, not claims: a run that yields its slice and
      // is reclaimed has not consumed any budget, so the counter is incremented
      // here — atomically with the state transition that spends it.
      const attempt = row.attempt + 1;
      if (!input.terminal && attempt < row.maxAttempts) {
        await execute(
          client,
          `
            UPDATE semantic_runs
            SET status = 'queued', attempt = $1, available_at = $2, error_message = $3,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = $4
            WHERE id = $5
          `,
          [
            attempt,
            input.availableAt ?? computeSemanticRetryAt(input.now, attempt),
            input.error,
            input.now,
            row.id,
          ],
        );
        return 'queued';
      }

      await execute(
        client,
        `
          UPDATE semantic_runs
          SET status = 'failed', attempt = $1, error_message = $2, completed_at = $3, updated_at = $3,
              lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $4
        `,
        [attempt, input.error, input.now, row.id],
      );
      return 'failed';
    });
  }

  async getRun(id: string): Promise<SemanticRun | null> {
    const [row] = await query<SemanticRun>(
      this.pool,
      `SELECT ${RUN_COLUMNS} FROM semantic_runs WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  async recoverExpiredRunLeases(now: string): Promise<{ requeued: number; expired: number }> {
    return withTransaction(this.pool, async (client) => {
      const rows = await query<SemanticRun>(
        client,
        `
          SELECT ${RUN_COLUMNS} FROM semantic_runs
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
          FOR UPDATE SKIP LOCKED
        `,
        [now],
      );

      let requeued = 0;
      let expired = 0;
      for (const row of rows) {
        // An abandoned lease is a recovery attempt, so it spends budget here —
        // atomically with the transition, exactly as `failRun` does.
        const attempt = row.attempt + 1;
        if (attempt < row.maxAttempts) {
          // The checkpoint is deliberately preserved so recovery resumes rather
          // than restarting the backfill from the beginning.
          requeued += await execute(
            client,
            `
              UPDATE semantic_runs
              SET status = 'queued', attempt = $1, available_at = $2, lease_owner = NULL,
                  lease_expires_at = NULL, error_message = 'Lease expired before completion',
                  updated_at = $3
              WHERE id = $4 AND status = 'running'
            `,
            [attempt, computeSemanticRetryAt(now, attempt), now, row.id],
          );
          continue;
        }
        expired += await execute(
          client,
          `
            UPDATE semantic_runs
            SET status = 'expired', attempt = $1, error_message = 'Lease expired before completion',
                completed_at = $2, updated_at = $2, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $3 AND status = 'running'
          `,
          [attempt, now, row.id],
        );
      }
      return { requeued, expired };
    });
  }

  // ─── Observability ──────────────────────────────────────────────────

  async getMetrics(indexId: string, now?: string): Promise<SemanticIndexMetrics> {
    const at = now ?? new Date().toISOString();
    const identity = await this.identityRow(this.pool, indexId);

    const intentCounts = await query<{ status: string; count: string }>(
      this.pool,
      `SELECT status, COUNT(*) AS count FROM semantic_intents WHERE index_id = $1 GROUP BY status`,
      [indexId],
    );
    const [retryAggregate] = await query<{ retrying: string; totalRetries: string }>(
      this.pool,
      `
        SELECT
          COALESCE(SUM(CASE WHEN status = 'queued' AND attempt > 0 THEN 1 ELSE 0 END), 0) AS retrying,
          COALESCE(SUM(CASE WHEN attempt > 1 THEN attempt - 1 ELSE 0 END), 0) AS "totalRetries"
        FROM semantic_intents
        WHERE index_id = $1 AND status IN ('queued', 'running')
      `,
      [indexId],
    );
    const [oldest] = await query<{ queued: string | null; running: string | null }>(
      this.pool,
      `
        SELECT
          MIN(created_at) FILTER (WHERE status = 'queued') AS queued,
          MIN(updated_at) FILTER (WHERE status = 'running') AS running
        FROM semantic_intents
        WHERE index_id = $1
      `,
      [indexId],
    );

    const count = (rows: Array<{ status: string; count: string }>, status: string) =>
      toNumber(rows.find((row) => row.status === status)?.count);

    const intents: SemanticIntentQueueMetrics = {
      queued: count(intentCounts, 'queued'),
      running: count(intentCounts, 'running'),
      retrying: toNumber(retryAggregate?.retrying),
      succeeded: count(intentCounts, 'succeeded'),
      failed: count(intentCounts, 'failed'),
      denied: count(intentCounts, 'denied'),
      expired: count(intentCounts, 'expired'),
      permanentFailures:
        count(intentCounts, 'failed') + count(intentCounts, 'denied') + count(intentCounts, 'expired'),
      totalRetries: toNumber(retryAggregate?.totalRetries),
      oldestQueuedAgeMs: ageMs(oldest?.queued ?? null, at),
      oldestRunningAgeMs: ageMs(oldest?.running ?? null, at),
    };

    const runCounts = await query<{ status: string; count: string }>(
      this.pool,
      `SELECT status, COUNT(*) AS count FROM semantic_runs WHERE index_id = $1 GROUP BY status`,
      [indexId],
    );
    const runs: SemanticRunMetrics = {
      queued: count(runCounts, 'queued'),
      running: count(runCounts, 'running'),
      succeeded: count(runCounts, 'succeeded'),
      failed: count(runCounts, 'failed'),
      cancelled: count(runCounts, 'cancelled'),
      expired: count(runCounts, 'expired'),
    };

    return {
      indexId,
      identityStatus: identity?.status ?? null,
      documentCount: identity?.documentCount ?? 0,
      vectorCount: identity?.vectorCount ?? 0,
      intents,
      runs,
      latestRuns: await this.latestRunProgress(indexId),
      byEntityType: await this.entityKindReadiness(this.pool, indexId, at),
    };
  }

  /**
   * The newest run per kind. One bounded lookup per kind rather than one
   * unbounded scan: run history grows without limit, but "the newest of each
   * kind" is all progress reporting needs.
   */
  private async latestRunProgress(indexId: string): Promise<SemanticRunProgress[]> {
    const progress: SemanticRunProgress[] = [];
    for (const kind of SEMANTIC_RUN_KINDS) {
      const [run] = await query<SemanticRun>(
        this.pool,
        `
          SELECT ${RUN_COLUMNS} FROM semantic_runs
          WHERE index_id = $1 AND kind = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [indexId, kind],
      );
      if (run) progress.push(runProgress(run));
    }
    return progress;
  }

  private boundedScanCapability(): SemanticScanCapability {
    return {
      kind: 'bounded-in-process',
      candidateCeiling: this.scanLimit,
      guaranteesFullRecall: false,
      guaranteedScale: this.scanLimit,
    };
  }

  private async scanCapability(
    identity?: Pick<SemanticIndexIdentity, 'id' | 'dimensions'> | null,
  ): Promise<SemanticScanCapability> {
    if (identity && await this.annIndexExists(identity) && this.vectorCapability.available) {
      return {
        kind: 'postgres-hnsw',
        candidateCeiling: ANN_MAX_CANDIDATES,
        guaranteesFullRecall: false,
        guaranteedScale: POSTGRES_HNSW_VALIDATED_SCALE,
        extensionVersion: this.vectorCapability.extensionVersion,
        maxDimensions: this.vectorCapability.maxDimensions,
      };
    }
    return this.boundedScanCapability();
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
        scan: await this.scanCapability(),
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

    const scan = await this.scanCapability(active);
    return {
      available: active.vectorCount > 0
        && (this.vectorCapability.mode !== 'required' || scan.kind === 'postgres-hnsw'),
      activeIdentityId: active.id,
      provider: active.provider,
      model: active.model,
      dimensions: active.dimensions,
      projectionVersion: active.projectionVersion,
      documentCount: active.documentCount,
      vectorCount: active.vectorCount,
      readyIdentityIds: ready.map((identity) => identity.id),
      stagingIdentities: staging,
      scan,
      byEntityType: await this.entityKindReadiness(this.pool, active.id, at),
    };
  }
}

/**
 * Stable construction point for composition roots: builds a
 * `SemanticIndexRepository` backed by PostgreSQL from a `pg` `Pool` (typically
 * `PostgresPersistenceBackend#context.pool` from `@/db/postgres/runtime`),
 * without callers needing to know the concrete class.
 */
export function createPostgresSemanticIndexRepository(
  pool: Pool,
  vectorCapability: PostgresVectorCapability = disabledPostgresVectorCapability(),
): SemanticIndexRepository {
  return new PostgresSemanticIndexRepository(pool, getSemanticScanLimit(), vectorCapability);
}
