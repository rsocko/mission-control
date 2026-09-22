import type { ExternalBindingType, GitHubTaskWriteOperation } from '@/db/schema';
import type { GitHubIdentityModeSnapshot } from '@/lib/external-identities/stable-identity-types';
import type {
  ExternalEntityKey,
  ExternalEntityLocatorObservation,
  ExternalEntityLocatorObservationResult,
  ExternalEntityLocatorPreflight,
  ExternalEntityLocatorRecord,
  ExternalEntityRecord,
  ExternalEntityUpsert,
  ExternalIdentityCollisionInput,
  ExternalIdentityCollisionRecord,
  ExternalIdentityWrite,
  ExternalIdentityWriteResult,
} from '@/lib/external-identities/types';

/**
 * Backend-neutral persistence port for the GitHub durable identity epoch, stable
 * NodeID lookups, linked-source identity, decision currency re-checks, and the
 * write-fence (write cycles + task/source write leases).
 *
 * The adapters (`createSqliteGitHubIdentityRepositories`,
 * `createPostgresGitHubIdentityRepositories`) own every driver detail. Nothing
 * in this file may reference `better-sqlite3`, `pg`, or Drizzle types. The
 * domain modules under `src/lib/external-identities/` orchestrate these methods,
 * translate the discriminated results into `GitHubWriteFenceError` codes, and
 * keep every pure computation (digests, intent projection, locator parsing).
 */

// ── Identity: stable NodeID batch lookup ──────────────────────────────────────

export interface GitHubStableLookupNamespace {
  provider: string;
  hostKey: string;
  entityType: string;
  bindingType: ExternalBindingType;
}

export interface GitHubStableLookupInputRow {
  candidateKey: string;
  stableId: string;
  ownerKey: string;
  repositoryKey: string;
  issueNumber: number | null;
}

export interface GitHubStableLookupRow {
  candidateKey: string;
  externalEntityId: string | null;
  bindingLocalId: string | null;
  localId: string | null;
  bindingState: string | null;
  bindingRevision: string | null;
  locatorRevision: number | null;
  currentOwnerKey: string | null;
  currentRepositoryKey: string | null;
  currentIssueNumber: number | null;
  pathEntityId: string | null;
}

// ── Identity: linked-source batch lookup ──────────────────────────────────────

export interface GitHubLinkedSourceLookupInputRow {
  candidateKey: string;
  linkedSourceId: string;
  stableId: string | null;
  ownerKey: string | null;
  repositoryKey: string | null;
  issueNumber: number | null;
}

export interface GitHubLinkedSourceLookupRow {
  candidateKey: string;
  linkedTaskId: string;
  linkedEntityId: string | null;
  stableEntityId: string | null;
  stableLinkedSourceId: string | null;
  stableTaskId: string | null;
  locatorRevision: number | null;
  currentOwnerKey: string | null;
  currentRepositoryKey: string | null;
  currentIssueNumber: number | null;
  pathEntityId: string | null;
}

// ── Identity: linked-source persistence ───────────────────────────────────────

/**
 * A fully normalized linked-source identity write. All evidence-derived values
 * are pre-computed by the domain module so the adapter transaction runs purely
 * over scalars and durable row reads.
 */
export interface GitHubLinkedSourcePersistWrite {
  linkedSourceId: string;
  /** True when the caller supplied NodeID evidence for this write. */
  hasEvidence: boolean;
  /** True when the evidence identity is a github issue (provider/entityType). */
  identityValid: boolean;
  provider: string;
  hostKey: string;
  entityType: string;
  stableId: string;
  ownerKey: string;
  repositoryKey: string;
  issueNumber: number | null;
  /** `owner/repo:number` canonical locator derived from the evidence. */
  canonicalSourceId: string;
  observedAt: string;
}

export interface GitHubLinkedSourcePersistResult {
  linkedSourceId: string;
  state: 'associated' | 'collision' | 'unbound';
}

// ── Identity: decision currency ───────────────────────────────────────────────

export interface GitHubDecisionCurrencyCheck {
  bindingType: 'task' | 'source_list';
  localId: string;
  externalEntityId: string;
  bindingRevision: string;
  locatorRevision: number;
}

// ── Identity: terminal-inaccessible exception reads ───────────────────────────

export interface GitHubIdentityExceptionSnapshot {
  eventId: number;
  connectorInstanceId: string;
  bindingType: ExternalBindingType;
  localId: string;
  category: 'terminal_inaccessible';
  action: 'accept' | 'revoke';
  proofType:
    | 'stage1_inaccessible'
    | 'post_backfill_authoritative_deletion'
    | 'legacy_comparison_evidence'
    | null;
  createdAt: string;
}

export interface GitHubIdentityPersistence {
  /** Durable identity epoch snapshot for one connector. */
  getModeSnapshot(
    connectorInstanceId: string,
    capturedAt?: string,
  ): Promise<GitHubIdentityModeSnapshot>;

  /** Ensures a GitHub connector has an identity epoch (revision 1 on create). */
  ensureControls(input: {
    connectorInstanceId: string;
    now: string;
  }): Promise<void>;

  /**
   * Atomically persists the primary task/source-list NodeID bindings observed by
   * normal GitHub sync execution. The frozen identity epoch is rechecked inside
   * the same transaction as every entity, locator, binding, and collision write.
   */
  persistExternalIdentityBatch(input: {
    connectorInstanceId: string;
    modeSnapshot?: GitHubIdentityModeSnapshot;
    writes: readonly ExternalIdentityWrite[];
  }): Promise<readonly ExternalIdentityWriteResult[]>;

  /** Single NodeID batch lookup used by the stable-identity resolver. */
  lookupStableIdentityBatch(input: {
    connectorInstanceId: string;
    namespace: GitHubStableLookupNamespace;
    rows: readonly GitHubStableLookupInputRow[];
  }): Promise<GitHubStableLookupRow[]>;

  /** Single NodeID batch lookup for linked-source identity resolution. */
  lookupLinkedSourceIdentityBatch(input: {
    connectorInstanceId: string;
    hostKey: string;
    rows: readonly GitHubLinkedSourceLookupInputRow[];
  }): Promise<GitHubLinkedSourceLookupRow[]>;

  /**
   * Atomically persists linked-source NodeID associations. Fences against the
   * frozen identity epoch when a snapshot is provided.
   */
  persistLinkedSourceIdentityBatch(input: {
    connectorInstanceId: string;
    modeSnapshot?: GitHubIdentityModeSnapshot;
    writes: readonly GitHubLinkedSourcePersistWrite[];
  }): Promise<readonly GitHubLinkedSourcePersistResult[]>;

  /**
   * Re-reads the binding and locator revisions behind applied decisions. Returns
   * `true` only when every check still matches an active binding + current
   * locator.
   */
  checkDecisionsCurrent(input: {
    connectorInstanceId: string;
    checks: readonly GitHubDecisionCurrencyCheck[];
  }): Promise<boolean>;

  /** Latest terminal-inaccessible exception event for a local row, if any. */
  getLatestTerminalInaccessibleException(input: {
    connectorInstanceId: string;
    bindingType: ExternalBindingType;
    localId: string;
  }): Promise<GitHubIdentityExceptionSnapshot | null>;

  // ── External entity directory (generic, operator + non-batch callers) ───────

  /** Looks up one external entity by its full identity key. */
  getExternalEntityByKey(key: ExternalEntityKey): Promise<ExternalEntityRecord | null>;

  /** Idempotently upserts one external entity, advancing `lastSeenAt` only forward. */
  upsertExternalEntity(input: ExternalEntityUpsert): Promise<ExternalEntityRecord>;

  /** The currently valid (`validTo IS NULL`) locator for an entity, if any. */
  getCurrentExternalEntityLocator(
    externalEntityId: string,
  ): Promise<ExternalEntityLocatorRecord | null>;

  /** Every locator revision recorded for an entity, oldest first. */
  listExternalEntityLocatorHistory(
    externalEntityId: string,
  ): Promise<ExternalEntityLocatorRecord[]>;

  /** Read-only check of what an operator locator observation would resolve to. */
  preflightExternalEntityLocator(
    input: ExternalEntityLocatorObservation,
  ): Promise<ExternalEntityLocatorPreflight>;

  /** Durably applies an operator-sourced locator observation. */
  observeExternalEntityLocator(
    input: ExternalEntityLocatorObservation,
  ): Promise<ExternalEntityLocatorObservationResult>;

  /** Idempotently records (or refreshes) a durable external-identity collision. */
  recordExternalIdentityCollision(
    input: ExternalIdentityCollisionInput,
  ): Promise<ExternalIdentityCollisionRecord>;
}

// ── Write fence ───────────────────────────────────────────────────────────────

/**
 * The subset of task columns the write fence reads. `deriveWriteIdentity`
 * receives this row inside the authorization transaction.
 */
export interface GitHubFenceTaskRow {
  id: string;
  sourceId: string;
  sourceListId: string | null;
  updatedAt: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  effort: number | null;
  dueDate: string | null;
  microStatus: string | null;
  parentId: string | null;
  isChecklistItem: boolean;
}

export type GitHubFenceTargetRole =
  | 'primary_issue'
  | 'parent_issue'
  | 'blocker_issue'
  | 'blocked_issue'
  | 'source_repository'
  | 'target_repository';

export interface GitHubFenceTarget {
  role: GitHubFenceTargetRole;
  entityId: string;
  repositoryEntityId: string | null;
  hostKey: string;
  locatorRevision: number;
  owner: string;
  repository: string;
  issueNumber: number | null;
  bindingRevision: string;
  bindingState: string;
}

/** The idempotency/intent facts derived from a task row inside the transaction. */
export interface GitHubWriteIdentity {
  idempotencyKey: string;
  intent: { kind: string; digest: string } | null;
  initialCreate: boolean;
}

export type GitHubBeginWriteCycleResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'stale_write_cycle_mode'
        | 'write_cycle_reconciliation_owned'
        | 'active_write_cycle'
        | 'write_cycle_replacement_lost';
    };

export type GitHubRecordCycleObservationResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'write_cycle_missing'
        | 'write_cycle_observation_stale_mode'
        | 'write_cycle_observation_lost';
    };

export type GitHubAuthorizeTaskWriteResult =
  | {
      ok: true;
      task: GitHubFenceTaskRow;
      modeRevision: number;
      leaseId: string;
      targets: readonly GitHubFenceTarget[];
    }
  | {
      ok: false;
      code:
        | 'missing_task'
        | 'stale_task_push_claim'
        | 'stale_write_cycle'
        | 'stable_identity_evidence_blocked'
        | 'missing_or_inaccessible_identity'
        | 'stable_binding_not_active'
        | 'write_already_succeeded'
        | 'active_or_unknown_lease';
    };

export type GitHubAuthorizeSourceWriteResult =
  | {
      ok: true;
      sourceList: { id: string; sourceId: string };
      target: GitHubFenceTarget;
      leaseId: string;
      modeRevision: number;
    }
  | {
      ok: false;
      code:
        | 'missing_source_list'
        | 'stale_write_cycle'
        | 'stable_identity_evidence_blocked'
        | 'missing_or_inaccessible_identity'
        | 'stable_binding_not_active'
        | 'active_or_unknown_lease';
    };

export type GitHubFinalizeWriteResult =
  | { status: 'committed' }
  | { status: 'not_committed' }
  | { status: 'outcome_lost' };

export type GitHubBlockWriteResult = {
  status: 'blocked' | 'unchanged' | 'cycle_lost' | 'outcome_lost';
};

export interface GitHubWriteFenceAuthorizationRef {
  leaseId: string;
  token: string;
  connectorInstanceId: string;
  taskId: string;
  expectedTaskVersion?: string;
  taskPushLeaseToken?: string;
}

export interface GitHubWriteFencePersistence {
  beginWriteCycle(input: {
    id: string;
    connectorInstanceId: string;
    jobId?: string;
    expectedModeRevision: number;
    pendingCandidateCount: number;
    now: string;
  }): Promise<GitHubBeginWriteCycleResult>;

  finishWriteCycle(input: {
    id: string;
    outcome: {
      observed: number;
      applied: number;
      blocked: number;
      failed: number;
      unknown: number;
    };
    now: string;
  }): Promise<{ committed: boolean }>;

  recordCycleObservation(input: {
    leaseId: string;
    now: string;
  }): Promise<GitHubRecordCycleObservationResult>;

  authorizeTaskWrite(input: {
    connectorInstanceId: string;
    taskId: string;
    operation: GitHubTaskWriteOperation;
    writeCycleId: string | null;
    targetSourceListId?: string | null;
    participantTaskIds?: readonly {
      role: 'parent_issue' | 'blocker_issue' | 'blocked_issue';
      taskId: string;
    }[];
    expectedTaskVersion?: string;
    taskPushLeaseToken?: string;
    leaseId: string;
    token: string;
    expiresAt: string;
    now: string;
    deriveWriteIdentity: (task: GitHubFenceTaskRow) => GitHubWriteIdentity;
  }): Promise<GitHubAuthorizeTaskWriteResult>;

  authorizeSourceWrite(input: {
    connectorInstanceId: string;
    sourceListId: string;
    operation: 'create' | 'label';
    writeCycleId: string | null;
    leaseId: string;
    token: string;
    expiresAt: string;
    now: string;
  }): Promise<GitHubAuthorizeSourceWriteResult>;

  hasSucceededWrite(input: {
    connectorInstanceId: string;
    taskId: string;
    operation: GitHubTaskWriteOperation;
    expectedTaskVersion: string;
    taskPushLeaseToken: string;
    now: string;
    deriveWriteIdentity: (task: GitHubFenceTaskRow) => GitHubWriteIdentity;
  }): Promise<boolean>;

  assertCycleCurrent(input: {
    authorization: GitHubWriteFenceAuthorizationRef;
    now: string;
  }): Promise<boolean>;

  confirmDispatch(input: {
    authorization: GitHubWriteFenceAuthorizationRef;
    now: string;
  }): Promise<boolean>;

  verifyPreflight(input: {
    leaseId: string;
    observed: {
      targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
    };
  }): Promise<boolean>;

  finalizeWrite(input: {
    authorization: GitHubWriteFenceAuthorizationRef;
    outcome: 'succeeded' | 'failed' | 'unknown';
    safeReason: string | null;
    resultDigest: string | null;
    now: string;
  }): Promise<GitHubFinalizeWriteResult>;

  blockWrite(input: {
    leaseId: string;
    token: string;
    code: string;
    now: string;
  }): Promise<GitHubBlockWriteResult>;

  expireUndispatchedLeases(now: string): Promise<number>;
}

export interface GitHubIdentityRepositories {
  readonly identity: GitHubIdentityPersistence;
  readonly writeFence: GitHubWriteFencePersistence;
}
