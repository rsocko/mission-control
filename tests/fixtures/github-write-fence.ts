import type { GitHubIssuesConnector } from '@/lib/connectors/github-issues';

/**
 * GitHub identity is permanently NodeID-first, so every connector mutation must
 * run inside a fenced write authorization. Unit tests that exercise the raw
 * connector API use this to supply the authorization the write fence would.
 */
export function runFencedGitHubWrite<T>(
  connector: GitHubIssuesConnector,
  route: {
    connectorInstanceId: string;
    taskId: string;
    owner: string;
    repository: string;
    issueNumber: number | null;
    operation?: 'create' | 'update' | 'complete' | 'delete' | 'label' | 'comment'
      | 'dependency' | 'sub_issue' | 'transfer';
    targets?: ReadonlyArray<{
      role: 'primary_issue' | 'parent_issue' | 'blocker_issue' | 'blocked_issue'
        | 'source_repository' | 'target_repository';
      owner: string;
      repository: string;
      issueNumber: number | null;
    }>;
  },
  write: () => Promise<T>,
): Promise<T> {
  return connector.runAuthorizedWrite({
    leaseId: `test-lease-${route.taskId}`,
    token: `test-token-${route.taskId}`,
    connectorInstanceId: route.connectorInstanceId,
    taskId: route.taskId,
    operation: route.operation ?? 'update',
    sourceId: route.issueNumber === null
      ? `${route.owner}/${route.repository}`
      : `${route.owner}/${route.repository}:${route.issueNumber}`,
    owner: route.owner,
    repository: route.repository,
    issueNumber: route.issueNumber,
    expiresAt: '2099-01-01T00:00:00.000Z',
    targets: route.targets ?? [
      {
        role: 'primary_issue',
        owner: route.owner,
        repository: route.repository,
        issueNumber: route.issueNumber,
      },
      {
        role: 'source_repository',
        owner: route.owner,
        repository: route.repository,
        issueNumber: null,
      },
    ],
  }, write);
}
