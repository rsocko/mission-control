/**
 * Backend-neutral persistence contract for the authoritative Monarch
 * transaction projection. Each mutating method is one adapter-owned atomic
 * operation; callers never receive a transaction or driver handle.
 */

export const FINANCE_TRANSACTION_PAGE_MAX = 500;

export type FinanceSnapshotMode = 'backfill' | 'incremental';

export interface FinanceSnapshotTransaction {
  id: string;
  date: string;
  amount: number;
  merchant: {
    name: string;
    logoUrl: string | null;
  };
  category: {
    id: string;
    name: string;
  } | null;
  account: {
    id: string;
    displayName: string;
    mask: string | null;
  };
  isPending: boolean;
  isRecurring: boolean;
  notes: string | null;
  tags: readonly string[];
  tagReferences: ReadonlyArray<{
    id: string;
    name: string;
  }>;
}

export interface FinanceSnapshotBasis {
  lastSuccessfulWindowEnd: string | null;
  needsStableTagBackfill: boolean;
}

export interface FinanceSnapshotProjectionProof {
  itemCount: number;
  contentDigest: string;
  projectionStartDate: string;
  coverageStart: string;
  coverageEnd: string;
  bridgeContractVersion: string;
}

export interface FinanceSnapshotStartCommand {
  connectorId: string;
  generationId: string;
  windowStart: string;
  windowEnd: string;
  mode: FinanceSnapshotMode;
  attemptAt: string;
}

export interface FinanceSnapshotPageCommand {
  connectorId: string;
  generationId: string;
  transactions: readonly FinanceSnapshotTransaction[];
  provenance: {
    provider: 'demo' | 'live';
    fetchedAt: string;
  };
  observedAt: string;
}

export interface FinanceSnapshotCompleteCommand {
  connectorId: string;
  generationId: string;
  windowStart: string;
  windowEnd: string;
  projectionStartDate: string;
  sourceAsOf: string;
  completedAt: string;
  added: number;
  updated: number;
}

export interface FinanceSnapshotFailureCommand {
  connectorId: string;
  generationId: string;
  failedAt: string;
  errorCode: string;
  errorMessage: string;
}

export class FinanceSnapshotFenceError extends Error {
  readonly code = 'finance_snapshot_generation_stale';

  constructor() {
    super('Finance snapshot generation is no longer current');
    this.name = 'FinanceSnapshotFenceError';
  }
}

export interface FinanceSnapshotPersistence {
  readBasis(
    connectorId: string,
    stableTagRecoveryStart: string,
  ): Promise<FinanceSnapshotBasis>;
  start(command: FinanceSnapshotStartCommand): Promise<void>;
  upsertPage(command: FinanceSnapshotPageCommand): Promise<{
    added: number;
    updated: number;
  }>;
  /**
   * Fences on the current generation, applies authoritative tombstones, and
   * advances the successful checkpoint in the same transaction.
   */
  complete(command: FinanceSnapshotCompleteCommand): Promise<{ removed: number }>;
  /**
   * Marks only the still-current generation failed. A superseded generation is
   * a deliberate no-op so it cannot overwrite a newer run.
   */
  fail(command: FinanceSnapshotFailureCommand): Promise<{ recorded: boolean }>;
}
