import 'server-only';

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import db, { sqlite } from '@/db';
import {
  agentDispatchAttempts,
  agentDispatchEvents,
  agentDispatches,
  hubProjects,
  projectPhaseItems,
  projectPhases,
  tags,
  taskProjects,
  taskTags,
  tasks,
  type AgentDataClassification,
  type AgentDispatchResult,
  type AgentDispatchScope,
  type AgentDispatchStatus,
  type AgentResultReference,
} from '@/db/schema';
import { ExternalAgentError } from './errors';
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

type Dispatch = typeof agentDispatches.$inferSelect;

const TERMINAL_STATUSES = new Set<AgentDispatchStatus>([
  'completed',
  'failed',
  'timed_out',
  'dead_letter',
  'cancelled',
]);
const ACTIVE_RESULT_STATUSES = new Set<AgentDispatchStatus>([
  'queued',
  'claimed',
  'in_progress',
  'waiting_for_user',
]);
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

interface SqlDispatchState {
  id: string;
  externalAgentId: string;
  status: AgentDispatchStatus;
  transport: Dispatch['transport'];
  previewHash: string;
  payloadPreview: string;
  attemptCount: number;
  maxAttempts: number;
  claimTokenHash: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  resultDigest: string | null;
  providerTaskId: string | null;
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
  const unique = [...new Set(actions.map((action) => requiredText(action, 'allowedActions[]', 80)))];
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

function event(
  dispatchId: string,
  eventType: string,
  fromStatus: AgentDispatchStatus | null,
  toStatus: AgentDispatchStatus | null,
  detail: Record<string, unknown>,
  now: string,
) {
  sqlite.prepare(`
    INSERT INTO agent_dispatch_events (
      dispatch_id, event_type, from_status, to_status, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    dispatchId,
    eventType,
    fromStatus,
    toStatus,
    JSON.stringify(redactForPersistence(detail, { maxBytes: 64 * 1024 })),
    now,
  );
}

function sqlDispatch(id: string): SqlDispatchState | undefined {
  return sqlite.prepare(`
    SELECT
      id,
      external_agent_id AS externalAgentId,
      status,
      transport,
      preview_hash AS previewHash,
      payload_preview AS payloadPreview,
      attempt_count AS attemptCount,
      max_attempts AS maxAttempts,
      claim_token_hash AS claimTokenHash,
      lease_expires_at AS leaseExpiresAt,
      deadline_at AS deadlineAt,
      result_digest AS resultDigest,
      provider_task_id AS providerTaskId
    FROM agent_dispatches
    WHERE id = ?
  `).get(id) as SqlDispatchState | undefined;
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

  const project = scope.projectId
    ? (await db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      description: hubProjects.description,
    }).from(hubProjects).where(eq(hubProjects.id, scope.projectId)).limit(1))[0]
    : undefined;
  if (scope.projectId && !project) {
    throw new ExternalAgentError('Scoped project not found', 'NOT_FOUND', 404);
  }

  const ids = new Set(scope.taskIds ?? []);
  if (scope.projectId) {
    const memberships = await db.select({ taskId: taskProjects.taskId })
      .from(taskProjects)
      .where(eq(taskProjects.projectId, scope.projectId));
    memberships.forEach(({ taskId }) => ids.add(taskId));
  }
  const taskRows = ids.size > 0
    ? await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      status: tasks.status,
      connectorType: tasks.connectorType,
    }).from(tasks).where(inArray(tasks.id, [...ids]))
    : [];
  if (scope.taskIds && taskRows.length !== new Set(scope.taskIds).size) {
    throw new ExternalAgentError('One or more scoped tasks were not found', 'NOT_FOUND', 404);
  }
  const taskIds = taskRows.map(({ id }) => id);
  const tagRows = taskIds.length > 0
    ? await db.select({
      taskId: taskTags.taskId,
      name: tags.name,
    }).from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, taskIds))
    : [];
  const tagsByTask = new Map<string, string[]>();
  tagRows.forEach(({ taskId, name }) => {
    const values = tagsByTask.get(taskId) ?? [];
    values.push(name);
    tagsByTask.set(taskId, values);
  });

  const phases = scope.projectId
    ? await db.select({
      id: projectPhases.id,
      name: projectPhases.name,
      description: projectPhases.description,
      sortOrder: projectPhases.sortOrder,
    }).from(projectPhases).where(eq(projectPhases.projectId, scope.projectId))
    : [];
  const phaseIds = phases.map(({ id }) => id);
  const phaseItems = phaseIds.length > 0
    ? await db.select({
      phaseId: projectPhaseItems.phaseId,
      taskId: projectPhaseItems.taskId,
    }).from(projectPhaseItems).where(inArray(projectPhaseItems.phaseId, phaseIds))
    : [];

  return {
    source: {
      instruction,
      project: project ?? undefined,
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
      tasks: taskRows.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        tags: tagsByTask.get(task.id) ?? [],
      })),
      phases: phases.map(({ id, ...phase }) => ({
        ...phase,
        taskIds: phaseItems.filter((item) => item.phaseId === id).map((item) => item.taskId),
      })),
      callbackUrl: callbackBaseUrl && agent.inboundWebhookId
        ? `${callbackBaseUrl.replace(/\/$/, '')}/api/inbound-webhooks/${encodeURIComponent(agent.inboundWebhookId)}/receive`
        : undefined,
      dispatchId,
      dataClassification: classification,
      allowedActions,
    },
    connectorTypes: taskRows.map(({ connectorType }) => connectorType),
  };
}

export async function getDispatch(id: string) {
  const [dispatch] = await db.select().from(agentDispatches)
    .where(eq(agentDispatches.id, id))
    .limit(1);
  if (!dispatch) return null;
  const [attempts, events] = await Promise.all([
    db.select().from(agentDispatchAttempts)
      .where(eq(agentDispatchAttempts.dispatchId, id))
      .orderBy(agentDispatchAttempts.attemptNumber),
    db.select().from(agentDispatchEvents)
      .where(eq(agentDispatchEvents.dispatchId, id))
      .orderBy(agentDispatchEvents.id),
  ]);
  return { ...dispatch, attempts, events };
}

export async function listDispatches(options: {
  status?: AgentDispatchStatus;
  agentId?: string;
  limit?: number;
} = {}) {
  const predicates = [];
  if (options.status) predicates.push(eq(agentDispatches.status, options.status));
  if (options.agentId) predicates.push(eq(agentDispatches.externalAgentId, options.agentId));
  return db.select().from(agentDispatches)
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(desc(agentDispatches.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
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

  const existing = await db.select({ id: agentDispatches.id })
    .from(agentDispatches)
    .where(and(
      eq(agentDispatches.externalAgentId, agent.id),
      eq(agentDispatches.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  const dispatchId = existing[0]?.id ?? randomUUID();
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
  const previewHash = hashCanonical({
    payload,
    destination: destinationFingerprint(agent),
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const maxAttempts = positiveInteger(input.maxAttempts, 3, 20);
  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : positiveInteger(input.timeoutMs, 24 * 60 * 60_000, 30 * 24 * 60 * 60_000);
  const deadlineAt = timeoutMs ? new Date(now.getTime() + timeoutMs).toISOString() : null;

  const transaction = sqlite.transaction(() => {
    const duplicate = sqlite.prepare(`
      SELECT id, preview_hash AS previewHash
      FROM agent_dispatches
      WHERE external_agent_id = ? AND idempotency_key = ?
    `).get(agent.id, idempotencyKey) as { id: string; previewHash: string } | undefined;
    if (duplicate) {
      if (duplicate.previewHash !== previewHash) {
        throw new ExternalAgentError(
          'Idempotency key was already used for a different disclosure preview',
          'IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      return duplicate.id;
    }
    sqlite.prepare(`
      INSERT INTO agent_dispatches (
        id, external_agent_id, idempotency_key, instruction, scope, status,
        transport, execution_locality, data_classification, allowed_actions,
        disclosed_fields, payload_preview, preview_hash, attempt_count, max_attempts,
        available_at, deadline_at, repository, base_ref, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'needs_confirmation', ?, ?, ?, ?, ?, ?, ?, 0, ?,
        ?, ?, ?, ?, ?, ?
      )
    `).run(
      dispatchId,
      agent.id,
      idempotencyKey,
      instruction,
      JSON.stringify(scope),
      agent.transport,
      agent.executionLocality,
      classification,
      JSON.stringify(allowedActions),
      JSON.stringify(disclosedFields),
      JSON.stringify(payload),
      previewHash,
      maxAttempts,
      nowIso,
      deadlineAt,
      scope.repository ?? null,
      scope.baseRef ?? null,
      nowIso,
      nowIso,
    );
    event(dispatchId, 'preview_created', null, 'needs_confirmation', {
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
    }, nowIso);
    return dispatchId;
  });
  const resolvedId = transaction.immediate();
  return (await getDispatch(resolvedId))!;
}

function checkRateLimit(agent: ExternalAgent, now: Date) {
  const since = new Date(now.getTime() - 60_000).toISOString();
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_dispatch_events
    WHERE event_type IN ('dispatch_confirmed', 'retry_requested')
      AND created_at >= ?
      AND dispatch_id IN (
        SELECT id FROM agent_dispatches WHERE external_agent_id = ?
      )
  `).get(since, agent.id) as { count: number };
  if (row.count >= agent.dataPolicy.maxRequestsPerMinute) {
    throw new ExternalAgentError(
      'External-agent rate limit exceeded',
      'RATE_LIMITED',
      429,
    );
  }
}

function confirmTransition(id: string, previewHash: string, agent: ExternalAgent) {
  const now = new Date();
  const nowIso = now.toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(id);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    if (dispatch.externalAgentId !== agent.id) {
      throw new ExternalAgentError('Dispatch agent changed unexpectedly', 'CONFLICT', 409);
    }
    const currentHash = hashCanonical({
      payload: JSON.parse(dispatch.payloadPreview) as Record<string, unknown>,
      destination: destinationFingerprint(agent),
    });
    if (dispatch.previewHash !== previewHash || currentHash !== previewHash) {
      throw new ExternalAgentError(
        'Disclosure preview changed; preview again before confirmation',
        'PREVIEW_MISMATCH',
        409,
      );
    }
    if (dispatch.status !== 'needs_confirmation') return false;
    checkRateLimit(agent, now);
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'queued', confirmed_at = ?, available_at = ?, updated_at = ?
      WHERE id = ? AND status = 'needs_confirmation' AND preview_hash = ?
    `).run(nowIso, nowIso, nowIso, id, previewHash);
    if (update.changes !== 1) return false;
    event(id, 'dispatch_confirmed', 'needs_confirmation', 'queued', {
      previewHash,
      executionLocality: agent.executionLocality,
    }, nowIso);
    return true;
  });
  return transaction.immediate();
}

function startAttempt(id: string): { attempt: number; payload: Record<string, unknown> } | null {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + 120_000).toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(id);
    if (!dispatch || dispatch.status !== 'queued') return null;
    const attempt = dispatch.attemptCount + 1;
    if (attempt > dispatch.maxAttempts) {
      sqlite.prepare(`
        UPDATE agent_dispatches
        SET status = 'dead_letter', completed_at = ?, updated_at = ?,
            error_message = 'Maximum dispatch attempts exceeded'
        WHERE id = ? AND status = 'queued'
      `).run(now, now, id);
      event(id, 'attempts_exhausted', 'queued', 'dead_letter', { attempt }, now);
      return null;
    }
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'in_progress', attempt_count = ?, started_at = COALESCE(started_at, ?),
          lease_expires_at = ?, updated_at = ?, error_message = NULL
      WHERE id = ? AND status = 'queued'
    `).run(attempt, now, leaseExpiresAt, now, id);
    if (update.changes !== 1) return null;
    sqlite.prepare(`
      INSERT INTO agent_dispatch_attempts (
        id, dispatch_id, attempt_number, status, started_at
      ) VALUES (?, ?, ?, 'in_progress', ?)
    `).run(randomUUID(), id, attempt, now);
    event(id, 'attempt_started', 'queued', 'in_progress', { attempt }, now);
    return {
      attempt,
      payload: JSON.parse(dispatch.payloadPreview) as Record<string, unknown>,
    };
  });
  return transaction.immediate();
}

function resumeInterruptedAttempt(
  id: string,
): { attempt: number; payload: Record<string, unknown> } | null {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + 120_000).toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(id);
    if (
      !dispatch
      || dispatch.status !== 'in_progress'
      || dispatch.providerTaskId
      || !dispatch.leaseExpiresAt
      || dispatch.leaseExpiresAt > now
    ) {
      return null;
    }
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'in_progress' AND provider_task_id IS NULL
        AND lease_expires_at <= ?
    `).run(leaseExpiresAt, now, id, now);
    if (update.changes !== 1) return null;
    event(id, 'attempt_recovered', 'in_progress', 'in_progress', {
      attempt: dispatch.attemptCount,
      leaseExpiresAt,
    }, now);
    return {
      attempt: dispatch.attemptCount,
      payload: JSON.parse(dispatch.payloadPreview) as Record<string, unknown>,
    };
  });
  return transaction.immediate();
}

function finishAttemptFromTransport(
  id: string,
  attempt: number,
  result: TransportDispatchResult,
) {
  const safeDetail = result.providerDetail
    ? redactForPersistence(result.providerDetail) as Record<string, unknown>
    : undefined;
  const safeError = result.errorMessage
    ? redactForPersistence(result.errorMessage, { maxText: 4_096, maxBytes: 8_192 }) as string
    : null;
  const normalizedTransport = normalizeResult({
    status: result.status,
    result: result.result,
    providerTaskId: result.providerTaskId,
    providerState: result.providerState,
    providerDetail: safeDetail,
    errorMessage: safeError ?? undefined,
  });
  const safeResult = normalizedTransport.result;
  const resultDigest = result.status === 'completed' || result.status === 'failed'
    ? hashCanonical(normalizedTransport)
    : null;
  const status = result.status;
  const terminal = status === 'completed' || status === 'failed';
  const resultStatus = safeResult && status === 'completed' ? 'pending_review' : null;
  const references = extractReferences(safeResult);
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const current = sqlDispatch(id);
    if (!current || current.attemptCount !== attempt || current.status !== 'in_progress') {
      return 'stale' as const;
    }
    if (current.deadlineAt && current.deadlineAt <= now) {
      expireDispatchInTransaction(current, now);
      return 'expired' as const;
    }
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = ?,
          provider_task_id = COALESCE(?, provider_task_id),
          provider_detail = ?,
          result = ?,
          result_digest = ?,
          result_status = ?,
          error_message = ?,
          github_pull_request_url = ?,
          repository = COALESCE(?, repository),
          base_ref = COALESCE(?, base_ref),
          branch_ref = ?,
          commit_sha = ?,
          checks = ?,
          artifacts = ?,
          lease_expires_at = NULL,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END,
          updated_at = ?
      WHERE id = ? AND status = 'in_progress' AND attempt_count = ?
    `).run(
      status,
      result.providerTaskId ?? null,
      safeDetail ? JSON.stringify(safeDetail) : null,
      safeResult ? JSON.stringify(safeResult) : null,
      resultDigest,
      resultStatus,
      safeError,
      references.pullRequestUrl,
      references.repository,
      references.baseRef,
      references.branchRef,
      references.commitSha,
      references.checks ? JSON.stringify(references.checks) : null,
      references.artifacts ? JSON.stringify(references.artifacts) : null,
      terminal ? 1 : 0,
      now,
      now,
      id,
      attempt,
    );
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts
      SET status = ?, provider_task_id = ?, provider_detail = ?, error_message = ?,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END
      WHERE dispatch_id = ? AND attempt_number = ?
    `).run(
      status,
      result.providerTaskId ?? null,
      safeDetail ? JSON.stringify(safeDetail) : null,
      safeError,
      terminal ? 1 : 0,
      now,
      id,
      attempt,
    );
    event(id, 'transport_state', 'in_progress', status, {
      attempt,
      providerState: result.providerState,
      providerTaskId: result.providerTaskId,
      resultDigest,
    }, now);
    return 'updated' as const;
  });
  const outcome = transaction.immediate();
  if (outcome === 'expired') {
    throw new ExternalAgentError(
      'Dispatch exceeded its deadline before the transport result was received',
      'DEADLINE_EXPIRED',
      409,
    );
  }
  return outcome === 'updated';
}

function failStartedAttempt(id: string, attempt: number, error: unknown) {
  const message = redactForPersistence(
    error instanceof Error ? error.message : String(error),
    { maxText: 4_096, maxBytes: 8_192 },
  ) as string;
  finishAttemptFromTransport(id, attempt, { status: 'failed', errorMessage: message });
}

async function executeDispatch(
  id: string,
  agent: ExternalAgent,
  resolver: TransportResolver,
) {
  if (agent.transport === 'pull') return undefined;
  const started = startAttempt(id) ?? resumeInterruptedAttempt(id);
  if (!started) return undefined;
  try {
    const result = await resolver(agent).dispatch(agent, {
      dispatchId: id,
      attempt: started.attempt,
      payload: started.payload,
    });
    finishAttemptFromTransport(id, started.attempt, result);
    return result.manualUrl;
  } catch (error) {
    failStartedAttempt(id, started.attempt, error);
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
  const confirmed = confirmTransition(id, requiredText(previewHash, 'previewHash', 128), agent);
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

function recoverExpiredClaims(now: Date, agentId?: string) {
  const nowIso = now.toISOString();
  const rows = sqlite.prepare(`
    SELECT id, status, attempt_count AS attemptCount, max_attempts AS maxAttempts
    FROM agent_dispatches
    WHERE transport = 'pull'
      AND status IN ('claimed', 'in_progress', 'waiting_for_user')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ?
      ${agentId ? 'AND external_agent_id = ?' : ''}
  `).all(...(agentId ? [nowIso, agentId] : [nowIso])) as Array<{
    id: string;
    status: AgentDispatchStatus;
    attemptCount: number;
    maxAttempts: number;
  }>;
  for (const row of rows) {
    const next: AgentDispatchStatus = row.attemptCount >= row.maxAttempts
      ? 'dead_letter'
      : 'queued';
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = ?, available_at = ?, claim_token_hash = NULL, claimed_at = NULL,
          lease_expires_at = NULL, completed_at = CASE WHEN ? = 'dead_letter' THEN ? ELSE NULL END,
          error_message = 'Claim lease expired', updated_at = ?
      WHERE id = ? AND status = ?
    `).run(next, nowIso, next, nowIso, nowIso, row.id, row.status);
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts
      SET status = 'lease_expired', error_message = 'Claim lease expired', completed_at = ?
      WHERE dispatch_id = ? AND attempt_number = ?
    `).run(nowIso, row.id, row.attemptCount);
    event(row.id, 'claim_expired', row.status, next, {
      attempt: row.attemptCount,
    }, nowIso);
  }
}

export function claimNextDispatch(
  agentId: string,
  options: { leaseMs?: number } = {},
) {
  const leaseMs = positiveInteger(options.leaseMs, 120_000, 60 * 60_000);
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const claimToken = randomBytes(32).toString('base64url');
  const transaction = sqlite.transaction(() => {
    recoverExpiredClaims(now, agentId);
    const candidate = sqlite.prepare(`
      SELECT id
      FROM agent_dispatches
      WHERE external_agent_id = ?
        AND transport = 'pull'
        AND status = 'queued'
        AND available_at <= ?
        AND cancel_requested_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `).get(agentId, nowIso) as { id: string } | undefined;
    if (!candidate) return null;
    const state = sqlDispatch(candidate.id)!;
    const attempt = state.attemptCount + 1;
    if (attempt > state.maxAttempts) {
      sqlite.prepare(`
        UPDATE agent_dispatches
        SET status = 'dead_letter', completed_at = ?, updated_at = ?,
            error_message = 'Maximum dispatch attempts exceeded'
        WHERE id = ? AND status = 'queued'
      `).run(nowIso, nowIso, candidate.id);
      event(candidate.id, 'attempts_exhausted', 'queued', 'dead_letter', { attempt }, nowIso);
      return null;
    }
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'claimed', attempt_count = ?, claim_token_hash = ?, claimed_at = ?,
          lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?,
          error_message = NULL
      WHERE id = ? AND status = 'queued'
    `).run(
      attempt,
      hashSecret(claimToken),
      nowIso,
      leaseExpiresAt,
      nowIso,
      nowIso,
      candidate.id,
    );
    if (update.changes !== 1) return null;
    sqlite.prepare(`
      INSERT INTO agent_dispatch_attempts (
        id, dispatch_id, attempt_number, status, started_at
      ) VALUES (?, ?, ?, 'claimed', ?)
    `).run(randomUUID(), candidate.id, attempt, nowIso);
    event(candidate.id, 'claimed', 'queued', 'claimed', {
      attempt,
      leaseExpiresAt,
    }, nowIso);
    return {
      dispatchId: candidate.id,
      attempt,
      claimToken,
      leaseExpiresAt,
      payload: JSON.parse(state.payloadPreview) as Record<string, unknown>,
    };
  });
  return transaction.immediate();
}

function safeTokenEqual(token: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
    return {
      name: requiredText(record.name, `${kind}[${index}].name`, 255),
      ...(record.status === undefined
        ? {}
        : { status: requiredText(record.status, `${kind}[${index}].status`, 80) }),
      ...(safeUrl(record.url, `${kind}[${index}].url`)
        ? { url: safeUrl(record.url, `${kind}[${index}].url`) }
        : {}),
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
    const summary = requiredText(raw.summary, 'result.summary', 32_000);
    const codeChange = raw.codeChange;
    result = {
      ...raw,
      summary,
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
  const providerDetail = input.providerDetail
    ? redactForPersistence(input.providerDetail, { maxBytes: 128 * 1024 }) as Record<string, unknown>
    : undefined;
  const errorMessage = input.errorMessage
    ? redactForPersistence(input.errorMessage, { maxText: 4_096, maxBytes: 8_192 }) as string
    : undefined;
  return {
    status,
    result,
    providerTaskId: input.providerTaskId
      ? requiredText(input.providerTaskId, 'providerTaskId', 255)
      : undefined,
    providerState: input.providerState
      ? requiredText(input.providerState, 'providerState', 255)
      : undefined,
    providerDetail,
    errorMessage,
  };
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

export function submitDispatchResult(
  dispatchId: string,
  input: DispatchResultInput,
  authorization: { claimToken?: string; agentAuthenticated?: boolean },
  options: { leaseMs?: number } = {},
) {
  const normalized = normalizeResult(input);
  const digest = hashCanonical(normalized);
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + positiveInteger(options.leaseMs, 120_000, 60 * 60_000),
  ).toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(dispatchId);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    if (dispatch.transport === 'pull') {
      if (
        !authorization.claimToken
        || !dispatch.claimTokenHash
        || !safeTokenEqual(authorization.claimToken, dispatch.claimTokenHash)
      ) {
        throw new ExternalAgentError('Invalid claim token', 'UNAUTHORIZED', 401);
      }
    } else if (!authorization.agentAuthenticated) {
      throw new ExternalAgentError('Authenticated agent result required', 'UNAUTHORIZED', 401);
    }
    if (TERMINAL_STATUSES.has(dispatch.status)) {
      if (dispatch.resultDigest === digest) return { duplicate: true, status: dispatch.status };
      throw new ExternalAgentError(
        `Dispatch is already terminal (${dispatch.status})`,
        'TERMINAL_DISPATCH',
        409,
      );
    }
    if (dispatch.deadlineAt && dispatch.deadlineAt <= nowIso) {
      expireDispatchInTransaction(dispatch, nowIso);
      return { expired: true as const, status: 'timed_out' as const };
    }
    if (!ACTIVE_RESULT_STATUSES.has(dispatch.status)) {
      throw new ExternalAgentError(
        `Dispatch cannot accept results while ${dispatch.status}`,
        'INVALID_TRANSITION',
        409,
      );
    }
    if (dispatch.transport === 'pull') {
      if (!dispatch.leaseExpiresAt || dispatch.leaseExpiresAt <= nowIso) {
        throw new ExternalAgentError('Claim lease expired', 'LEASE_EXPIRED', 409);
      }
      if (normalized.status === 'queued') {
        throw new ExternalAgentError(
          'Pull results cannot return an active claim to the queue',
          'INVALID_TRANSITION',
          409,
        );
      }
    }
    const toStatus = normalized.status;
    const terminal = toStatus === 'completed' || toStatus === 'failed';
    const references = extractReferences(normalized.result);
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = ?,
          provider_task_id = COALESCE(?, provider_task_id),
          provider_detail = COALESCE(?, provider_detail),
          result = COALESCE(?, result),
          result_digest = ?,
          result_status = CASE WHEN ? = 'completed' THEN 'pending_review' ELSE result_status END,
          error_message = ?,
          github_pull_request_url = COALESCE(?, github_pull_request_url),
          repository = COALESCE(?, repository),
          base_ref = COALESCE(?, base_ref),
          branch_ref = COALESCE(?, branch_ref),
          commit_sha = COALESCE(?, commit_sha),
          checks = COALESCE(?, checks),
          artifacts = COALESCE(?, artifacts),
          lease_expires_at = CASE WHEN ? THEN NULL ELSE ? END,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END,
          updated_at = ?
      WHERE id = ? AND status = ?
    `).run(
      toStatus,
      normalized.providerTaskId ?? null,
      normalized.providerDetail ? JSON.stringify(normalized.providerDetail) : null,
      normalized.result ? JSON.stringify(normalized.result) : null,
      digest,
      toStatus,
      normalized.errorMessage ?? null,
      references.pullRequestUrl,
      references.repository,
      references.baseRef,
      references.branchRef,
      references.commitSha,
      references.checks ? JSON.stringify(references.checks) : null,
      references.artifacts ? JSON.stringify(references.artifacts) : null,
      terminal ? 1 : 0,
      leaseExpiresAt,
      terminal ? 1 : 0,
      nowIso,
      nowIso,
      dispatchId,
      dispatch.status,
    );
    if (update.changes !== 1) {
      throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
    }
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts
      SET status = ?, provider_task_id = COALESCE(?, provider_task_id),
          provider_detail = COALESCE(?, provider_detail), error_message = ?,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END
      WHERE dispatch_id = ? AND attempt_number = ?
    `).run(
      toStatus,
      normalized.providerTaskId ?? null,
      normalized.providerDetail ? JSON.stringify(normalized.providerDetail) : null,
      normalized.errorMessage ?? null,
      terminal ? 1 : 0,
      nowIso,
      dispatchId,
      dispatch.attemptCount,
    );
    event(dispatchId, 'result_received', dispatch.status, toStatus, {
      attempt: dispatch.attemptCount,
      providerState: normalized.providerState,
      providerTaskId: normalized.providerTaskId,
      resultDigest: digest,
    }, nowIso);
    return { duplicate: false, status: toStatus };
  });
  const result = transaction.immediate();
  if ('expired' in result) {
    throw new ExternalAgentError(
      'Dispatch exceeded its deadline before the result was received',
      'DEADLINE_EXPIRED',
      409,
    );
  }
  return result;
}

export function cancelDispatch(id: string) {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(id);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    if (dispatch.status === 'cancelled') return false;
    if (TERMINAL_STATUSES.has(dispatch.status)) {
      throw new ExternalAgentError(
        `Dispatch is already terminal (${dispatch.status})`,
        'TERMINAL_DISPATCH',
        409,
      );
    }
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'cancelled', cancel_requested_at = ?, completed_at = ?,
          claim_token_hash = NULL, lease_expires_at = NULL,
          error_message = 'Dispatch cancelled by user', updated_at = ?
      WHERE id = ? AND status = ?
    `).run(now, now, now, id, dispatch.status);
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts
      SET status = 'cancelled', error_message = 'Dispatch cancelled by user', completed_at = ?
      WHERE dispatch_id = ? AND attempt_number = ? AND completed_at IS NULL
    `).run(now, id, dispatch.attemptCount);
    event(id, 'cancelled', dispatch.status, 'cancelled', {
      providerTaskId: dispatch.providerTaskId,
    }, now);
    return true;
  });
  return transaction.immediate();
}

export async function retryDispatch(
  id: string,
  options: { transportResolver?: TransportResolver } = {},
) {
  const dispatch = await getDispatch(id);
  if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
  const agent = await getExternalAgent(dispatch.externalAgentId);
  assertAgentEnabled(agent);
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const current = sqlDispatch(id);
    if (!current) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    if (
      current.status !== 'failed'
      && current.status !== 'timed_out'
      && current.status !== 'dead_letter'
      && current.status !== 'cancelled'
    ) {
      throw new ExternalAgentError(
        `Dispatch cannot be retried while ${current.status}`,
        'INVALID_TRANSITION',
        409,
      );
    }
    checkRateLimit(agent, new Date(now));
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'queued', max_attempts = MAX(max_attempts, attempt_count + 1),
          available_at = ?, provider_task_id = NULL, provider_detail = NULL,
          result = NULL, result_digest = NULL, result_status = NULL,
          claim_token_hash = NULL, claimed_at = NULL, lease_expires_at = NULL,
          cancel_requested_at = NULL, github_issue_url = NULL, github_pull_request_url = NULL,
          branch_ref = NULL, commit_sha = NULL, checks = NULL, artifacts = NULL,
          error_message = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(now, now, id, current.status);
    event(id, 'retry_requested', current.status, 'queued', {
      nextAttempt: current.attemptCount + 1,
      executionLocality: dispatch.executionLocality,
    }, now);
  });
  transaction.immediate();
  const manualUrl = await executeDispatch(
    id,
    agent,
    options.transportResolver ?? createTransportResolver(),
  );
  return { dispatch: (await getDispatch(id))!, manualUrl };
}

export function markDispatchWaiting(id: string, detail: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const dispatch = sqlDispatch(id);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    if (dispatch.status !== 'claimed' && dispatch.status !== 'in_progress') {
      throw new ExternalAgentError(
        `Dispatch cannot wait while ${dispatch.status}`,
        'INVALID_TRANSITION',
        409,
      );
    }
    sqlite.prepare(`
      UPDATE agent_dispatches SET status = 'waiting_for_user', updated_at = ?
      WHERE id = ? AND status = ?
    `).run(now, id, dispatch.status);
    sqlite.prepare(`
      UPDATE agent_dispatch_attempts SET status = 'waiting_for_user'
      WHERE dispatch_id = ? AND attempt_number = ?
    `).run(id, dispatch.attemptCount);
    event(id, 'waiting_for_user', dispatch.status, 'waiting_for_user', detail, now);
  });
  transaction.immediate();
}

function expireDispatchInTransaction(
  dispatch: Pick<SqlDispatchState, 'id' | 'status' | 'attemptCount'>,
  nowIso: string,
) {
  const update = sqlite.prepare(`
    UPDATE agent_dispatches
    SET status = 'timed_out', completed_at = ?, updated_at = ?,
        claim_token_hash = NULL, lease_expires_at = NULL,
        error_message = 'Dispatch exceeded its deadline'
    WHERE id = ? AND status = ?
  `).run(nowIso, nowIso, dispatch.id, dispatch.status);
  if (update.changes !== 1) {
    throw new ExternalAgentError('Dispatch changed concurrently', 'CONFLICT', 409);
  }
  sqlite.prepare(`
    UPDATE agent_dispatch_attempts
    SET status = 'timed_out', error_message = 'Dispatch exceeded its deadline',
        completed_at = ?
    WHERE dispatch_id = ? AND attempt_number = ? AND completed_at IS NULL
  `).run(nowIso, dispatch.id, dispatch.attemptCount);
  event(dispatch.id, 'timed_out', dispatch.status, 'timed_out', {}, nowIso);
}

export function expireDispatches(now = new Date()) {
  const nowIso = now.toISOString();
  const transaction = sqlite.transaction(() => {
    recoverExpiredClaims(now);
    const rows = sqlite.prepare(`
      SELECT id, status, attempt_count AS attemptCount
      FROM agent_dispatches
      WHERE status IN ('queued', 'claimed', 'in_progress', 'waiting_for_user')
        AND deadline_at IS NOT NULL
        AND deadline_at <= ?
    `).all(nowIso) as Array<{
      id: string;
      status: AgentDispatchStatus;
      attemptCount: number;
    }>;
    for (const row of rows) {
      expireDispatchInTransaction(row, nowIso);
    }
    return rows.length;
  });
  return transaction.immediate();
}

export function reviewDispatchResult(
  id: string,
  decision: 'accepted' | 'rejected' | 'partial',
) {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const update = sqlite.prepare(`
      UPDATE agent_dispatches
      SET result_status = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'completed' AND result_status = 'pending_review'
    `).run(decision, now, now, id);
    if (update.changes !== 1) {
      throw new ExternalAgentError(
        'Dispatch has no pending result review',
        'INVALID_TRANSITION',
        409,
      );
    }
    event(id, 'result_reviewed', 'completed', 'completed', { decision }, now);
  });
  transaction.immediate();
}

export function cleanupExpiredDispatches(now = new Date()) {
  const rows = sqlite.prepare(`
    SELECT d.id, d.completed_at AS completedAt, a.data_policy AS dataPolicy
    FROM agent_dispatches d
    JOIN external_agents a ON a.id = d.external_agent_id
    WHERE d.status IN ('completed', 'failed', 'timed_out', 'dead_letter', 'cancelled')
      AND d.completed_at IS NOT NULL
  `).all() as Array<{
    id: string;
    completedAt: string;
    dataPolicy: string;
  }>;
  const expired = rows.filter((row) => {
    const policy = JSON.parse(row.dataPolicy) as ExternalAgent['dataPolicy'];
    return new Date(row.completedAt).getTime() + policy.retentionDays * 86_400_000 <= now.getTime();
  });
  const transaction = sqlite.transaction(() => {
    for (const row of expired) {
      sqlite.prepare('DELETE FROM agent_dispatches WHERE id = ?').run(row.id);
    }
  });
  transaction.immediate();
  return expired.length;
}
