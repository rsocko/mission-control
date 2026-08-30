/**
 * Provider-neutral contracts for the durable, versioned semantic index
 * (issue #1664, `docs/design/proposed/semantic-index-platform/architecture.md`).
 *
 * Every type here is portable: no database driver, no ORM import, no runtime
 * dependency. Backends (SQLite, PostgreSQL) implement `SemanticIndexRepository`;
 * workers and retrieval call sites consume it. All operations are Promise-based
 * so an async backend (PostgreSQL) and a synchronous one (better-sqlite3) can
 * satisfy the same contract.
 *
 * This module deliberately contains **only** the persistence boundary. Search,
 * Universe, Houston, projection builders, and the index worker are wired in a
 * later phase.
 */

// ─── Entity addressing ──────────────────────────────────────────────────────

/**
 * Coarse entity namespace. The architecture commits to these kinds; this issue
 * only persists them — task and alert projections are wired later.
 */
export type SemanticEntityType =
  | 'task'
  | 'project'
  | 'tag'
  | 'triage-item'
  | 'alert'
  | 'houston-summary';

export const SEMANTIC_ENTITY_TYPES: readonly SemanticEntityType[] = [
  'task',
  'project',
  'tag',
  'triage-item',
  'alert',
  'houston-summary',
] as const;

/**
 * Compatibility aliases for names already used by the legacy
 * `search_embeddings` table and existing search call sites. `notification` is
 * the pre-existing Mission Control name for what the architecture calls
 * "alert/event"; both resolve to the canonical `alert` kind so a rename does
 * not silently split one vector space into two.
 */
export const SEMANTIC_ENTITY_TYPE_ALIASES: Readonly<Record<string, SemanticEntityType>> = {
  notification: 'alert',
  alerts: 'alert',
  tasks: 'task',
  projects: 'project',
  tags: 'tag',
  triage: 'triage-item',
  triageitem: 'triage-item',
  triage_item: 'triage-item',
  houston_summary: 'houston-summary',
  houstonsummary: 'houston-summary',
};

export function isSemanticEntityType(value: unknown): value is SemanticEntityType {
  return typeof value === 'string'
    && (SEMANTIC_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Resolves an external entity-kind name to its canonical
 * `SemanticEntityType`, applying the compatibility aliases above. Returns
 * `null` for unknown kinds so callers can reject rather than guess.
 */
export function normalizeSemanticEntityType(value: string): SemanticEntityType | null {
  const trimmed = value.trim();
  if (isSemanticEntityType(trimmed)) return trimmed;
  const alias = SEMANTIC_ENTITY_TYPE_ALIASES[trimmed.toLowerCase()];
  return alias ?? null;
}

/**
 * Sensitivity tier, ordered exactly as the architecture states it:
 * `local-only` is the most restrictive, `standard` the least.
 */
export type SemanticSensitivity = 'local-only' | 'restricted' | 'standard';

export const SEMANTIC_SENSITIVITIES: readonly SemanticSensitivity[] = [
  'local-only',
  'restricted',
  'standard',
] as const;

export function isSemanticSensitivity(value: unknown): value is SemanticSensitivity {
  return typeof value === 'string'
    && (SEMANTIC_SENSITIVITIES as readonly string[]).includes(value);
}

/** Numeric rank used for ordering/comparison: lower is more restrictive. */
export function semanticSensitivityRank(value: SemanticSensitivity): number {
  return SEMANTIC_SENSITIVITIES.indexOf(value);
}

export type SemanticDocumentMetadataValue = string | number | boolean | null;

// ─── Versioned index documents ──────────────────────────────────────────────

/**
 * The versioned projection of an authoritative domain entity, exactly as the
 * architecture's `SemanticIndexDocument` describes it, plus the fields the
 * persistence boundary needs.
 *
 * `sourceUpdatedAt` is the authoritative source mutation timestamp. It serves
 * two purposes and must be monotonic per entity:
 *
 * 1. the conditional-write guard — a delayed worker cannot overwrite a newer
 *    projection with an older one; and
 * 2. the bounded-scan ordering key.
 *
 * The authoritative domain record is never reconstructed from this projection.
 */
export interface SemanticIndexDocument {
  entityType: SemanticEntityType;
  entityId: string;
  title: string;
  body: string;
  keywords: string[];
  metadata: Record<string, SemanticDocumentMetadataValue>;
  sourceRevision: string;
  contentFingerprint: string;
  projectionVersion: number;
  sensitivity: SemanticSensitivity;
  /** Optional retention deadline. Absent means "retain until deleted". */
  retainUntil?: string | null;
  sourceUpdatedAt: string;
}

/** A document write, addressed to a specific index identity. */
export interface SemanticDocumentWrite extends SemanticIndexDocument {
  id: string;
  indexId: string;
  now: string;
}

/** A persisted document row. */
export interface SemanticDocumentRecord extends SemanticIndexDocument {
  id: string;
  indexId: string;
  /**
   * Monotonic per `(indexId, entityType, entityId)`. Incremented whenever the
   * stored content changes, so a vector can name the exact document version it
   * embedded.
   */
  version: number;
  retainUntil: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type SemanticDocumentWriteStatus = 'created' | 'updated' | 'unchanged' | 'stale';

export type SemanticStaleReason =
  | 'older-source-update'
  | 'document-missing'
  | 'document-superseded';

export interface SemanticDocumentWriteResult {
  status: SemanticDocumentWriteStatus;
  /** The winning row: the freshly written one, or the newer one that won. */
  document: SemanticDocumentRecord | null;
  reason?: SemanticStaleReason;
}

export interface SemanticDocumentDeleteResult {
  status: 'deleted' | 'already-deleted' | 'missing';
  removedVectors: number;
}

// ─── Vectors ────────────────────────────────────────────────────────────────

/**
 * A vector always references the document version it was produced from, and
 * records the embedding identity (provider/model/dimensions), when it was
 * embedded, and which run/intent produced it.
 */
export interface SemanticVectorWrite {
  id: string;
  indexId: string;
  documentId: string;
  documentVersion: number;
  entityType: SemanticEntityType;
  entityId: string;
  sourceRevision: string;
  contentFingerprint: string;
  projectionVersion: number;
  provider: string;
  model: string;
  dimensions: number;
  sensitivity: SemanticSensitivity;
  embedding: Float32Array;
  /** Precomputed L2 norm; recomputed and validated by the backend. */
  norm?: number;
  sourceUpdatedAt: string;
  embeddedAt: string;
  /** Index job identity — the `SemanticRun` that produced this vector. */
  indexRunId: string | null;
  /** The intent that produced this vector, when the write came from the queue. */
  intentId: string | null;
  expiresAt?: string | null;
  now: string;
}

export interface SemanticVectorRecord {
  id: string;
  indexId: string;
  documentId: string;
  documentVersion: number;
  entityType: SemanticEntityType;
  entityId: string;
  sourceRevision: string;
  contentFingerprint: string;
  projectionVersion: number;
  provider: string;
  model: string;
  dimensions: number;
  sensitivity: SemanticSensitivity;
  embedding: Float32Array;
  norm: number;
  sourceUpdatedAt: string;
  embeddedAt: string;
  indexRunId: string | null;
  intentId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SemanticVectorWriteStatus = 'created' | 'updated' | 'unchanged' | 'stale';

export interface SemanticVectorWriteResult {
  status: SemanticVectorWriteStatus;
  reason?: SemanticStaleReason;
}

// ─── Bounded document listing ───────────────────────────────────────────────

/**
 * The subset of a vector that reconciliation needs in order to decide whether a
 * document's embedding is current, incompatible, or absent. The embedding
 * itself is deliberately excluded: reconciliation never needs to read vector
 * payloads, and streaming them would make a bounded scan unbounded in memory.
 */
export interface SemanticVectorSummary {
  id: string;
  documentId: string;
  documentVersion: number;
  sourceRevision: string;
  contentFingerprint: string;
  projectionVersion: number;
  provider: string;
  model: string;
  dimensions: number;
  sensitivity: SemanticSensitivity;
  expiresAt: string | null;
  embeddedAt: string;
}

/**
 * One document plus its current vector state, as returned by `listDocuments`.
 */
export interface SemanticDocumentSummary {
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
  vector: SemanticVectorSummary | null;
}

/**
 * Keyset-paginated document listing, ordered by `entityId` ascending within one
 * entity kind. `entityType` is required so the cursor is a single stable
 * column — that is exactly the checkpoint shape resumable runs persist.
 */
export interface SemanticDocumentListRequest {
  indexId: string;
  entityType: SemanticEntityType;
  /** Exclusive lower bound on `entityId`. Absent starts from the beginning. */
  afterEntityId?: string | null;
  limit: number;
  /** Includes tombstoned rows, which orphan/retention checks need. */
  includeDeleted?: boolean;
}

// ─── Index identities ───────────────────────────────────────────────────────

/**
 * Identity lifecycle.
 *
 * - `building`  — staged build in progress; never served.
 * - `ready`     — passed its build; eligible for cutover and for rollback.
 *                 **Many identities may be `ready` simultaneously.**
 * - `active`    — the single identity retrieval reads from.
 * - `retired`   — withdrawn; eligible for cleanup.
 * - `failed`    — build or activation failed; eligible for cleanup.
 */
export type SemanticIndexStatus = 'building' | 'ready' | 'active' | 'retired' | 'failed';

export const SEMANTIC_INDEX_STATUSES: readonly SemanticIndexStatus[] = [
  'building',
  'ready',
  'active',
  'retired',
  'failed',
] as const;

/** Statuses that accept document/vector writes. */
export const SEMANTIC_WRITABLE_IDENTITY_STATUSES: readonly SemanticIndexStatus[] = [
  'building',
  'ready',
  'active',
] as const;

export interface SemanticIndexIdentity {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  projectionVersion: number;
  status: SemanticIndexStatus;
  documentCount: number;
  vectorCount: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  failureReason: string | null;
}

export interface SemanticIndexIdentityInput {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  projectionVersion: number;
  now: string;
  /** Defaults to `building`; `ready` is allowed for adopted/imported spaces. */
  status?: Extract<SemanticIndexStatus, 'building' | 'ready'>;
}

/** Readiness gate evaluated before cutover. */
export interface SemanticActivationGate {
  minVectorCount?: number;
  /** Maximum documents allowed to lack a current vector. Defaults to 0. */
  maxStaleDocuments?: number;
  /** Maximum vectors allowed to be incompatible with the identity. Defaults to 0. */
  maxIncompatibleVectors?: number;
}

export type SemanticActivationRejection =
  | 'identity-not-found'
  | 'identity-not-ready'
  | 'already-active'
  | 'gate-vector-count'
  | 'gate-stale-documents'
  | 'gate-incompatible-vectors';

export interface SemanticActivationResult {
  status: 'activated' | 'rejected';
  activatedId: string | null;
  /** The identity demoted back to `ready` so it remains available for rollback. */
  previousActiveId: string | null;
  reason?: SemanticActivationRejection;
}

export type SemanticRollbackRejection =
  | 'identity-not-found'
  | 'identity-not-ready'
  | 'already-active'
  | 'no-active-identity'
  | 'incompatible-identity';

export interface SemanticRollbackResult {
  status: 'rolled-back' | 'rejected';
  activatedId: string | null;
  previousActiveId: string | null;
  reason?: SemanticRollbackRejection;
}

export interface SemanticCleanupResult {
  identitiesRemoved: number;
  documentsRemoved: number;
  vectorsRemoved: number;
  intentsRemoved: number;
  runsRemoved: number;
  /** Identity ids skipped because they were active or not yet eligible. */
  skippedIds: string[];
}

// ─── Durable intent queue ───────────────────────────────────────────────────

export type SemanticIntentKind = 'upsert' | 'delete';

/**
 * Terminal and non-terminal intent states.
 *
 * - `queued`    — waiting for a worker; `availableAt` gates visibility.
 * - `running`   — leased by `leaseOwner` until `leaseExpiresAt`.
 * - `succeeded` — terminal success.
 * - `failed`    — terminal failure after exhausting attempts.
 * - `denied`    — terminal policy refusal (sensitivity/route denial).
 * - `expired`   — terminal: lease recovery exhausted attempts, or retention
 *                 removed the entity before the work ran.
 */
export type SemanticIntentStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired';

export const SEMANTIC_TERMINAL_INTENT_STATUSES: readonly SemanticIntentStatus[] = [
  'succeeded',
  'failed',
  'denied',
  'expired',
] as const;

export interface SemanticIntent {
  id: string;
  idempotencyKey: string;
  indexId: string;
  kind: SemanticIntentKind;
  entityType: SemanticEntityType;
  entityId: string;
  sourceRevision: string | null;
  contentFingerprint: string | null;
  projectionVersion: number | null;
  /** When the authoritative domain write happened — the coalescing guard. */
  requestedAt: string;
  status: SemanticIntentStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  retryAfter: string | null;
  lastError: string | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SemanticIntentEnqueue {
  id: string;
  idempotencyKey: string;
  indexId: string;
  kind: SemanticIntentKind;
  entityType: SemanticEntityType;
  entityId: string;
  sourceRevision?: string | null;
  contentFingerprint?: string | null;
  projectionVersion?: number | null;
  requestedAt: string;
  now: string;
  availableAt?: string;
  maxAttempts?: number;
}

/**
 * - `enqueued`   — a new queued row was created.
 * - `coalesced`  — an existing queued row was updated in place with newer work.
 * - `ignored`    — an existing queued row already carries newer-or-equal work.
 * - `superseded` — an in-flight (`running`) row exists, so a *new* queued row
 *                  was created rather than corrupting the active attempt.
 */
export type SemanticIntentEnqueueStatus = 'enqueued' | 'coalesced' | 'ignored' | 'superseded';

export interface SemanticIntentEnqueueResult {
  status: SemanticIntentEnqueueStatus;
  intent: SemanticIntent;
}

export interface SemanticIntentClaimRequest {
  indexId: string;
  owner: string;
  limit: number;
  leaseMs: number;
  now: string;
}

export interface SemanticIntentFailure {
  id: string;
  owner: string;
  error: string;
  now: string;
  /** Terminal policy denial; skips retry regardless of attempts remaining. */
  denied?: boolean;
  /** Force a terminal failure even with attempts remaining. */
  terminal?: boolean;
  /** Provider-supplied retry hint; also becomes the next `availableAt`. */
  retryAfter?: string | null;
}

export interface SemanticIntentCompletion {
  id: string;
  owner: string;
  now: string;
  /** Free-form terminal detail, e.g. `embedded`, `unchanged`, `deleted`. */
  outcome?: string | null;
}

export interface SemanticIntentQueueMetrics {
  queued: number;
  running: number;
  /** Queued rows that already consumed at least one attempt. */
  retrying: number;
  succeeded: number;
  failed: number;
  denied: number;
  expired: number;
  /** `failed + denied + expired` — work that will never complete on its own. */
  permanentFailures: number;
  /** Sum of attempts beyond the first across all non-terminal rows. */
  totalRetries: number;
  oldestQueuedAgeMs: number;
  oldestRunningAgeMs: number;
}

// ─── Durable runs ───────────────────────────────────────────────────────────

export type SemanticRunKind = 'backfill' | 'reconcile' | 'cleanup';

export const SEMANTIC_RUN_KINDS: readonly SemanticRunKind[] = [
  'backfill',
  'reconcile',
  'cleanup',
] as const;

export type SemanticRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * Terminal run states a same-key run may legitimately be re-scheduled from.
 *
 * `succeeded` is deliberately absent: the fixed `backfill:initial` key exists
 * precisely so a completed backfill is not queued again on every maintenance
 * tick. `cancelled` is absent too — it records a deliberate stop, not a fault.
 */
export const SEMANTIC_RETRYABLE_TERMINAL_RUN_STATUSES: readonly SemanticRunStatus[] = [
  'failed',
  'expired',
] as const;

export interface SemanticRun {
  id: string;
  indexId: string;
  kind: SemanticRunKind;
  idempotencyKey: string;
  status: SemanticRunStatus;
  /** Stable resume point. Preserved across yields, retries, and recovery. */
  checkpoint: string | null;
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  /**
   * Failure/recovery attempts consumed, **not** claim count. Yielding a slice
   * and being reclaimed costs nothing; only `failRun` and expired-lease
   * recovery spend budget against `maxAttempts`.
   */
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SemanticRunCreate {
  id: string;
  indexId: string;
  kind: SemanticRunKind;
  idempotencyKey: string;
  now: string;
  availableAt?: string;
  maxAttempts?: number;
  checkpoint?: string | null;
}

/**
 * `created` covers both a first scheduling and the replacement of a run whose
 * key had gone terminal-failed; `existing` means the key still owns live or
 * successfully completed work and nothing was queued.
 */
export interface SemanticRunCreateResult {
  status: 'created' | 'existing';
  run: SemanticRun;
}

export interface SemanticRunClaimRequest {
  owner: string;
  leaseMs: number;
  now: string;
  indexId?: string;
  kinds?: SemanticRunKind[];
}

export interface SemanticRunCheckpoint {
  id: string;
  owner: string;
  now: string;
  checkpoint?: string | null;
  processedDelta?: number;
  failedDelta?: number;
  skippedDelta?: number;
  /** Renews the lease alongside the checkpoint when provided. */
  leaseMs?: number;
}

export interface SemanticRunFailure {
  id: string;
  owner: string;
  error: string;
  now: string;
  terminal?: boolean;
  availableAt?: string;
}

export interface SemanticRunCompletion {
  id: string;
  owner: string;
  now: string;
  status?: Extract<SemanticRunStatus, 'succeeded' | 'cancelled'>;
  checkpoint?: string | null;
}

export interface SemanticRunMetrics {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  expired: number;
}

// ─── Readiness & metrics ────────────────────────────────────────────────────

/**
 * Per-entity-kind observability. `stale`, `incompatible`, and `expired` are the
 * counts the architecture requires to be observable by entity kind and index
 * identity.
 */
export interface SemanticEntityKindReadiness {
  entityType: SemanticEntityType;
  documents: number;
  vectors: number;
  /** Live documents whose current revision has no matching vector. */
  stale: number;
  /**
   * Vectors whose provider/model/dimensions/projection version disagree with
   * their identity — they are not in the same comparable vector space.
   */
  incompatible: number;
  /** Live documents past `retainUntil`. */
  expired: number;
}

/**
 * A non-secret description of one index identity, safe to expose through an
 * operator/status surface: names the vector space and its lifecycle, never any
 * content, query, or credential.
 */
export interface SemanticIdentityDescriptor {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  projectionVersion: number;
  status: SemanticIndexStatus;
  documentCount: number;
  vectorCount: number;
}

/**
 * What the backend's retrieval strategy actually guarantees. Reported alongside
 * readiness so a status consumer can tell "ready" from "ready, but recall is
 * only guaranteed up to N entities".
 */
export interface SemanticScanCapability {
  kind: 'bounded-in-process';
  candidateCeiling: number;
  guaranteesFullRecall: boolean;
  guaranteedScale: number;
}

export interface SemanticIndexReadiness {
  available: boolean;
  activeIdentityId: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  projectionVersion: number | null;
  documentCount: number;
  vectorCount: number;
  /** Identities eligible for cutover or rollback, newest-ready first. */
  readyIdentityIds: string[];
  /**
   * Identities being built or awaiting cutover (`building`/`ready`), excluding
   * the active one. This is what makes "a new vector space is staging" visible
   * during an identity migration.
   */
  stagingIdentities: SemanticIdentityDescriptor[];
  scan: SemanticScanCapability;
  byEntityType: SemanticEntityKindReadiness[];
}

/** Progress for one durable run, including its resume checkpoint. */
export interface SemanticRunProgress {
  id: string;
  kind: SemanticRunKind;
  status: SemanticRunStatus;
  checkpoint: string | null;
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SemanticIndexMetrics {
  indexId: string;
  identityStatus: SemanticIndexStatus | null;
  documentCount: number;
  vectorCount: number;
  intents: SemanticIntentQueueMetrics;
  runs: SemanticRunMetrics;
  /** The newest run per kind, so progress and checkpoints are observable. */
  latestRuns: SemanticRunProgress[];
  byEntityType: SemanticEntityKindReadiness[];
}

// ─── Bounded-scan vector query ──────────────────────────────────────────────

/**
 * Explicit description of *how* candidates were selected. The current backends
 * scan a bounded, ordered candidate set in process: they report
 * `guaranteesFullRecall: false` and the scale they actually support, rather
 * than implying correct top-k at the 100,000-entity target.
 */
export interface SemanticQueryScan {
  kind: 'bounded-in-process';
  candidatesScanned: number;
  candidateCeiling: number;
  guaranteesFullRecall: boolean;
  /** Corpus size at which this strategy still returns correct top-k. */
  guaranteedScale: number;
  /** True when the corpus exceeded the ceiling, so recall is not guaranteed. */
  truncated: boolean;
}

/**
 * A portable predicate over projected document metadata.
 *
 * Domain filters (authorization scopes, connector/source, status) are expressed
 * against the *projection*, never against backend-specific domain tables, so the
 * same request runs unchanged on SQLite and PostgreSQL. Backends must apply
 * these predicates **before** the candidate ceiling, so an excluded row never
 * consumes a scan slot and never reaches scoring.
 *
 * `keys` is evaluated as a group because one logical field can live under
 * different metadata names per entity kind (a task's `status` and an alert's
 * `category`, for example). A key that is absent from a document never matches.
 */
export interface SemanticMetadataFilter {
  keys: string[];
  /**
   * - `any`  — at least one key equals one of `values` (inclusion).
   * - `none` — no key equals any of `values` (exclusion).
   */
  match: 'any' | 'none';
  values: string[];
  /** ASCII case-insensitive comparison on both sides. */
  caseInsensitive?: boolean;
}

export interface SemanticQueryRequest {
  /** Defaults to the active identity. A non-active identity must be `ready`. */
  indexId?: string;
  queryEmbedding: Float32Array;
  limit: number;
  entityTypes?: SemanticEntityType[];
  sensitivities?: SemanticSensitivity[];
  /** Excluded before scoring; never returned even at a lower rank. */
  excludeEntityIds?: string[];
  /** AND-ed portable metadata predicates, applied before the candidate cap. */
  metadataFilters?: SemanticMetadataFilter[];
  minScore?: number;
  /** Filters vectors/documents past their retention deadline. */
  now?: string;
}

export interface SemanticQueryResult {
  id: string;
  entityType: SemanticEntityType;
  entityId: string;
  score: number;
  title: string;
  body: string;
  /** The projected metadata the document was indexed with. Never raw source. */
  metadata: Record<string, SemanticDocumentMetadataValue>;
  sourceRevision: string;
  sourceUpdatedAt: string;
  /** When the vector itself was produced — the freshness stamp for callers. */
  embeddedAt: string;
  projectionVersion: number;
  sensitivity: SemanticSensitivity;
  provider: string;
  model: string;
}

export interface SemanticQueryResponse {
  identityId: string | null;
  results: SemanticQueryResult[];
  scan: SemanticQueryScan;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type SemanticIndexValidationCode =
  | 'unknown-entity-type'
  | 'unknown-sensitivity'
  | 'identity-not-found'
  | 'identity-not-writable'
  | 'identity-not-queryable'
  | 'provider-mismatch'
  | 'model-mismatch'
  | 'dimension-mismatch'
  | 'projection-version-mismatch'
  | 'invalid-embedding'
  | 'invalid-argument';

/**
 * Thrown for programming/contract violations that must never be silently
 * coerced into a "stale" or "unchanged" outcome — a mismatched vector space is
 * a bug, not a race.
 */
export class SemanticIndexValidationError extends Error {
  constructor(
    readonly code: SemanticIndexValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'SemanticIndexValidationError';
  }
}

// ─── Repository contract ────────────────────────────────────────────────────

export interface SemanticIndexRepository {
  // Identity lifecycle
  createIdentity(input: SemanticIndexIdentityInput): Promise<SemanticIndexIdentity>;
  getIdentity(id: string): Promise<SemanticIndexIdentity | null>;
  getActiveIdentity(): Promise<SemanticIndexIdentity | null>;
  listIdentities(status?: SemanticIndexStatus): Promise<SemanticIndexIdentity[]>;
  /** `building` -> `ready`. Only a built identity may become a cutover candidate. */
  markIdentityReady(id: string, now: string): Promise<boolean>;
  markIdentityFailed(id: string, reason: string, now: string): Promise<boolean>;
  /** Cutover. Only from `ready`, only after the gate passes. */
  activateIdentity(
    id: string,
    now: string,
    gate?: SemanticActivationGate,
  ): Promise<SemanticActivationResult>;
  /** Activates a specified prior compatible `ready` identity. */
  rollbackToIdentity(id: string, now: string): Promise<SemanticRollbackResult>;
  /** Refuses to retire the active identity. */
  retireIdentity(id: string, now: string): Promise<boolean>;
  /** Deletes only `retired`/`failed` identities and their cascaded rows. */
  cleanupIdentities(input: { before: string; now: string }): Promise<SemanticCleanupResult>;

  // Documents
  upsertDocument(document: SemanticDocumentWrite): Promise<SemanticDocumentWriteResult>;
  getDocument(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticDocumentRecord | null>;
  /**
   * Bounded, keyset-paginated listing of documents (with their vector state)
   * for one entity kind. This is the only enumeration primitive the contract
   * offers, so reconciliation and cleanup can never accidentally load the whole
   * corpus.
   */
  listDocuments(request: SemanticDocumentListRequest): Promise<SemanticDocumentSummary[]>;
  deleteDocument(input: {
    indexId: string;
    entityType: SemanticEntityType;
    entityId: string;
    now: string;
  }): Promise<SemanticDocumentDeleteResult>;
  /** Tombstones documents past `retainUntil` and removes their vectors. */
  expireDocuments(input: { now: string; indexId?: string; limit?: number }): Promise<{
    documentsExpired: number;
    vectorsRemoved: number;
  }>;
  /** Hard-deletes tombstoned documents older than `before`. */
  purgeDeletedDocuments(input: { before: string; limit?: number }): Promise<number>;

  // Vectors
  upsertVector(vector: SemanticVectorWrite): Promise<SemanticVectorWriteResult>;
  getVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<SemanticVectorRecord | null>;
  deleteVector(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): Promise<boolean>;
  queryVectors(request: SemanticQueryRequest): Promise<SemanticQueryResponse>;

  // Intent queue
  enqueueIntent(intent: SemanticIntentEnqueue): Promise<SemanticIntentEnqueueResult>;
  claimIntents(request: SemanticIntentClaimRequest): Promise<SemanticIntent[]>;
  renewIntentLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean>;
  completeIntent(input: SemanticIntentCompletion): Promise<boolean>;
  failIntent(input: SemanticIntentFailure): Promise<SemanticIntentStatus | null>;
  getIntent(id: string): Promise<SemanticIntent | null>;
  /** Requeues or expires `running` intents whose lease elapsed. */
  recoverExpiredIntentLeases(now: string): Promise<{ requeued: number; expired: number }>;
  /** Removes terminal intents older than `before`. */
  pruneIntents(before: string): Promise<number>;

  // Runs
  createRun(run: SemanticRunCreate): Promise<SemanticRunCreateResult>;
  claimRun(request: SemanticRunClaimRequest): Promise<SemanticRun | null>;
  renewRunLease(input: {
    id: string;
    owner: string;
    leaseMs: number;
    now: string;
  }): Promise<boolean>;
  checkpointRun(input: SemanticRunCheckpoint): Promise<boolean>;
  /** Yields a claimed run back to `queued`, preserving its checkpoint. */
  releaseRun(input: { id: string; owner: string; now: string; availableAt?: string }): Promise<boolean>;
  completeRun(input: SemanticRunCompletion): Promise<boolean>;
  failRun(input: SemanticRunFailure): Promise<SemanticRunStatus | null>;
  getRun(id: string): Promise<SemanticRun | null>;
  recoverExpiredRunLeases(now: string): Promise<{ requeued: number; expired: number }>;

  // Observability
  getMetrics(indexId: string, now?: string): Promise<SemanticIndexMetrics>;
  getReadiness(now?: string): Promise<SemanticIndexReadiness>;
}
