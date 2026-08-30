import type {
  GitHubIdentityPersistence,
  GitHubWriteFencePersistence,
} from './github-identity';
import type { GitHubDependencyPersistence } from './github-dependencies';
import type { GitHubHierarchyPersistence } from './github-hierarchy';
import type { GitHubProjectPersistence } from './github-projects';

export { UnsupportedGitHubWorkerOperationError } from './github-worker-errors';

/**
 * The backend-neutral persistence surface the normal GitHub queue execution
 * path needs.
 *
 * This composition is registered atomically: the runtime either has every
 * member (and `github-issues` execution is therefore supported on the selected
 * backend) or none of them. Partial registration is not representable, which is
 * what lets `ConnectorExecutionSupport` decide whether GitHub connectors and the
 * dependency resume/relationship pollers may start.
 *
 * Operator and recovery surfaces (repository repoint, bulk transfer, historical
 * task-transfer succession workflows, identity backfill/status, manual exception
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
}
