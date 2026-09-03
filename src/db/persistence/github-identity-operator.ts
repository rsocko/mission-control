import type { GitHubIdentityPhase } from '@/db/schema';
import type {
  GitHubIdentityExceptionRequest,
  GitHubIdentityExceptionResult,
} from '@/lib/external-identities/stable-identity-types';
import type {
  GitHubIdentityBackfillOptions,
  GitHubIdentityBackfillProgress,
  GitHubIdentityBackfillStatus,
  GitHubIdentityPreflightResult,
} from '@/lib/external-identities/github-backfill';
import type {
  GitHubWriteCycleReconciliationCommand,
  GitHubWriteCycleReconciliationResult,
} from '@/lib/external-identities/write-cycle-reconciliation';
import type {
  GitHubWriteOutcomeReader,
  GitHubWriteOutcomeResolutionCommand,
  GitHubWriteOutcomeResolutionResult,
} from '@/lib/external-identities/write-outcome-resolution';
import type { GitHubIdentityStatusOptions } from '@/lib/external-identities/identity-status';
import type { ExternalIdentityWrite, ExternalIdentityWriteResult } from '@/lib/external-identities/types';

export { UnsupportedGitHubWorkerOperationError } from './github-worker-errors';

/**
 * Backend-neutral port for the five GitHub identity operator/recovery surfaces
 * that `@/db/persistence/github-worker.ts` documents as deliberately absent
 * from normal Layer 3A/3B GitHub queue execution: identity backfill/status,
 * manual terminal-inaccessible exception mutation, unknown write-outcome
 * resolution, and interrupted write-cycle recovery.
 *
 * These are pre-existing, previously audited worker exclusions (see
 * `github-worker.ts` and `github-worker-errors.ts`), not new exceptions
 * introduced by this port. This interface exists only so the SQLite CLI
 * operator tool (`scripts/github-identity-operator.ts`) and its test suite can
 * reach them through a composition root instead of importing `@/db` directly.
 *
 * The SQLite adapter genuinely implements every member, reusing the exact
 * pre-existing query/mutation logic verbatim. The PostgreSQL adapter is **not**
 * a genuine async implementation: every member synchronously throws
 * `UnsupportedGitHubWorkerOperationError` before any SQLite import/evaluation,
 * transaction acquisition, remote network effect, or durable mutation is
 * attempted. Cross-backend behavioral parity is not claimed or required for
 * this port; only the SQLite adapter's exact prior behavior and the PG
 * adapter's fail-closed contract are covered by tests.
 */
export interface GitHubIdentityOperatorPersistence {
  /** Operational status report: NodeID coverage, collisions, write-cycle recovery, exceptions. */
  getIdentityStatus(
    connectorInstanceId: string,
    options?: GitHubIdentityStatusOptions,
  ): Promise<Record<string, unknown>>;

  /** Records (or idempotently replays) a manual terminal-inaccessible exception decision. */
  recordIdentityException(
    request: GitHubIdentityExceptionRequest,
  ): Promise<GitHubIdentityExceptionResult>;

  /** Reconciles a write cycle that was interrupted before dispatch evidence existed. */
  reconcileInterruptedWriteCycle(
    command: GitHubWriteCycleReconciliationCommand,
  ): Promise<GitHubWriteCycleReconciliationResult>;

  /** Read-only inspection of write cycles/leases with dispatch or quarantine evidence. */
  inspectWriteOutcomes(options: {
    connectorInstanceId: string;
    cycleId?: string;
    leaseId?: string;
    limit?: number;
  }): Promise<Record<string, unknown>>;

  /** Resolves an unknown write outcome, reading authoritative state through `reader`. */
  resolveWriteOutcome(
    command: GitHubWriteOutcomeResolutionCommand,
    reader: GitHubWriteOutcomeReader,
  ): Promise<GitHubWriteOutcomeResolutionResult>;

  /** Current backfill lifecycle phase for a connector, if migration state exists. */
  getBackfillPhase(connectorInstanceId: string): Promise<GitHubIdentityPhase | null>;

  /** Advances the backfill lifecycle phase, validating the transition is legal. */
  updateBackfillPhase(input: {
    connectorInstanceId: string;
    phase: GitHubIdentityPhase;
    now: string;
  }): Promise<void>;

  /**
   * Dry-runs a batch write the way the Stage-1 backfill preview does: computes
   * the exact results a real write would return without committing any change.
   */
  previewIdentityBatch(
    writes: readonly ExternalIdentityWrite[],
  ): Promise<readonly ExternalIdentityWriteResult[]>;

  /** Durable migration-state row for a connector's backfill, if one exists. */
  getBackfillStatus(
    connectorInstanceId: string,
  ): Promise<GitHubIdentityBackfillStatus | null>;

  /** Read-only (optionally collision-persisting) preflight check before a backfill run. */
  preflightBackfill(
    connectorInstanceId: string,
    persistCollisions?: boolean,
  ): Promise<GitHubIdentityPreflightResult>;

  /** Runs (or dry-runs) one bounded backfill sweep. */
  runBackfill(
    options: GitHubIdentityBackfillOptions,
  ): Promise<GitHubIdentityBackfillProgress>;
}
