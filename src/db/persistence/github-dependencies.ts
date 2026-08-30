import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';

/**
 * Backend-neutral persistence port for GitHub dependency generation,
 * reconciliation, resume, and polling.
 *
 * The adapters (`createSqliteGitHubDependencyRepositories`,
 * `createPostgresGitHubDependencyRepositories`) own every driver detail and are
 * the sole authority on the fenced-write transactions. Nothing in this file may
 * reference `better-sqlite3`, `pg`, or Drizzle types.
 *
 * `src/lib/sync/task-dependency-manager.ts` orchestrates these methods, keeps
 * every pure computation (evidence merge, identity-runtime resolution, edge
 * dedup, progress projection), and translates the discriminated results into the
 * domain errors it throws.
 *
 * Atomicity: every method whose name mutates snapshot state is exactly one
 * transaction in each adapter and re-checks the same fence predicates the legacy
 * `validateDependencySnapshotMutationInTransaction` used — snapshot id + status,
 * persisted identity mode/revision, the live GitHub identity epoch
 * (`mode_revision`), and the operation's cursor/phase.
 */

// ── Records ───────────────────────────────────────────────────────────────────

export type DependencySnapshotStatus =
  | 'running'
  | 'failed'
  | 'partial'
  | 'completed';

export type DependencySnapshotPhase =
  | 'collecting'
  | 'ready'
  | 'reconciling'
  | 'completed';

export type DependencyReadMode = 'graphql-bulk' | 'rest-fallback' | 'legacy';

export type DependencyIdentityEvidenceSource =
  | 'graphql-node'
  | 'rest-unavailable'
  | 'legacy-unavailable';

export type DependencyEvidenceState = 'verified' | 'missing' | 'partial';

/** Mirrors `dependency_reconciliation_snapshots` as a backend-neutral row. */
export interface DependencySnapshotRecord {
  id: string;
  connectorInstanceId: string;
  status: DependencySnapshotStatus;
  phase: DependencySnapshotPhase;
  readMode: DependencyReadMode | null;
  cursor: number;
  total: number;
  batchSize: number;
  failureCount: number;
  importedCount: number;
  removedCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  collectionCompletedAt: string | null;
  collectionPageCount: number;
  overflowFetchCount: number;
  identityMode: string;
  identityModeRevision: number;
  identityEvidenceSource: DependencyIdentityEvidenceSource;
  identityEvidenceEligible: boolean;
  identityEvidenceFailureReason: string | null;
  failedAt: string | null;
  nextAttemptAt: string | null;
  failureReason: string | null;
  lastResumeAttemptAt: string | null;
  lastResumeOutcome: 'advanced' | 'deferred' | 'failed' | null;
  lastResumeReason: string | null;
}

/**
 * The full column set for a freshly created snapshot. Fields the schema defaults
 * are optional; the adapters apply the same defaults as the SQLite/PostgreSQL
 * table definitions.
 */
export interface DependencySnapshotInsert {
  id: string;
  connectorInstanceId: string;
  status: DependencySnapshotStatus;
  phase: DependencySnapshotPhase;
  readMode?: DependencyReadMode | null;
  cursor?: number;
  total: number;
  batchSize: number;
  failureCount?: number;
  importedCount?: number;
  removedCount?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  collectionCompletedAt?: string | null;
  collectionPageCount?: number;
  overflowFetchCount?: number;
  identityMode: string;
  identityModeRevision: number;
  identityEvidenceSource?: DependencyIdentityEvidenceSource;
  identityEvidenceEligible?: boolean;
  identityEvidenceFailureReason?: string | null;
  failedAt?: string | null;
  nextAttemptAt?: string | null;
  failureReason?: string | null;
}

/** Mirrors `task_dependencies`. */
export interface DependencyRecord {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: 'blocks' | 'related';
  connectorInstanceId: string | null;
  syncStatus: 'local' | 'pending' | 'synced' | 'failed';
  syncAction: 'create' | 'delete' | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface TaskDependencyInsert {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: 'blocks' | 'related';
  connectorInstanceId: string | null;
  syncStatus: 'local' | 'pending' | 'synced' | 'failed';
  syncAction: 'create' | 'delete' | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

/** The task columns dependency reconciliation reads. */
export interface DependencyTaskRow {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  isChecklistItem: boolean;
  metadata: unknown;
}

export interface DependencySnapshotEdgeRecord {
  blockerSourceId: string;
  blockedSourceId: string;
  blockerIdentityEvidence: ExternalIdentityEvidence | null;
  blockerIdentityEvidenceState: DependencyEvidenceState;
}

export interface DependencySnapshotItemEvidence {
  sourceId: string;
  identityEvidence: ExternalIdentityEvidence | null;
  identityEvidenceState: DependencyEvidenceState;
}

export interface DependencySnapshotItemInsert {
  position: number;
  sourceId: string;
  verified: boolean;
  identityEvidence?: ExternalIdentityEvidence | null;
  identityEvidenceState: DependencyEvidenceState;
}

export interface ResumableReconciliationRow {
  connectorId: string;
  generationId: string;
  status: 'running' | 'failed';
  processed: number;
  total: number;
  nextAttemptAt: string | null;
}

export interface HealthTerminalStatusRow {
  connectorInstanceId: string;
  status: DependencySnapshotStatus;
  startedAt: string;
}

export interface SnapshotEdgeCountRow {
  snapshotId: string;
  count: number;
}

export interface GenerationEdgeRow {
  blockerSourceId: string;
  blockedSourceId: string;
}

/**
 * The frozen identity epoch a fenced snapshot mutation validates against. Mirrors
 * the fields `validateDependencySnapshotMutationInTransaction` re-checked.
 */
export interface DependencySnapshotFence {
  id: string;
  connectorInstanceId: string;
  identityMode: string;
  identityModeRevision: number;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface UpdateDependencySyncInput {
  id: string;
  connectorInstanceId?: string;
  syncStatus?: 'local' | 'pending' | 'synced' | 'failed';
  syncAction?: 'create' | 'delete' | null;
  syncError?: string | null;
  lastSyncedAt?: string | null;
}

export interface CreateGenerationInput {
  connectorInstanceId: string;
  frozenModeRevision: number;
  /** Insert applied when the live identity epoch still matches. */
  matchInsert: DependencySnapshotInsert;
  /** Insert applied when the live identity epoch drifted. */
  mismatchInsert: DependencySnapshotInsert;
  /** Positional source items, inserted only when the epoch matches. */
  items?: readonly DependencySnapshotItemInsert[];
  /** Deletion candidate dependency ids, inserted only when the epoch matches. */
  deletionCandidateIds: readonly string[];
}

export interface AbandonInterruptedCollectionInput {
  fence: DependencySnapshotFence;
  failedAt: string;
}

export interface StageCollectionPageInput {
  fence: DependencySnapshotFence;
  expectedTotal: number;
  readMode: DependencyReadMode;
  identityEvidenceSource: DependencyIdentityEvidenceSource;
  newItems: readonly DependencySnapshotItemInsert[];
  edges: readonly DependencySnapshotEdgeRecord[];
  newSourceIdCount: number;
  overflowFetchCount: number;
  updatedAt: string;
}

export interface CompleteCollectionInput {
  fence: DependencySnapshotFence;
  readMode: DependencyReadMode;
  identityEvidenceSource: DependencyIdentityEvidenceSource;
  completedAt: string;
  /**
   * Pure derivation of the identity-evidence verdict from the count of items and
   * edges whose evidence state is not `verified`. Invoked inside the
   * transaction over durable counts.
   */
  deriveEvidence: (incompleteEvidenceCount: number) => {
    identityEvidenceEligible: boolean;
    identityEvidenceFailureReason: string | null;
  };
}

export interface FailCollectionInput {
  fence: DependencySnapshotFence;
  failedAt: string;
  failureReason: string;
}

export interface RecordResumeOutcomeInput {
  generationId: string;
  outcome: 'advanced' | 'deferred' | 'failed';
  reason: string;
  attemptedAt: string;
}

export interface ApplyTargetedReconciliationInput {
  connectorInstanceId: string;
  expectedModeRevision: number;
  syncedAt: string;
  /** Existing dependency ids to mark synced (guarded on `syncAction IS NULL`). */
  syncedUpdateIds: readonly string[];
  /** New dependency rows to insert (idempotent via conflict-do-nothing). */
  inserts: readonly TaskDependencyInsert[];
  /** Dependency ids to delete (guarded synced + `syncAction IS NULL`). */
  deletionIds: readonly string[];
}

export interface ApplyReconciliationBatchInput {
  fence: DependencySnapshotFence;
  batchStart: number;
  batchEnd: number;
  lastSyncedAt: string;
  /** Remote edges to stage; omitted/empty when the generation is pre-staged. */
  stagedEdges: readonly DependencySnapshotEdgeRecord[];
  /** Blocked source ids to mark verified, with optional evidence. */
  verifiedUpdates: readonly {
    sourceId: string;
    identityEvidence?: ExternalIdentityEvidence | null;
    identityEvidenceState?: DependencyEvidenceState;
  }[];
}

export interface MarkSnapshotFailedInput {
  fence: DependencySnapshotFence;
  cursor: number;
  failureCount: number;
  failedAt: string;
  nextAttemptAt: string | null;
  failureReason: string;
}

export interface CompleteSnapshotPartialInput {
  fence: DependencySnapshotFence;
  cursor: number;
  total: number;
  connectorInstanceId: string;
  completedAt: string;
  failureReason: string;
  identityEvidenceFailureReason: string | null;
  retainedSnapshotIds: readonly string[];
}

export interface FinalizeSnapshotGenerationInput {
  fence: DependencySnapshotFence;
  cursor: number;
  total: number;
  connectorInstanceId: string;
  completedAt: string;
  identityEvidenceEligible: boolean;
  identityEvidenceFailureReason: string | null;
  insertableEdges: readonly TaskDependencyInsert[];
  removableDependencyIds: readonly string[];
  retainedSnapshotIds: readonly string[];
  insertChunkSize: number;
  deleteChunkSize: number;
}

// ── Results ───────────────────────────────────────────────────────────────────

export type ApplyTargetedReconciliationResult =
  | { status: 'applied'; imported: number; removed: number }
  | { status: 'identity-context-changed' };

export type CompleteSnapshotPartialResult =
  | { status: 'applied'; prunedSnapshots: number }
  | { status: 'fenced' };

export type FinalizeSnapshotGenerationResult =
  | { status: 'applied'; imported: number; removed: number; prunedSnapshots: number }
  | { status: 'fenced' };

// ── Port ──────────────────────────────────────────────────────────────────────

export interface GitHubDependencyPersistence {
  // Direct (non-fenced) task_dependencies mutations.
  getDependencyById(id: string): Promise<DependencyRecord | null>;
  updateDependencySync(input: UpdateDependencySyncInput): Promise<void>;
  deleteDependencyById(id: string): Promise<void>;

  // Reads over connector tasks + local dependencies.
  listConnectorTasks(connectorInstanceId: string): Promise<DependencyTaskRow[]>;
  listBlocksDependenciesForTasks(taskIds: readonly string[]): Promise<DependencyRecord[]>;
  getDeletionCandidateDependencyIds(connectorInstanceId: string): Promise<string[]>;

  // Snapshot lifecycle reads.
  getSnapshotById(id: string): Promise<DependencySnapshotRecord | null>;
  loadActiveSnapshot(connectorInstanceId: string): Promise<DependencySnapshotRecord | null>;
  getLastCompletedSnapshot(
    connectorInstanceId: string,
  ): Promise<DependencySnapshotRecord | null>;
  getTerminalSnapshotIdsToRetain(input: {
    connectorInstanceId: string;
    currentSnapshotId: string;
    maxHistory: number;
  }): Promise<string[]>;

  // Health / resume / polling reads.
  getHealthLatestSnapshots(
    connectorInstanceIds?: readonly string[],
  ): Promise<DependencySnapshotRecord[]>;
  getHealthCompletedSnapshots(
    connectorInstanceIds?: readonly string[],
  ): Promise<DependencySnapshotRecord[]>;
  countEdgesBySnapshotIds(
    snapshotIds: readonly string[],
  ): Promise<SnapshotEdgeCountRow[]>;
  getHealthTerminalStatuses(
    connectorInstanceIds?: readonly string[],
  ): Promise<HealthTerminalStatusRow[]>;
  countSnapshotEdges(snapshotId: string): Promise<number>;
  getSnapshotStatus(snapshotId: string): Promise<DependencySnapshotStatus | null>;
  listGenerationEdgePage(input: {
    snapshotId: string;
    offset: number;
    limit: number;
  }): Promise<GenerationEdgeRow[]>;
  getResumableReconciliations(): Promise<ResumableReconciliationRow[]>;

  // Snapshot item / edge reads.
  listSnapshotItemsForSourceIds(input: {
    snapshotId: string;
    sourceIds: readonly string[];
  }): Promise<DependencySnapshotItemEvidence[]>;
  listVerifiedSnapshotItems(snapshotId: string): Promise<DependencySnapshotItemEvidence[]>;
  listVerifiedItemsForSourceIds(input: {
    snapshotId: string;
    sourceIds: readonly string[];
  }): Promise<DependencySnapshotItemEvidence[]>;
  listSnapshotItemsInWindow(input: {
    snapshotId: string;
    start: number;
    end: number;
  }): Promise<Array<{ position: number; sourceId: string }>>;
  listSnapshotEdges(snapshotId: string): Promise<DependencySnapshotEdgeRecord[]>;
  listStagedEdgesForSourceIds(input: {
    snapshotId: string;
    blockedSourceIds: readonly string[];
  }): Promise<DependencySnapshotEdgeRecord[]>;
  listSnapshotCandidateDependencyIds(snapshotId: string): Promise<string[]>;

  // Fenced snapshot mutations (one transaction each).
  createGeneration(input: CreateGenerationInput): Promise<boolean>;
  abandonInterruptedCollection(
    input: AbandonInterruptedCollectionInput,
  ): Promise<boolean>;
  stageCollectionPage(input: StageCollectionPageInput): Promise<boolean>;
  completeCollection(input: CompleteCollectionInput): Promise<boolean>;
  failCollection(input: FailCollectionInput): Promise<boolean>;
  recordResumeOutcome(input: RecordResumeOutcomeInput): Promise<void>;
  applyTargetedReconciliation(
    input: ApplyTargetedReconciliationInput,
  ): Promise<ApplyTargetedReconciliationResult>;
  applyReconciliationBatch(input: ApplyReconciliationBatchInput): Promise<boolean>;
  markSnapshotFailed(input: MarkSnapshotFailedInput): Promise<boolean>;
  abandonSnapshotForIdentityContextChange(
    fence: DependencySnapshotFence,
    now: string,
  ): Promise<void>;
  completeSnapshotPartial(
    input: CompleteSnapshotPartialInput,
  ): Promise<CompleteSnapshotPartialResult>;
  finalizeSnapshotGeneration(
    input: FinalizeSnapshotGenerationInput,
  ): Promise<FinalizeSnapshotGenerationResult>;
}
