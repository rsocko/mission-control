import 'server-only';

import type {
  AgentDataClassification,
  AgentDispatchRecord,
  AgentDispatchStatus,
  AgentResultReference,
  ExternalAgentCapabilities,
  ExternalAgentLocality,
  ExternalAgentType,
} from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  assertClassificationAllowed,
  resolveDispatchClassification,
} from './policy';
import { listExternalAgents } from './registry';
import {
  createDispatchPreview,
  expireDispatches,
  reconcileDispatch,
} from './service';

const CAPABILITY_ACTIONS: Array<[
  keyof ExternalAgentCapabilities,
  string,
]> = [
  ['canAnalyzeCode', 'analyze_code'],
  ['canWriteCode', 'write_code'],
  ['canRunCommands', 'run_commands'],
  ['canPush', 'push'],
  ['canCreatePullRequest', 'create_pull_request'],
  ['canProposeTasks', 'propose_tasks'],
  ['canProposePhases', 'propose_phases'],
];

const ACTIVE_STATUSES: AgentDispatchStatus[] = [
  'needs_confirmation',
  'queued',
  'claimed',
  'in_progress',
  'waiting_for_user',
];

const RETRYABLE_STATUSES: AgentDispatchStatus[] = [
  'failed',
  'timed_out',
  'dead_letter',
  'cancelled',
];

export interface TaskDelegationTarget {
  id: string;
  name: string;
  type: ExternalAgentType;
  description: string | null;
  executionLocality: ExternalAgentLocality;
  dataClassification: AgentDataClassification;
  allowedActions: string[];
  companyId: string | null;
}

export type TaskDelegationDisplayState =
  | 'preview'
  | 'queued'
  | 'running'
  | 'idle'
  | 'waiting_for_user'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'completed';

export interface TaskDelegationSummary {
  dispatchId: string;
  targetId: string;
  targetName: string;
  targetType: ExternalAgentType;
  companyId: string | null;
  responsibleAgent: string | null;
  responsibleAgentId: string | null;
  issueIdentifier: string | null;
  issueUrl: string | null;
  runId: string | null;
  runUrl: string | null;
  locality: ExternalAgentLocality;
  canonicalState: AgentDispatchStatus;
  displayState: TaskDelegationDisplayState;
  latestProgress: string | null;
  blocker: string | null;
  pendingApproval: boolean;
  pullRequestUrl: string | null;
  commitSha: string | null;
  checks: AgentResultReference[];
  artifacts: AgentResultReference[];
  disclosedFields: string[];
  allowedActions: string[];
  errorMessage: string | null;
  updatedAt: string;
  canCancel: boolean;
  canRetry: boolean;
}

export interface TaskDelegationContext {
  taskId: string;
  eligibleTargets: TaskDelegationTarget[];
  assignments: TaskDelegationSummary[];
  syncError: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstBlocker(detail: Record<string, unknown> | null) {
  const blockers = record(detail?.blockers);
  const execution = record(blockers?.execution);
  const attention = record(blockers?.attention);
  const issue = Array.isArray(blockers?.issues)
    ? record(blockers.issues[0])
    : null;
  return text(execution?.message)
    ?? text(execution?.reason)
    ?? text(attention?.message)
    ?? text(attention?.reason)
    ?? text(issue?.title)
    ?? text(issue?.reason);
}

function displayState(
  dispatch: AgentDispatchRecord,
  detail: Record<string, unknown> | null,
): TaskDelegationDisplayState {
  if (text(detail?.issueStatus) === 'blocked') return 'blocked';
  const progress = record(detail?.progress);
  if (text(progress?.livenessState) === 'idle') return 'idle';
  switch (dispatch.status) {
    case 'needs_confirmation':
      return 'preview';
    case 'claimed':
    case 'in_progress':
      return 'running';
    case 'waiting_for_user':
      return 'waiting_for_user';
    case 'failed':
    case 'dead_letter':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      return 'queued';
  }
}

function providerLink(endpoint: string | null, path: string | null) {
  if (!endpoint || !path) return null;
  try {
    return new URL(path, endpoint).toString();
  } catch {
    return null;
  }
}

function assignmentSummary(
  dispatch: AgentDispatchRecord,
  target: Awaited<ReturnType<typeof listExternalAgents>>[number] | undefined,
): TaskDelegationSummary {
  const detail = record(dispatch.providerDetail);
  const executor = record(detail?.executor);
  const progress = record(detail?.progress);
  const pendingApprovals = Array.isArray(detail?.pendingApprovals)
    ? detail.pendingApprovals
    : [];
  const runId = text(detail?.runId);
  const issueId = text(detail?.issueId) ?? dispatch.providerTaskId;
  return {
    dispatchId: dispatch.id,
    targetId: dispatch.externalAgentId,
    targetName: target?.name ?? dispatch.externalAgentId,
    targetType: target?.type ?? 'manual',
    companyId: text(detail?.companyId) ?? target?.providerConfig.paperclip?.companyId ?? null,
    responsibleAgent: text(executor?.name),
    responsibleAgentId: text(executor?.agentId) ?? text(detail?.assigneeAgentId),
    issueIdentifier: text(detail?.issueIdentifier),
    issueUrl: providerLink(target?.endpoint ?? null, issueId ? `/issues/${issueId}` : null),
    runId,
    runUrl: providerLink(
      target?.endpoint ?? null,
      runId && (text(executor?.agentId) ?? text(detail?.assigneeAgentId))
        ? `/agents/${text(executor?.agentId) ?? text(detail?.assigneeAgentId)}/runs/${runId}`
        : null,
    ),
    locality: dispatch.executionLocality,
    canonicalState: dispatch.status,
    displayState: displayState(dispatch, detail),
    latestProgress: text(progress?.message),
    blocker: firstBlocker(detail),
    pendingApproval: pendingApprovals.length > 0,
    pullRequestUrl: dispatch.githubPullRequestUrl,
    commitSha: dispatch.commitSha,
    checks: dispatch.checks ?? [],
    artifacts: dispatch.artifacts ?? [],
    disclosedFields: dispatch.disclosedFields,
    allowedActions: dispatch.allowedActions,
    errorMessage: dispatch.errorMessage,
    updatedAt: dispatch.updatedAt,
    canCancel: ACTIVE_STATUSES.includes(dispatch.status),
    canRetry: RETRYABLE_STATUSES.includes(dispatch.status),
  };
}

async function taskSnapshot(taskId: string) {
  const snapshot = await (await getExternalAgentControlPersistence()).payloads.snapshot({
    taskIds: [taskId],
  });
  if (snapshot.tasks.length !== 1) {
    throw new ExternalAgentError('Task not found', 'NOT_FOUND', 404);
  }
  return snapshot;
}

export async function listEligibleTaskDelegationTargets(taskId: string) {
  const snapshot = await taskSnapshot(taskId);
  const task = snapshot.tasks[0];
  if (task.status === 'done' || task.status === 'cancelled') return [];
  const classification = resolveDispatchClassification([task.connectorType]);
  const agents = await listExternalAgents();
  return agents.flatMap<TaskDelegationTarget>((agent) => {
    if (!agent.enabled || agent.deletedAt) return [];
    if (agent.type === 'copilot-cloud' || agent.type === 'copilot-sdk-workspace') {
      return [];
    }
    try {
      assertClassificationAllowed(
        classification,
        agent.dataPolicy,
        agent.executionLocality,
      );
    } catch (error) {
      if (error instanceof ExternalAgentError) return [];
      throw error;
    }
    const allowedActions = CAPABILITY_ACTIONS.flatMap(([capability, action]) => (
      agent.capabilities[capability] ? [action] : []
    ));
    return [{
      id: agent.id,
      name: agent.name,
      type: agent.type,
      description: agent.description,
      executionLocality: agent.executionLocality,
      dataClassification: classification,
      allowedActions,
      companyId: agent.providerConfig.paperclip?.companyId ?? null,
    }];
  });
}

export async function listTaskDelegationSummaries(taskIds: string[]) {
  if (!taskIds.length) return new Map<string, TaskDelegationSummary>();
  const [dispatches, targets] = await Promise.all([
    (await getExternalAgentControlPersistence()).dispatches.list({
      taskIds,
      limit: Math.min(taskIds.length * 5, 500),
    }),
    listExternalAgents({ includeDeleted: true }),
  ]);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const summaries = new Map<string, TaskDelegationSummary>();
  for (const dispatch of dispatches) {
    for (const taskId of dispatch.scope.taskIds ?? []) {
      if (!summaries.has(taskId)) {
        summaries.set(taskId, assignmentSummary(dispatch, targetById.get(dispatch.externalAgentId)));
      }
    }
  }
  return summaries;
}

export async function getTaskDelegationContext(taskId: string): Promise<TaskDelegationContext> {
  await taskSnapshot(taskId);
  await expireDispatches();
  const persistence = await getExternalAgentControlPersistence();
  let dispatches = await persistence.dispatches.list({ taskIds: [taskId], limit: 50 });
  let syncError: string | null = null;
  const current = dispatches[0];
  if (
    current
    && ACTIVE_STATUSES.includes(current.status)
    && current.providerTaskId
  ) {
    try {
      await reconcileDispatch(current.id);
      dispatches = await persistence.dispatches.list({ taskIds: [taskId], limit: 50 });
    } catch (error) {
      syncError = error instanceof Error ? error.message : 'Delegation status could not be refreshed';
    }
  }
  const targets = await listExternalAgents({ includeDeleted: true });
  const targetById = new Map(targets.map((target) => [target.id, target]));
  return {
    taskId,
    eligibleTargets: await listEligibleTaskDelegationTargets(taskId),
    assignments: dispatches.map((dispatch) => (
      assignmentSummary(dispatch, targetById.get(dispatch.externalAgentId))
    )),
    syncError,
  };
}

export async function previewTaskDelegation(input: {
  taskId: string;
  agentId: string;
  instruction: string;
  allowedActions?: string[];
  idempotencyKey: string;
  callbackBaseUrl?: string;
}) {
  const targets = await listEligibleTaskDelegationTargets(input.taskId);
  const target = targets.find(({ id }) => id === input.agentId);
  if (!target) {
    throw new ExternalAgentError(
      'Execution target is not eligible for this task',
      'DISCLOSURE_BLOCKED',
      403,
    );
  }
  const requested = input.allowedActions ?? target.allowedActions;
  if (requested.some((action) => !target.allowedActions.includes(action))) {
    throw new ExternalAgentError(
      'Requested action is not allowed for this execution target',
      'CAPABILITY_MISMATCH',
      422,
    );
  }
  const persistence = await getExternalAgentControlPersistence();
  const existing = await persistence.dispatches.findPreview(target.id, input.idempotencyKey);
  if (!existing) {
    const active = await persistence.dispatches.list({
      taskIds: [input.taskId],
      limit: 50,
    });
    if (active.some((dispatch) => ACTIVE_STATUSES.includes(dispatch.status))) {
      throw new ExternalAgentError(
        'Task already has an active execution assignment',
        'INVALID_TRANSITION',
        409,
      );
    }
  }
  return createDispatchPreview({
    agentId: target.id,
    instruction: input.instruction,
    scope: { taskIds: [input.taskId] },
    dataClassification: target.dataClassification,
    allowedActions: requested,
    idempotencyKey: input.idempotencyKey,
    callbackBaseUrl: input.callbackBaseUrl,
  });
}
