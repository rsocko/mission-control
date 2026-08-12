/**
 * GitHub API client — authenticated REST + GraphQL fetch with pagination.
 */

import {
  DEFAULT_GITHUB_API_ORIGIN,
  normalizeGitHubOrigin,
  type TrustedGitHubOrigin,
} from './identity';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_REST_URL = 'https://api.github.com';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export { GITHUB_GRAPHQL_URL, GITHUB_REST_URL };

/** Returns true for transient network errors worth retrying (socket resets, DNS failures, etc.) */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('other side closed') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('etimedout') ||
    msg.includes('abort')
  );
}

function getRequestTimeoutMs(): number {
  const configured = Number(process.env.MC_GITHUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

async function fetchWithTimeout(
  input: string,
  options?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = options?.signal;
  const timeoutMs = getRequestTimeoutMs();
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new Error(`GitHub request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (upstreamSignal?.aborted) {
      throw upstreamSignal.reason instanceof Error
        ? upstreamSignal.reason
        : new Error('GitHub request aborted');
    }
    if (controller.signal.aborted) {
      throw new Error(`GitHub request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal | null,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export interface GraphQLResponse {
  data?: {
    repository?: {
      id: string;
      nameWithOwner: string;
      url: string;
      issues?: {
        pageInfo: GraphQLPageInfo;
        nodes: GraphQLIssue[];
      };
      issue?: {
        number: number;
        blockedBy?: GraphQLBlockedByConnection | null;
      } | null;
    };
    transferIssue?: {
      issue?: {
        number?: number;
        repository?: { id?: string };
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export interface GraphQLIssue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  labels?: { nodes: Array<{ name: string; color: string }> } | null;
  assignees?: { nodes: Array<{ login: string }> } | null;
  milestone?: { title: string } | null;
  parent?: {
    id: string;
    number: number;
    title: string;
    url: string;
    repository: {
      id?: string;
      nameWithOwner: string;
      url?: string;
    };
  } | null;
  blockedBy?: GraphQLBlockedByConnection | null;
}

export interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQLBlockedByIssue {
  id: string;
  number: number;
  url: string;
  repository: {
    id: string;
    nameWithOwner: string;
    url: string;
  };
}

export interface GraphQLBlockedByConnection {
  totalCount: number;
  pageInfo: GraphQLPageInfo;
  nodes: GraphQLBlockedByIssue[];
}

export interface GitHubRestIssue {
  id?: number;
  number: number;
  node_id?: string;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url?: string;
  repository_url?: string;
  labels: Array<string | { name: string; color: string }>;
  assignee?: { login: string } | null;
  pull_request?: unknown;
}

export interface GitHubRestRepository {
  id?: number;
  node_id?: string;
  full_name: string;
  url?: string;
  html_url?: string;
  open_issues_count?: number;
}

export interface GitHubNotification {
  id: string;
  reason: string;
  subject: {
    title: string;
    type: string;
    url?: string | null;
  };
  repository: {
    full_name: string;
  };
  updated_at: string;
  unread: boolean;
  last_read_at?: string | null;
}

// ─── GitHub Projects V2 Types ───────────────────────────────────────────────

export interface GitHubProjectV2 {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  items: {
    totalCount: number;
  };
}

export interface GitHubProjectV2Item {
  id: string;
  type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE';
  fieldValues: {
    nodes: Array<{
      __typename: string;
      field?: { name: string };
      name?: string; // SingleSelectFieldValue
      text?: string; // TextFieldValue
      date?: string; // DateFieldValue
    }>;
  };
  content: {
    __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
    id?: string;
    number?: number;
    title?: string;
    body?: string;
    state?: string;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string | null;
    url?: string;
    labels?: { nodes: Array<{ name: string; color: string }> };
    assignees?: { nodes: Array<{ login: string }> };
    repository?: { nameWithOwner: string };
  } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GraphQLAnyResponse = { data?: any; errors?: Array<{ message: string }> };

export interface GitHubClient {
  readonly origin: TrustedGitHubOrigin;
  restFetch(path: string, options?: RequestInit): Promise<Response>;
  graphqlFetch(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<GraphQLResponse>;
  graphqlFetchAny(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<GraphQLAnyResponse>;
}

export function createGitHubClient(
  token: string,
  configuredOrigin = DEFAULT_GITHUB_API_ORIGIN,
): GitHubClient {
  const origin = normalizeGitHubOrigin(configuredOrigin);

  async function restFetch(path: string, options?: RequestInit): Promise<Response> {
    const url = resolveRestUrl(path, origin);
    return withRetry(
      () =>
        fetchWithTimeout(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...(options?.headers || {}),
          },
        }),
      `REST ${path}`,
      options?.signal,
    );
  }

  async function graphqlFetch(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<GraphQLResponse> {
    const res = await withRetry(
      () =>
        fetchWithTimeout(origin.graphqlUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: options?.signal,
        }),
      'GraphQL',
      options?.signal,
    );
    if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
    return res.json();
  }

  return {
    origin,
    restFetch,
    graphqlFetch,
    graphqlFetchAny: graphqlFetch as (
      query: string,
      variables?: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => Promise<GraphQLAnyResponse>,
  };
}

function resolveRestUrl(path: string, origin: TrustedGitHubOrigin): string {
  if (!path.startsWith('http://') && !path.startsWith('https://')) {
    return `${origin.restBaseUrl}${path}`;
  }
  const parsed = new URL(path);
  const requestedOrigin = normalizeGitHubOrigin(parsed.origin);
  if (requestedOrigin.hostKey !== origin.hostKey) {
    throw new Error('GitHub pagination URL does not match the configured host');
  }
  return parsed.toString();
}
