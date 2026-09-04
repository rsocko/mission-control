import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentDataClassification,
  AgentDispatchRecord,
  AgentDispatchResult,
  AgentDispatchScope,
  AgentResultReference,
} from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  assertClassificationAllowed,
  hashCanonical,
  hashSecret,
  redactForPersistence,
  resolveDispatchClassification,
  selectAllowedPayloadFields,
} from './policy';
import { getExternalAgent, type ExternalAgent } from './registry';
import {
  createTransportResolver,
  type TransportDispatchResult,
  type TransportResolver,
} from './transports';

const ACTION_CAPABILITIES = {
  analyze_code: 'canAnalyzeCode',
  write_code: 'canWriteCode',
  run_commands: 'canRunCommands',
  push: 'canPush',
  create_pull_request: 'canCreatePullRequest',
  propose_tasks: 'canProposeTasks',
  propose_phases: 'canProposePhases',
} as const;

export interface DispatchPreviewInput {
  agentId: string;
  instruction: string;
  scope?: AgentDispatchScope;
  dataClassification?: AgentDataClassification;
  allowedActions?: string[];
  idempotencyKey: string;
  callbackBaseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface DispatchResultInput {
  status?: 'queued' | 'in_progress' | 'waiting_for_user' | 'completed' | 'failed';
  result?: AgentDispatchResult;
  summary?: string;
  tasks?: Array<Record<string, unknown>>;
  phases?: Array<Record<string, unknown>>;
  modifications?: Array<Record<string, unknown>>;
  suggestedClosures?: Array<Record<string, unknown>>;
  codeChange?: AgentDispatchResult['codeChange'];
  providerTaskId?: string;
  providerState?: string;
  providerDetail?: Record<string, unknown>;
  errorMessage?: string;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ExternalAgentError(
      `Value must be an integer between 1 and ${maximum}`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExternalAgentError(`${field} is required`, 'VALIDATION_ERROR', 422);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ExternalAgentError(
      `${field} exceeds ${maxLength} characters`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return normalized;
}

function validateRepository(value: string | undefined) {
  if (value === undefined) return undefined;
  const repository = requiredText(value, 'scope.repository', 255);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ExternalAgentError(
      'scope.repository must use owner/repository format',
      'VALIDATION_ERROR',
      422,
    );
  }
  return repository;
}

function normalizeScope(value: AgentDispatchScope | undefined): AgentDispatchScope {
  const scope = value ?? {};
  const taskIds = scope.taskIds
    ? [...new Set(scope.taskIds.map((id) => requiredText(id, 'scope.taskIds[]', 255)))]
    : undefined;
  if (taskIds && taskIds.length > 500) {
    throw new ExternalAgentError('scope.taskIds cannot exceed 500 items', 'VALIDATION_ERROR', 422);
  }
  return {
    projectId: scope.projectId
      ? requiredText(scope.projectId, 'scope.projectId', 255)
      : undefined,
    taskIds,
    repository: validateRepository(scope.repository),
    defaultBranch: scope.defaultBranch
      ? requiredText(scope.defaultBranch, 'scope.defaultBranch', 255)
      : undefined,
    baseRef: scope.baseRef ? requiredText(scope.baseRef, 'scope.baseRef', 255) : undefined,
    createPullRequest: scope.createPullRequest === true,
  };
}

function validateAllowedActions(agent: ExternalAgent, actions: string[]) {
  const unique = [...new Set(actions.map((action) =>
    requiredText(action, 'allowedActions[]', 80)))];
  for (const action of unique) {
    const capability = ACTION_CAPABILITIES[action as keyof typeof ACTION_CAPABILITIES];
    if (!capability || agent.capabilities[capability] !== true) {
      throw new ExternalAgentError(
        `Agent does not support allowed action "${action}"`,
        'CAPABILITY_MISMATCH',
        422,
      );
    }
  }
  if (
    agent.executionLocality === 'inference'
    && unique.some((action) =>
      action === 'analyze_code'
      || action === 'write_code'
      || action === 'run_commands'
      || action === 'push'
      || action === 'create_pull_request')
  ) {
    throw new ExternalAgentError(
      'Inference cannot be authorized for repository or command side effects',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  return unique;
}

function destinationFingerprint(agent: ExternalAgent) {
  return {
    type: agent.type,
    transport: agent.transport,
    executionLocality: agent.executionLocality,
    endpoint: agent.endpoint,
    authType: agent.authType,
    credentialReferenceHash: hashSecret(agent.authCredentialRef ?? ''),
    inboundWebhookId: agent.inboundWebhookId,
    capabilitiesHash: hashCanonical(agent.capabilities),
    dataPolicyHash: hashCanonical(agent.dataPolicy),
  };
}

function assertAgentEnabled(agent: ExternalAgent | null): asserts agent is ExternalAgent {
  if (!agent || agent.deletedAt) {
    throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  }
  if (!agent.enabled) {
    throw new ExternalAgentError('External agent is disabled', 'AGENT_DISABLED', 409);
  }
}

async function loadPayloadSource(
  dispatchId: string,
  agent: ExternalAgent,
  instruction: string,
  scope: AgentDispatchScope,
  classification: AgentDataClassification,
  allowedActions: string[],
  callbackBaseUrl?: string,
) {
  if (scope.repository && agent.executionLocality === 'inference') {
    throw new ExternalAgentError(
      'Inference dispatches cannot claim repository access',
      'EXECUTION_BOUNDARY_MISMATCH',
      422,
    );
  }
  if (
    (agent.type === 'copilot-cloud' || agent.type === 'copilot-sdk-workspace')
    && !scope.repository
  ) {
    throw new ExternalAgentError(
      `${agent.type} requires an explicit repository scope`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const snapshot = await (await getExternalAgentControlPersistence()).payloads.snapshot(scope);
  if (scope.projectId && !snapshot.project) {
    throw new ExternalAgentError('Scoped project not found', 'NOT_FOUND', 404);
  }
  if (scope.taskIds) {
    const found = new Set(snapshot.tasks.map(({ id }) => id));
    if ([...new Set(scope.taskIds)].some((id) => !found.has(id))) {
      throw new ExternalAgentError('One or more scoped tasks were not found', 'NOT_FOUND', 404);
    }
  }
  return {
    source: {
      instruction,
      project: snapshot.project,
      repository: scope.repository
        ? {
          fullName: scope.repository,
          defaultBranch: scope.defaultBranch ?? scope.baseRef ?? 'main',
        }
        : undefined,
      execution: {
        locality: agent.executionLocality,
        baseRef: scope.baseRef,
        createPullRequest: scope.createPullRequest,
      },
      tasks: snapshot.tasks.map(({ connectorType: _connectorType, ...task }) => task),
      phases: snapshot.phases,
      callbackUrl: callbackBaseUrl && agent.inboundWebhookId
        ? `${callbackBaseUrl.replace(/\/$/, '')}/api/inbound-webhooks/${encodeURIComponent(agent.inboundWebhookId)}/receive`
        : undefined,
      dispatchId,
      dataClassification: classification,
      allowedActions,
    },
    connectorTypes: snapshot.tasks.map(({ connectorType }) => connectorType),
  };
}

export async function getDispatch(id: string) {
  return (await getExternalAgentControlPersistence()).dispatches.get(id);
}

export async function listDispatches(options: {
  status?: AgentDispatchRecord['status'];
  agentId?: string;
  limit?: number;
} = {}) {
  return (await getExternalAgentControlPersistence()).dispatches.list(options);
}

export async function createDispatchPreview(input: DispatchPreviewInput) {
  const agent = await getExternalAgent(requiredText(input.agentId, 'agentId', 255));
  assertAgentEnabled(agent);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 255);
  const instruction = redactForPersistence(
    requiredText(input.instruction, 'instruction', 32_000),
    { maxText: 32_000, maxBytes: 64 * 1024 },
  ) as string;
  const scope = normalizeScope(input.scope);
  const allowedActions = validateAllowedActions(agent, input.allowedActions ?? []);
  if (scope.createPullRequest && !allowedActions.includes('create_pull_request')) {
    throw new ExternalAgentError(
      'createPullRequest requires the create_pull_request allowed action',
      'CONFIRMATION_REQUIRED',
      422,
    );
  }

  const persistence = await getExternalAgentControlPersistence();
  const existing = await persistence.dispatches.findPreview(agent.id, idempotencyKey);
  const dispatchId = existing?.id ?? randomUUID();
  const preliminary = await loadPayloadSource(
    dispatchId,
    agent,
    instruction,
    scope,
    input.dataClassification ?? 'standard',
    allowedActions,
    input.callbackBaseUrl,
  );
  const classification = resolveDispatchClassification(
    preliminary.connectorTypes,
    input.dataClassification,
  );
  assertClassificationAllowed(classification, agent.dataPolicy, agent.executionLocality);
  const loaded = classification === (input.dataClassification ?? 'standard')
    ? preliminary
    : await loadPayloadSource(
      dispatchId,
      agent,
      instruction,
      scope,
      classification,
      allowedActions,
      input.callbackBaseUrl,
    );
  const { payload, disclosedFields } = selectAllowedPayloadFields(
    loaded.source,
    agent.dataPolicy.fieldAllowlist,
  );
  const destination = destinationFingerprint(agent);
  const previewHash = hashCanonical({ payload, destination });
  if (existing && existing.previewHash !== previewHash) {
    throw new ExternalAgentError(
      'Idempotency key was already used for a different disclosure preview',
      'IDEMPOTENCY_CONFLICT',
      409,
    );
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : positiveInteger(input.timeoutMs, 24 * 60 * 60_000, 30 * 24 * 60 * 60_000);
  const record: AgentDispatchRecord = {
    id: dispatchId,
    externalAgentId: agent.id,
    idempotencyKey,
    instruction,
    scope,
    status: 'needs_confirmation',
    transport: agent.transport,
    executionLocality: agent.executionLocality,
    dataClassification: classification,
    allowedActions,
    disclosedFields,
    payloadPreview: payload,
    previewHash,
    providerTaskId: null,
    providerDetail: null,
    result: null,
    resultDigest: null,
    resultStatus: null,
    claimTokenHash: null,
    claimedAt: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    maxAttempts: positiveInteger(input.maxAttempts, 3, 20),
    availableAt: now,
    deadlineAt: timeoutMs ? new Date(nowDate.getTime() + timeoutMs).toISOString() : null,
    cancelRequestedAt: null,
    githubIssueUrl: null,
    githubPullRequestUrl: null,
    repository: scope.repository ?? null,
    baseRef: scope.baseRef ?? null,
    branchRef: null,
    commitSha: null,
    checks: null,
    artifacts: null,
    errorMessage: null,
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await persistence.dispatches.createPreview(record, {
    eventType: 'preview_created',
    fromStatus: null,
    toStatus: 'needs_confirmation',
    detail: redactForPersistence({
      agentId: agent.id,
      executionLocality: agent.executionLocality,
      destination: {
        type: agent.type,
        transport: agent.transport,
        endpoint: agent.endpoint,
        authType: agent.authType,
      },
      dataClassification: classification,
      disclosedFields,
      previewHash,
    }, { maxBytes: 64 * 1024 }) as Record<string, unknown>,
    createdAt: now,
  });
  if (created.previewHash !== previewHash) {
    const concurrentPayload = { ...payload, dispatchId: created.id };
    const equivalentHash = hashCanonical({ payload: concurrentPayload, destination });
    if (created.previewHash !== equivalentHash) {
      throw new ExternalAgentError(
        'Idempotency key was already used for a different disclosure preview',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
  }
  return (await persistence.dispatches.get(created.id))!;
}

async function beginOrResumeAttempt(id: string) {
  const persistence = await getExternalAgentControlPersistence();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + 120_000).toISOString();
  return (await persistence.dispatches.beginAttempt({
    id,
    attemptId: randomUUID(),
    now,
    leaseExpiresAt,
  })) ?? persistence.dispatches.resumeAttempt({ id, now, leaseExpiresAt });
}

function extractReferences(result?: AgentDispatchResult) {
  const code = result?.codeChange;
  return {
    repository: code?.repository ?? null,
    baseRef: code?.baseRef ?? null,
    branchRef: code?.branchRef ?? null,
    commitSha: code?.commitSha ?? null,
    pullRequestUrl: code?.pullRequestUrl ?? null,
    checks: code?.checks,
    artifacts: code?.artifacts,
  };
}

async function finishAttemptFromTransport(
  id: string,
  attempt: number,
  leaseExpiresAt: string,
  result: TransportDispatchResult,
) {
  const safeDetail = result.providerDetail
    ? redactForPersistence(result.providerDetail) as Record<string, unknown>
    : undefined;
  const safeError = result.errorMessage
    ? redactForPersistence(result.errorMessage, { maxText: 4_096, maxBytes: 8_192 }) as string
    : null;
  const normalized = normalizeResult({
    status: result.status,
    result: result.result,
    providerTaskId: result.providerTaskId,
    providerState: result.providerState,
    providerDetail: safeDetail,
    errorMessage: safeError ?? undefined,
  });
  const resultDigest = result.status === 'completed' || result.status === 'failed'
    ? hashCanonical(normalized)
    : null;
  const references = extractReferences(normalized.result);
  const outcome = await (await getExternalAgentControlPersistence()).dispatches.finalizeAttempt({
    dispatchId: id,
    attempt,
    leaseExpiresAt,
    status: result.status,
    providerTaskId: result.providerTaskId,
    providerDetail: safeDetail,
    result: normalized.result,
    resultDigest,
    resultStatus: normalized.result && result.status === 'completed' ? 'pending_review' : null,
    errorMessage: safeError,
    ...references,
    providerState: result.providerState,
    now: new Date().toISOString(),
  });
  if (outcome === 'expired') {
    throw new ExternalAgentError(
      'Dispatch exceeded its deadline before the transport result was received',
      'DEADLINE_EXPIRED',
      409,
    );
  }
  return outcome === 'updated';
}

async function failStartedAttempt(
  id: string,
  attempt: number,
  leaseExpiresAt: string,
  error: unknown,
) {
  const message = redactForPersistence(
    error instanceof Error ? error.message : String(error),
    { maxText: 4_096, maxBytes: 8_192 },
  ) as string;
  await finishAttemptFromTransport(
    id,
    attempt,
    leaseExpiresAt,
    { status: 'failed', errorMessage: message },
  );
}

async function executeDispatch(
  id: string,
  agent: ExternalAgent,
  resolver: TransportResolver,
) {
  if (agent.transport === 'pull') return undefined;
  const started = await beginOrResumeAttempt(id);
  if (!started) return undefined;
  try {
    const result = await resolver(agent).dispatch(agent, {
      dispatchId: id,
      attempt: started.attempt,
      payload: started.payload,
    });
    await finishAttemptFromTransport(id, started.attempt, started.leaseExpiresAt, result);
    return result.manualUrl;
  } catch (error) {
    await failStartedAttempt(id, started.attempt, started.leaseExpiresAt, error);
    throw error;
  }
}

export async function confirmDispatch(
  id: string,
  previewHash: string,
  options: { transportResolver?: TransportResolver } = {},
) {
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  const agent = await getExternalAgent(dispatch.externalAgentId);
  assertAgentEnabled(agent);
  const requiredHash = requiredText(previewHash, 'previewHash', 128);
  const currentHash = hashCanonical({
    payload: dispatch.payloadPreview,
    destination: destinationFingerprint(agent),
  });
  const confirmed = await (await getExternalAgentControlPersistence()).dispatches.confirm({
    id,
    agentId: agent.id,
    agentSnapshot: agent,
    previewHash: requiredHash,
    currentPreviewHash: currentHash,
    maxRequestsPerMinute: agent.dataPolicy.maxRequestsPerMinute,
    now: new Date().toISOString(),
  });
  let manualUrl: string | undefined;
  if (
    confirmed
    || (dispatch.status === 'queued' && dispatch.attemptCount === 0)
    || dispatch.status === 'in_progress'
  ) {
    manualUrl = await executeDispatch(
      id,
      agent,
      options.transportResolver ?? createTransportResolver(),
    );
  }
  return { dispatch: (await getDispatch(id))!, manualUrl };
}

export async function claimNextDispatch(
  agentId: string,
  options: { leaseMs?: number } = {},
) {
  const leaseMs = positiveInteger(options.leaseMs, 120_000, 60 * 60_000);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const claimToken = randomBytes(32).toString('base64url');
  const claim = await (await getExternalAgentControlPersistence()).dispatches.claimNext({
    agentId,
    attemptId: randomUUID(),
    claimTokenHash: hashSecret(claimToken),
    now,
    leaseExpiresAt,
  });
  return claim ? { ...claim, claimToken } : null;
}

function safeUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = requiredText(value, field, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ExternalAgentError(`${field} must be a valid URL`, 'VALIDATION_ERROR', 422);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExternalAgentError(`${field} must use HTTP or HTTPS`, 'VALIDATION_ERROR', 422);
  }
  return url.toString();
}

function normalizeReferences(
  values: unknown,
  kind: 'checks' | 'artifacts',
): AgentResultReference[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 100) {
    throw new ExternalAgentError(`${kind} must be an array of at most 100 items`, 'VALIDATION_ERROR', 422);
  }
  return values.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ExternalAgentError(`${kind}[${index}] must be an object`, 'VALIDATION_ERROR', 422);
    }
    const record = entry as Record<string, unknown>;
    const url = safeUrl(record.url, `${kind}[${index}].url`);
    return {
      name: requiredText(record.name, `${kind}[${index}].name`, 255),
      ...(record.status === undefined
        ? {}
        : { status: requiredText(record.status, `${kind}[${index}].status`, 80) }),
      ...(url ? { url } : {}),
      ...(record.mediaType === undefined
        ? {}
        : { mediaType: requiredText(record.mediaType, `${kind}[${index}].mediaType`, 255) }),
    };
  });
}

function normalizeResult(input: DispatchResultInput) {
  const status = input.status ?? 'completed';
  if (!['queued', 'in_progress', 'waiting_for_user', 'completed', 'failed'].includes(status)) {
    throw new ExternalAgentError('Result status is invalid', 'VALIDATION_ERROR', 422);
  }
  const raw = input.result ?? (
    input.summary !== undefined
      ? {
        summary: input.summary,
        tasks: input.tasks,
        phases: input.phases,
        modifications: input.modifications,
        suggestedClosures: input.suggestedClosures,
        codeChange: input.codeChange,
      }
      : undefined
  );
  let result: AgentDispatchResult | undefined;
  if (raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ExternalAgentError('result must be an object', 'VALIDATION_ERROR', 422);
    }
    const codeChange = raw.codeChange;
    result = {
      ...raw,
      summary: requiredText(raw.summary, 'result.summary', 32_000),
      ...(codeChange
        ? {
          codeChange: {
            repository: validateRepository(codeChange.repository)!,
            baseRef: codeChange.baseRef
              ? requiredText(codeChange.baseRef, 'result.codeChange.baseRef', 255)
              : undefined,
            branchRef: codeChange.branchRef
              ? requiredText(codeChange.branchRef, 'result.codeChange.branchRef', 255)
              : undefined,
            commitSha: codeChange.commitSha
              ? requiredText(codeChange.commitSha, 'result.codeChange.commitSha', 128)
              : undefined,
            pullRequestUrl: safeUrl(
              codeChange.pullRequestUrl,
              'result.codeChange.pullRequestUrl',
            ),
            checks: normalizeReferences(codeChange.checks, 'checks'),
            artifacts: normalizeReferences(codeChange.artifacts, 'artifacts'),
          },
        }
        : {}),
    };
    result = redactForPersistence(result, { maxBytes: 512 * 1024 }) as AgentDispatchResult;
  }
  if (status === 'completed' && !result) {
    throw new ExternalAgentError(
      'Completed results require structured result content',
      'VALIDATION_ERROR',
      422,
    );
  }
  return {
    status,
    result,
    providerTaskId: input.providerTaskId
      ? requiredText(input.providerTaskId, 'providerTaskId', 255)
      : undefined,
    providerState: input.providerState
      ? requiredText(input.providerState, 'providerState', 255)
      : undefined,
    providerDetail: input.providerDetail
      ? redactForPersistence(input.providerDetail, { maxBytes: 128 * 1024 }) as
        Record<string, unknown>
      : undefined,
    errorMessage: input.errorMessage
      ? redactForPersistence(input.errorMessage, { maxText: 4_096, maxBytes: 8_192 }) as string
      : undefined,
  };
}

export async function submitDispatchResult(
  dispatchId: string,
  input: DispatchResultInput,
  authorization: { claimToken?: string; agentAuthenticated?: boolean },
  options: { leaseMs?: number } = {},
) {
  const normalized = normalizeResult(input);
  const digest = hashCanonical(normalized);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const references = extractReferences(normalized.result);
  const result = await (await getExternalAgentControlPersistence()).dispatches.submitResult({
    dispatchId,
    status: normalized.status,
    result: normalized.result,
    providerTaskId: normalized.providerTaskId,
    providerState: normalized.providerState,
    providerDetail: normalized.providerDetail,
    errorMessage: normalized.errorMessage ?? null,
    ...references,
    digest,
    authorization: {
      claimTokenHash: authorization.claimToken
        ? hashSecret(authorization.claimToken)
        : undefined,
      agentAuthenticated: authorization.agentAuthenticated,
    },
    leaseExpiresAt: new Date(
      nowDate.getTime() + positiveInteger(options.leaseMs, 120_000, 60 * 60_000),
    ).toISOString(),
    now,
  });
  if (result.expired) {
    throw new ExternalAgentError(
      'Dispatch exceeded its deadline before the result was received',
      'DEADLINE_EXPIRED',
      409,
    );
  }
  return { duplicate: result.duplicate, status: result.status };
}

export async function cancelDispatch(id: string) {
  return (await getExternalAgentControlPersistence()).dispatches.cancel(
    id,
    new Date().toISOString(),
  );
}

export async function retryDispatch(
  id: string,
  options: { transportResolver?: TransportResolver } = {},
) {
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  const agent = await getExternalAgent(dispatch.externalAgentId);
  assertAgentEnabled(agent);
  await (await getExternalAgentControlPersistence()).dispatches.retry({
    id,
    agentId: agent.id,
    maxRequestsPerMinute: agent.dataPolicy.maxRequestsPerMinute,
    now: new Date().toISOString(),
    executionLocality: dispatch.executionLocality,
  });
  const manualUrl = await executeDispatch(
    id,
    agent,
    options.transportResolver ?? createTransportResolver(),
  );
  return { dispatch: (await getDispatch(id))!, manualUrl };
}

export async function markDispatchWaiting(
  id: string,
  detail: Record<string, unknown> = {},
) {
  await (await getExternalAgentControlPersistence()).dispatches.markWaiting(
    id,
    redactForPersistence(detail, { maxBytes: 64 * 1024 }) as Record<string, unknown>,
    new Date().toISOString(),
  );
}

export async function expireDispatches(now = new Date()) {
  return (await getExternalAgentControlPersistence()).dispatches.expire(now.toISOString());
}

export async function reviewDispatchResult(
  id: string,
  decision: 'accepted' | 'rejected' | 'partial',
) {
  await (await getExternalAgentControlPersistence()).dispatches.review(
    id,
    decision,
    new Date().toISOString(),
  );
}

export async function cleanupExpiredDispatches(now = new Date()) {
  return (await getExternalAgentControlPersistence()).dispatches.cleanup(now.toISOString());
}
