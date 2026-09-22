import type { ConnectorConfig } from '@/types';

/**
 * Backend-neutral persistence for Houston's finance assistant: the six bounded
 * finance reads, the two approval-gated finance mutations, the pending
 * approval lifecycle, and the redacted approval audit.
 *
 * Every member is purpose-built and domain-shaped. There is deliberately no
 * generic query/SQL surface, no raw driver handle, no fallback, and no dual
 * write: an operation either exists here with its exact bound, ordering, and
 * atomicity, or the assistant cannot perform it. Adapters never perform
 * provider I/O — the category mutation is expressed as a claim, an
 * externally-observable provider call owned by the domain service, and then a
 * separate completion or failure transition, so no database transaction is
 * ever held across the Tyrion Bridge request.
 */

/** Maximum finance connectors read while proving unambiguous selection. */
export const FINANCE_ASSISTANT_CONNECTOR_LIMIT = 2;
/** Maximum rows read while proving an unambiguous name match. */
export const FINANCE_ASSISTANT_AMBIGUITY_LIMIT = 2;
/** Maximum rows read while proving a single idempotent replay. */
export const FINANCE_ASSISTANT_REPLAY_LIMIT = 2;
/** Maximum same-date/same-amount candidates scanned for an approved target. */
export const FINANCE_ASSISTANT_MUTATION_TARGET_LIMIT = 50;
/** Category/kid aggregate rows read so the twelfth-plus row proves truncation. */
export const FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT = 13;
/** Hard ceiling for the bounded transaction search page. */
export const FINANCE_ASSISTANT_TRANSACTION_LIMIT_MAX = 25;
/** Hard ceiling for the bounded attribution exception page. */
export const FINANCE_ASSISTANT_EXCEPTION_LIMIT_MAX = 20;
/** Hard ceiling for the bounded recurring obligation page. */
export const FINANCE_ASSISTANT_OBLIGATION_LIMIT_MAX = 25;
/**
 * A `processing` category claim older than this is treated as abandoned and
 * may be retried by the same idempotency key.
 */
export const FINANCE_ASSISTANT_MUTATION_CLAIM_STALE_MS = 15 * 60_000;

/** Clamps a caller-supplied page size into `[1, maximum]`. */
export function boundedAssistantLimit(limit: number, maximum: number): number {
  if (!Number.isSafeInteger(limit)) return 1;
  return Math.min(Math.max(limit, 1), maximum);
}

export type FinanceAssistantSyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export type FinanceAssistantAttributionHealth =
  | 'idle'
  | 'healthy'
  | 'degraded'
  | 'unavailable';
export type FinanceAssistantAttributionStatus =
  | 'attributed'
  | 'unassigned'
  | 'pending'
  | 'unavailable';
export type FinanceAssistantAttributionConfidence = 'definite' | 'likely' | 'none';
export type FinanceAssistantAttributionMethod =
  | 'manual'
  | 'account-rule'
  | 'merchant-rule'
  | 'historical-pattern'
  | 'unassigned'
  | 'unavailable';
export type FinanceAssistantMutationTool =
  | 'assignFinanceTransactionKid'
  | 'updateFinanceTransactionCategory';
export type FinanceAssistantApprovalOutcome =
  | 'denied'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'invalid-approval';

export interface FinanceAssistantConnector {
  id: string;
  pollIntervalMinutes: number | null;
}

/** Projection freshness inputs; freshness itself is decided by the service. */
export interface FinanceAssistantProjectionState {
  sourceAsOf: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  lastSuccessfulSyncAt: string | null;
  status: FinanceAssistantSyncStatus;
  lastErrorCode: string | null;
  attributionStatus: FinanceAssistantAttributionHealth;
  attributionLastSuccessfulAt: string | null;
}

/**
 * One projected transaction. `pending`/`recurring` are domain booleans on both
 * backends, and the version fields exist so the service can prove the approved
 * target has not changed before it mutates anything.
 */
export interface FinanceAssistantTransaction {
  id: string;
  connectorId: string;
  date: string;
  amount: number;
  merchant: string | null;
  category: string | null;
  confirmedCategory: string | null;
  pending: boolean;
  recurring: boolean;
  kidName: string | null;
  attributionStatus: FinanceAssistantAttributionStatus;
  confidence: FinanceAssistantAttributionConfidence | null;
  method: FinanceAssistantAttributionMethod | null;
  assignedKidId: string | null;
  sourceFingerprint: string;
  lastSeenAt: string;
  manualDecidedAt: string | null;
}

export interface FinanceAssistantTransactionQuery {
  connectorId: string;
  startDate: string;
  endDate: string;
  /** Case-insensitive merchant substring; escaped by the adapter. */
  merchantQuery?: string;
  categoryName?: string;
  kidId?: string;
  triageStatus?: string;
  limit: number;
}

export interface FinanceAssistantTransactionPage {
  transactions: FinanceAssistantTransaction[];
  truncated: boolean;
}

export interface FinanceAssistantAmountTotal {
  totalAmount: number;
  transactionCount: number;
}

export interface FinanceAssistantSpendingSummary extends FinanceAssistantAmountTotal {
  byCategory: Array<{ category: string; amount: number; transactionCount: number }>;
  byKid: Array<{ kidName: string; amount: number; transactionCount: number }>;
}

export interface FinanceAssistantKid {
  id: string;
  name: string;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
}

export interface FinanceAssistantProjectedKid {
  id: string;
  name: string;
}

export interface FinanceAssistantProjectedCategory {
  upstreamCategoryId: string;
  name: string;
}

export interface FinanceAssistantException {
  date: string;
  merchantName: string | null;
  reasonCode: string;
  retryable: boolean;
  assignedKidId: string | null;
  confidence: FinanceAssistantAttributionConfidence | null;
  lastObservedAt: string;
}

export interface FinanceAssistantExceptionPage {
  exceptions: FinanceAssistantException[];
  truncated: boolean;
  subjects: Array<{ kidId: string; name: string }>;
}

export interface FinanceAssistantObligation {
  merchant: string;
  amount: number;
  frequency: string;
  nextExpectedDate: string | null;
  category: string | null;
}

export interface FinanceAssistantObligationPage {
  obligations: FinanceAssistantObligation[];
  truncated: boolean;
  /** Bounded aggregate over the whole horizon, not just the returned page. */
  estimatedMonthlyAmount: number;
}

/** The approved transaction version an atomic mutation must still observe. */
export interface FinanceAssistantExpectedVersion {
  sourceFingerprint: string;
  lastSeenAt: string;
  assignedKidId: string | null;
  confirmedCategory: string | null;
  manualDecidedAt: string | null;
}

export interface FinanceAssistantKidAssignmentCommand {
  connectorId: string;
  transactionId: string;
  kidId: string;
  idempotencyKey: string;
  actorType: 'parent-admin' | 'service';
  decidedAt: string;
  expectedVersion: FinanceAssistantExpectedVersion;
}

export type FinanceAssistantKidAssignmentResult =
  | { status: 'applied' }
  | { status: 'replayed' }
  | { status: 'idempotency-conflict' }
  | { status: 'connector-not-found' }
  | { status: 'transaction-not-found' }
  | { status: 'transaction-conflict' }
  | { status: 'unknown-attribution-subject' };

export interface FinanceAssistantCategoryClaimCommand {
  connectorId: string;
  transactionId: string;
  categoryId: string;
  expectedCategoryName: string;
  idempotencyKey: string;
  claimedAt: string;
  expectedVersion: FinanceAssistantExpectedVersion;
}

export type FinanceAssistantCategoryClaimResult =
  | { status: 'claimed'; upstreamTransactionId: string; claimToken: string }
  | { status: 'already-succeeded' }
  | { status: 'idempotency-conflict' }
  | { status: 'transaction-not-found' }
  | { status: 'transaction-conflict' }
  | { status: 'category-conflict' }
  | { status: 'mutation-in-progress' };

export interface FinanceAssistantCategoryCompletionCommand {
  connectorId: string;
  transactionId: string;
  categoryId: string;
  idempotencyKey: string;
  claimToken: string;
  completedAt: string;
}

export interface FinanceAssistantCategoryFailureCommand {
  connectorId: string;
  idempotencyKey: string;
  claimToken: string;
  errorCode: string;
  errorMessage: string;
  failedAt: string;
}

export interface FinanceAssistantPendingApprovalCommand {
  approvalId: string;
  toolCallId: string;
  tool: FinanceAssistantMutationTool;
  /** Canonical JSON produced by the service; compared byte-for-byte. */
  toolInput: string;
  correlationId: string;
  createdAt: string;
  expiresAt: string;
}

export type FinanceAssistantApprovalPersistResult =
  | { status: 'stored' }
  | { status: 'replayed' }
  | { status: 'conflict' };

export interface FinanceAssistantConsumeApprovalCommand {
  approvalId: string;
  toolCallId: string;
  tool: FinanceAssistantMutationTool;
  toolInput: string;
  now: string;
}

export type FinanceAssistantApprovalConsumeResult =
  | { status: 'consumed'; toolInput: string }
  | { status: 'expired' }
  | { status: 'invalid' };

export interface FinanceAssistantApprovalAuditCommand {
  correlationId: string;
  callHash: string;
  tool: FinanceAssistantMutationTool;
  decision: 'approve' | 'deny';
  outcome: FinanceAssistantApprovalOutcome;
  durationMs: number;
  createdAt: string;
}

export interface FinanceAssistantPersistence {
  /**
   * Enabled, non-deleted finance connectors ordered by `created_at, id` and
   * capped at {@link FINANCE_ASSISTANT_CONNECTOR_LIMIT}, so the service can
   * distinguish "none configured" from "ambiguous" without reading the estate.
   */
  listEnabledConnectors(): Promise<FinanceAssistantConnector[]>;
  /** Normalized configuration for one enabled connector, or `null`. */
  readConnectorConfig(connectorId: string): Promise<ConnectorConfig | null>;
  readProjectionState(connectorId: string): Promise<FinanceAssistantProjectionState | null>;
  searchTransactions(
    query: FinanceAssistantTransactionQuery,
  ): Promise<FinanceAssistantTransactionPage>;
  readSpendingSummary(input: {
    connectorId: string;
    startDate: string;
    endDate: string;
  }): Promise<FinanceAssistantSpendingSummary>;
  readKidSpendingTotal(input: {
    connectorId: string;
    kidId: string;
    startDate: string;
    endDate: string;
  }): Promise<FinanceAssistantAmountTotal>;
  listAttributionExceptions(input: {
    connectorId: string;
    limit: number;
  }): Promise<FinanceAssistantExceptionPage>;
  listRecurringObligations(input: {
    connectorId: string;
    horizonStart: string;
    horizonEnd: string;
    limit: number;
  }): Promise<FinanceAssistantObligationPage>;
  matchKidsByName(name: string): Promise<FinanceAssistantKid[]>;
  matchProjectedKidsByName(input: {
    connectorId: string;
    name: string;
  }): Promise<FinanceAssistantProjectedKid[]>;
  matchProjectedCategoriesByName(input: {
    connectorId: string;
    name: string;
  }): Promise<FinanceAssistantProjectedCategory[]>;
  findApprovedMutationTargets(input: {
    connectorId: string;
    date: string;
    amount: number;
  }): Promise<FinanceAssistantTransaction[]>;
  /** Resolved manual attribution decisions replayed by approval identity. */
  findReplayedKidAssignments(
    idempotencyKey: string,
  ): Promise<Array<{ kidName: string | null }>>;
  /** Succeeded category updates replayed by approval identity. */
  findReplayedCategoryUpdates(
    idempotencyKey: string,
  ): Promise<Array<{ categoryName: string | null }>>;
  /**
   * Atomic manual kid assignment: compare-and-swap on the approved transaction
   * version, resolve the projected exception, and write the attribution audit
   * in one transaction, or change nothing.
   */
  applyManualKidAssignment(
    command: FinanceAssistantKidAssignmentCommand,
  ): Promise<FinanceAssistantKidAssignmentResult>;
  /**
   * Atomically claims the single active category mutation for a transaction.
   * The claim is committed before the service performs provider I/O.
   */
  claimCategoryMutation(
    command: FinanceAssistantCategoryClaimCommand,
  ): Promise<FinanceAssistantCategoryClaimResult>;
  /** Confirms a provider-verified category update in one transaction. */
  completeCategoryMutation(
    command: FinanceAssistantCategoryCompletionCommand,
  ): Promise<boolean>;
  /**
   * Records a provider failure without changing projected category state.
   * Finalization is conditional on the claim token so an abandoned provider
   * request cannot overwrite the outcome of a newer retry.
   */
  failCategoryMutation(command: FinanceAssistantCategoryFailureCommand): Promise<boolean>;
  /**
   * Idempotently persists one server-owned pending approval, pruning expired
   * proposals first. Conflicting reuse of an approval identity is rejected.
   */
  persistPendingApproval(
    command: FinanceAssistantPendingApprovalCommand,
  ): Promise<FinanceAssistantApprovalPersistResult>;
  /** Exactly-once consume of a matching, unexpired pending approval. */
  consumePendingApproval(
    command: FinanceAssistantConsumeApprovalCommand,
  ): Promise<FinanceAssistantApprovalConsumeResult>;
  /** Appends one redacted approval-action audit row. */
  recordApprovalAudit(command: FinanceAssistantApprovalAuditCommand): Promise<void>;
}
