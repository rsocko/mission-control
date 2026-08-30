export type {
  SemanticActivationGate,
  SemanticActivationRejection,
  SemanticActivationResult,
  SemanticCleanupResult,
  SemanticDocumentDeleteResult,
  SemanticDocumentListRequest,
  SemanticDocumentMetadataValue,
  SemanticDocumentRecord,
  SemanticDocumentSummary,
  SemanticDocumentWrite,
  SemanticDocumentWriteResult,
  SemanticDocumentWriteStatus,
  SemanticEntityKindReadiness,
  SemanticEntityType,
  SemanticIdentityDescriptor,
  SemanticIndexDocument,
  SemanticIndexIdentity,
  SemanticIndexIdentityInput,
  SemanticIndexMetrics,
  SemanticIndexReadiness,
  SemanticIndexRepository,
  SemanticIndexStatus,
  SemanticIndexValidationCode,
  SemanticIntent,
  SemanticIntentClaimRequest,
  SemanticIntentCompletion,
  SemanticIntentEnqueue,
  SemanticIntentEnqueueResult,
  SemanticIntentEnqueueStatus,
  SemanticIntentFailure,
  SemanticIntentKind,
  SemanticIntentQueueMetrics,
  SemanticIntentStatus,
  SemanticMetadataFilter,
  SemanticQueryRequest,
  SemanticQueryResponse,
  SemanticQueryResult,
  SemanticQueryScan,
  SemanticRollbackRejection,
  SemanticRollbackResult,
  SemanticRun,
  SemanticRunCheckpoint,
  SemanticRunClaimRequest,
  SemanticRunCompletion,
  SemanticRunCreate,
  SemanticRunCreateResult,
  SemanticRunFailure,
  SemanticRunKind,
  SemanticRunMetrics,
  SemanticRunProgress,
  SemanticRunStatus,
  SemanticScanCapability,
  SemanticSensitivity,
  SemanticStaleReason,
  SemanticVectorRecord,
  SemanticVectorSummary,
  SemanticVectorWrite,
  SemanticVectorWriteResult,
  SemanticVectorWriteStatus,
} from './contracts';

export {
  SEMANTIC_ENTITY_TYPES,
  SEMANTIC_ENTITY_TYPE_ALIASES,
  SEMANTIC_INDEX_STATUSES,
  SEMANTIC_RETRYABLE_TERMINAL_RUN_STATUSES,
  SEMANTIC_RUN_KINDS,
  SEMANTIC_SENSITIVITIES,
  SEMANTIC_TERMINAL_INTENT_STATUSES,
  SEMANTIC_WRITABLE_IDENTITY_STATUSES,
  SemanticIndexValidationError,
  isSemanticEntityType,
  isSemanticSensitivity,
  normalizeSemanticEntityType,
  semanticSensitivityRank,
} from './contracts';

export {
  canonicalJson,
  computeNorm,
  computeSemanticRetryAt,
  cosineSimilarity,
  getSemanticIntentLeaseMs,
  getSemanticIntentMaxAttempts,
  getSemanticRunLeaseMs,
  getSemanticRunMaxAttempts,
  getSemanticScanLimit,
  identityDescriptor,
  jsonEquals,
  normalizeMetadataFilters,
  parseEmbedding,
  runProgress,
  serializeEmbedding,
  supersededRunIdempotencyKey,
} from './validation';

export { SqliteSemanticIndexRepository } from './sqlite-repository';

export {
  getSemanticIndexRepository,
  resetSemanticIndexRepositoryForTests,
} from './repository-facade';

export {
  assessLegacyCohorts,
  classifyLegacyRow,
  iterateLegacyAdoptionCandidates,
  legacyEmbeddingsTableExists,
  type LegacyAdoptionCandidate,
  type LegacyAdoptionTarget,
  type LegacyCohort,
  type LegacyCohortAssessment,
  type LegacyIneligibilityReason,
} from './sqlite-legacy-adoption';

// ─── Projections ────────────────────────────────────────────────────────────

export {
  ALERT_PROJECTION_VERSION,
  SEMANTIC_PROJECTION_VERSION,
  TASK_PROJECTION_VERSION,
  buildEmbeddingText,
  projectAlert,
  projectSource,
  projectTask,
  projectionVersionFor,
  type SemanticProjectionOptions,
  type SemanticSensitivityResolver,
} from './projections';

export {
  SEMANTIC_BODY_MAX_LENGTH,
  SEMANTIC_KEYWORD_MAX_LENGTH,
  SEMANTIC_MAX_KEYWORDS,
  SEMANTIC_TITLE_MAX_LENGTH,
  computeContentFingerprint,
  computeSourceRevision,
  latestTimestamp,
  normalizeBlock,
  normalizeBodyField,
  normalizeInline,
  normalizeKeywords,
  normalizeMetadata,
  normalizeTitleField,
  toIsoTimestamp,
  truncateStable,
} from './projections/normalize';

export { createPolicySensitivityResolver } from './sensitivity';

// ─── Authoritative source port ──────────────────────────────────────────────

export {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  isSemanticSourceEntityType,
  type SemanticAlertSource,
  type SemanticSourceEntityType,
  type SemanticSourceIdPage,
  type SemanticSourcePort,
  type SemanticSourceRecord,
  type SemanticSourceRecordPage,
  type SemanticTaskSource,
} from './source/contracts';

export {
  getSemanticSourcePort,
  resetSemanticSourcePortForTests,
} from './source/facade';

// ─── Embedding seam ─────────────────────────────────────────────────────────

export {
  AIEmbeddingProvider,
  getSemanticEmbeddingProvider,
  type SemanticEmbeddingFailure,
  type SemanticEmbeddingOutcome,
  type SemanticEmbeddingProvider,
  type SemanticEmbeddingRequest,
  type SemanticEmbeddingRoute,
  type SemanticEmbeddingSuccess,
  type SemanticRouteResolution,
} from './embedding-provider';

// ─── Service, runs, worker ──────────────────────────────────────────────────

export {
  SemanticIndexService,
  type SemanticIdentityResolution,
  type SemanticIndexServiceOptions,
  type SemanticIntentOutcome,
  type SemanticIntentOutcomeStatus,
  type SemanticPublishResult,
} from './service';

export {
  parseKindCursor,
  runBackfillSlice,
  runCleanupSlice,
  runIdempotencyKey,
  runReconcileSlice,
  runSlice,
  serializeKindCursor,
  type SemanticCleanupCounts,
  type SemanticDrift,
  type SemanticReconciliationCounts,
  type SemanticRunContext,
  type SemanticRunDependencies,
  type SemanticRunSliceResult,
} from './runs';

export {
  SemanticIndexWorker,
  type SemanticIndexWorkerOptions,
  type SemanticWorkerCycleReport,
} from './worker';

export {
  getSemanticWorkerConfig,
  isSemanticIndexEnabled,
  type SemanticWorkerConfig,
} from './config';

export {
  activateSemanticIdentity,
  createSemanticIndexRuntime,
  getSemanticIndexMetrics,
  getSemanticIndexReadiness,
  getSemanticIndexRuntime,
  getSemanticIndexService,
  getSemanticIndexWorker,
  publishSemanticDelete,
  publishSemanticUpsert,
  resetSemanticIndexRuntimeForTests,
  retireSemanticIdentity,
  rollbackSemanticIdentity,
  scheduleSemanticBackfill,
  setSemanticIndexRuntimeForTests,
  startSemanticIndexWorker,
  stopSemanticIndexWorker,
  type SemanticBackfillSchedule,
  type SemanticBackfillScheduleStatus,
  type SemanticIdentityLifecycleOutcome,
  type SemanticIndexRuntime,
  type SemanticIndexRuntimeOverrides,
} from './runtime';
