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

export interface FinanceAttributionPersistence {
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
}
