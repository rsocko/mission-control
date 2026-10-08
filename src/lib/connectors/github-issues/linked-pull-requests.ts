import 'server-only';

import { createHash } from 'node:crypto';
import { assertTrustedGitHubUrl, normalizeGitHubOrigin } from './identity';
import { isNativeGitHubIssueSourceId, parseSourceId } from './issue-transformer';

export interface LinkedPullRequest {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  repository: string;
  baseRefName: string;
  defaultBranch: string | null;
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
}

export interface LinkedPullRequestsResult {
  pullRequests: LinkedPullRequest[];
  hasMore: boolean;
}

interface PullRequestNode extends Omit<LinkedPullRequest, 'repository' | 'defaultBranch' | 'checks'> {
  repository: { nameWithOwner: string; defaultBranchRef: { name: string } | null };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: LinkedPullRequest['checks'] } | null } }> };
  mergeCommit: { statusCheckRollup: { state: LinkedPullRequest['checks'] } | null } | null;
}

interface PullRequestConnection {
  nodes: Array<PullRequestNode | null>;
  pageInfo: { hasNextPage: boolean };
}

type CrossReferencedSource =
  | ({ __typename: 'PullRequest' } & PullRequestNode)
  | { __typename: string };

interface IssueReferences {
  closedByPullRequestsReferences: PullRequestConnection | null;
  timelineItems: {
    nodes: Array<{
      source: CrossReferencedSource | null;
    } | null>;
    pageInfo: { hasNextPage: boolean };
  } | null;
}

function isPullRequestSource(
  source: CrossReferencedSource | null | undefined,
): source is { __typename: 'PullRequest' } & PullRequestNode {
  return source?.__typename === 'PullRequest' && 'repository' in source;
}

const PULL_REQUEST_FIELDS = `
  number url title state isDraft baseRefName
  repository { nameWithOwner defaultBranchRef { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  mergeCommit { statusCheckRollup { state } }
`;

const REFERENCES = `
  closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
    pageInfo { hasNextPage }
    nodes { ${PULL_REQUEST_FIELDS} }
  }
  timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
    pageInfo { hasNextPage }
    nodes {
      ... on CrossReferencedEvent {
        source {
          __typename
          ... on PullRequest { ${PULL_REQUEST_FIELDS} }
        }
      }
    }
  }
`;

const cache = new Map<string, {
  expiresAt: number;
  promise: Promise<LinkedPullRequestsResult>;
}>();

/** Detail-only lookup: bounded to one page, with shared in-flight requests and a short cache. */
export function getLinkedPullRequests(
  token: string,
  apiOrigin: string | undefined,
  sourceId: string,
  nodeId?: string,
): Promise<LinkedPullRequestsResult> {
  if (!isNativeGitHubIssueSourceId(sourceId)) throw new Error('Not a native GitHub issue');
  const { repo, issueNumber } = parseSourceId(sourceId);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('Invalid issue number');
  const [owner, name] = repo.split('/');
  const origin = normalizeGitHubOrigin(apiOrigin);
  // Credential changes must not reuse data fetched under a previous access scope.
  const key = createHash('sha256')
    .update(JSON.stringify([origin.hostKey, token, sourceId, nodeId ?? null]))
    .digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  cache.delete(key);
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);

  const promise = (async (): Promise<LinkedPullRequestsResult> => {
    const query = nodeId
      ? `query IssuePullRequests($id: ID!) { issue: node(id: $id) { ... on Issue { ${REFERENCES} } } }`
      : `query IssuePullRequests($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) { issue(number: $number) { ${REFERENCES} } }
          }`;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(origin.graphqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: nodeId ? { id: nodeId } : { owner, name, number: issueNumber },
      }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw new Error('GitHub linked pull requests request failed');
    const { data } = await response.json() as {
      data?: {
        issue?: IssueReferences | null;
        repository?: { issue: IssueReferences | null } | null;
      };
    };
    const issue = nodeId ? data?.issue : data?.repository?.issue;
    const closingReferences = issue?.closedByPullRequestsReferences;
    const timelineReferences = issue?.timelineItems;
    if (!closingReferences && !timelineReferences) {
      throw new Error('GitHub linked pull requests are unavailable');
    }

    const pullRequests = new Map<string, PullRequestNode>();
    for (const pullRequest of closingReferences?.nodes ?? []) {
      if (pullRequest) {
        pullRequests.set(`${pullRequest.repository.nameWithOwner}#${pullRequest.number}`, pullRequest);
      }
    }
    for (const event of timelineReferences?.nodes ?? []) {
      if (isPullRequestSource(event?.source)) {
        const pullRequest = event.source;
        pullRequests.set(`${pullRequest.repository.nameWithOwner}#${pullRequest.number}`, pullRequest);
      }
    }

    return {
      pullRequests: [...pullRequests.values()].map((pr) => ({
        number: pr.number,
        url: assertTrustedGitHubUrl(pr.url, origin).href,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        repository: pr.repository.nameWithOwner,
        baseRefName: pr.baseRefName,
        defaultBranch: pr.repository.defaultBranchRef?.name ?? null,
        // Head checks do not establish whether the merged commit built successfully.
        checks: (pr.state === 'MERGED'
          ? pr.mergeCommit?.statusCheckRollup?.state
          : pr.commits?.nodes[0]?.commit.statusCheckRollup?.state) ?? null,
      })),
      hasMore: Boolean(
        closingReferences?.pageInfo.hasNextPage
        || timelineReferences?.pageInfo.hasNextPage,
      ),
    };
  })();
  const entry = { expiresAt: Date.now() + 60_000, promise };
  cache.set(key, entry);
  void promise.catch(() => { entry.expiresAt = Date.now() + 15_000; });
  return promise;
}
