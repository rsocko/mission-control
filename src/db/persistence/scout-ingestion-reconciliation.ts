/**
 * Backend-neutral persistence contract for Scout push ingestion, the Scout
 * parallel-comparison projection, and Scout reconciliation runs/suggestions.
 *
 * This is a domain-specific port, not a generic database escape hatch: every
 * member names one Scout storage operation, adapters own the statements and the
 * transaction boundaries, and the service keeps every identifier, timestamp,
 * hash, and policy decision. Where an operation has to interleave a read and a
 * write inside one transaction, the port takes a *pure* decision callback whose
 * input and output are both typed Scout records — the callback never receives a
 * database handle, a query builder, or a transaction object.
 */
import type { TaskFieldStateRecord } from '@/lib/tasks/field-state';

/** Maximum number of open Scout tasks a single reconciliation run may evaluate. */
export const MAX_SCOUT_RECONCILIATION_TASKS_PER_RUN = 200;

/**
 * Raised by an adapter when a bounded compare-and-set fence loses. The service
 * maps each code onto its own HTTP-shaped error so status selection stays a
 * service policy decision.
 */
export class ScoutPersistenceConflictError extends Error {
  constructor(
    readonly code:
      | 'task-changed-before-completion'
      | 'task-changed-before-confirmation'
      | 'run-claim-lost'
      | 'suggestion-acted-concurrently',
    message: string,
  ) {
    super(message);
    this.name = 'ScoutPersistenceConflictError';
  }
}

// ─── INGESTION ───────────────────────────────────────────────────────────────

/** One Scout source list (sidebar folder/list) definition owned by the service. */
export interface ScoutSourceListDefinition {
  /** Primary key of the `source_lists` row. */
  readonly id: string;
  /** Connector-facing list identifier (`source_lists.source_id`). */
  readonly sourceId: string;
  readonly name: string;
  readonly type: string;
  readonly icon: string;
  readonly iconColor: string;
}

/** Row values the adapter inserts when the Scout connector config does not exist yet. */
export interface ScoutConnectorConfigDefaults {
  readonly type: string;
  readonly name: string;
  readonly syncMode: string;
  readonly pollIntervalMinutes: number | null;
  /** Serialized JSON, produced by the service so both backends store identical text. */
  readonly capabilities: string;
  readonly credentials: string;
  readonly settings: string;
  readonly syncedLists: string;
}

export interface ScoutConnectorBootstrapInput {
  readonly connectorInstanceId: string;
  readonly now: string;
  readonly defaults: ScoutConnectorConfigDefaults;
  /** Pre-created when the connector row is inserted for the first time. */
  readonly sourceLists: readonly ScoutSourceListDefinition[];
}

export interface ScoutConnectorBootstrapResult {
  /** False when this call created the connector configuration row. */
  readonly existed: boolean;
  readonly enabled: boolean;
  /** Raw stored settings value; `null` when the row was just created. */
  readonly settings: unknown;
}

export interface ScoutCrossConnectorCandidate {
  readonly id: string;
  readonly title: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly metadata: unknown;
}

export interface ScoutExistingTask {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly metadata: unknown;
  readonly status: string;
  readonly snoozedUntil: string | null;
}

export interface ScoutTriageItemState {
  readonly id: string;
  readonly status: string;
}

export interface ScoutIngestGuard {
  readonly suppressed: boolean;
  readonly linkedTaskId: string | null;
}

/** Snapshot handed to the merge decision callback from inside the item transaction. */
export interface ScoutTaskMergeSnapshot {
  readonly task: ScoutExistingTask | null;
  readonly fieldStates: readonly TaskFieldStateRecord[];
}

export interface ScoutFieldObservationWrite {
  readonly fieldName: string;
  readonly sourceValue: string;
  readonly locallyOverridden: boolean;
  readonly sourceObservedAt: string | null;
  readonly localEditedAt: string | null;
  readonly updatedAt: string;
}

export interface ScoutRenderedTaskUpdates {
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: string;
  readonly dueDate?: string | null;
}

export type ScoutTaskMergeDecision =
  | {
      readonly kind: 'skip';
      readonly reason: 'task_missing' | 'task_closed' | 'snoozed';
    }
  | {
      readonly kind: 'apply';
      /** Field-state rows upserted for every mergeable field, always written. */
      readonly observations: readonly ScoutFieldObservationWrite[];
      /**
       * Rendered task columns plus serialized metadata, written only when the
       * service decided the task actually changed.
       */
      readonly taskWrite: {
        readonly rendered: ScoutRenderedTaskUpdates;
        readonly metadata: string;
        readonly updatedAt: string;
        readonly lastSyncedAt: string;
      } | null;
    };

export interface ScoutTaskMergeInput {
  readonly taskId: string;
  /** Pure decision function evaluated inside the adapter's item transaction. */
  readonly decide: (snapshot: ScoutTaskMergeSnapshot) => ScoutTaskMergeDecision;
}

export interface ScoutTaskCreationInput {
  readonly connectorInstanceId: string;
  readonly connectorType: string;
  readonly taskId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly sourceListId: string;
  readonly sourceListName: string | null;
  readonly metadata: string;
  readonly now: string;
  readonly fieldStates: readonly ScoutFieldObservationWrite[];
  readonly tags: readonly ScoutTagInsert[];
  readonly projectId: string | null;
}

export interface ScoutTagInsert {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: string;
  readonly source: string | null;
  readonly color: string;
  readonly confirmed: boolean;
  readonly createdAt: string;
}

export type ScoutTaskCreationOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'suppressed' }
  | { readonly kind: 'conflict'; readonly taskId: string };

export interface ScoutLinkSourceInput {
  readonly id: string;
  readonly taskId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly linkedAt: string;
  readonly matchConfidence: number;
  readonly metadata: string;
}

export type ScoutLinkSourceOutcome =
  | { readonly kind: 'linked' }
  | { readonly kind: 'suppressed' };

/** Column values shared by triage insert and triage refresh, produced by the service. */
export interface ScoutTriageItemValues {
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly description: string | null;
  readonly contentType: string;
  readonly capturedAt: string;
  readonly aiSummary: string | null;
  readonly aiCategories: readonly string[];
  readonly aiSuggestedActions: readonly unknown[];
  readonly aiRelevanceScore: number;
  readonly aiUrgency: string;
  readonly rawMetadata: Record<string, unknown>;
}

export interface ScoutTriageUpsertInput {
  readonly triageItemId: string;
  readonly sourcePlatform: string;
  readonly sourceId: string;
  readonly ingestedAt: string;
  readonly values: ScoutTriageItemValues;
}

export type ScoutTriageUpsertOutcome =
  | { readonly kind: 'created'; readonly triageItemId: string }
  | { readonly kind: 'updated'; readonly triageItemId: string }
  | { readonly kind: 'closed'; readonly triageItemId: string };

export interface ScoutSourceListCountRefresh {
  readonly connectorType: string;
  /** `source_lists.source_id` of the list whose count is refreshed. */
  readonly sourceListId: string;
  readonly syncedAt: string;
}

export interface ScoutIngestionRepository {
  /**
   * Reads (or creates, exactly once) the Scout connector configuration row and
   * its five source lists. Never parses settings: the raw stored value is
   * returned so the service owns settings parsing and defaulting.
   */
  bootstrapConnector(
    input: ScoutConnectorBootstrapInput,
  ): Promise<ScoutConnectorBootstrapResult>;
  /** Creates the list if `source_lists.source_id` is absent. */
  ensureSourceList(input: {
    readonly connectorInstanceId: string;
    readonly definition: ScoutSourceListDefinition;
    readonly now: string;
  }): Promise<{ readonly created: boolean }>;
  /** One batch-wide snapshot of open non-Scout tasks used for cross-connector matching. */
  listCrossConnectorCandidates(input: {
    readonly excludeConnectorType: string;
    readonly closedStatuses: readonly string[];
  }): Promise<ScoutCrossConnectorCandidate[]>;
  findExistingTask(input: {
    readonly connectorType: string;
    readonly sourceId: string;
  }): Promise<ScoutExistingTask | null>;
  findTriageItem(input: {
    readonly sourcePlatform: string;
    readonly sourceId: string;
  }): Promise<ScoutTriageItemState | null>;
  /** Returns the subset of `projectIds` that exist, preserving input order. */
  filterExistingProjectIds(projectIds: readonly string[]): Promise<string[]>;
  readIngestGuard(input: {
    readonly connectorInstanceId: string;
    readonly sourceId: string;
  }): Promise<ScoutIngestGuard>;
  /**
   * One transaction: re-read the task and its field states, evaluate `decide`,
   * then write the rendered columns/metadata (when the service asked for it)
   * and every field-state observation.
   */
  mergeExistingTask(input: ScoutTaskMergeInput): Promise<ScoutTaskMergeDecision>;
  /**
   * One transaction: suppression check, conflict-tolerant task insert with
   * winner readback, initial field states, tags, tag links, and project link.
   */
  createTask(input: ScoutTaskCreationInput): Promise<ScoutTaskCreationOutcome>;
  /** One transaction: suppression check plus conflict-tolerant linked-source insert. */
  linkSourceToTask(input: ScoutLinkSourceInput): Promise<ScoutLinkSourceOutcome>;
  /**
   * One transaction: never reopens an `actioned`/`dismissed` row, and reports
   * the stored row identity so the caller can publish exactly once.
   */
  upsertTriageItem(input: ScoutTriageUpsertInput): Promise<ScoutTriageUpsertOutcome>;
  refreshSourceListCounts(
    refreshes: readonly ScoutSourceListCountRefresh[],
  ): Promise<void>;
}

// ─── PARALLEL COMPARISON ─────────────────────────────────────────────────────

export interface ScoutComparisonTask {
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly createdAt: string;
  readonly priority: string;
  readonly status: string;
  readonly metadata: unknown;
}

export interface ScoutComparisonLinkedPair {
  readonly taskId: string;
  readonly sourceId: string;
  readonly connectorType: string;
}

export interface ScoutComparisonWindow {
  readonly scoutTasks: ScoutComparisonTask[];
  readonly comparisonTasks: ScoutComparisonTask[];
  readonly linkedPairs: ScoutComparisonLinkedPair[];
}

export interface ScoutComparisonRepository {
  readWindow(input: {
    readonly since: string;
    readonly scoutConnectorType: string;
    readonly comparisonConnectorType: string;
  }): Promise<ScoutComparisonWindow>;
}

// ─── RECONCILIATION ──────────────────────────────────────────────────────────

export interface ScoutConnectorConfigurationRecord {
  readonly enabled: boolean;
  /** Raw stored settings value; the service owns parsing. */
  readonly settings: unknown;
}

export interface ScoutReconciliationTask {
  readonly id: string;
  readonly title: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly status: string;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly statusReason: string | null;
}

export interface ScoutReconciliationRunRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly requestHash: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly summary: Record<string, number> | null;
}

export interface ScoutReconciliationEvaluationView {
  readonly taskId: string;
  readonly title: string;
  readonly candidateAction: string;
  readonly action: string;
  readonly confidence: number;
  readonly evidence: unknown;
  readonly policyDecision: string;
  readonly policyReason: string;
  readonly applied: boolean;
  readonly appliedResult: Record<string, unknown> | null;
}

export interface ScoutReconciliationRunInsert {
  readonly id: string;
  readonly scopeKey: string;
  readonly scopeType: 'all' | 'project' | 'task';
  readonly scopeId: string | null;
  readonly lookbackHours: number;
  readonly dryRun: boolean;
  readonly source: 'api' | 'automation';
  readonly sourceIdentity: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly leaseToken: string;
  readonly startedAt: string;
}

export interface ScoutReconciliationTaskStateRecord {
  readonly taskId: string;
  readonly neverAutoComplete: boolean;
  readonly reason: string;
  readonly sourceRunId: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ScoutReconciliationTaskStateUpsert {
  readonly taskId: string;
  readonly neverAutoComplete: boolean;
  readonly reason: string;
  readonly sourceRunId: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ScoutEvaluationInsert {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly candidateAction: string;
  readonly action: string;
  readonly confidence: number;
  readonly evidenceHash: string;
  readonly evidence: unknown;
  readonly policyDecision: string;
  readonly policyReason: string;
  readonly payloadHash: string;
  readonly applied: boolean;
  readonly appliedResult: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface ScoutSuggestionInsert {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly evaluationId: string;
  readonly action: 'suggest-complete' | 'escalate';
  readonly status: 'pending';
  readonly confidence: number;
  readonly evidenceHash: string;
  readonly evidence: unknown;
  readonly policyDecision: string;
  readonly policyReason: string;
  readonly payloadHash: string;
  readonly proposedEffect: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** Column values used to close out a suggestion row. */
export interface ScoutSuggestionActedUpdate {
  readonly status: 'accepted' | 'dismissed' | 'superseded';
  readonly updatedAt: string;
  readonly actedAt: string;
  readonly actedBy: string;
}

/** Task columns written when reconciliation completes a task. */
export interface ScoutTaskCompletionUpdate {
  readonly columns: Readonly<Record<string, string | null>>;
  readonly expectedStatuses: readonly string[];
}

export interface ScoutDigestNotificationRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly body: string;
  readonly level: string;
  readonly levelRank: number;
  readonly category: string;
  readonly templateKey: string;
  readonly state: string;
  readonly isActionable: boolean;
  readonly receivedAt: string;
  readonly sortAt: string;
  readonly groupKey: string;
  readonly dedupeKey: string;
  readonly navigationTarget: string;
  readonly metadata: Record<string, unknown>;
  readonly presentation: Record<string, unknown>;
}

/** Transaction-local reads handed to the run's per-task decision callback. */
export interface ScoutEvaluationContext {
  readonly currentTask: ScoutReconciliationTask | null;
  readonly taskState: ScoutReconciliationTaskStateRecord | null;
  readonly connector: ScoutConnectorConfigurationRecord | null;
  readonly dismissedSuggestionId: string | null;
  readonly pendingSuggestion: {
    readonly id: string;
    readonly evidenceHash: string;
  } | null;
}

export type ScoutEvaluationEffect =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'record-applied-result';
      readonly appliedResult: Record<string, unknown>;
    }
  | {
      readonly kind: 'complete-task';
      readonly taskId: string;
      readonly completion: ScoutTaskCompletionUpdate;
      readonly supersedePending: ScoutSuggestionActedUpdate;
      readonly appliedResult: Record<string, unknown>;
    }
  | {
      readonly kind: 'reuse-suggestion';
      readonly appliedResult: Record<string, unknown>;
    }
  | {
      readonly kind: 'insert-suggestion';
      readonly supersede: {
        readonly suggestionId: string;
        readonly update: ScoutSuggestionActedUpdate;
      } | null;
      readonly suggestion: ScoutSuggestionInsert;
      readonly appliedResult: Record<string, unknown>;
    };

export interface ScoutEvaluationDecision<TResult> {
  readonly evaluation: ScoutEvaluationInsert;
  readonly effect: ScoutEvaluationEffect;
  readonly result: TResult;
}

export interface ScoutEvaluationPlanEnvelope<TPlan> {
  readonly plan: TPlan;
  readonly taskId: string;
  readonly connectorInstanceId: string;
  readonly evidenceHash: string;
}

export interface ScoutReconciliationCommitInput<TPlan, TResult> {
  readonly runId: string;
  readonly leaseToken: string;
  readonly completedAt: string;
  readonly plans: readonly ScoutEvaluationPlanEnvelope<TPlan>[];
  /** Pure per-task decision evaluated inside the run transaction, in plan order. */
  readonly decide: (
    plan: TPlan,
    context: ScoutEvaluationContext,
  ) => ScoutEvaluationDecision<TResult>;
  /** Pure summary of every applied decision, stored on the run row. */
  readonly summarize: (results: readonly TResult[]) => Record<string, number>;
  /** Optional digest notification row, inserted inside the same transaction. */
  readonly digest: (
    summary: Record<string, number>,
  ) => ScoutDigestNotificationRecord | null;
}

export interface ScoutReconciliationCommitResult<TResult> {
  readonly results: TResult[];
  readonly summary: Record<string, number>;
}

export interface ScoutReconciliationSuggestionRow {
  readonly id: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskPriority: string;
  readonly taskDueDate: string | null;
  readonly action: 'suggest-complete' | 'escalate';
  readonly confidence: number;
  readonly evidence: unknown;
  readonly policyReason: string;
  readonly payloadHash: string;
  readonly proposedEffect: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ScoutSuggestionRecord {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly evaluationId: string;
  readonly action: 'suggest-complete' | 'escalate';
  readonly status: 'pending' | 'accepted' | 'dismissed' | 'superseded';
  readonly payloadHash: string;
  readonly evidenceHash: string;
  readonly expiresAt: string;
}

export interface ScoutSuggestionActionSnapshot {
  readonly suggestion: ScoutSuggestionRecord | null;
  readonly task: ScoutReconciliationTask | null;
  readonly connector: ScoutConnectorConfigurationRecord | null;
}

export type ScoutSuggestionActionDecision<TResult> =
  | { readonly kind: 'replay'; readonly result: TResult }
  | {
      readonly kind: 'accept';
      readonly result: TResult;
      readonly expectedPayloadHash: string;
      readonly suggestionUpdate: ScoutSuggestionActedUpdate;
      readonly taskId: string;
      readonly completion: ScoutTaskCompletionUpdate;
      readonly evaluationId: string;
      readonly appliedResult: Record<string, unknown>;
    }
  | {
      readonly kind: 'dismiss';
      readonly result: TResult;
      readonly expectedPayloadHash: string;
      readonly suggestionUpdate: ScoutSuggestionActedUpdate;
      readonly taskState: ScoutReconciliationTaskStateUpsert | null;
    };

export interface ScoutReconciliationScopeQuery {
  readonly type: 'all' | 'project' | 'task';
  readonly id: string | null;
  readonly openStatuses: readonly string[];
  readonly connectorType: string;
  readonly limit: number;
}

export interface ScoutReconciliationRepository {
  getConnectorConfiguration(input: {
    readonly connectorType: string;
    readonly connectorInstanceId?: string;
  }): Promise<ScoutConnectorConfigurationRecord | null>;
  expireStaleRuns(input: {
    readonly scopeKey: string;
    readonly startedBefore: string;
    readonly completedAt: string;
    readonly error: string;
  }): Promise<void>;
  findRunByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ScoutReconciliationRunRecord | null>;
  loadRunEvaluations(runId: string): Promise<ScoutReconciliationEvaluationView[]>;
  findRecentCompletedRun(input: {
    readonly scopeKey: string;
    readonly startedAtOrAfter: string;
  }): Promise<{ readonly startedAt: string } | null>;
  createRun(
    record: ScoutReconciliationRunInsert,
  ): Promise<{ readonly kind: 'created' } | { readonly kind: 'conflict' }>;
  /** Claims a previously failed run for retry under the active-scope uniqueness fence. */
  resumeFailedRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly startedAt: string;
  }): Promise<
    | { readonly kind: 'resumed' }
    | { readonly kind: 'not-claimable' }
    | { readonly kind: 'conflict' }
  >;
  failRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly completedAt: string;
  }): Promise<void>;
  listScopedTasks(
    scope: ScoutReconciliationScopeQuery,
  ): Promise<ScoutReconciliationTask[]>;
  listTaskStates(
    taskIds: readonly string[],
  ): Promise<ScoutReconciliationTaskStateRecord[]>;
  /**
   * One transaction: every evaluation insert, suggestion supersession/insert,
   * task-state change, optional task completion, the optional digest row, and
   * the final run summary all commit together, or none of them do.
   */
  commitRun<TPlan, TResult>(
    input: ScoutReconciliationCommitInput<TPlan, TResult>,
  ): Promise<ScoutReconciliationCommitResult<TResult>>;
  /** Expires stale/terminal pending suggestions, then lists the remaining ones. */
  listPendingSuggestions(input: {
    readonly now: string;
    readonly limit: number;
    readonly openStatuses: readonly string[];
    readonly terminalStatuses: readonly string[];
  }): Promise<ScoutReconciliationSuggestionRow[]>;
  /** One transaction: read the suggestion/task/connector, decide, then apply. */
  actOnSuggestion<TResult>(input: {
    readonly suggestionId: string;
    readonly decide: (
      snapshot: ScoutSuggestionActionSnapshot,
    ) => ScoutSuggestionActionDecision<TResult>;
  }): Promise<TResult>;
  hasAppliedAutoCompletion(taskId: string): Promise<boolean>;
}

export interface ScoutIngestionReconciliationPersistence {
  readonly ingestion: ScoutIngestionRepository;
  readonly comparison: ScoutComparisonRepository;
  readonly reconciliation: ScoutReconciliationRepository;
}
