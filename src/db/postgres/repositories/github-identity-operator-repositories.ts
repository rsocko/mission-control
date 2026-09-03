import { UnsupportedGitHubWorkerOperationError } from '@/db/persistence/github-worker-errors';
import type { GitHubIdentityOperatorPersistence } from '@/db/persistence/github-identity-operator';

/**
 * PostgreSQL adapter for the five pre-existing, previously audited GitHub
 * worker operator/recovery surfaces (see `github-worker-errors.ts` and
 * `github-identity-operator.ts`): identity backfill/status, manual
 * terminal-inaccessible exception mutation, unknown write-outcome resolution,
 * and interrupted write-cycle recovery.
 *
 * This is **not** a genuine async implementation. Every member synchronously
 * throws `UnsupportedGitHubWorkerOperationError` before any SQLite
 * import/evaluation, transaction acquisition, remote network effect, or
 * durable mutation is attempted — it merely returns a Promise rejected with
 * that error so it satisfies the port's async signature. Cross-backend
 * behavioral parity is neither claimed nor required for this port; production
 * remains SQLite for these five operator-only surfaces.
 */
export function createPostgresGitHubIdentityOperatorRepositories(): GitHubIdentityOperatorPersistence {
  function unsupported(reason: string): never {
    throw new UnsupportedGitHubWorkerOperationError(reason);
  }

  return {
    async getIdentityStatus() {
      return unsupported('GitHub identity operational status reporting');
    },
    async recordIdentityException() {
      return unsupported('manual GitHub terminal-inaccessible exception mutation');
    },
    async reconcileInterruptedWriteCycle() {
      return unsupported('interrupted GitHub write-cycle reconciliation');
    },
    async inspectWriteOutcomes() {
      return unsupported('GitHub write-outcome inspection');
    },
    async resolveWriteOutcome() {
      return unsupported('GitHub write-outcome resolution');
    },
    async getBackfillPhase() {
      return unsupported('GitHub identity backfill phase lookup');
    },
    async updateBackfillPhase() {
      return unsupported('GitHub identity backfill phase transition');
    },
    async previewIdentityBatch() {
      return unsupported('GitHub identity backfill batch preview');
    },
    async getBackfillStatus() {
      return unsupported('GitHub identity backfill status lookup');
    },
    async preflightBackfill() {
      return unsupported('GitHub identity backfill preflight');
    },
    async runBackfill() {
      return unsupported('GitHub identity backfill execution');
    },
  };
}
