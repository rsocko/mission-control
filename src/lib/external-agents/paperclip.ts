import 'server-only';

import type {
  AgentDispatchResult,
  AgentDispatchStatus,
  PaperclipProviderConfig,
} from './contracts';
import { ExternalAgentError } from './errors';
import { canonicalJson, redactForPersistence } from './policy';

const RESPONSE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface PaperclipConnection {
  endpoint: string;
  credential: string | null;
  config: PaperclipProviderConfig;
  fetcher?: typeof fetch;
}

interface PaperclipAgent {
  id: string;
  companyId: string;
  name?: string;
  status?: string;
  adapterType?: string;
}

interface PaperclipWorkProduct {
  type?: string;
  provider?: string;
  title?: string;
  url?: string | null;
  status?: string;
  healthStatus?: string;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PaperclipIssue {
  id: string;
  identifier?: string;
  companyId?: string;
  title?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string | null;
  executionRunId?: string | null;
  blockedBy?: Array<Record<string, unknown>>;
  blockerAttention?: Record<string, unknown> | null;
  executionBlocker?: Record<string, unknown> | null;
  workProducts?: PaperclipWorkProduct[];
  updatedAt?: string;
  deduplicated?: boolean;
  deduplicationReason?: string;
}

interface PaperclipRun {
  id: string;
  agentId?: string;
  agentName?: string;
  adapterType?: string;
  status?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  errorCode?: string | null;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  nextAction?: string | null;
  livenessState?: string | null;
  livenessReason?: string | null;
}

export interface PaperclipDispatchInput {
  dispatchId: string;
  payload: Record<string, unknown>;
}

export interface PaperclipProviderState {
  status: Extract<
    AgentDispatchStatus,
    | 'queued'
    | 'in_progress'
    | 'waiting_for_user'
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
  >;
  providerTaskId: string;
  providerState: string;
  providerDetail: Record<string, unknown>;
  result?: AgentDispatchResult;
  errorMessage?: string;
}

function endpointUrl(connection: PaperclipConnection, path: string) {
  return new URL(`/api${path}`, connection.endpoint).toString();
}

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    throw new ExternalAgentError(
      'Paperclip response exceeded the size limit',
      'PAYLOAD_TOO_LARGE',
      502,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) {
    throw new ExternalAgentError(
      'Paperclip response exceeded the size limit',
      'PAYLOAD_TOO_LARGE',
      502,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ExternalAgentError(
      'Paperclip returned an invalid JSON response',
      'PROVIDER_RESPONSE_INVALID',
      502,
    );
  }
}

async function request<T>(
  connection: PaperclipConnection,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (connection.fetcher ?? fetch)(endpointUrl(connection, path), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(connection.credential
          ? { Authorization: `Bearer ${connection.credential}` }
          : {}),
      },
      ...(options.body === undefined ? {} : { body: canonicalJson(options.body) }),
      signal: controller.signal,
    });
    const body = await readBounded(response);
    if (!response.ok) {
      const providerMessage = body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
      const code = response.status === 401
        ? 'CREDENTIAL_INVALID'
        : response.status === 403
          ? 'PROVIDER_FORBIDDEN'
          : response.status === 404
            ? 'PROVIDER_NOT_FOUND'
            : response.status === 409
              ? 'PROVIDER_CONFLICT'
              : response.status === 422
                ? 'PROVIDER_STATE_REJECTED'
                : 'PROVIDER_ERROR';
      throw new ExternalAgentError(
        `Paperclip ${options.method ?? 'GET'} ${path} failed: ${providerMessage}`,
        code,
        response.status >= 500 ? 502 : response.status,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ExternalAgentError) throw error;
    throw new ExternalAgentError(
      error instanceof Error && error.name === 'AbortError'
        ? 'Paperclip request timed out'
        : 'Paperclip request failed',
      'TRANSPORT_ERROR',
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requiredConfig(connection: PaperclipConnection) {
  if (!connection.config.companyId || !connection.config.assigneeAgentId) {
    throw new ExternalAgentError(
      'Paperclip company and assignee configuration is missing',
      'TRANSPORT_INVALID',
      500,
    );
  }
  return connection.config;
}

function assertIssueScope(
  connection: PaperclipConnection,
  issue: PaperclipIssue,
  expectedIssueId?: string,
) {
  const config = requiredConfig(connection);
  if (
    !issue.id
    || (expectedIssueId && issue.id !== expectedIssueId)
    || issue.companyId !== config.companyId
  ) {
    throw new ExternalAgentError(
      'Paperclip returned an issue outside the configured company or correlation',
      'PROVIDER_SCOPE_MISMATCH',
      502,
    );
  }
}

export async function validatePaperclipConnection(connection: PaperclipConnection) {
  const config = requiredConfig(connection);
  const health = await request<Record<string, unknown>>(connection, '/health');
  if (health.status !== 'ok') {
    throw new ExternalAgentError(
      `Paperclip is not ready (status: ${String(health.status ?? 'unknown')})`,
      'PROVIDER_UNAVAILABLE',
      503,
    );
  }
  const agent = await request<PaperclipAgent>(
    connection,
    `/agents/${encodeURIComponent(config.assigneeAgentId)}`,
  );
  if (agent.id !== config.assigneeAgentId || agent.companyId !== config.companyId) {
    throw new ExternalAgentError(
      'Paperclip assignee is not in the configured company',
      'PROVIDER_SCOPE_MISMATCH',
      422,
    );
  }
  if (
    config.requiredAdapterType
    && agent.adapterType !== config.requiredAdapterType
  ) {
    throw new ExternalAgentError(
      `Paperclip assignee uses adapter ${agent.adapterType ?? 'unknown'}, not ${config.requiredAdapterType}`,
      'PROVIDER_RUNTIME_MISMATCH',
      422,
    );
  }
  return {
    health: {
      status: health.status,
      version: health.version ?? health.serverVersion ?? null,
      deploymentMode: health.deploymentMode ?? null,
    },
    agent: {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name ?? null,
      status: agent.status ?? null,
      adapterType: agent.adapterType ?? null,
    },
  };
}

function titleFromPayload(payload: Record<string, unknown>) {
  const instruction = typeof payload.instruction === 'string'
    ? payload.instruction.trim()
    : 'Mission Control dispatch';
  return instruction.split(/\r?\n/, 1)[0].slice(0, 240) || 'Mission Control dispatch';
}

function priorityFromPayload(payload: Record<string, unknown>) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const priorities = tasks
    .map((task) => task && typeof task === 'object'
      ? (task as Record<string, unknown>).priority
      : undefined);
  if (priorities.includes('critical')) return 'critical';
  if (priorities.includes('high')) return 'high';
  if (priorities.length > 0 && priorities.every((priority) => priority === 'low')) {
    return 'low';
  }
  return 'medium';
}

function issueDescription(input: PaperclipDispatchInput) {
  return [
    'Mission Control delegated outcome.',
    '',
    `Correlation: \`${input.dispatchId}\``,
    '',
    '```json',
    canonicalJson(input.payload),
    '```',
  ].join('\n');
}

export async function dispatchToPaperclip(
  connection: PaperclipConnection,
  input: PaperclipDispatchInput,
): Promise<PaperclipProviderState> {
  const config = requiredConfig(connection);
  const issue = await request<PaperclipIssue>(
    connection,
    `/companies/${encodeURIComponent(config.companyId)}/issues`,
    {
      method: 'POST',
      body: {
        title: titleFromPayload(input.payload),
        description: issueDescription(input),
        status: 'todo',
        priority: priorityFromPayload(input.payload),
        assigneeAgentId: config.assigneeAgentId,
        ...(config.projectId ? { projectId: config.projectId } : {}),
        idempotencyKey: `mission-control:${input.dispatchId}`,
        allowDuplicate: false,
      },
    },
  );
  if (!issue.id) {
    throw new ExternalAgentError(
      'Paperclip issue creation did not return an issue ID',
      'PROVIDER_RESPONSE_INVALID',
      502,
    );
  }
  assertIssueScope(connection, issue);
  if (issue.assigneeAgentId !== config.assigneeAgentId) {
    throw new ExternalAgentError(
      'Paperclip created the issue with an unexpected assignee',
      'PROVIDER_SCOPE_MISMATCH',
      502,
    );
  }
  return stateFromIssue(issue, null, []);
}

function mapIssueStatus(issueStatus: string | undefined, runStatus?: string) {
  if (issueStatus === 'done') return 'completed' as const;
  if (issueStatus === 'cancelled' || runStatus === 'cancelled') return 'cancelled' as const;
  if (
    runStatus === 'failed'
    || runStatus === 'timed_out'
    || issueStatus === 'failed'
  ) {
    return runStatus === 'timed_out' ? 'timed_out' as const : 'failed' as const;
  }
  if (
    issueStatus === 'blocked'
    || issueStatus === 'in_review'
  ) {
    return 'waiting_for_user' as const;
  }
  if (issueStatus === 'in_progress' || runStatus === 'running') {
    return 'in_progress' as const;
  }
  return 'queued' as const;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function resultFromWorkProducts(
  issue: PaperclipIssue,
  workProducts: PaperclipWorkProduct[],
): AgentDispatchResult {
  const pullRequest = workProducts.find((item) =>
    item.type === 'pull_request' && stringValue(item.url));
  const branch = workProducts.find((item) => item.type === 'branch');
  const commit = workProducts.find((item) => item.type === 'commit');
  const prMetadata = pullRequest?.metadata ?? {};
  const branchMetadata = branch?.metadata ?? {};
  const commitMetadata = commit?.metadata ?? {};
  const repository = stringValue(prMetadata.repo)
    ?? stringValue(branchMetadata.repo)
    ?? stringValue(commitMetadata.repo);
  const artifacts = workProducts
    .filter((item) => !['pull_request', 'branch', 'commit'].includes(item.type ?? ''))
    .slice(0, 100)
    .map((item) => ({
      name: item.title ?? item.type ?? 'Paperclip work product',
      ...(item.status ? { status: item.status } : {}),
      ...(item.url ? { url: item.url } : {}),
    }));
  return {
    summary: `Paperclip issue ${issue.identifier ?? issue.id} completed`,
    ...(repository
      ? {
        codeChange: {
          repository,
          baseRef: stringValue(prMetadata.baseRef),
          branchRef: stringValue(prMetadata.headRef)
            ?? stringValue(branchMetadata.branch),
          commitSha: stringValue(commitMetadata.sha),
          pullRequestUrl: pullRequest?.url ?? undefined,
          ...(artifacts.length ? { artifacts } : {}),
        },
      }
      : artifacts.length
        ? {
          providerDetail: { artifacts },
        }
        : {}),
  };
}

function stateFromIssue(
  issue: PaperclipIssue,
  run: PaperclipRun | null,
  approvals: Array<Record<string, unknown>>,
): PaperclipProviderState {
  const status = mapIssueStatus(issue.status, run?.status);
  const workProducts = Array.isArray(issue.workProducts) ? issue.workProducts : [];
  const detail = redactForPersistence({
    companyId: issue.companyId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueStatus: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    issueUpdatedAt: issue.updatedAt,
    runId: run?.id ?? issue.executionRunId ?? null,
    runStatus: run?.status ?? null,
    executor: run
      ? {
        agentId: run.agentId ?? issue.assigneeAgentId ?? null,
        name: run.agentName ?? null,
        adapterType: run.adapterType ?? null,
      }
      : null,
    progress: run
      ? {
        message: run.currentStatusMessage ?? run.lastAssistantSnippet ?? null,
        updatedAt: run.currentStatusUpdatedAt ?? null,
        currentToolName: run.currentToolName ?? null,
        nextAction: run.nextAction ?? null,
        livenessState: run.livenessState ?? null,
        livenessReason: run.livenessReason ?? null,
      }
      : null,
    blockers: {
      issues: issue.blockedBy ?? [],
      attention: issue.blockerAttention ?? null,
      execution: issue.executionBlocker ?? null,
    },
    pendingApprovals: approvals.filter((approval) => approval.status === 'pending'),
    costs: run?.usageJson ?? null,
    workProducts,
    deduplicated: issue.deduplicated ?? false,
    deduplicationReason: issue.deduplicationReason ?? null,
  }, { maxBytes: 256 * 1024 }) as Record<string, unknown>;
  return {
    status,
    providerTaskId: issue.id,
    providerState: issue.status ?? run?.status ?? 'unknown',
    providerDetail: detail,
    ...(status === 'completed'
      ? { result: resultFromWorkProducts(issue, workProducts) }
      : {}),
    ...((status === 'failed' || status === 'timed_out') && run?.error
      ? { errorMessage: run.error }
      : {}),
  };
}

export async function getPaperclipState(
  connection: PaperclipConnection,
  issueId: string,
): Promise<PaperclipProviderState> {
  const issue = await request<PaperclipIssue>(
    connection,
    `/issues/${encodeURIComponent(issueId)}`,
  );
  assertIssueScope(connection, issue, issueId);
  let run: PaperclipRun | null = null;
  if (issue.executionRunId) {
    run = await request<PaperclipRun>(
      connection,
      `/heartbeat-runs/${encodeURIComponent(issue.executionRunId)}`,
    );
  } else {
    run = await request<PaperclipRun | null>(
      connection,
      `/issues/${encodeURIComponent(issueId)}/active-run`,
    );
  }
  const approvalResponse = await request<unknown>(
    connection,
    `/issues/${encodeURIComponent(issueId)}/approvals`,
  );
  if (!Array.isArray(approvalResponse)) {
    throw new ExternalAgentError(
      'Paperclip returned an invalid approvals response',
      'PROVIDER_RESPONSE_INVALID',
      502,
    );
  }
  const approvals = approvalResponse.filter(
    (approval): approval is Record<string, unknown> =>
      Boolean(approval) && typeof approval === 'object' && !Array.isArray(approval),
  );
  return stateFromIssue(issue, run, approvals);
}

export async function cancelPaperclipIssue(
  connection: PaperclipConnection,
  issueId: string,
): Promise<PaperclipProviderState> {
  const current = await getPaperclipState(connection, issueId);
  if (current.status === 'completed') {
    throw new ExternalAgentError(
      'Paperclip issue already completed and cannot be cancelled',
      'PROVIDER_STATE_REJECTED',
      409,
    );
  }
  if (current.status === 'cancelled') return current;
  const runId = stringValue(current.providerDetail.runId);
  if (runId) {
    await request<PaperclipRun>(
      connection,
      `/heartbeat-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    );
  }
  await request<PaperclipIssue>(
    connection,
    `/issues/${encodeURIComponent(issueId)}`,
    {
      method: 'PATCH',
      body: {
        status: 'cancelled',
        comment: 'Cancelled by the correlated Mission Control dispatch.',
      },
    },
  );
  return getPaperclipState(connection, issueId);
}
