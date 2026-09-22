/**
 * Layer 3B: backend-neutral persistence ports for the GitHub *recovery* and
 * *operator* surfaces — native issue transfer, historical task-transfer
 * succession reconciliation, bulk transfer runs, and repository repoint.
 *
 * Nothing in this file may reference `better-sqlite3`, `pg`, Drizzle, a raw
 * database handle, or a transaction object. The adapters
 * (`createSqliteGitHubRecoveryRepositories`,
 * `createPostgresGitHubRecoveryRepositories`) own every driver detail and are
 * the sole authority on transaction boundaries.
 *
 * Effect ordering contract, enforced by the orchestrating services:
 *
 * - Every GitHub HTTP call, retry sleep, and rate-limit backoff happens
 *   *outside* adapter transactions. Adapter methods never receive a callback
 *   that performs remote I/O; the only callbacks they accept are synchronous
 *   pure functions (metadata refresh, verdict computation).
 * - Each adapter method owns at most one short, bounded transaction. Inside it
 *   the adapter re-reads and re-checks every fence it was given (operation
 *   phase, maintenance-lock ownership, connector activity, identity-mode
 *   revision, stable binding/locator revision, item state, metadata digest)
 *   before writing.
 * - Results are bounded value objects. Raw credentials never appear in any
 *   result except the single, explicitly-named
 *   {@link GitHubRecoveryPersistence.getConnectorCredentials} accessor, and node
 *   IDs are replaced by SHA-256 digests wherever a digest is sufficient.
 *
 * The PostgreSQL adapter never falls back to SQLite. When a Layer 3B surface is
 * genuinely unavailable it throws `UnsupportedGitHubWorkerOperationError`
 * *before* any remote effect is attempted.
 *
 * Backup evidence: SQLite file verification stays an edge helper in
 * `@/lib/connectors/github-issues/backup-verifier`. Both backends accept the
 * bounded, pre-verified {@link GitHubRecoveryBackupAttestation} value; the
 * persistence layer never opens, dumps, or restores a database file.
 */

import type {
  ExternalEntityIdentity,
  ExternalEntityLocatorEvidence,
  ExternalIdentityEvidence,
} from '@/lib/external-identities/types';

export type GitHubRepositoryRepointOperationPhase =
  | 'locked'
  | 'applying'
  | 'applied'
  | 'verifying'
  | 'verified'
  | 'verification_failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed';

export type GitHubBulkTransferRunPhase =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export type GitHubBulkTransferItemState =
  | 'pending'
  | 'transferring'
  | 'transferred'
  | 'failed';

/**
 * Externally verified backup evidence.
 *
 * This is deliberately a *value*, not a capability: the operator (or the
 * SQLite edge helper) verifies the backup out of band and passes the bounded
 * attestation through the service contract. `integrityCheck` is `'ok'` only
 * when a full integrity verification succeeded; `source` records which kind of
 * evidence produced it so PostgreSQL deployments can carry externally verified
 * dumps without this repository shipping PostgreSQL backup tooling.
 */
export interface GitHubRecoveryBackupAttestation extends Record<string, unknown> {
  /** Opaque operator-supplied locator (a file path, object key, or URI). */
  path: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
  integrityCheck: 'ok';
  verifiedAt: string;
  /**
   * Which evidence produced the attestation. Absent means the legacy SQLite
   * file verifier, which is the only value historical rows carry.
   */
  source?: 'sqlite-file' | 'external-preverified';
}

/** Non-secret connector projection the recovery services orchestrate against. */
export interface GitHubRecoveryConnectorSnapshot {
  id: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  syncedLists: string[];
  apiOrigin: string | null;
}

/**
 * The single credential-bearing accessor. Callers use it only to construct a
 * GitHub client and must never place its result in a log, event payload, or
 * any other persisted or returned value.
 */
export interface GitHubRecoveryConnectorCredentials {
  token: string;
  apiOrigin: string | null;
}

/** A repository source-list binding resolved through its current locator. */
export interface GitHubRecoveryRepositoryBinding {
  repositoryEntityId: string;
  repositoryStableId: string;
  /** The bound `source_lists.id`. */
  localId: string;
}

/** A connector task joined to its active stable issue binding and locator. */
export interface GitHubRecoveryIssuePlanRow {
  taskId: string;
  sourceId: string;
  issueEntityId: string | null;
  issueStableId: string | null;
  issueNumber: number | null;
  repositoryEntityId: string | null;
}

export interface GitHubRecoveryIdentityModeSnapshot {
  connectorInstanceId: string;
  modeRevision: number;
}

/** The stable binding a transfer/succession proof is anchored to. */
export interface GitHubRecoveryTaskTransferBinding {
  taskId: string;
  sourceId: string;
  title: string;
  externalEntityId: string;
  stableId: string;
  hostKey: string;
  repositoryEntityId: string;
  locatorSourceId: string;
}

export interface GitHubRecoveryHistoricalObservation {
  evidence: ExternalIdentityEvidence;
  title: string;
  state: string;
  stateReason: string | null;
}

export interface GitHubRecoveryHistoricalReconcileRequest {
  connectorInstanceId: string;
  sourceTaskId: string;
  successorTaskId: string;
  expectedRevision: number;
  requestedSourceId: string;
  observation: GitHubRecoveryHistoricalObservation;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now: string;
}

export interface GitHubRecoveryHistoricalReconcileResult {
  changed: boolean;
  reconciliationId: string;
  sourceTaskId: string;
  successorTaskId: string;
  proofKind: 'rest_historical_redirect';
}

/**
 * Applying the local routing update after GitHub confirmed a same-identity
 * transfer. `collision` means the destination locator is already owned by a
 * different stable entity: the adapter recorded the collision and disabled the
 * connector inside the same transaction, and the caller must fail closed.
 */
export type GitHubRecoveryNativeTransferResult =
  | { outcome: 'applied' }
  | { outcome: 'collision' };

export interface GitHubRecoveryNativeTransferInput {
  connectorInstanceId: string;
  taskId: string;
  issueEntityId: string;
  /** The pre-transfer `owner/repository:number` route, for collision audit. */
  legacySourceId: string;
  newSourceId: string;
  targetRepository: string;
  targetRepositoryEntityId: string;
  identity: ExternalEntityIdentity;
  locator: ExternalEntityLocatorEvidence;
  observedAt: string;
  now: string;
  /** Pure, synchronous metadata projection applied to the re-read task row. */
  refreshMetadata: (metadata: unknown) => unknown;
}

/* ------------------------------------------------------------------ *
 * Repository repoint
 * ------------------------------------------------------------------ */

export interface GitHubRepointCounts extends Record<string, unknown> {
  connectorSettings: number;
  connectorSyncedLists: number;
  sourceLists: number;
  tasks: number;
  linkedSources: number;
  ingestSuppressions: number;
  deletionCandidates: number;
  pendingPushes: number;
  failedPushes: number;
  dependencySnapshots: number;
  openIdentityCollisions: number;
  targetTaskConflicts: number;
  targetSourceListConflicts: number;
}

export interface GitHubRepointRelationshipCounts extends Record<string, unknown> {
  projects: number;
  phases: number;
  schedules: number;
  tags: number;
  dependencies: number;
  history: number;
  myDay: number;
  focus: number;
  attachments: number;
}

export interface GitHubRepointActivity extends Record<string, unknown> {
  queuedSyncJobs: number;
  runningSyncJobs: number;
  operationLeases: number;
  maintenanceLocks: number;
}

/** The bounded local inventory a repoint preflight reads in one pass. */
export interface GitHubRepointInventory {
  counts: GitHubRepointCounts;
  relationships: GitHubRepointRelationshipCounts;
  activity: GitHubRepointActivity;
  /** At most 50 source IDs, ordered, for the operator report. */
  deletionCandidates: string[];
}

export interface GitHubRepointOperationRecord {
  id: string;
  connectorInstanceId: string;
  idempotencyKey: string;
  phase: GitHubRepositoryRepointOperationPhase;
  actor: string;
  hostKey: string;
  repositoryEntityId: string;
  repositoryStableId: string;
  fromOwner: string;
  fromRepository: string;
  toOwner: string;
  toRepository: string;
  connectorWasEnabled: boolean;
  backupProof: Record<string, unknown>;
  preflight: Record<string, unknown>;
  rollbackSnapshot: Record<string, unknown>;
  verification: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** True when this operation still owns the connector maintenance lock. */
  connectorLocked: boolean;
}

/** A single issue whose locator the apply/rollback transaction must move. */
export interface GitHubRepointIssueMutation {
  taskId: string;
  issueEntityId: string;
  issueNumber: number;
  identity: ExternalEntityIdentity;
  locator: ExternalEntityLocatorEvidence;
  observedAt: string;
}

export interface GitHubRepointAcquireInput {
  connectorInstanceId: string;
  idempotencyKey: string;
  actor: string;
  from: string;
  to: string;
  hostKey: string;
  repositoryEntityId: string;
  repositoryStableId: string;
  sourceListId: string;
  backupProof: Record<string, unknown>;
  preflight: Record<string, unknown>;
  relationships: GitHubRepointRelationshipCounts;
  taskIdDigest: string;
  counts: GitHubRepointCounts;
  backupSha256: string;
  now: string;
}

export type GitHubRepointApplyResult =
  | { outcome: 'applied'; tasksUpdated: number }
  | { outcome: 'collision'; scope: 'repository' | 'issue'; error: string }
  /** The operation already left `locked`; the caller re-reads the record. */
  | { outcome: 'not-applicable' };

export interface GitHubRepointApplyInput {
  operationId: string;
  repositoryIdentity: ExternalEntityIdentity;
  repositoryLocator: ExternalEntityLocatorEvidence;
  repositoryObservedAt: string;
  repositorySourceListId: string;
  issues: readonly GitHubRepointIssueMutation[];
  sourceListsUpdated: number;
  now: string;
}

/** Local routing state the verification step compares against the plan. */
export interface GitHubRepointRoutingSnapshot {
  configuredRepositoryMatches: number;
  configuredRepositorySourceMatches: number;
  syncedListMatches: number;
  syncedListSourceMatches: number;
  targetSourceLists: number;
  sourceSourceLists: number;
  targetTasks: number;
  sourceTasks: number;
}

export interface GitHubRepointRollbackInput {
  operationId: string;
  actor: string;
  from: string;
  to: string;
  now: string;
}

export type GitHubRepointRollbackResult =
  | { outcome: 'rolled-back' }
  | { outcome: 'repaired'; snapshotMode: 'captured' | 'legacy_derived' }
  | { outcome: 'already-rolled-back' };

export interface GitHubRepointPersistence {
  getRepositoryBinding(
    connectorInstanceId: string,
    repository: string,
  ): Promise<GitHubRecoveryRepositoryBinding | null>;

  listIssuePlanRows(
    connectorInstanceId: string,
    repository: string,
  ): Promise<GitHubRecoveryIssuePlanRow[]>;

  /** Bounded read-only inventory for the preflight report. */
  collectInventory(input: {
    connectorInstanceId: string;
    from: string;
    to: string;
    ownedOperationId?: string;
  }): Promise<GitHubRepointInventory>;

  /**
   * Read-only locator preflight. Returns `'collision'` when adopting the
   * observed locator would take a path owned by a different stable entity.
   */
  preflightLocator(input: {
    entityId: string;
    identity: ExternalEntityIdentity;
    locator: ExternalEntityLocatorEvidence;
    repositoryEntityId: string | null;
    observedAt: string;
  }): Promise<'unchanged' | 'update' | 'collision'>;

  findOperationByIdempotency(
    connectorInstanceId: string,
    idempotencyKey: string,
  ): Promise<GitHubRepointOperationRecord | null>;

  getOperation(operationId: string): Promise<GitHubRepointOperationRecord | null>;

  /**
   * Takes the exclusive connector maintenance lock, disables the connector, and
   * records the `locked` operation in one transaction. Re-checks connector
   * activity and lock uniqueness inside the transaction.
   */
  acquireOperation(
    input: GitHubRepointAcquireInput,
  ): Promise<GitHubRepointOperationRecord>;

  /** One transaction: fence, move every locator, repoint local routing. */
  applyOperation(
    input: GitHubRepointApplyInput,
  ): Promise<GitHubRepointApplyResult>;

  /** Fenced phase transition plus a bounded audit event. */
  setOperationPhase(input: {
    operationId: string;
    phase: GitHubRepositoryRepointOperationPhase;
    actor: string;
    payload: Record<string, unknown>;
    now: string;
  }): Promise<void>;

  readRoutingSnapshot(input: {
    connectorInstanceId: string;
    from: string;
    to: string;
  }): Promise<GitHubRepointRoutingSnapshot>;

  /** Fenced success: re-enable the connector and release the lock. */
  completeVerification(input: {
    operationId: string;
    verification: Record<string, unknown>;
    now: string;
  }): Promise<void>;

  /** Fenced failure: keep the lock and the connector disabled. */
  failVerification(input: {
    operationId: string;
    verification: Record<string, unknown>;
    error: string;
    now: string;
  }): Promise<void>;

  /**
   * One transaction implementing both the first rollback and the idempotent
   * rolled-back source-list repair. The adapter re-reads the current issue
   * locators; the caller supplies only the identity fences.
   */
  rollbackOperation(
    input: GitHubRepointRollbackInput,
  ): Promise<GitHubRepointRollbackResult>;
}

/* ------------------------------------------------------------------ *
 * Bulk transfer
 * ------------------------------------------------------------------ */

export interface GitHubBulkTransferRunRecord {
  id: string;
  connectorInstanceId: string;
  idempotencyKey: string;
  phase: GitHubBulkTransferRunPhase;
  actor: string;
  sourceRepository: string;
  targetRepository: string;
  planHash: string;
  plan: Record<string, unknown>;
  connectorWasEnabled: boolean;
  transferredCount: number;
  skippedCount: number;
  failedCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GitHubBulkTransferItemRecord {
  runId: string;
  taskId: string;
  issueEntityId: string;
  issueStableId: string;
  sourceNumber: number;
  targetNumber: number | null;
  state: GitHubBulkTransferItemState;
  beforeDigest: string;
  newSourceId: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface GitHubBulkTransferSuccessionRecord {
  id: string;
  runId: string;
  taskId: string;
  sourceExternalEntityId: string;
  successorExternalEntityId: string;
  sourceStableIdDigest: string;
  successorStableIdDigest: string;
  sourceId: string;
  successorSourceId: string;
  targetRepositoryEntityId: string;
  targetNumber: number;
  proof: Record<string, unknown>;
  proofDigest: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  observedAt: string;
  createdAt: string;
}

export interface GitHubBulkTransferItemCounts {
  totalCount: number;
  transferredCount: number;
  pendingCount: number;
  ambiguousCount: number;
  failedCount: number;
}

export interface GitHubBulkTransferConnectorTaskRow {
  id: string;
  sourceId: string;
  status: string;
}

export interface GitHubBulkTransferCreateRunInput {
  runId: string;
  connectorInstanceId: string;
  idempotencyKey: string;
  actor: string;
  sourceRepository: string;
  targetRepository: string;
  planHash: string;
  plan: Record<string, unknown>;
  items: ReadonlyArray<{
    taskId: string;
    issueEntityId: string;
    issueStableId: string;
    sourceNumber: number;
    beforeDigest: string;
  }>;
  now: string;
}

export interface GitHubBulkTransferSuccessionInput {
  runId: string;
  taskId: string;
  connectorInstanceId: string;
  sourceRepository: string;
  targetRepository: string;
  sourceNumber: number;
  targetNumber: number;
  issueEntityId: string;
  issueStableId: string;
  beforeDigest: string;
  expectedModeRevision: number;
  successorSourceId: string;
  sourceId: string;
  sourceStableIdDigest: string;
  successorStableIdDigest: string;
  targetRepositoryEntityId: string;
  targetRepositoryStableId: string;
  evidence: ExternalIdentityEvidence;
  proof: Record<string, unknown>;
  proofDigest: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now: string;
  refreshMetadata: (metadata: unknown) => unknown;
}

export interface GitHubBulkTransferPersistence {
  getRepositoryBinding(
    connectorInstanceId: string,
    repository: string,
  ): Promise<{ entityId: string; stableId: string } | null>;

  /** Sync jobs + operation leases + maintenance locks blocking the run. */
  countConnectorActivity(input: {
    connectorInstanceId: string;
    ignoreOwnedOperationLease: boolean;
  }): Promise<number>;

  /** Pending writes, deletion candidates, collisions, and cycle quarantine. */
  countBlockingState(connectorInstanceId: string): Promise<number>;

  /** Tasks durably retired with an authoritative-deletion exception. */
  listAuthoritativeDeletedTaskIds(connectorInstanceId: string): Promise<string[]>;

  listConnectorTasks(
    connectorInstanceId: string,
  ): Promise<GitHubBulkTransferConnectorTaskRow[]>;

  /**
   * Digest of a task and its relationships, used as the drift fence.
   *
   * The digest is only ever compared against another digest produced by the
   * same adapter in the same deployment, so backends may differ in the exact
   * projection; each adapter must be internally stable and must exclude the
   * fields a transfer legitimately rewrites (issue number, node ID, URL).
   */
  taskMetadataDigest(taskId: string): Promise<string>;

  /** Stable digest of connector routing state (config, lists, suppressions). */
  connectorMetadataDigest(connectorInstanceId: string): Promise<string>;

  findRun(
    connectorInstanceId: string,
    idempotencyKey: string,
  ): Promise<GitHubBulkTransferRunRecord | null>;

  getRun(runId: string): Promise<GitHubBulkTransferRunRecord | null>;

  listItems(
    runId: string,
    states?: readonly GitHubBulkTransferItemState[],
  ): Promise<GitHubBulkTransferItemRecord[]>;

  getItem(
    runId: string,
    taskId: string,
  ): Promise<GitHubBulkTransferItemRecord | null>;

  countItems(runId: string): Promise<GitHubBulkTransferItemCounts>;

  listSuccessions(runId: string): Promise<GitHubBulkTransferSuccessionRecord[]>;

  getSuccession(
    runId: string,
    taskId: string,
  ): Promise<GitHubBulkTransferSuccessionRecord | null>;

  /** Bounded target numbers proven by `dispatch_accepted` audit events. */
  listAcceptedDispatchTargets(
    runId: string,
    taskId: string,
  ): Promise<number[]>;

  createRun(input: GitHubBulkTransferCreateRunInput): Promise<void>;

  markRunRunning(runId: string, now: string): Promise<void>;

  failRun(runId: string, error: string, now: string): Promise<void>;

  abortRun(runId: string, actor: string, now: string): Promise<void>;

  /** Re-enables the connector and closes the run in one transaction. */
  completeRun(input: {
    runId: string;
    connectorInstanceId: string;
    connectorWasEnabled: boolean;
    transferredCount: number;
    destinationBeforeCount: number;
    destinationAfterCount: number;
    now: string;
  }): Promise<void>;

  setItemState(input: {
    runId: string;
    taskId: string;
    state: Extract<GitHubBulkTransferItemState, 'pending' | 'transferring' | 'failed'>;
    now: string;
    startedAt?: string;
    lastError?: string | null;
  }): Promise<void>;

  /** Marks the item transferred and refreshes the run counter atomically. */
  completeItem(input: {
    runId: string;
    taskId: string;
    targetNumber: number;
    newSourceId: string;
    eventPayload: Record<string, unknown>;
    now: string;
  }): Promise<void>;

  appendEvent(input: {
    runId: string;
    taskId: string | null;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): Promise<void>;

  /**
   * Reconciles an ambiguous item whose destination kept its stable identity.
   * One transaction: adopt the destination locator, repoint the task, close the
   * item, refresh the run, and append the audit event.
   */
  reconcileItemRouting(input: {
    runId: string;
    taskId: string;
    connectorInstanceId: string;
    issueEntityId: string;
    targetRepository: string;
    targetRepositoryEntityId: string;
    targetNumber: number;
    identity: ExternalEntityIdentity;
    locator: ExternalEntityLocatorEvidence;
    observedAt: string;
    actor: string;
    now: string;
    /** SHA-256 of the item's stable issue ID, for the bounded audit payload. */
    issueStableIdDigest: string;
    refreshMetadata: (metadata: unknown) => unknown;
  }): Promise<void>;

  /**
   * Records a proven identity succession. One transaction re-checks the item
   * state, identity-mode revision, task route, and stable binding before
   * retiring the source locator, binding the successor entity, repointing the
   * task, and writing the succession proof.
   */
  recordSuccession(input: GitHubBulkTransferSuccessionInput): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

export interface GitHubTransferPersistence {
  getConnector(
    connectorInstanceId: string,
  ): Promise<GitHubRecoveryConnectorSnapshot | null>;

  /** The only credential-bearing accessor; never log or persist the result. */
  getConnectorCredentials(
    connectorInstanceId: string,
  ): Promise<GitHubRecoveryConnectorCredentials | null>;

  disableConnector(connectorInstanceId: string, now: string): Promise<void>;

  getIdentityModeSnapshot(
    connectorInstanceId: string,
  ): Promise<GitHubRecoveryIdentityModeSnapshot>;

  getRepositoryBinding(
    connectorInstanceId: string,
    repository: string,
  ): Promise<GitHubRecoveryRepositoryBinding | null>;

  getRepositoryStableId(entityId: string): Promise<string | null>;

  listIssuePlanRows(
    connectorInstanceId: string,
    repository: string,
  ): Promise<GitHubRecoveryIssuePlanRow[]>;

  readTaskTransferBinding(
    connectorInstanceId: string,
    taskId: string,
  ): Promise<GitHubRecoveryTaskTransferBinding>;

  applyNativeTransferRouting(
    input: GitHubRecoveryNativeTransferInput,
  ): Promise<GitHubRecoveryNativeTransferResult>;

  recordHistoricalTransferReconciliation(
    request: GitHubRecoveryHistoricalReconcileRequest,
  ): Promise<GitHubRecoveryHistoricalReconcileResult>;
}

/**
 * The complete Layer 3B composition.
 *
 * Like the Layer 3A `GitHubWorkerRepositories`, this is registered atomically:
 * either every member is present (and the operator recovery surfaces are
 * supported on the selected backend) or the composition is absent and every
 * recovery entry point fails closed before any remote effect.
 */
export interface GitHubRecoveryPersistence {
  readonly transfer: GitHubTransferPersistence;
  readonly bulkTransfer: GitHubBulkTransferPersistence;
  readonly repoint: GitHubRepointPersistence;
}
