/**
 * Shared fail-closed error for the GitHub worker persistence ports.
 *
 * Layer 3A migrates the *normal* GitHub queue-execution surfaces (identity
 * epoch and write fencing, dependency generation, hierarchy reconciliation, and
 * Projects V2 association reconciliation) behind backend-neutral ports. Layer
 * 3B adds `recovery` (native issue transfer, historical task-transfer
 * succession reconciliation, bulk transfer runs, and repository repoint),
 * which is genuinely implemented on both backends.
 *
 * The remaining operator/recovery surfaces — identity backfill/status, manual
 * terminal-inaccessible exception mutation, unknown write-outcome resolution,
 * and interrupted write-cycle recovery — are pre-existing, previously audited
 * worker exclusions. They are exposed through the narrowly-scoped
 * `GitHubIdentityOperatorPersistence` port (`github-identity-operator.ts`) so
 * the operator CLI can reach them without importing `@/db` directly, but they
 * remain deliberately unsupported on PostgreSQL: that adapter is not a genuine
 * async implementation and every member fails closed with this error before
 * any remote effect is attempted.
 */
export class UnsupportedGitHubWorkerOperationError extends Error {
  readonly code = 'unsupported-github-worker-operation';

  constructor(readonly reason: string) {
    super(`PostgreSQL GitHub worker persistence does not support ${reason}`);
    this.name = 'UnsupportedGitHubWorkerOperationError';
  }
}
