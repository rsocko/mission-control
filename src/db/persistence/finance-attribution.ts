/**
 * Backend-neutral persistence contract for automated Tyrion attribution.
 * Manual mutation APIs intentionally remain outside Layer 5A, but the state
 * snapshot included with each write provides a null-safe compare-and-swap so
 * an in-flight automated response can never replace a newer manual decision.
 */

export const FINANCE_ATTRIBUTION_READ_MAX = 500;
export const FINANCE_ATTRIBUTION_WRITE_MAX = 100;

export type FinanceManualAction = 'assign-kid' | 'parent-expense';

export interface FinanceAttributionStateSnapshot {
  assignedKidId: string | null;
  kidAssignmentMethod: string | null;
  manualDecisionAction: FinanceManualAction | null;
  manualDecidedAt: string | null;
}

export interface FinanceAttributionRow extends FinanceAttributionStateSnapshot {
  id: string;
  upstreamTransactionId: string;
  sourceFingerprint: string;
  firstSeenAt: string;
}

export interface FinanceAttributionResult {
  contractVersion: string;
  sourceRef: string;
  status: 'attributed' | 'unassigned' | 'pending';
  kidId: string | null;
  confidence: 'definite' | 'likely' | 'none';
  method:
    | 'manual'
    | 'account-rule'
    | 'merchant-rule'
    | 'historical-pattern'
    | 'unassigned'
    | 'unavailable';
  explanation: string;
  reviewStatus: 'not-required' | 'pending' | 'resolved';
  reasons: readonly string[];
  decisionSource: 'manual' | 'automated' | 'fallback';
  policyVersion: number;
  engineVersion: string;
  evaluatedAt: string;
}

export interface FinanceAttributionApplyItem {
  transactionId: string;
  sourceFingerprint: string;
  sourceRef: string;
  stateSnapshot: FinanceAttributionStateSnapshot;
  hasManualDecision: boolean;
  manualResultMatches: boolean;
  result: FinanceAttributionResult;
}

export interface FinanceAttributionUnavailableItem {
  transactionId: string;
  sourceFingerprint: string;
  sourceRef: string | null;
  stateSnapshot: FinanceAttributionStateSnapshot;
}

export interface FinanceAttributionFailure {
  code: string;
  retryable: boolean;
  reason: string;
  explanation: string;
}

export interface FinanceAttributionFinishCommand {
  connectorId: string;
  generationId: string;
  fenceMode?: FinanceAttributionFenceMode;
  attemptedAt: string;
  succeeded: boolean;
  terminalFailureCode: string | null;
  status: 'healthy' | 'degraded' | 'unavailable';
  policyVersion: number | null;
  engineVersion: string;
}

export type FinanceAttributionFenceMode = 'snapshot' | 'row-generation';

export class FinanceAttributionFenceError extends Error {
  readonly code = 'finance_attribution_generation_stale';

  constructor() {
    super('Finance attribution generation is no longer current');
    this.name = 'FinanceAttributionFenceError';
  }
}

/**
 * Stable domain error for every API-shaped attribution mutation. It lives in
 * the contract (rather than in the finance service) so both the SQLite and
 * PostgreSQL adapters raise exactly one class identity and every route keeps
 * its existing `code`/`status` mapping unchanged.
 */
export class FinanceAttributionMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FinanceAttributionMutationError';
  }
}

export type FinanceAttributionActorType = 'parent-admin' | 'service';

export type FinanceAttributionExceptionStatus =
  | 'open'
  | 'retry_requested'
  | 'resolved'
  | 'dismissed';

export type FinanceAttributionExceptionStatusFilter =
  | FinanceAttributionExceptionStatus
  | 'current'
  | 'all';

export const FINANCE_ATTRIBUTION_EXCEPTION_STATUS_FILTERS: readonly
FinanceAttributionExceptionStatusFilter[] = [
  'current',
  'open',
  'retry_requested',
  'resolved',
  'dismissed',
  'all',
];

export const FINANCE_ATTRIBUTION_EXCEPTION_PAGE_MAX = 100;

export interface FinanceAttributionExceptionCursor {
  updatedAt: string;
  id: string;
}

/**
 * The exact public exception projection the attribution-exception API returns.
 * It deliberately excludes transaction identifiers, raw provider output, source
 * sequences, detector versions, and persistence metadata.
 */
export interface FinanceAttributionExceptionView {
  id: string;
  status: FinanceAttributionExceptionStatus;
  reasonCode: string;
  retryable: boolean;
  reviewState: string;
  policyVersion: number | null;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  updatedAt: string;
  date: string;
  merchantName: string | null;
  assignedKidId: string | null;
  attributionStatus: string | null;
  confidence: string | null;
  method: string | null;
  explanation: string | null;
  reasons: readonly string[];
  decisionSource: string | null;
  engineVersion: string | null;
  evaluatedAt: string | null;
}

export interface FinanceAttributionSubjectView {
  kidId: string;
  name: string;
}

export interface FinanceAttributionExceptionQuery {
  connectorId: string;
  status: FinanceAttributionExceptionStatusFilter;
  limit: number;
  cursor: FinanceAttributionExceptionCursor | null;
}

export interface FinanceAttributionExceptionPage {
  exceptions: readonly FinanceAttributionExceptionView[];
  /** True when at least one more row exists after `exceptions`. */
  hasMore: boolean;
  subjects: readonly FinanceAttributionSubjectView[];
}

export interface FinanceAttributionExpectedTransactionVersion {
  sourceFingerprint: string;
  lastSeenAt: string;
  assignedKidId: string | null;
  confirmedCategory: string | null;
  manualDecidedAt: string | null;
}

export interface FinanceAttributionManualDecisionCommand {
  connectorId: string;
  transactionId: string;
  action: FinanceManualAction;
  kidId: string | null;
  idempotencyKey: string;
  auditAction: 'approve' | 'manual-resolve';
  actorType: FinanceAttributionActorType;
  exceptionId: string | null;
  expectedExceptionUpdatedAt: string | null;
  expectedTransactionVersion: FinanceAttributionExpectedTransactionVersion | null;
  now: string;
}

export interface FinanceAttributionManualDecisionResult {
  status: 'resolved';
  transactionId: string;
  kidId: string | null;
  replayed: boolean;
}

export type FinanceAttributionExceptionAction =
  | 'approve'
  | 'manual-resolve'
  | 'dismiss'
  | 'retry';

export interface FinanceAttributionExceptionActionCommand {
  connectorId: string;
  exceptionId: string;
  action: FinanceAttributionExceptionAction;
  kidId: string | null;
  expectedUpdatedAt: string;
  idempotencyKey: string;
  actorType: FinanceAttributionActorType;
  now: string;
}

export interface FinanceAttributionExceptionActionResult {
  status: string;
  exceptionId: string;
  replayed: boolean;
  /**
   * True only when this call committed a *first* retry action. Callers use it
   * to schedule the follow-up sync strictly after commit; it is false for an
   * idempotent replay and for every non-retry action.
   */
  retryScheduled: boolean;
}

export interface FinanceAttributionPersistence {
  /**
   * Preserves the API's connector-not-found precedence before request-shape
   * validation while keeping connector ownership in the selected adapter.
   */
  assertConnector(connectorId: string): Promise<void>;
  readRows(
    connectorId: string,
    upstreamTransactionIds: readonly string[],
  ): Promise<Map<string, FinanceAttributionRow>>;
  applyResults(input: {
    connectorId: string;
    generationId: string;
    fenceMode?: FinanceAttributionFenceMode;
    now: string;
    items: readonly FinanceAttributionApplyItem[];
    provenance: string;
  }): Promise<void>;
  persistUnavailable(input: {
    connectorId: string;
    generationId: string;
    fenceMode?: FinanceAttributionFenceMode;
    now: string;
    items: readonly FinanceAttributionUnavailableItem[];
    failure: FinanceAttributionFailure;
    contractVersion: string;
    provenance: string;
  }): Promise<void>;
  finish(command: FinanceAttributionFinishCommand): Promise<{ recorded: boolean }>;
  /**
   * Bounded, cursor-paginated attribution exception listing. The caller has
   * already validated the status/limit/cursor request shape; the adapter owns
   * connector ownership validation and the ordered keyset scan, and returns one
   * extra row's worth of information through `hasMore` so the caller can encode
   * the opaque cursor without the adapter knowing the transport encoding.
   */
  listExceptions(
    query: FinanceAttributionExceptionQuery,
  ): Promise<FinanceAttributionExceptionPage>;
  /**
   * Atomic manual transaction decision. Connector ownership, transaction
   * existence, projected-subject membership, expected-version CAS, exception
   * CAS, the state mutation, and the idempotency audit all happen inside one
   * write transaction. Exact replay of a committed key returns the first
   * committed result; reuse with another payload raises
   * `idempotency_conflict`.
   */
  applyManualDecision(
    command: FinanceAttributionManualDecisionCommand,
  ): Promise<FinanceAttributionManualDecisionResult>;
  /**
   * Atomic approve / manual-resolve / dismiss / retry on one exception. Retry
   * scheduling is deliberately *not* performed here: the result reports
   * `retryScheduled` so the caller can wake the sync queue only after this
   * transaction has committed, and never for an idempotent replay.
   */
  actOnException(
    command: FinanceAttributionExceptionActionCommand,
  ): Promise<FinanceAttributionExceptionActionResult>;
}
