import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentDataClassification,
  AgentDispatchRecord,
  AgentDispatchResult,
  AgentDispatchScope,
  AgentPayloadSnapshot,
  AgentResultReference,
  AgentInteraction,
  AgentInteractionContinuationPolicy,
  AgentInteractionKind,
  AgentDispatchActionType,
} from './contracts';
import { SCOUT_WORKER_ACTIONS } from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  assertClassificationAllowed,
  assertRichTaskContextAllowed,
  hashCanonical,
  hashSecret,
  redactForPersistence,
  resolveDispatchClassificationForSources,
  selectAllowedPayloadFields,
} from './policy';
import { parseSourceId } from '@/lib/connectors/github-issues/issue-transformer';
import {
  getExternalAgent,
  resolveExternalAgentCredential,
  type ExternalAgent,
} from './registry';
import {
  createTransportResolver,
  type TransportDispatchResult,
  type TransportResolver,
} from './transports';
import { getCopilotCloudTask } from './copilot-cloud';
import {
  cancelPaperclipIssue,
  getPaperclipState,
  type PaperclipConnection,
} from './paperclip';

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
  taskBriefs?: Record<string, string>;
  dataClassification?: AgentDataClassification;
  allowedActions?: string[];
  idempotencyKey: string;
  callbackBaseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface DispatchResultInput {
  status?:
    | 'queued'
    | 'in_progress'
    | 'waiting_for_user'
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'cancelled';
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

function assertExternalAgentWorker(): void {
  if (process.env.MC_PROCESS_ROLE !== 'worker') {
    throw new ExternalAgentError(
      'External-agent provider execution is restricted to the packaged worker',
      'EXECUTION_BOUNDARY_MISMATCH',
      503,
    );
  }
}

async function enqueueDispatchAction(
  dispatchId: string,
  action: AgentDispatchActionType,
  priority: number,
): Promise<boolean> {
  return (await getExternalAgentControlPersistence()).actions.enqueue({
    dispatchId,
    action,
    priority,
    now: new Date().toISOString(),
  });
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

function validateUuid(value: string, field: string) {
  const normalized = requiredText(value, field, 255);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(normalized)) {
    throw new ExternalAgentError(`${field} must be a UUID`, 'VALIDATION_ERROR', 422);
  }
  return normalized;
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
    model: scope.model ? requiredText(scope.model, 'scope.model', 255) : undefined,
    createPullRequest: scope.createPullRequest === true,
    paperclip: scope.paperclip
      ? {
        companyId: validateUuid(scope.paperclip.companyId, 'scope.paperclip.companyId'),
        assigneeAgentId: validateUuid(
          scope.paperclip.assigneeAgentId,
          'scope.paperclip.assigneeAgentId',
        ),
        ...(scope.paperclip.projectId
          ? { projectId: validateUuid(scope.paperclip.projectId, 'scope.paperclip.projectId') }
          : {}),
        ...(scope.paperclip.requiredAdapterType
          ? {
            requiredAdapterType: requiredText(
              scope.paperclip.requiredAdapterType,
              'scope.paperclip.requiredAdapterType',
              255,
            ),
          }
          : {}),
      }
      : undefined,
  };
}

function validateAllowedActions(agent: ExternalAgent, actions: string[]) {
  const unique = [...new Set(actions.map((action) =>
    requiredText(action, 'allowedActions[]', 80)))];
  for (const action of unique) {
    if (SCOUT_WORKER_ACTIONS.includes(action as (typeof SCOUT_WORKER_ACTIONS)[number])) {
      if (!agent.capabilities.scout?.actions.includes(
        action as (typeof SCOUT_WORKER_ACTIONS)[number],
      )) {
        throw new ExternalAgentError(
          `Agent does not support allowed action "${action}"`,
          'CAPABILITY_MISMATCH',
          422,
        );
      }
      continue;
    }
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
    providerConfigHash: hashCanonical(agent.providerConfig),
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

function sourceIssue(
  task: Pick<
    AgentPayloadSnapshot['tasks'][number],
    'connectorType' | 'sourceId' | 'sourceUrl'
  >,
  repository: string | undefined,
) {
  if (task.connectorType !== 'github-issues' || !task.sourceId) return undefined;
  const parsed = parseSourceId(task.sourceId);
  if (
    !parsed.repo
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repo)
    || !Number.isSafeInteger(parsed.issueNumber)
    || parsed.issueNumber < 1
  ) {
    return undefined;
  }
  if (repository && parsed.repo.toLowerCase() !== repository.toLowerCase()) {
    throw new ExternalAgentError(
      `GitHub issue ${parsed.repo}#${parsed.issueNumber} cannot be dispatched to ${repository}`,
      'REPOSITORY_SCOPE_MISMATCH',
      409,
    );
  }
  let url: string | undefined;
  if (task.sourceUrl) {
    try {
      const candidate = new URL(task.sourceUrl);
      if (
        candidate.protocol === 'https:'
        && !candidate.username
        && !candidate.password
        && candidate.pathname.toLowerCase()
          === `/${parsed.repo}/issues/${parsed.issueNumber}`.toLowerCase()
      ) {
        url = candidate.toString();
      }
    } catch {
      // Invalid connector URLs are omitted rather than repaired or invented.
    }
  }
  return {
    type: 'github-issue',
    repository: parsed.repo,
    issueNumber: parsed.issueNumber,
    ...(url ? { url } : {}),
  };
}

async function loadPayloadSource(
  dispatchId: string,
  agent: ExternalAgent,
  instruction: string,
  scope: AgentDispatchScope,
  taskBriefs: Map<string, string>,
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
  if (agent.type === 'copilot-cloud' || agent.type === 'paperclip') {
    assertRichTaskContextAllowed(agent.dataPolicy);
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
      alwaysInstructions: agent.providerConfig.alwaysInstructions ?? '',
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
        model: scope.model,
        createPullRequest: scope.createPullRequest,
      },
      tasks: snapshot.tasks.map(({
        connectorType,
        sourceId: _sourceId,
        sourceUrl: _sourceUrl,
        ...task
      }) => {
        const taskSourceIssue = sourceIssue(
          { connectorType, sourceId: _sourceId, sourceUrl: _sourceUrl },
          agent.type === 'copilot-cloud' ? scope.repository : undefined,
        );
        return {
          ...task,
          ...(taskBriefs.has(task.id) ? { description: taskBriefs.get(task.id)! } : {}),
          subtasks: task.subtasks.map(({
            connectorType: subtaskConnectorType,
            sourceId: subtaskSourceId,
            sourceUrl: subtaskSourceUrl,
            ...subtask
          }) => {
            const subtaskSourceIssue = sourceIssue({
              connectorType: subtaskConnectorType,
              sourceId: subtaskSourceId,
              sourceUrl: subtaskSourceUrl,
            }, agent.type === 'copilot-cloud' ? scope.repository : undefined);
            return {
              ...subtask,
              ...(subtaskSourceIssue ? { sourceIssue: subtaskSourceIssue } : {}),
            };
          }),
          ...(taskSourceIssue ? { sourceIssue: taskSourceIssue } : {}),
        };
      }),
      phases: snapshot.phases,
      callbackUrl: callbackBaseUrl && agent.inboundWebhookId
        ? `${callbackBaseUrl.replace(/\/$/, '')}/api/inbound-webhooks/${encodeURIComponent(agent.inboundWebhookId)}/receive`
        : undefined,
      dispatchId,
      dataClassification: classification,
      allowedActions,
    },
    connectorSources: snapshot.tasks.flatMap(({
      connectorType,
      connectorInstanceId,
      subtasks,
    }) => [
      { connectorType, connectorInstanceId: connectorInstanceId ?? '' },
      ...subtasks.map((subtask) => ({
        connectorType: subtask.connectorType,
        connectorInstanceId: subtask.connectorInstanceId ?? '',
      })),
    ]),
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
  const taskBriefs = new Map<string, string>();
  if (input.taskBriefs !== undefined) {
    if (
      !input.taskBriefs
      || typeof input.taskBriefs !== 'object'
      || Array.isArray(input.taskBriefs)
    ) {
      throw new ExternalAgentError(
        'taskBriefs must be an object keyed by task ID',
        'VALIDATION_ERROR',
        422,
      );
    }
    const scopedTaskIds = new Set(scope.taskIds ?? []);
    for (const [taskId, brief] of Object.entries(input.taskBriefs)) {
      if (!scopedTaskIds.has(taskId)) continue;
      if (typeof brief !== 'string' || brief.length > 32_000) {
        throw new ExternalAgentError(
          'Each delegated task brief must be text no longer than 32,000 characters',
          'VALIDATION_ERROR',
          422,
        );
      }
      taskBriefs.set(taskId, brief);
    }
  }
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
    taskBriefs,
    input.dataClassification ?? 'standard',
    allowedActions,
    input.callbackBaseUrl,
  );
  const classificationResolution = await resolveDispatchClassificationForSources(
    preliminary.connectorSources,
    input.dataClassification,
  );
  const classification = classificationResolution.classification;
  assertClassificationAllowed(classification, agent.dataPolicy, agent.executionLocality);
  const loaded = classification === (input.dataClassification ?? 'standard')
    ? preliminary
    : await loadPayloadSource(
      dispatchId,
      agent,
      instruction,
      scope,
      taskBriefs,
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
  const resultDigest = [
    'completed',
    'failed',
    'timed_out',
    'cancelled',
  ].includes(result.status)
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
  scope: AgentDispatchScope,
) {
  assertExternalAgentWorker();
  if (agent.transport === 'pull') return undefined;
  const started = await beginOrResumeAttempt(id);
  if (!started) return undefined;
  try {
    const result = await resolver(agent).dispatch(agent, {
      dispatchId: id,
      attempt: started.attempt,
      payload: started.payload,
      scope,
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
  _options: { transportResolver?: TransportResolver } = {},
) {
  void _options;
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
  if (confirmed || (dispatch.status === 'queued' && dispatch.attemptCount === 0)) {
    await enqueueDispatchAction(id, 'submit', 50);
  }
  return {
    dispatch: (await getDispatch(id))!,
    manualUrl: undefined as string | undefined,
  };
}

export async function claimNextDispatch(
  agentId: string,
  options: { leaseMs?: number; dispatchId?: string } = {},
) {
  const leaseMs = positiveInteger(options.leaseMs, 120_000, 60 * 60_000);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
  const claimToken = randomBytes(32).toString('base64url');
  const claim = await (await getExternalAgentControlPersistence()).dispatches.claimNext({
    agentId,
    dispatchId: options.dispatchId,
    attemptId: randomUUID(),
    claimTokenHash: hashSecret(claimToken),
    now,
    leaseExpiresAt,
  });
  return claim ? { ...claim, claimToken } : null;
}

export async function requestDispatchInteraction(
  dispatchId: string,
  claimToken: string,
  input: {
    kind: AgentInteractionKind;
    prompt: string;
    choices?: string[];
    continuationPolicy?: AgentInteractionContinuationPolicy;
  },
) {
  const prompt = requiredText(input.prompt, 'prompt', 2_000);
  const choices = input.choices?.map((choice, index) =>
    requiredText(choice, `choices[${index}]`, 200));
  if (choices && (choices.length < 2 || choices.length > 20)) {
    throw new ExternalAgentError(
      'choices must contain between 2 and 20 items',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (choices && new Set(choices).size !== choices.length) {
    throw new ExternalAgentError(
      'choices must be unique',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.kind === 'approval' && choices) {
    throw new ExternalAgentError(
      'approval interactions use approved or rejected outcomes, not choices',
      'VALIDATION_ERROR',
      422,
    );
  }
  const interaction: AgentInteraction = {
    id: randomUUID(),
    kind: input.kind,
    status: 'pending',
    prompt,
    ...(choices ? { choices } : {}),
    continuationPolicy: input.continuationPolicy ?? 'resume_same_dispatch',
    createdAt: new Date().toISOString(),
  };
  await submitDispatchResult(
    dispatchId,
    {
      status: 'waiting_for_user',
      providerDetail: { interaction },
    },
    { claimToken },
  );
  return interaction;
}

export async function resolveDispatchInteraction(
  id: string,
  input: {
    interactionId: string;
    outcome: 'answered' | 'approved' | 'rejected';
    answer?: string;
  },
) {
  const interactionId = requiredText(input.interactionId, 'interactionId', 200);
  const answer = input.answer === undefined
    ? undefined
    : requiredText(input.answer, 'answer', 4_000);
  const dispatch = await getDispatch(id);
  const stored = dispatch?.providerDetail?.interaction;
  if (
    !stored
    || typeof stored !== 'object'
    || Array.isArray(stored)
    || (stored as Record<string, unknown>).id !== interactionId
    || (stored as Record<string, unknown>).status !== 'pending'
  ) {
    throw new ExternalAgentError(
      'Dispatch has no matching pending interaction',
      'INVALID_TRANSITION',
      409,
    );
  }
  const interaction = stored as Record<string, unknown>;
  if (
    (interaction.kind === 'question' && input.outcome !== 'answered')
    || (interaction.kind === 'approval' && input.outcome === 'answered')
  ) {
    throw new ExternalAgentError(
      'Interaction outcome does not match its kind',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.outcome === 'answered' && !answer) {
    throw new ExternalAgentError(
      'Answered interactions require an answer',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (
    answer
    && Array.isArray(interaction.choices)
    && !interaction.choices.includes(answer)
  ) {
    throw new ExternalAgentError(
      'Answer must match one of the available choices',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (input.outcome !== 'answered' && answer) {
    throw new ExternalAgentError(
      'Approval outcomes do not accept an answer',
      'VALIDATION_ERROR',
      422,
    );
  }
  await (await getExternalAgentControlPersistence()).dispatches.resolveInteraction({
    id,
    interactionId,
    outcome: input.outcome,
    ...(answer ? { answer } : {}),
    now: new Date().toISOString(),
  });
  if ((await getDispatch(id))?.status === 'queued') {
    await enqueueDispatchAction(id, 'submit', 50);
  }
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
  if (![
    'queued',
    'in_progress',
    'waiting_for_user',
    'completed',
    'failed',
    'timed_out',
    'cancelled',
  ].includes(status)) {
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
  authorization: {
    claimToken?: string;
    agentAuthenticated?: boolean;
    allowCompletedProviderTaskUpdate?: boolean;
  },
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
      allowCompletedProviderTaskUpdate:
        authorization.allowCompletedProviderTaskUpdate,
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
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  const agent = await getExternalAgent(dispatch.externalAgentId);
  if (agent?.type === 'copilot-cloud' && dispatch.providerTaskId) {
    throw new ExternalAgentError(
      'GitHub Agent Tasks does not currently expose task cancellation; the provider task remains active',
      'CANCELLATION_UNSUPPORTED',
      409,
    );
  }
  if (dispatch.status === 'cancelled') return false;
  await enqueueDispatchAction(id, 'cancel', 100);
  return true;
}

export async function stopTrackingDispatch(id: string) {
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  const agent = await getExternalAgent(dispatch.externalAgentId);
  if (agent?.type !== 'copilot-cloud' || !dispatch.providerTaskId) {
    throw new ExternalAgentError(
      'Stop tracking is only available for active GitHub Agent Tasks',
      'INVALID_TRANSITION',
      409,
    );
  }
  return (await getExternalAgentControlPersistence()).dispatches.cancel(
    id,
    new Date().toISOString(),
  );
}

const COMPLETED_OUTPUT_RECONCILIATION_MS = 30 * 24 * 60 * 60 * 1_000;

function pullRequestLifecycleState(dispatch: AgentDispatchRecord): string | null {
  const detail = dispatch.providerDetail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const pullRequest = detail.pullRequest;
  if (!pullRequest || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
    return null;
  }
  const snapshot = pullRequest as Record<string, unknown>;
  return typeof snapshot.state === 'string'
    ? snapshot.state.toLowerCase()
    : null;
}

export function shouldReconcileDispatch(
  dispatch: AgentDispatchRecord,
  now = new Date(),
) {
  if (['queued', 'claimed', 'in_progress', 'waiting_for_user'].includes(dispatch.status)) {
    return true;
  }
  if (
    dispatch.status !== 'completed'
    || dispatch.executionLocality !== 'github-hosted'
    || !dispatch.providerTaskId
    || !dispatch.repository
  ) {
    return false;
  }
  if (
    dispatch.scope.createPullRequest === true
    && ['merged', 'closed'].includes(pullRequestLifecycleState(dispatch) ?? '')
  ) {
    return false;
  }
  const completedAt = dispatch.completedAt ? Date.parse(dispatch.completedAt) : Number.NaN;
  return !Number.isFinite(completedAt)
    || now.getTime() - completedAt <= COMPLETED_OUTPUT_RECONCILIATION_MS;
}

export async function reconcileDispatch(
  id: string,
  options: { fetcher?: typeof fetch } = {},
) {
  assertExternalAgentWorker();
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  if (!shouldReconcileDispatch(dispatch)) return dispatch;
  const agent = await getExternalAgent(dispatch.externalAgentId);
  assertAgentEnabled(agent);
  if (agent.type === 'paperclip') {
    if (!dispatch.providerTaskId) return dispatch;
    const provider = await getPaperclipState(
      await paperclipConnection(agent, options.fetcher, dispatch.scope.paperclip),
      dispatch.providerTaskId,
    );
    await submitDispatchResult(
      dispatch.id,
      {
        status: provider.status,
        result: provider.result,
        providerTaskId: provider.providerTaskId,
        providerState: provider.providerState,
        providerDetail: provider.providerDetail,
        errorMessage: provider.errorMessage,
      },
      { agentAuthenticated: true },
    );
    return (await getDispatch(id))!;
  }

  if (
    dispatch.executionLocality !== 'github-hosted'
    || !dispatch.providerTaskId
    || !dispatch.repository
  ) {
    return dispatch;
  }
  if (agent.type !== 'copilot-cloud') {
    throw new ExternalAgentError(
      'GitHub-hosted dispatch is not backed by the Copilot cloud adapter',
      'EXECUTION_BOUNDARY_MISMATCH',
      409,
    );
  }
  const provider = await getCopilotCloudTask(
    agent,
    dispatch.repository,
    dispatch.baseRef ?? dispatch.scope.defaultBranch ?? 'main',
    dispatch.providerTaskId,
    options.fetcher,
  );
  if (dispatch.status === 'completed' && provider.status === 'completed') {
    const references = extractReferences(provider.result);
    await (await getExternalAgentControlPersistence()).dispatches.refreshOutput({
      id: dispatch.id,
      providerDetail: provider.providerDetail ?? {},
      pullRequestUrl: references.pullRequestUrl ?? undefined,
      branchRef: references.branchRef ?? undefined,
      commitSha: references.commitSha ?? undefined,
      now: new Date().toISOString(),
    });
    return (await getDispatch(id))!;
  }
  await submitDispatchResult(
    dispatch.id,
    {
      status: provider.status,
      result: provider.result,
      providerTaskId: provider.providerTaskId,
      providerState: provider.providerState,
      providerDetail: provider.providerDetail,
      errorMessage: provider.errorMessage,
    },
    {
      agentAuthenticated: true,
      allowCompletedProviderTaskUpdate: dispatch.status === 'completed',
    },
  );
  return (await getDispatch(id))!;
}

export async function requestDispatchReconciliation(id: string) {
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  if (!shouldReconcileDispatch(dispatch)) return false;
  return enqueueDispatchAction(id, 'reconcile', 75);
}

export async function executeExternalAgentWorkerAction(
  dispatchId: string,
  action: AgentDispatchActionType,
  options: { fetcher?: typeof fetch; transportResolver?: TransportResolver } = {},
): Promise<void> {
  assertExternalAgentWorker();
  const dispatch = await getDispatch(dispatchId);
  if (!dispatch) return;
  const agent = await getExternalAgent(dispatch.externalAgentId);
  if (action === 'submit') {
    assertAgentEnabled(agent);
    await executeDispatch(
      dispatch.id,
      agent,
      options.transportResolver ?? createTransportResolver({ fetcher: options.fetcher }),
      dispatch.scope,
    );
    return;
  }
  if (action === 'reconcile') {
    await reconcileDispatch(dispatch.id, { fetcher: options.fetcher });
    return;
  }
  if (dispatch.status === 'cancelled') return;
  if (agent?.type === 'paperclip' && dispatch.providerTaskId) {
    assertAgentEnabled(agent);
    const provider = await cancelPaperclipIssue(
      await paperclipConnection(agent, options.fetcher, dispatch.scope.paperclip),
      dispatch.providerTaskId,
    );
    await submitDispatchResult(
      dispatch.id,
      {
        status: provider.status,
        result: provider.result,
        providerTaskId: provider.providerTaskId,
        providerState: provider.providerState,
        providerDetail: provider.providerDetail,
        errorMessage: provider.errorMessage,
      },
      { agentAuthenticated: true },
    );
    return;
  }
  await (await getExternalAgentControlPersistence()).dispatches.cancel(
    dispatch.id,
    new Date().toISOString(),
  );
}

async function paperclipConnection(
  agent: ExternalAgent,
  fetcher?: typeof fetch,
  configOverride?: PaperclipConnection['config'],
): Promise<PaperclipConnection> {
  const config = agent.providerConfig.paperclip;
  if (!agent.endpoint || !config) {
    throw new ExternalAgentError(
      'Paperclip endpoint and provider configuration are missing',
      'TRANSPORT_INVALID',
      500,
    );
  }
  return {
    endpoint: agent.endpoint,
    credential: await resolveExternalAgentCredential(agent),
    config: configOverride ?? config,
    fetcher,
  };
}

export async function reconcileActiveExternalAgentDispatches(
  options: { fetcher?: typeof fetch } = {},
) {
  assertExternalAgentWorker();
  const statuses: AgentDispatchRecord['status'][] = [
    'queued',
    'in_progress',
    'waiting_for_user',
    'completed',
  ];
  const dispatches = (await Promise.all(
    statuses.map((status) => listDispatches({ status, limit: 500 })),
  )).flat();
  let reconciled = 0;
  const failures: Array<{ dispatchId: string; error: string }> = [];
  for (const dispatch of dispatches) {
    if (!shouldReconcileDispatch(dispatch)) continue;
    const agent = await getExternalAgent(dispatch.externalAgentId);
    if (
      dispatch.executionLocality !== 'github-hosted'
      && agent?.type !== 'paperclip'
    ) {
      continue;
    }

    try {
      if (!dispatch.providerTaskId) {
        assertAgentEnabled(agent);
        await executeDispatch(
          dispatch.id,
          agent,
          createTransportResolver({ fetcher: options.fetcher }),
          dispatch.scope,
        );
        if ((await getDispatch(dispatch.id))?.providerTaskId) reconciled += 1;
        continue;
      }
      await reconcileDispatch(dispatch.id, options);
      reconciled += 1;
    } catch (error) {
      failures.push({
        dispatchId: dispatch.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { reconciled, failures };
}

export async function requestActiveExternalAgentReconciliation() {
  const statuses: AgentDispatchRecord['status'][] = [
    'queued',
    'in_progress',
    'waiting_for_user',
    'completed',
  ];
  const dispatches = (await Promise.all(
    statuses.map((status) => listDispatches({ status, limit: 500 })),
  )).flat();
  let queued = 0;
  for (const dispatch of dispatches) {
    if (!shouldReconcileDispatch(dispatch)) continue;
    if (await enqueueDispatchAction(dispatch.id, 'reconcile', 75)) queued += 1;
  }
  return { queued };
}

export async function reconcileActiveCopilotCloudDispatches(
  options: { fetcher?: typeof fetch } = {},
) {
  return reconcileActiveExternalAgentDispatches(options);
}

export async function retryDispatch(
  id: string,
  _options: { transportResolver?: TransportResolver } = {},
) {
  void _options;
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
  await enqueueDispatchAction(id, 'submit', 50);
  return { dispatch: (await getDispatch(id))! };
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
