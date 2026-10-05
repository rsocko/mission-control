import 'server-only';

import {
  createGitHubClient,
  GitHubHttpError,
  type GitHubClient,
} from '@/lib/connectors/github-issues/github-client';
import { canonicalJson, redactForPersistence } from './policy';
import { ExternalAgentError } from './errors';
import { resolveGitHubAgentCredential, type ExternalAgent } from './registry';
import type {
  AgentDispatchResult,
  AgentDispatchStatus,
} from './contracts';
import type {
  ExternalAgentTransportAdapter,
  TransportDispatch,
  TransportDispatchResult,
} from './transports';

const API_VERSION = '2026-03-10';
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEDUPLICATION_SCAN_LIMIT = 20;

export const GITHUB_AGENT_TASK_STATES = [
  'queued',
  'in_progress',
  'idle',
  'waiting_for_user',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
] as const;

export type GitHubAgentTaskState = (typeof GITHUB_AGENT_TASK_STATES)[number];

interface GitHubAgentTaskArtifact {
  provider?: string;
  type?: string;
  data?: {
    id?: number;
    global_id?: string;
    head_ref?: string;
    base_ref?: string;
  };
}

export interface GitHubAgentTask {
  id: string;
  url?: string;
  html_url?: string;
  name?: string;
  state: GitHubAgentTaskState;
  artifacts?: GitHubAgentTaskArtifact[];
  sessions?: Array<{
    prompt?: string;
    head_ref?: string;
    base_ref?: string;
    model?: string;
    error?: { message?: string };
  }>;
  created_at?: string;
  updated_at?: string;
}

interface CopilotTaskTarget {
  owner: string;
  repository: string;
  fullName: string;
  baseRef: string;
  model?: string;
  createPullRequest: boolean;
}

interface PullRequestReference {
  url?: string;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { full_name?: string } };
}

function parsePullRequestReference(value: unknown): PullRequestReference | undefined {
  const node = record(value);
  if (node?.__typename !== 'PullRequest') return undefined;
  const headRepository = record(node.headRepository);
  const baseRepository = record(node.baseRepository);
  return {
    url: text(node.url),
    head: {
      ref: text(node.headRefName),
      sha: text(node.headRefOid),
      ...(headRepository
        ? { repo: { full_name: text(headRepository.nameWithOwner) } }
        : {}),
    },
    base: {
      ref: text(node.baseRefName),
      ...(baseRepository
        ? { repo: { full_name: text(baseRepository.nameWithOwner) } }
        : {}),
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function apiHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...extra,
  };
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ExternalAgentError(
      'GitHub Agent Tasks response exceeded the size limit',
      'PAYLOAD_TOO_LARGE',
      502,
    );
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ExternalAgentError(
        'GitHub Agent Tasks response exceeded the size limit',
        'PAYLOAD_TOO_LARGE',
        502,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new ExternalAgentError(
      'GitHub Agent Tasks returned an invalid JSON response',
      'PROVIDER_RESPONSE_INVALID',
      502,
    );
  }
}

async function withProviderErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExternalAgentError) throw error;
    if (error instanceof GitHubHttpError) {
      if (
        error.status === 429
        || (error.status === 403 && error.headers['x-ratelimit-remaining'] === '0')
      ) {
        throw new ExternalAgentError(
          `GitHub rate-limited the Agent tasks request.${
            error.retryAfterMs === null
              ? ''
              : ` Retry after ${Math.ceil(error.retryAfterMs / 1_000)} seconds.`
          }`,
          'RATE_LIMITED',
          429,
        );
      }
      if (error.status === 401) {
        throw new ExternalAgentError(
          'GitHub rejected the user credential; reconnect with a PAT, OAuth token, or GitHub App user token',
          'CREDENTIAL_INVALID',
          401,
        );
      }
      if (error.status === 403) {
        throw new ExternalAgentError(
          'GitHub denied the Agent tasks request; verify Copilot entitlement, repository enablement, and Agent tasks permission',
          'GITHUB_PERMISSION_DENIED',
          403,
        );
      }
      throw new ExternalAgentError(
        `GitHub Agent Tasks request failed with HTTP ${error.status}`,
        'GITHUB_PROVIDER_ERROR',
        502,
      );
    }
    throw new ExternalAgentError(
      error instanceof Error && error.message.toLowerCase().includes('timed out')
        ? 'GitHub Agent Tasks request timed out'
        : 'GitHub Agent Tasks request failed',
      'TRANSPORT_ERROR',
      502,
    );
  }
}

function retryDetail(response: Response): string {
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  if (retryAfter) return ` Retry after ${retryAfter} seconds.`;
  if (reset && /^\d+$/.test(reset)) {
    return ` Retry after ${new Date(Number(reset) * 1_000).toISOString()}.`;
  }
  return '';
}

async function assertGitHubResponse(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = await readBoundedJson(response);
  if (response.ok) return body;
  const providerMessage = typeof body.message === 'string' ? ` ${body.message}` : '';
  if (
    response.status === 429
    || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  ) {
    throw new ExternalAgentError(
      `GitHub rate-limited ${operation}.${retryDetail(response)}`,
      'RATE_LIMITED',
      429,
    );
  }
  if (response.status === 401) {
    throw new ExternalAgentError(
      `GitHub rejected the user credential while ${operation}; reconnect with a PAT, OAuth token, or GitHub App user token`,
      'CREDENTIAL_INVALID',
      401,
    );
  }
  if (response.status === 403) {
    throw new ExternalAgentError(
      `GitHub denied ${operation}; Copilot Business or Enterprise entitlement and Agent tasks repository read/write permission are required.${providerMessage}`,
      'GITHUB_PERMISSION_DENIED',
      403,
    );
  }
  if (response.status === 404) {
    throw new ExternalAgentError(
      `GitHub could not find the exact repository or resource while ${operation}`,
      'GITHUB_RESOURCE_NOT_FOUND',
      404,
    );
  }
  if (response.status === 422 || response.status === 400) {
    throw new ExternalAgentError(
      `GitHub rejected ${operation}.${providerMessage}`,
      'GITHUB_VALIDATION_FAILED',
      422,
    );
  }
  throw new ExternalAgentError(
    `GitHub failed ${operation} with HTTP ${response.status}.${providerMessage}`,
    'GITHUB_PROVIDER_ERROR',
    502,
  );
}

function parseTask(value: Record<string, unknown>): GitHubAgentTask {
  const state = value.state;
  if (
    typeof value.id !== 'string'
    || typeof state !== 'string'
    || !GITHUB_AGENT_TASK_STATES.includes(state as GitHubAgentTaskState)
  ) {
    throw new ExternalAgentError(
      'GitHub Agent Tasks response is missing a valid task ID or state',
      'PROVIDER_RESPONSE_INVALID',
      502,
    );
  }
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((entry): GitHubAgentTaskArtifact[] => {
      const artifact = record(entry);
      if (!artifact) return [];
      const data = record(artifact.data);
      return [{
        provider: text(artifact.provider),
        type: text(artifact.type),
        ...(data
          ? {
            data: {
              ...(typeof data.id === 'number' ? { id: data.id } : {}),
              ...(text(data.global_id) ? { global_id: text(data.global_id) } : {}),
              ...(text(data.head_ref) ? { head_ref: text(data.head_ref) } : {}),
              ...(text(data.base_ref) ? { base_ref: text(data.base_ref) } : {}),
            },
          }
          : {}),
      }];
    })
    : undefined;
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.flatMap((entry): NonNullable<GitHubAgentTask['sessions']> => {
      const session = record(entry);
      if (!session) return [];
      const error = record(session.error);
      return [{
        prompt: text(session.prompt),
        head_ref: text(session.head_ref),
        base_ref: text(session.base_ref),
        model: text(session.model),
        ...(error ? { error: { message: text(error.message) } } : {}),
      }];
    })
    : undefined;
  return {
    id: value.id,
    state: state as GitHubAgentTaskState,
    url: text(value.url),
    html_url: text(value.html_url),
    name: text(value.name),
    artifacts,
    sessions,
    created_at: text(value.created_at),
    updated_at: text(value.updated_at),
  };
}

export function mapGitHubAgentTaskState(
  state: GitHubAgentTaskState,
): Extract<
  AgentDispatchStatus,
  | 'queued'
  | 'in_progress'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
> {
  if (state === 'idle') return 'in_progress';
  return state;
}

function targetFromPayload(payload: Record<string, unknown>): CopilotTaskTarget {
  const repository = payload.repository;
  const execution = payload.execution;
  if (
    !repository
    || typeof repository !== 'object'
    || Array.isArray(repository)
    || !execution
    || typeof execution !== 'object'
    || Array.isArray(execution)
  ) {
    throw new ExternalAgentError(
      'Copilot cloud dispatch requires reviewed repository and execution details',
      'VALIDATION_ERROR',
      422,
    );
  }
  const fullName = (repository as Record<string, unknown>).fullName;
  if (typeof fullName !== 'string') {
    throw new ExternalAgentError(
      'Copilot cloud dispatch requires an exact owner/repository target',
      'VALIDATION_ERROR',
      422,
    );
  }
  const [owner, name, ...extra] = fullName.split('/');
  if (!owner || !name || extra.length) {
    throw new ExternalAgentError(
      'Copilot cloud repository target must use owner/repository format',
      'VALIDATION_ERROR',
      422,
    );
  }
  const detail = execution as Record<string, unknown>;
  const repositoryDetail = repository as Record<string, unknown>;
  const baseRef = detail.baseRef ?? repositoryDetail.defaultBranch;
  if (typeof baseRef !== 'string' || !baseRef) {
    throw new ExternalAgentError(
      'Copilot cloud dispatch requires a base ref',
      'VALIDATION_ERROR',
      422,
    );
  }
  return {
    owner,
    repository: name,
    fullName,
    baseRef,
    model: typeof detail.model === 'string' ? detail.model : undefined,
    createPullRequest: detail.createPullRequest === true,
  };
}

async function preflight(
  client: GitHubClient,
  target: CopilotTaskTarget,
): Promise<GitHubAgentTask[]> {
  await assertGitHubResponse(
    await client.restFetch('/user', { headers: apiHeaders() }),
    'validating the user-to-server credential',
  );
  const repository = await assertGitHubResponse(
    await client.restFetch(
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`,
      { headers: apiHeaders() },
    ),
    'validating repository access',
  );
  if (
    typeof repository.full_name !== 'string'
    || repository.full_name.toLowerCase() !== target.fullName.toLowerCase()
  ) {
    throw new ExternalAgentError(
      'GitHub repository identity does not match the confirmed dispatch target',
      'REPOSITORY_IDENTITY_MISMATCH',
      409,
    );
  }
  await assertGitHubResponse(
    await client.restFetch(
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/git/ref/heads/${encodeURIComponent(target.baseRef)}`,
      { headers: apiHeaders() },
    ),
    'validating the confirmed base ref',
  );
  const eligibility = await client.graphqlFetchAny(
    `query CopilotDispatchEligibility($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes { login }
        }
      }
    }`,
    { owner: target.owner, name: target.repository },
  );
  const actors = eligibility.data?.repository?.suggestedActors?.nodes;
  if (
    !Array.isArray(actors)
    || !actors.some((actor: unknown) =>
      actor
      && typeof actor === 'object'
      && 'login' in actor
      && String(actor.login).replace(/\[bot\]$/, '') === 'copilot-swe-agent')
  ) {
    throw new ExternalAgentError(
      'Copilot cloud agent is not enabled or entitled for the confirmed repository',
      'COPILOT_NOT_AVAILABLE',
      403,
    );
  }
  const listed = await assertGitHubResponse(
    await client.restFetch(
      `/agents/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/tasks?per_page=${DEDUPLICATION_SCAN_LIMIT}&sort=created_at&direction=desc`,
      { headers: apiHeaders() },
    ),
    'validating Agent tasks read permission',
  );
  return Array.isArray(listed.tasks)
    ? listed.tasks
      .filter((task): task is Record<string, unknown> =>
        Boolean(task && typeof task === 'object' && !Array.isArray(task)))
      .map(parseTask)
    : [];
}

function taskPrompt(dispatch: TransportDispatch): string {
  return `Mission Control dispatch ${dispatch.dispatchId}\n\n${canonicalJson(dispatch.payload)}`;
}

async function findExistingTask(
  client: GitHubClient,
  target: CopilotTaskTarget,
  tasks: GitHubAgentTask[],
  prompt: string,
): Promise<GitHubAgentTask | null> {
  for (const task of tasks) {
    const detail = parseTask(await assertGitHubResponse(
      await client.restFetch(
        `/agents/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/tasks/${encodeURIComponent(task.id)}`,
        { headers: apiHeaders() },
      ),
      'checking an existing Agent task',
    ));
    if (detail.sessions?.some((session) => session.prompt === prompt)) return detail;
  }
  return null;
}

async function pullRequestReference(
  client: GitHubClient,
  target: CopilotTaskTarget,
  task: GitHubAgentTask,
): Promise<{
  codeChange?: AgentDispatchResult['codeChange'];
  warning?: string;
}> {
  const branch = task.artifacts?.find((artifact) => artifact.type === 'branch')?.data;
  const pull = task.artifacts?.find((artifact) => artifact.type === 'pull')?.data;
  const session = task.sessions?.at(-1);
  const reportedHeadRef = branch?.head_ref ?? session?.head_ref;
  const reportedBaseRef = branch?.base_ref ?? session?.base_ref ?? target.baseRef;
  let pullRequest: PullRequestReference | undefined;
  let warning: string | undefined;
  if (pull?.global_id) {
    try {
      const response = await client.graphqlFetchAny(
        `query AgentTaskPullRequest($id: ID!) {
          node(id: $id) {
            __typename
            ... on PullRequest {
              url
              headRefName
              headRefOid
              baseRefName
              headRepository { nameWithOwner }
              baseRepository { nameWithOwner }
            }
          }
        }`,
        { id: pull.global_id },
      );
      const resolvedPullRequest = parsePullRequestReference(response.data?.node);
      if (response.errors?.length || !resolvedPullRequest) {
        warning = 'GitHub reported a pull request output, but its details are unavailable.';
      } else {
        pullRequest = resolvedPullRequest;
      }
    } catch {
      warning = 'GitHub reported a pull request output, but its details could not be loaded.';
    }
  }
  if (pull && !pullRequest && reportedHeadRef) {
    try {
      const [owner, name] = target.fullName.split('/');
      const response = await client.graphqlFetchAny(
        `query AgentTaskPullRequestByBranch(
          $owner: String!,
          $name: String!,
          $headRef: String!,
          $baseRef: String!
        ) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              first: 2,
              headRefName: $headRef,
              baseRefName: $baseRef,
              states: [OPEN, CLOSED, MERGED]
            ) {
              nodes {
                __typename
                url
                headRefName
                headRefOid
                baseRefName
                headRepository { nameWithOwner }
                baseRepository { nameWithOwner }
              }
            }
          }
        }`,
        {
          owner,
          name,
          headRef: reportedHeadRef,
          baseRef: reportedBaseRef,
        },
      );
      const repository = record(response.data?.repository);
      const pullRequests = record(repository?.pullRequests);
      const nodes = Array.isArray(pullRequests?.nodes) ? pullRequests.nodes : [];
      const matches = nodes
        .map(parsePullRequestReference)
        .filter((entry): entry is PullRequestReference => Boolean(entry));
      if (!response.errors?.length && matches.length === 1) {
        pullRequest = matches[0];
        warning = undefined;
      } else if (!warning) {
        warning = 'GitHub reported a pull request output, but its details are unavailable.';
      }
    } catch {
      if (!warning) {
        warning = 'GitHub reported a pull request output, but its details could not be loaded.';
      }
    }
  } else if (pull && !pullRequest) {
    warning = 'GitHub reported a pull request output without a resolvable global ID.';
  }
  if (pullRequest) {
    if (
      pullRequest.base?.repo?.full_name
      && pullRequest.base.repo.full_name.toLowerCase() !== target.fullName.toLowerCase()
    ) {
      throw new ExternalAgentError(
        'GitHub returned a pull request from a repository other than the confirmed target',
        'REPOSITORY_IDENTITY_MISMATCH',
        409,
      );
    }
  }
  const branchRef = pullRequest?.head?.ref ?? reportedHeadRef;
  const baseRef = pullRequest?.base?.ref ?? reportedBaseRef;
  return {
    ...((branchRef || pullRequest?.url)
      ? {
        codeChange: {
          repository: target.fullName,
          baseRef,
          branchRef,
          commitSha: pullRequest?.head?.sha,
          pullRequestUrl: pullRequest?.url,
        },
      }
      : {}),
    ...(warning ? { warning } : {}),
  };
}

function providerDetail(
  task: GitHubAgentTask,
  outputWarning?: string,
): Record<string, unknown> {
  const session = task.sessions?.at(-1);
  return redactForPersistence({
    state: task.state,
    taskUrl: task.html_url,
    apiUrl: task.url,
    name: task.name,
    model: session?.model,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    artifacts: task.artifacts,
    outputWarning,
  }, { maxBytes: 128 * 1024 }) as Record<string, unknown>;
}

async function transportResult(
  client: GitHubClient,
  target: CopilotTaskTarget,
  task: GitHubAgentTask,
): Promise<TransportDispatchResult> {
  const status = mapGitHubAgentTaskState(task.state);
  const output = await pullRequestReference(client, target, task);
  const errorMessage = task.sessions
    ?.map((session) => session.error?.message)
    .find((message): message is string => Boolean(message));
  return {
    status,
    providerTaskId: task.id,
    providerState: task.state,
    providerDetail: providerDetail(task, output.warning),
    ...(errorMessage ? { errorMessage } : {}),
    ...(status === 'completed'
      ? {
        result: {
          summary: task.name
            ? `GitHub Copilot completed "${task.name}"`
            : 'GitHub Copilot completed the Agent task',
          ...(output.codeChange ? { codeChange: output.codeChange } : {}),
        },
      }
      : {}),
  };
}

async function createClient(agent: ExternalAgent, fetcher: typeof fetch) {
  if (!agent.endpoint) {
    throw new ExternalAgentError(
      'Copilot cloud agent API origin is missing',
      'TRANSPORT_INVALID',
      500,
    );
  }
  const credential = await resolveGitHubAgentCredential(agent);
  return createGitHubClient(credential, agent.endpoint, fetcher);
}

export async function getCopilotCloudTask(
  agent: ExternalAgent,
  repository: string,
  baseRef: string,
  providerTaskId: string,
  fetcher: typeof fetch = fetch,
): Promise<TransportDispatchResult> {
  return withProviderErrors(async () => {
    const client = await createClient(agent, fetcher);
    const target = targetFromPayload({
      repository: { fullName: repository, defaultBranch: baseRef },
      execution: { baseRef, createPullRequest: false },
    });
    const task = parseTask(await assertGitHubResponse(
      await client.restFetch(
        `/agents/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/tasks/${encodeURIComponent(providerTaskId)}`,
        { headers: apiHeaders() },
      ),
      'reconciling the Agent task',
    ));
    return transportResult(client, target, task);
  });
}

export function createCopilotCloudTransport(
  fetcher: typeof fetch = fetch,
): ExternalAgentTransportAdapter {
  return {
    kind: 'push',
    async dispatch(agent, dispatch) {
      return withProviderErrors(async () => {
        const client = await createClient(agent, fetcher);
        const target = targetFromPayload(dispatch.payload);
        const prompt = taskPrompt(dispatch);
        const listedTasks = await preflight(client, target);
        const existing = await findExistingTask(client, target, listedTasks, prompt);
        if (existing) return transportResult(client, target, existing);
        const body = {
          prompt,
          base_ref: target.baseRef,
          ...(target.model ? { model: target.model } : {}),
          create_pull_request: target.createPullRequest,
        };
        const task = parseTask(await assertGitHubResponse(
          await client.restFetch(
            `/agents/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/tasks`,
            {
              method: 'POST',
              headers: apiHeaders({
                'Idempotency-Key': dispatch.dispatchId,
                'X-MC-Dispatch-Id': dispatch.dispatchId,
              }),
              body: JSON.stringify(body),
            },
          ),
          'starting the Agent task',
        ));
        return transportResult(client, target, task);
      });
    },
  };
}
