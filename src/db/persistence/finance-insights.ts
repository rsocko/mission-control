/**
 * Backend-neutral persistence contract for Layer 5B: the Tyrion finance
 * insight surfaces built on top of the Layer 5A core projection (history
 * projection, transaction backfill, publication capture/delivery, the
 * occurrence cache, and the small connector-selection helper they all
 * share). Every mutating method is one adapter-owned atomic operation;
 * callers never receive a transaction or driver handle. Fact/summary
 * payloads are treated as opaque, already-validated JSON at this boundary —
 * schema validation and canonicalization stay in `@/lib/finance-insights`.
 */

import type { ConnectorNotificationInput } from './connector-execution';

// ─── Shared value shapes ────────────────────────────────────────────────────

export interface FinanceInsightWindowProof {
  index: number;
  start: string;
  end: string;
  sourceAsOf: string;
  itemCount: number;
  digest: string;
}

// ─── History projection (finance-insight-history-sync.ts) ──────────────────

export interface FinanceInsightProjectionState {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  generationId: string | null;
  lastSuccessfulAt: string | null;
  sourceAsOf: string | null;
  itemCount: number | null;
  contentDigest: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  windowCount: number | null;
  windowsDigest: string | null;
  bridgeContractVersion: string | null;
}

export interface FinanceInsightProjectionAttemptStartCommand {
  connectorId: string;
  attemptId: string;
  attemptAt: string;
}

export interface FinanceInsightProjectionAttemptFactsCommand {
  connectorId: string;
  attemptId: string;
  facts: ReadonlyArray<{ sourceRef: string; occurredOn: string; payload: unknown }>;
}

export interface FinanceInsightProjectionAttemptWindowCommand {
  connectorId: string;
  attemptId: string;
  proof: FinanceInsightWindowProof;
}

export interface FinanceInsightProjectionPromoteAttemptCommand {
  connectorId: string;
  attemptId: string;
  generationId: string;
  completedAt: string;
  sourceAsOf: string;
  itemCount: number;
  contentDigest: string;
  coverageStart: string;
  coverageEnd: string;
  windowCount: number;
  windowsDigest: string;
  bridgeContractVersion: string;
}

export interface FinanceInsightProjectionFailAttemptCommand {
  connectorId: string;
  attemptId: string;
  failedAt: string;
  errorCode: string;
}

export interface FinanceInsightDatasetInsightState {
  dataset: string;
  generationId: string | null;
  sourceAsOf: string | null;
  freshUntil: string | null;
  outcome: 'succeeded' | 'failed' | null;
  itemCount: number | null;
  contentDigest: string | null;
  bridgeContractVersion: string | null;
}

/**
 * Raised when an attempt-fenced write (promote/fail) no longer targets the
 * connector's current attempt. A superseded caller's write becomes a
 * deliberate no-op from the caller's point of view (it should not clobber a
 * newer run), so this is caught and mapped by the caller.
 */
export class FinanceInsightProjectionFenceError extends Error {
  readonly code = 'finance_insight_projection_attempt_stale';

  constructor() {
    super('Finance insight projection attempt is no longer current');
    this.name = 'FinanceInsightProjectionFenceError';
  }
}

// ─── Operational (live, non-staged) reference/transaction facts ────────────
// Backs both the backfill window/promotion digest verification against the
// live source-of-truth and the recurring/category/account/tag publication
// facts, which are not versioned through generations. Shapes and
// normalization/scoping semantics are identical to what used to live in
// `@/lib/finance-insights/projection-facts` (now retired in favor of this
// port plus the SQLite-only synchronous helper it and worker-runtime share).

export type FinanceInsightOperationalFactKind =
  | 'transaction'
  | 'recurring'
  | 'category'
  | 'account'
  | 'tag';

export interface FinanceInsightOperationalTransactionFact {
  sourceRef: string;
  occurredOn: string;
  amountMinor: number;
  merchantName: string;
  categoryRef: string | null;
  accountRef: string | null;
  isPending: boolean;
  recurringRef: string | null;
  tagRefs: string[];
}

export interface FinanceInsightOperationalRecurringFact {
  sourceRef: string;
  displayName: string;
  amountMinor: number | null;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'unknown';
  nextDate: string | null;
  categoryRef: string | null;
  accountRef: string | null;
  active: boolean;
}

export interface FinanceInsightOperationalCategoryFact {
  sourceRef: string;
  displayName: string;
  groupRef: string | null;
  active: boolean;
}

export interface FinanceInsightOperationalAccountFact {
  sourceRef: string;
  accountType: 'checking' | 'savings' | 'credit' | 'cash' | 'loan' | 'investment' | 'other';
  active: boolean;
}

export interface FinanceInsightOperationalTagFact {
  sourceRef: string;
  displayName: string;
  active: boolean;
}

export interface FinanceInsightOperationalProjectionFacts {
  transaction: FinanceInsightOperationalTransactionFact[];
  recurring: FinanceInsightOperationalRecurringFact[];
  category: FinanceInsightOperationalCategoryFact[];
  account: FinanceInsightOperationalAccountFact[];
  tag: FinanceInsightOperationalTagFact[];
}

export interface FinanceInsightProjectionPersistence {
  /**
   * Marks the connector's projection attempt running and clears any staged
   * facts/windows left over from a prior attempt that never promoted.
   */
  startAttempt(command: FinanceInsightProjectionAttemptStartCommand): Promise<void>;
  insertAttemptFacts(command: FinanceInsightProjectionAttemptFactsCommand): Promise<void>;
  insertAttemptWindowProof(command: FinanceInsightProjectionAttemptWindowCommand): Promise<void>;
  readAttemptFacts(connectorId: string, attemptId: string): Promise<Array<{
    sourceRef: string;
    occurredOn: string;
    payload: unknown;
  }>>;
  readAttemptWindowProofs(
    connectorId: string,
    attemptId: string,
  ): Promise<FinanceInsightWindowProof[]>;
  /**
   * Renames the attempt's staged rows onto the stable generation id, fences
   * on the attempt still being current, and clears every other generation.
   * Throws `FinanceInsightProjectionFenceError` when the attempt has been
   * superseded (e.g. a concurrent retry already promoted or failed it).
   */
  promoteAttempt(command: FinanceInsightProjectionPromoteAttemptCommand): Promise<void>;
  /** Marks only the still-current attempt failed; a superseded attempt is a no-op. */
  failAttempt(command: FinanceInsightProjectionFailAttemptCommand): Promise<{ recorded: boolean }>;

  readState(connectorId: string): Promise<FinanceInsightProjectionState | null>;
  readWindowProofs(
    connectorId: string,
    generationId: string,
  ): Promise<FinanceInsightWindowProof[]>;
  /** Reads the promoted, generation-scoped transaction facts payload as-stored. */
  readPromotedTransactionFacts(connectorId: string, generationId: string): Promise<unknown[]>;
  readDatasetInsightState(connectorId: string): Promise<FinanceInsightDatasetInsightState[]>;
  /**
   * Reads live (non-staged) connector reference/transaction facts directly
   * from the connector's current-state tables, normalized and identity-scoped
   * identically to `readPromotedTransactionFacts`'s already-promoted
   * payloads. `transactionStart`/`transactionEnd` only bound the
   * `'transaction'` kind; every other kind always reads its full live set for
   * the connector. `onlyKind`, when given, skips computing every other kind.
   */
  readOperationalProjectionFacts(
    connectorId: string,
    transactionStart: string,
    onlyKind?: FinanceInsightOperationalFactKind,
    transactionEnd?: string,
  ): Promise<FinanceInsightOperationalProjectionFacts>;
}

// ─── Transaction backfill (transaction-backfill.ts) ─────────────────────────

export interface FinanceInsightBackfillPlan {
  id: string;
  connectorId: string;
  idempotencyKey: string;
  horizonMonths: number;
  coverageStart: string;
  coverageEnd: string;
  currency: string;
  bridgeContractVersion: string;
  windowCount: number;
  nextWindowOrdinal: number;
  status: 'running' | 'completed';
}

export interface FinanceInsightBackfillWindowProof {
  windowOrdinal: number;
  generationRef: string;
  windowStart: string;
  windowEnd: string;
  sourceAsOf: string;
  itemCount: number;
  contentDigest: string;
  currency: string;
  bridgeContractVersion: string;
}

export interface FinanceInsightBackfillTransaction {
  id: string;
  date: string;
  amount: number;
  merchant: { name: string; logoUrl: string | null };
  category: { id: string; name: string } | null;
  account: { id: string; displayName: string; mask: string | null };
  isPending: boolean;
  isRecurring: boolean;
  notes: string | null;
  tags: readonly string[];
  tagReferences: ReadonlyArray<{ id: string; name: string }>;
}

export interface FinanceInsightBackfillPageCommand {
  connectorId: string;
  generationRef: string;
  transactions: readonly FinanceInsightBackfillTransaction[];
  provenance: { provider: 'demo' | 'live'; fetchedAt: string };
  now: string;
}

export interface FinanceInsightBackfillWindowCaptureCommand {
  connectorId: string;
  planId: string;
  windowOrdinal: number;
  planWindowCount: number;
  windowStart: string;
  windowEnd: string;
  generationRef: string;
  sourceAsOf: string;
  currency: string;
  bridgeContractVersion: string;
  completedAt: string;
  /** Expected transaction count for this window after tombstoning stale rows. */
  expectedItemCount: number;
  /** Ceiling on the plan's running total transaction item count. */
  maxTotalItemCount: number;
}

export interface FinanceInsightBackfillPromotionCommand {
  connectorId: string;
  planId: string;
  idempotencyKey: string;
  generationId: string;
  sourceAsOf: string;
  itemCount: number;
  contentDigest: string;
  coverageStart: string;
  coverageEnd: string;
  windowCount: number;
  windowsDigest: string;
  bridgeContractVersion: string;
  completedAt: string;
  facts: readonly unknown[];
  windows: readonly FinanceInsightWindowProof[];
}

export class FinanceInsightBackfillDeliveryEnabledError extends Error {
  readonly code = 'finance_insight_backfill_delivery_enabled';

  constructor() {
    super('Finance insight delivery is enabled; backfill is unavailable');
    this.name = 'FinanceInsightBackfillDeliveryEnabledError';
  }
}

export class FinanceInsightBackfillWindowIncompleteError extends Error {
  readonly code = 'finance_insight_backfill_window_incomplete';

  constructor() {
    super('Finance insight backfill window is incomplete');
    this.name = 'FinanceInsightBackfillWindowIncompleteError';
  }
}

export class FinanceInsightBackfillTooLargeError extends Error {
  readonly code: string;

  constructor(code = 'transaction_generation_too_large') {
    super('Finance insight backfill exceeds the item ceiling');
    this.name = 'FinanceInsightBackfillTooLargeError';
    this.code = code;
  }
}

export class FinanceInsightBackfillPlanUnavailableError extends Error {
  readonly code = 'finance_insight_backfill_window_conflict';

  constructor() {
    super('Finance insight backfill plan is unavailable or not ready to promote');
    this.name = 'FinanceInsightBackfillPlanUnavailableError';
  }
}

export class FinanceInsightBackfillProjectionConflictError extends Error {
  readonly code = 'finance_insight_backfill_projection_changed';

  constructor() {
    super('Finance insight backfill projection changed since it was captured');
    this.name = 'FinanceInsightBackfillProjectionConflictError';
  }
}

export interface FinanceInsightBackfillPersistence {
  /** Throws `FinanceInsightBackfillDeliveryEnabledError` when delivery is live. */
  assertDeliveryDisabled(connectorId: string): Promise<void>;
  loadPlan(connectorId: string, idempotencyKey: string): Promise<FinanceInsightBackfillPlan | null>;
  /**
   * Atomically returns the existing plan for `idempotencyKey` or creates one.
   * Fences on delivery being disabled. Callers validate that an existing
   * plan's identity fields match the request.
   */
  createPlan(input: {
    connectorId: string;
    idempotencyKey: string;
    horizonMonths: number;
    currency: string;
    coverageStart: string;
    coverageEnd: string;
    bridgeContractVersion: string;
    windowCount: number;
    now: string;
  }): Promise<FinanceInsightBackfillPlan>;
  loadWindowProofs(planId: string): Promise<FinanceInsightBackfillWindowProof[]>;
  /** Looks up the observed date of `upstreamTransactionId` in a prior window of the same plan. */
  findPriorWindowTransactionDate(
    connectorId: string,
    planId: string,
    upstreamTransactionId: string,
  ): Promise<string | null>;
  /** Backfill-fenced write of a transaction page (no incremental-sync generation fence). */
  upsertTransactionPage(command: FinanceInsightBackfillPageCommand): Promise<{
    added: number;
    updated: number;
  }>;
  /**
   * Tombstones transactions in the window not seen by `generationRef`,
   * verifies the resulting live count matches `expectedItemCount`, records
   * the window proof, and advances the plan. Throws
   * `FinanceInsightBackfillDeliveryEnabledError`,
   * `FinanceInsightBackfillWindowIncompleteError`, or
   * `FinanceInsightBackfillTooLargeError` on failure.
   */
  recordWindowCapture(command: FinanceInsightBackfillWindowCaptureCommand): Promise<{
    itemCount: number;
  }>;
  recordPlanFailure(planId: string, errorCode: string, now: string): Promise<void>;
  /**
   * Promotes a completed backfill plan's accumulated windows into the shared
   * history projection generation. Idempotent when the generation already
   * matches; throws `FinanceInsightBackfillPlanUnavailableError` when the
   * plan is not ready, or `FinanceInsightBackfillProjectionConflictError`
   * when a different generation is already current.
   */
  promoteCompletedPlan(
    command: FinanceInsightBackfillPromotionCommand,
  ): Promise<{ promoted: boolean }>;
}

// ─── Publication (publication.ts) ───────────────────────────────────────────

export interface FinanceInsightPublicationState {
  publicationId: string | null;
  generationIdentity: string | null;
  sourceSequence: number;
}

export interface FinanceInsightPublicationFact {
  kind: string;
  sourceRef: string;
  batchIndex: number;
  factIndex: number;
  payload: unknown;
}

export interface FinanceInsightPublicationCaptureCommand {
  connectorId: string;
  providerType: string;
  capturedAt: string;
  generationIdentity: string;
  /** `(currentState?.sourceSequence ?? 0) + 1`, computed by the caller from a prior read. */
  expectedSourceSequence: number;
  publicationId: string;
  idempotencyKey: string;
  createRequest: unknown;
  contractVersion: string;
  sourceAsOf: string;
  coverageStart: string;
  coverageEnd: string;
  currency: string;
  bridgeContractVersion: string;
  capturedConstituents: unknown;
  manifest: unknown;
  manifestDigest: string;
  expiresAt: string;
  cacheCount: number;
  facts: readonly FinanceInsightPublicationFact[];
}

export type FinanceInsightPublicationCaptureResult =
  | { status: 'captured'; publicationId: string; sourceSequence: number }
  | { status: 'idempotent'; publicationId: string; sourceSequence: number }
  | { status: 'conflict' };

export interface FinanceInsightPublicationRecord {
  id: string;
  createRequest: unknown;
  manifestDigest: string;
  sourceAsOf: string;
  alertCapable: boolean;
  expiresAt: string;
}

export interface FinanceInsightPublicationPersistence {
  readCurrentState(connectorId: string): Promise<FinanceInsightPublicationState | null>;
  capture(
    command: FinanceInsightPublicationCaptureCommand,
  ): Promise<FinanceInsightPublicationCaptureResult>;
  recordOutcome(input: {
    connectorId: string;
    providerType: string;
    now: string;
    outcome: 'refused' | 'failed';
    code: string;
  }): Promise<void>;
  /** Loads the latest (or a specific) still-fresh publication plus its ordered facts. */
  loadLatest(
    connectorId: string,
    publicationId: string | null,
    now: string,
  ): Promise<{
    record: FinanceInsightPublicationRecord;
    facts: FinanceInsightPublicationFact[];
  } | null>;
}

// ─── Delivery checkpoints (orchestrator.ts) ─────────────────────────────────

export interface FinanceInsightDeliveryState {
  stage: 'captured' | 'staging' | 'uploading' | 'committed' | 'evaluation-requested';
  nextBatchOrdinal: number;
  detectorSetVersion: string | null;
  policyVersion: number | null;
  evaluationSequence: number | null;
}

export interface FinanceInsightDeliveryPersistence {
  findContinuationPublicationId(connectorId: string): Promise<string | null>;
  /** Inserts the delivery checkpoint row if absent, then returns its current state. */
  ensureState(input: {
    connectorId: string;
    publicationId: string;
    sourceSequence: number;
    now: string;
  }): Promise<FinanceInsightDeliveryState>;
  markStaging(input: { publicationId: string; now: string }): Promise<void>;
  advanceBatch(input: { publicationId: string; nextBatchOrdinal: number; now: string }): Promise<void>;
  markCommitted(input: {
    publicationId: string;
    detectorSetVersion: string;
    policyVersion: number;
    now: string;
  }): Promise<void>;
  readMaxEvaluationSequence(input: {
    connectorId: string;
    excludingPublicationId: string;
  }): Promise<number | null>;
  recordEvaluationOutcome(input: {
    publicationId: string;
    evaluationSequence: number;
    evaluationState: string;
    evaluationIdempotencyKey: string;
    now: string;
    succeeded: boolean;
    errorCode: string | null;
    retryable: boolean;
  }): Promise<void>;
  recordFailure(input: {
    publicationId: string;
    code: string;
    retryable: boolean;
    now: string;
  }): Promise<void>;
}

// ─── Occurrence cache (occurrence-cache.ts) ─────────────────────────────────

export interface FinanceInsightOccurrenceCacheState {
  sourceGeneration: string;
  sourceSequence: number;
  sourceAsOf: string;
  summaryExpiresAt: string;
  purgeAfter: string;
}

export interface FinanceInsightOccurrenceMetadataRow {
  occurrenceId: string;
  insightId: string;
  kind: string;
  sourceLifecycle: string | null;
  updatedAt: string;
  summaryPayload: unknown | null;
}

export interface FinanceInsightOccurrenceReplaceItem {
  occurrenceId: string;
  insightId: string;
  deliveryRevision: number;
  revisionDigest: string;
  kind: string;
  entityKind: string;
  entitySourceRef: string;
  entityLabel: string;
  analysisState: string;
  sourceLifecycle: string | null;
  severity: string;
  confidence: string;
  baselineSufficiency: string;
  headline: string;
  freshnessState: string;
  freshnessSourceAsOf: string | null;
  targetDescriptors: unknown;
  summaryPayload: unknown;
  updatedAt: string;
}

export interface FinanceInsightOccurrenceCachePersistence {
  prune(now: string, payloadCutoff: string, tombstoneCutoff: string): Promise<void>;
  /**
   * Atomically validates and replaces (or idempotently refreshes) the
   * connector's occurrence cache generation. Throws a plain `Error` with a
   * descriptive message on any identity/staleness/revision violation,
   * matching the existing lib-level error surface.
   */
  replace(input: {
    connectorId: string;
    sourceGeneration: string;
    sourceSequence: number;
    sourceAsOf: string;
    refreshedAt: string;
    summaryExpiresAt: string;
    purgeAfter: string;
    tombstoneLimit: number;
    items: readonly FinanceInsightOccurrenceReplaceItem[];
  }): Promise<void>;
  readState(connectorId: string): Promise<FinanceInsightOccurrenceCacheState | null>;
  readCurrentGenerationRows(
    connectorId: string,
    sourceGeneration: string,
    limit: number,
  ): Promise<FinanceInsightOccurrenceMetadataRow[]>;
}

// ─── Shared connector-selection helper ──────────────────────────────────────

export interface FinanceInsightConnectorPersistence {
  /** Lists up to `limit` enabled+non-deleted connector ids of the requested types. */
  listEnabledConnectorIds(
    connectorTypes: readonly string[],
    limit: number,
  ): Promise<readonly string[]>;
  /** Returns the single enabled+non-deleted connector id of one of `connectorTypes`, or null. */
  resolveSingleEnabledConnectorId(connectorTypes: readonly string[]): Promise<string | null>;
}

// ─── Notification lifecycle (notification-ingestion.ts) ────────────────────

/**
 * One occurrence's reconcile-only signal: the notification (if any) already
 * tracking `sourceId` must be closed out because the occurrence is no
 * longer eligible for active delivery. Deliberately opaque/lib-agnostic —
 * eligibility decisions and the insight-specific `InsightOccurrenceSummaryV1`
 * shape stay in `@/lib/finance-insights`; the adapter only applies the
 * already-decided close-out.
 */
export interface FinanceInsightNotificationReconcileItem {
  sourceId: string;
  lastSourceActivityAt: string;
  lastSourceActivityKey: string;
  sourceResolvedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface FinanceInsightNotificationLifecycleResult {
  id: string;
  created: boolean;
  pendingDelivery: boolean;
}

export interface FinanceInsightNotificationLifecycleOutcome {
  results: readonly FinanceInsightNotificationLifecycleResult[];
  hasPendingDelivery: boolean;
}

/**
 * Reuses `ConnectorNotificationInput` (from the generic connector-execution
 * contract) for the notification body instead of introducing a second
 * generic notification-input shape. `groupKey`/`dedupeKey` travel alongside
 * it rather than on `ConnectorNotificationInput` itself (which has no such
 * fields, matching the existing generic connector-notification adapters):
 * finance-insight notifications group multiple occurrence notifications
 * under one insight (`groupKey`) and de-duplicate delivery independent of
 * the notification's row identity (`dedupeKey`), both already computed by
 * `@/lib/finance-insights/notification-ingestion` today.
 */
export interface FinanceInsightNotificationIngestItem {
  readonly input: ConnectorNotificationInput;
  readonly groupKey: string | null;
  readonly dedupeKey: string | null;
}

/**
 * Reuses `ConnectorNotificationInput` (from the generic connector-execution
 * contract) for `ingest` items instead of introducing a second generic
 * notification-input shape.
 */
export interface FinanceInsightNotificationLifecyclePersistence {
  isDeliveryEnabled(connectorId: string): Promise<boolean>;
  /**
   * One adapter-owned atomic transaction: closes out `reconcile` items no
   * longer eligible for active delivery, creates/dedupes `ingest` items by
   * `sourceId`, and resyncs each ingested notification's provider
   * presentation/actions in the same pass (every ingest, not only on
   * create, since finance occurrences are re-delivered in place as they
   * evolve). Callers must wake the push dispatcher themselves, after the
   * returned promise resolves, when `hasPendingDelivery` is true
   * (wake-after-commit).
   */
  runLifecycle(input: {
    connectorId: string;
    now: string;
    reconcile: readonly FinanceInsightNotificationReconcileItem[];
    ingest: readonly FinanceInsightNotificationIngestItem[];
  }): Promise<FinanceInsightNotificationLifecycleOutcome>;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

/**
 * Layer 5B insight composition. Registered as `FinanceWorkerPersistence.insights`
 * alongside the Layer 5A core (identity/snapshots/datasets/attribution): a
 * backend either supplies the whole finance surface or none of it.
 */
export interface FinanceInsightPersistence {
  readonly connectors: FinanceInsightConnectorPersistence;
  readonly projection: FinanceInsightProjectionPersistence;
  readonly backfill: FinanceInsightBackfillPersistence;
  readonly publication: FinanceInsightPublicationPersistence;
  readonly delivery: FinanceInsightDeliveryPersistence;
  readonly occurrenceCache: FinanceInsightOccurrenceCachePersistence;
  readonly notifications: FinanceInsightNotificationLifecyclePersistence;
}
