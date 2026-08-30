/**
 * Pure, backend-agnostic helpers shared by the SQLite and PostgreSQL
 * `SemanticIndexRepository` adapters. Nothing here touches a driver, so every
 * rule below is unit-testable without a database and cannot drift between
 * backends.
 */

import {
  isSemanticEntityType,
  isSemanticSensitivity,
  SemanticIndexValidationError,
  type SemanticDocumentWrite,
  type SemanticEntityType,
  type SemanticIdentityDescriptor,
  type SemanticIndexIdentity,
  type SemanticIntentStatus,
  type SemanticMetadataFilter,
  type SemanticQueryResult,
  type SemanticRun,
  type SemanticRunProgress,
  type SemanticSensitivity,
  type SemanticVectorWrite,
} from './contracts';

// ─── Environment-tunable defaults ───────────────────────────────────────────

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Bounded candidate ceiling for the in-process scan. This is a compatibility
 * path for small corpora, **not** the 100,000-entity target — see
 * `SemanticQueryScan.guaranteesFullRecall`.
 */
export function getSemanticScanLimit(): number {
  return positiveInteger(process.env.MC_SEMANTIC_INDEX_SCAN_LIMIT, 5_000);
}

export function getSemanticIntentLeaseMs(): number {
  return positiveInteger(process.env.MC_SEMANTIC_INTENT_LEASE_MS, 60_000);
}

export function getSemanticIntentMaxAttempts(): number {
  return positiveInteger(process.env.MC_SEMANTIC_INTENT_MAX_ATTEMPTS, 5);
}

export function getSemanticIntentRetryBaseMs(): number {
  return positiveInteger(process.env.MC_SEMANTIC_INTENT_RETRY_BASE_MS, 30_000);
}

export function getSemanticRunLeaseMs(): number {
  return positiveInteger(process.env.MC_SEMANTIC_RUN_LEASE_MS, 300_000);
}

export function getSemanticRunMaxAttempts(): number {
  return positiveInteger(process.env.MC_SEMANTIC_RUN_MAX_ATTEMPTS, 3);
}

/** Exponential backoff capped at 15 minutes, mirroring the sync worker. */
export function computeSemanticRetryAt(
  now: string,
  attempt: number,
  retryBaseMs = getSemanticIntentRetryBaseMs(),
): string {
  const delayMs = Math.min(retryBaseMs * (2 ** Math.max(0, attempt - 1)), 15 * 60_000);
  return new Date(new Date(now).getTime() + delayMs).toISOString();
}

export function addMs(now: string, ms: number): string {
  return new Date(new Date(now).getTime() + ms).toISOString();
}

export function ageMs(from: string | null | undefined, now: string): number {
  if (!from) return 0;
  const started = new Date(from).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(current)) return 0;
  return Math.max(0, current - started);
}

// ─── Embedding serialization ────────────────────────────────────────────────

export function serializeEmbedding(embedding: Float32Array): string {
  return JSON.stringify(Array.from(embedding));
}

/**
 * Parses a stored embedding. Returns `null` for anything that is not a finite
 * numeric array — a corrupt row must never be scored as if it were valid.
 */
export function parseEmbedding(raw: unknown): Float32Array | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const values = new Float32Array(parsed.length);
  for (let index = 0; index < parsed.length; index++) {
    const value = parsed[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    values[index] = value;
  }
  return values;
}

export function computeNorm(embedding: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < embedding.length; index++) {
    sum += embedding[index] * embedding[index];
  }
  return Math.sqrt(sum);
}

/** Cosine similarity against a vector whose norm is already known. */
export function cosineSimilarity(
  query: Float32Array,
  queryNorm: number,
  candidate: Float32Array,
  candidateNorm: number,
): number {
  if (query.length !== candidate.length) return 0;
  const denominator = queryNorm * candidateNorm;
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  let dot = 0;
  for (let index = 0; index < query.length; index++) {
    dot += query[index] * candidate[index];
  }
  const score = dot / denominator;
  return Number.isFinite(score) ? score : 0;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function assertEntityType(value: string): SemanticEntityType {
  if (!isSemanticEntityType(value)) {
    throw new SemanticIndexValidationError(
      'unknown-entity-type',
      `Unknown semantic entity type: ${value}`,
    );
  }
  return value;
}

export function assertSensitivity(value: string): SemanticSensitivity {
  if (!isSemanticSensitivity(value)) {
    throw new SemanticIndexValidationError(
      'unknown-sensitivity',
      `Unknown semantic sensitivity: ${value}`,
    );
  }
  return value;
}

export function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SemanticIndexValidationError(
      'invalid-argument',
      `${field} must be a positive integer, received ${String(value)}`,
    );
  }
  return value;
}

/**
 * A document write must name a known entity kind and sensitivity, carry a
 * non-empty revision/fingerprint, and match the identity's projection version —
 * a projection-version change is a new index identity, never an in-place write.
 */
export function validateDocumentWrite(
  document: SemanticDocumentWrite,
  identity: SemanticIndexIdentity,
): void {
  assertEntityType(document.entityType);
  assertSensitivity(document.sensitivity);
  if (!document.entityId) {
    throw new SemanticIndexValidationError('invalid-argument', 'entityId is required');
  }
  if (!document.sourceRevision) {
    throw new SemanticIndexValidationError('invalid-argument', 'sourceRevision is required');
  }
  if (!document.contentFingerprint) {
    throw new SemanticIndexValidationError('invalid-argument', 'contentFingerprint is required');
  }
  if (!document.sourceUpdatedAt || Number.isNaN(new Date(document.sourceUpdatedAt).getTime())) {
    throw new SemanticIndexValidationError(
      'invalid-argument',
      'sourceUpdatedAt must be an ISO timestamp',
    );
  }
  if (document.projectionVersion !== identity.projectionVersion) {
    throw new SemanticIndexValidationError(
      'projection-version-mismatch',
      `Document projection version ${document.projectionVersion} does not match identity `
      + `${identity.id} projection version ${identity.projectionVersion}`,
    );
  }
}

/**
 * A vector write must belong to the identity's exact vector space: same
 * provider, model, dimension count, and projection version — and the embedding
 * itself must be finite and exactly `identity.dimensions` long.
 */
export function validateVectorWrite(
  vector: SemanticVectorWrite,
  identity: SemanticIndexIdentity,
): number {
  assertEntityType(vector.entityType);
  assertSensitivity(vector.sensitivity);
  if (vector.provider !== identity.provider) {
    throw new SemanticIndexValidationError(
      'provider-mismatch',
      `Vector provider ${vector.provider} does not match identity ${identity.id} `
      + `provider ${identity.provider}`,
    );
  }
  if (vector.model !== identity.model) {
    throw new SemanticIndexValidationError(
      'model-mismatch',
      `Vector model ${vector.model} does not match identity ${identity.id} model ${identity.model}`,
    );
  }
  if (vector.dimensions !== identity.dimensions) {
    throw new SemanticIndexValidationError(
      'dimension-mismatch',
      `Vector dimensions ${vector.dimensions} do not match identity ${identity.id} `
      + `dimensions ${identity.dimensions}`,
    );
  }
  if (vector.projectionVersion !== identity.projectionVersion) {
    throw new SemanticIndexValidationError(
      'projection-version-mismatch',
      `Vector projection version ${vector.projectionVersion} does not match identity `
      + `${identity.id} projection version ${identity.projectionVersion}`,
    );
  }
  if (vector.embedding.length !== identity.dimensions) {
    throw new SemanticIndexValidationError(
      'dimension-mismatch',
      `Embedding length ${vector.embedding.length} does not match identity ${identity.id} `
      + `dimensions ${identity.dimensions}`,
    );
  }
  for (let index = 0; index < vector.embedding.length; index++) {
    if (!Number.isFinite(vector.embedding[index])) {
      throw new SemanticIndexValidationError(
        'invalid-embedding',
        `Embedding contains a non-finite value at index ${index}`,
      );
    }
  }
  const norm = computeNorm(vector.embedding);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new SemanticIndexValidationError(
      'invalid-embedding',
      'Embedding norm must be finite and non-zero',
    );
  }
  return norm;
}

export function validateQueryEmbedding(
  embedding: Float32Array,
  identity: SemanticIndexIdentity,
): number {
  if (embedding.length !== identity.dimensions) {
    throw new SemanticIndexValidationError(
      'dimension-mismatch',
      `Query embedding length ${embedding.length} does not match active identity `
      + `${identity.id} dimensions ${identity.dimensions}`,
    );
  }
  for (let index = 0; index < embedding.length; index++) {
    if (!Number.isFinite(embedding[index])) {
      throw new SemanticIndexValidationError(
        'invalid-embedding',
        `Query embedding contains a non-finite value at index ${index}`,
      );
    }
  }
  const norm = computeNorm(embedding);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new SemanticIndexValidationError(
      'invalid-embedding',
      'Query embedding norm must be finite and non-zero',
    );
  }
  return norm;
}

// ─── Portable metadata filters ──────────────────────────────────────────────

/**
 * Metadata keys are interpolated into a JSON accessor by both adapters, so they
 * are restricted to a conservative identifier shape. Anything else is rejected
 * as a contract violation rather than escaped and hoped for.
 */
export const SEMANTIC_METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const SEMANTIC_MAX_METADATA_FILTERS = 8;
export const SEMANTIC_MAX_METADATA_FILTER_KEYS = 8;
export const SEMANTIC_MAX_METADATA_FILTER_VALUES = 32;

/**
 * Validates portable metadata predicates and returns them normalized (values
 * lower-cased when the filter is case-insensitive, so both adapters compare the
 * same way). Returns `[]` when there is nothing to apply.
 */
export function normalizeMetadataFilters(
  filters: SemanticMetadataFilter[] | undefined,
): SemanticMetadataFilter[] {
  if (!filters || filters.length === 0) return [];
  if (filters.length > SEMANTIC_MAX_METADATA_FILTERS) {
    throw new SemanticIndexValidationError(
      'invalid-argument',
      `At most ${SEMANTIC_MAX_METADATA_FILTERS} metadata filters may be supplied`,
    );
  }
  return filters.map((filter) => {
    if (filter.match !== 'any' && filter.match !== 'none') {
      throw new SemanticIndexValidationError(
        'invalid-argument',
        `Metadata filter match must be "any" or "none", received ${String(filter.match)}`,
      );
    }
    if (!Array.isArray(filter.keys) || filter.keys.length === 0
      || filter.keys.length > SEMANTIC_MAX_METADATA_FILTER_KEYS) {
      throw new SemanticIndexValidationError(
        'invalid-argument',
        `Metadata filter must name 1..${SEMANTIC_MAX_METADATA_FILTER_KEYS} keys`,
      );
    }
    for (const key of filter.keys) {
      if (typeof key !== 'string' || !SEMANTIC_METADATA_KEY_PATTERN.test(key)) {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          `Metadata filter key ${String(key)} is not a supported metadata key`,
        );
      }
    }
    if (!Array.isArray(filter.values) || filter.values.length === 0
      || filter.values.length > SEMANTIC_MAX_METADATA_FILTER_VALUES) {
      throw new SemanticIndexValidationError(
        'invalid-argument',
        `Metadata filter must supply 1..${SEMANTIC_MAX_METADATA_FILTER_VALUES} values`,
      );
    }
    for (const value of filter.values) {
      if (typeof value !== 'string') {
        throw new SemanticIndexValidationError(
          'invalid-argument',
          'Metadata filter values must be strings',
        );
      }
    }
    return {
      keys: [...filter.keys],
      match: filter.match,
      values: filter.caseInsensitive
        ? filter.values.map((value) => value.toLowerCase())
        : [...filter.values],
      caseInsensitive: filter.caseInsensitive === true,
    };
  });
}

// ─── Canonical JSON comparison ──────────────────────────────────────────────

/**
 * Order-independent serialization of a JSON value.
 *
 * Object keys are sorted recursively; array order is preserved because order is
 * meaningful in a JSON array. Used to compare a stored document against an
 * incoming one without treating a re-ordering as a change.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * True when two JSON values are the same document.
 *
 * PostgreSQL stores metadata as `jsonb`, which does **not** preserve key order,
 * so a byte comparison of `JSON.stringify` output reports every no-op rewrite as
 * a change: the version would be bumped and the vector marked stale on every
 * single reconciliation pass. Comparing canonically is what makes an unchanged
 * document actually report `unchanged` on both backends.
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ─── Conditional-write comparison ───────────────────────────────────────────

/**
 * Monotonic source guard. Delayed work must never overwrite a newer projection,
 * so a write is stale strictly when its source mutation timestamp precedes the
 * stored one. Equal timestamps fall through to fingerprint comparison, which
 * distinguishes "same content" from "same instant, different content".
 */
export function isStaleSourceUpdate(incoming: string, stored: string): boolean {
  const incomingMs = new Date(incoming).getTime();
  const storedMs = new Date(stored).getTime();
  if (!Number.isFinite(incomingMs) || !Number.isFinite(storedMs)) return false;
  return incomingMs < storedMs;
}

// ─── Deterministic ranking ──────────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Deterministic ordering: score descending, then the architecture's documented
 * tie-break chain — entity kind, normalized title, stable id.
 */
export function compareQueryResults(a: SemanticQueryResult, b: SemanticQueryResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  if (titleA !== titleB) return titleA < titleB ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// ─── Queue helpers ──────────────────────────────────────────────────────────

/**
 * Resolves the terminal/retry status for a failed intent. Denials are terminal
 * regardless of attempts remaining; otherwise attempts are exhausted before the
 * intent is marked permanently failed.
 */
export function resolveIntentFailureStatus(input: {
  attempt: number;
  maxAttempts: number;
  denied?: boolean;
  terminal?: boolean;
}): Extract<SemanticIntentStatus, 'queued' | 'failed' | 'denied'> {
  if (input.denied) return 'denied';
  if (input.terminal) return 'failed';
  return input.attempt < input.maxAttempts ? 'queued' : 'failed';
}

export function jsonOrDefault<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The key a superseded terminal run is moved to, so the natural key is free for
 * its replacement while the failed attempt stays queryable as history. Run ids
 * are unique, so a superseded key can never collide with a live one.
 */
export function supersededRunIdempotencyKey(idempotencyKey: string, runId: string): string {
  return `${idempotencyKey}\u0000superseded:${runId}`;
}

// ─── Observability projections ──────────────────────────────────────────────

/** Strips an identity down to the non-secret fields a status surface may show. */
export function identityDescriptor(identity: SemanticIndexIdentity): SemanticIdentityDescriptor {
  return {
    id: identity.id,
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    projectionVersion: identity.projectionVersion,
    status: identity.status,
    documentCount: identity.documentCount,
    vectorCount: identity.vectorCount,
  };
}

/**
 * Projects a run to its progress fields. `errorMessage` and `leaseOwner` are
 * deliberately dropped: an error string can quote provider output, and a lease
 * owner names a host.
 */
export function runProgress(run: SemanticRun): SemanticRunProgress {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    checkpoint: run.checkpoint,
    processedCount: run.processedCount,
    failedCount: run.failedCount,
    skippedCount: run.skippedCount,
    attempt: run.attempt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}
