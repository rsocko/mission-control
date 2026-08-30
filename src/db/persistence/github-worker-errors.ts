/**
 * Shared fail-closed error for the GitHub worker persistence ports.
 *
 * Layer 3A migrates the *normal* GitHub queue-execution surfaces (identity
 * epoch and write fencing, dependency generation, hierarchy reconciliation, and
 * Projects V2 association reconciliation) behind backend-neutral ports. Operator
 * and recovery surfaces — repository repoint, bulk transfer, historical task
 * transfer succession workflows, identity backfill/status, manual exception
 * mutation, unknown-outcome resolution, and interrupted write-cycle recovery —
 * are deliberately *not* migrated yet and must fail closed under PostgreSQL
 * before any remote effect is attempted.
 */
export class UnsupportedGitHubWorkerOperationError extends Error {
  readonly code = 'unsupported-github-worker-operation';

  constructor(readonly reason: string) {
    super(`PostgreSQL GitHub worker persistence does not support ${reason}`);
    this.name = 'UnsupportedGitHubWorkerOperationError';
  }
}
