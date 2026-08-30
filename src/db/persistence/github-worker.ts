import type {
  GitHubIdentityPersistence,
  GitHubWriteFencePersistence,
} from './github-identity';
import type { GitHubDependencyPersistence } from './github-dependencies';
import type { GitHubHierarchyPersistence } from './github-hierarchy';
import type { GitHubProjectPersistence } from './github-projects';
import type { GitHubRecoveryPersistence } from './github-recovery';

export { UnsupportedGitHubWorkerOperationError } from './github-worker-errors';

/**
 * The backend-neutral persistence surface the GitHub queue execution path and
 * the GitHub operator recovery workflows need.
 *
 * This composition is registered atomically: the runtime either has every
 * member (and `github-issues` execution is therefore supported on the selected
 * backend) or none of them. Partial registration is not representable, which is
 * what lets `ConnectorExecutionSupport` decide whether GitHub connectors and the
 * dependency resume/relationship pollers may start.
 *
 * Layer 3A supplies `identity`, `writeFence`, `dependencies`, `hierarchy`, and
 * `projects` for normal queue execution. Layer 3B adds `recovery`, which covers
 * native issue transfer, historical task-transfer succession reconciliation,
 * bulk transfer runs, and repository repoint.
 *
 * The remaining operator surfaces (identity backfill/status, manual exception
 * mutation, unknown-outcome resolution, interrupted write-cycle recovery) are
 * deliberately absent. Under PostgreSQL they fail closed through
 * `UnsupportedGitHubWorkerOperationError` or
 * `UnsupportedConnectorExecutionError` before any remote effect is attempted.
 */
export interface GitHubWorkerRepositories {
  readonly identity: GitHubIdentityPersistence;
  readonly writeFence: GitHubWriteFencePersistence;
  readonly dependencies: GitHubDependencyPersistence;
  readonly hierarchy: GitHubHierarchyPersistence;
  readonly projects: GitHubProjectPersistence;
  readonly recovery: GitHubRecoveryPersistence;
}
