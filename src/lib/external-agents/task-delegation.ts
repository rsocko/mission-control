import 'server-only';

import type {
  AgentDispatchRecord,
  AgentDispatchStatus,
  AgentPayloadSnapshot,
  AgentResultReference,
  ExternalAgentCapabilities,
  ExternalAgentLocality,
  ExternalAgentType,
  PaperclipProviderConfig,
} from './contracts';
import { ExternalAgentError } from './errors';
import { getExternalAgentControlPersistence } from './persistence';
import {
  assertClassificationAllowed,
  assertRichTaskContextAllowed,
  resolveDispatchClassification,
} from './policy';
import {
  getExternalAgent,
  listExternalAgents,
  resolveExternalAgentCredential,
  resolveGitHubAgentCredential,
} from './registry';
import {
  createDispatchPreview,
  expireDispatches,
  reconcileDispatch,
} from './service';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { parseSourceId } from '@/lib/connectors/github-issues/issue-transformer';
import { validatePaperclipConnection } from './paperclip';

const CAPABILITY_ACTIONS: Array<[keyof ExternalAgentCapabilities, string]> = [
  ['canAnalyzeCode', 'analyze_code'],
  ['canWriteCode', 'write_code'],
  ['canRunCommands', 'run_commands'],
  ['canPush', 'push'],
  ['canCreatePullRequest', 'create_pull_request'],
  ['canProposeTasks', 'propose_tasks'],
  ['canProposePhases', 'propose_phases'],
  ['canPerformM365Actions', 'm365_actions'],
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

const SUPPORTED_TARGET_TYPES = new Set<ExternalAgentType>([
  'copilot-cloud',
  'paperclip',
  'pull-queue',
]);

type SnapshotTask = AgentPayloadSnapshot['tasks'][number];

export interface TaskDelegationRepository {
  repository: string;
  displayName: string;
  connectorId: string;
  connectorName: string;
}

export interface TaskDelegationEligibility {
  taskId: string;
  title: string;
  connectorType: string;
  ready: boolean;
  blocker: string | null;
  repository: string | null;
  repositoryLocked: boolean;
  errorCode?: string;
  statusCode?: number;
}

export interface TaskDelegationTarget {
  id: string;
  name: string;
  type: ExternalAgentType;
  description: string | null;
  alwaysInstructions: string;
  executionLocality: ExternalAgentLocality;
  allowedActions: string[];
  hasCredential: boolean;
  paperclipBinding: {
    companyId: string;
    projectId: string | null;
    assigneeAgentId: string;
    requiredAdapterType: string | null;
  } | null;
  repositories: TaskDelegationRepository[];
  eligibility: TaskDelegationEligibility[];
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
  providerTaskId: string | null;
  locality: ExternalAgentLocality;
  canonicalState: AgentDispatchStatus;
  displayState: TaskDelegationDisplayState;
  latestProgress: string | null;
  blocker: string | null;
  pendingApproval: boolean;
  repository: string | null;
  baseRef: string | null;
  model: string | null;
  createPullRequest: boolean;
  attemptCount: number;
  maxAttempts: number;
  branchRef: string | null;
  pullRequestUrl: string | null;
  commitSha: string | null;
  checks: AgentResultReference[];
  artifacts: AgentResultReference[];
  disclosedFields: string[];
  allowedActions: string[];
  errorMessage: string | null;
  updatedAt: string;
  canCancel: boolean;
  canStopTracking: boolean;
  canRetry: boolean;
  cancellationLimitation: string | null;
}

export interface TaskDelegationContext {
  taskIds: string[];
  tasks: Array<{
    id: string;
    title: string;
    connectorType: string;
  }>;
  targets: TaskDelegationTarget[];
  assignments: Array<TaskDelegationSummary & { taskId: string }>;
  syncErrors: Array<{ dispatchId: string; message: string }>;
}

export interface TaskDelegationPreviewInput {
  taskId: string;
  agentId: string;
  instruction: string;
  allowedActions?: string[];
  operationId: string;
  repository?: string;
  baseRef?: string;
  model?: string;
  createPullRequest?: boolean;
  paperclipBinding?: PaperclipProviderConfig;
  maxAttempts?: number;
  timeoutMs?: number;
  callbackBaseUrl?: string;
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

export function taskDelegationDisplayState(
  dispatch: AgentDispatchRecord,
  detail: Record<string, unknown> | null,
): TaskDelegationDisplayState {
  if (text(detail?.issueStatus) === 'blocked') return 'blocked';
  const progress = record(detail?.progress);
  if (
    text(progress?.livenessState) === 'idle'
    || text(detail?.providerState) === 'idle'
    || text(detail?.state) === 'idle'
  ) {
    return 'idle';
  }
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
  const cloudCancellation = target?.type === 'copilot-cloud'
    && Boolean(dispatch.providerTaskId)
    && ACTIVE_STATUSES.includes(dispatch.status);
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
    providerTaskId: dispatch.providerTaskId,
    locality: dispatch.executionLocality,
    canonicalState: dispatch.status,
    displayState: taskDelegationDisplayState(dispatch, detail),
    latestProgress: text(progress?.message)
      ?? (dispatch.status === 'waiting_for_user' ? 'Waiting for your input or approval.' : null),
    blocker: firstBlocker(detail),
    pendingApproval: pendingApprovals.length > 0,
    repository: dispatch.repository,
    baseRef: dispatch.baseRef,
    model: dispatch.scope.model ?? null,
    createPullRequest: dispatch.scope.createPullRequest === true,
    attemptCount: dispatch.attemptCount,
    maxAttempts: dispatch.maxAttempts,
    branchRef: dispatch.branchRef,
    pullRequestUrl: dispatch.githubPullRequestUrl,
    commitSha: dispatch.commitSha,
    checks: dispatch.checks ?? [],
    artifacts: dispatch.artifacts ?? [],
    disclosedFields: dispatch.disclosedFields,
    allowedActions: dispatch.allowedActions,
    errorMessage: dispatch.errorMessage,
    updatedAt: dispatch.updatedAt,
    canCancel: (
      target?.type !== 'copilot-cloud'
      || !dispatch.providerTaskId
    ) && ACTIVE_STATUSES.includes(dispatch.status),
    canStopTracking: cloudCancellation,
    canRetry: RETRYABLE_STATUSES.includes(dispatch.status),
    cancellationLimitation: cloudCancellation
      ? 'GitHub Agent Tasks does not expose cancellation. Mission Control can stop tracking, but provider work may continue.'
      : null,
  };
}

async function taskSnapshot(taskIds: string[]) {
  const unique = [...new Set(taskIds)];
  if (!unique.length || unique.length > 100) {
    throw new ExternalAgentError(
      'Delegation requires between 1 and 100 task IDs',
      'VALIDATION_ERROR',
      422,
    );
  }
  const snapshot = await (await getExternalAgentControlPersistence()).payloads.snapshot({
    taskIds: unique,
  });
  if (snapshot.tasks.length !== unique.length) {
    throw new ExternalAgentError('One or more tasks were not found', 'NOT_FOUND', 404);
  }
  return snapshot;
}

function sourceRepository(task: SnapshotTask): string | null {
  if (task.connectorType !== 'github-issues' || !task.sourceId) return null;
  const parsed = parseSourceId(task.sourceId);
  return parsed.repo && Number.isSafeInteger(parsed.issueNumber) && parsed.issueNumber > 0
    ? parsed.repo
    : null;
}

async function configuredRepositories(): Promise<TaskDelegationRepository[]> {
  const { connectors, sourceLists } = await (
    await getConnectorManagementPersistence()
  ).getGitHubRepositorySnapshot();
  const repositories = new Map<string, TaskDelegationRepository>();
  for (const connector of connectors) {
    const settings = (connector.settings ?? {}) as { repos?: unknown };
    const configured = Array.isArray(settings.repos)
      ? settings.repos.filter((value): value is string => typeof value === 'string')
      : [];
    const lists = sourceLists.filter((list) => list.connectorInstanceId === connector.id);
    for (const list of lists) {
      repositories.set(list.sourceId.toLowerCase(), {
        repository: list.sourceId,
        displayName: list.name,
        connectorId: connector.id,
        connectorName: connector.name,
      });
    }
    for (const repository of configured) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) continue;
      const key = repository.toLowerCase();
      if (!repositories.has(key)) {
        repositories.set(key, {
          repository,
          displayName: repository,
          connectorId: connector.id,
          connectorName: connector.name,
        });
      }
    }
  }
  return [...repositories.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository));
}

function allowedActions(capabilities: ExternalAgentCapabilities) {
  return CAPABILITY_ACTIONS.flatMap(([capability, action]) => (
    capabilities[capability] ? [action] : []
  ));
}

async function credentialBlocker(agent: Awaited<ReturnType<typeof getExternalAgent>>) {
  if (!agent || agent.authType === 'none') return null;
  try {
    if (agent.type === 'copilot-cloud') {
      await resolveGitHubAgentCredential(agent);
    } else {
      const credential = await resolveExternalAgentCredential(agent);
      if (!credential) return 'Execution credential is unavailable';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Execution credential is unavailable';
  }
}

function eligibilityFor(
  task: SnapshotTask,
  disclosedConnectorTypes: string[],
  target: Awaited<ReturnType<typeof listExternalAgents>>[number],
  activeTaskIds: Set<string>,
  credentialError: string | null,
  repositories: TaskDelegationRepository[],
): TaskDelegationEligibility {
  const repository = sourceRepository(task);
  let blocker: string | null = null;
  if (task.status === 'done' || task.status === 'cancelled') {
    blocker = `Task is ${task.status}`;
  } else if (activeTaskIds.has(task.id)) {
    blocker = 'Task already has an active delegation';
  } else if (credentialError) {
    blocker = credentialError;
  } else {
    const classification = resolveDispatchClassification(disclosedConnectorTypes);
    try {
      assertClassificationAllowed(
        classification,
        target.dataPolicy,
        target.executionLocality,
      );
    } catch (error) {
      blocker = error instanceof Error ? error.message : 'Task data policy blocks this destination';
    }
  }
  if (!blocker && (target.type === 'copilot-cloud' || target.type === 'paperclip')) {
    try {
      assertRichTaskContextAllowed(target.dataPolicy);
    } catch (error) {
      blocker = error instanceof Error
        ? error.message
        : 'Destination disclosure policy is missing required task context';
    }
  }
  if (!blocker && target.type === 'copilot-cloud') {
    if (task.connectorType === 'github-issues' && !repository) {
      blocker = 'GitHub task does not have an exact source repository identity';
    } else if (task.connectorType !== 'github-issues' && repositories.length === 0) {
      blocker = 'No configured and validated GitHub repository is available';
    }
  }
  return {
    taskId: task.id,
    title: task.title,
    connectorType: task.connectorType,
    ready: blocker === null,
    blocker,
    repository,
    repositoryLocked: task.connectorType === 'github-issues',
  };
}

export async function getTaskDelegationContext(
  taskIdsInput: string | string[],
): Promise<TaskDelegationContext> {
  const taskIds = typeof taskIdsInput === 'string' ? [taskIdsInput] : taskIdsInput;
  const persistence = await getExternalAgentControlPersistence();
  const [snapshot, payloadSnapshot] = await Promise.all([
    taskSnapshot(taskIds),
    persistence.payloads.snapshot({ taskIds }),
  ]);
  const connectorTypesByTask = new Map(payloadSnapshot.tasks.map((task) => [
    task.id,
    [
      task.connectorType,
      ...task.subtasks.map((subtask) => subtask.connectorType),
    ],
  ]));
  await expireDispatches();
  let dispatches = await persistence.dispatches.list({
    taskIds,
    limit: Math.min(taskIds.length * 10, 500),
  });
  const syncErrors: TaskDelegationContext['syncErrors'] = [];
  for (const dispatch of dispatches) {
    if (!ACTIVE_STATUSES.includes(dispatch.status) || !dispatch.providerTaskId) continue;
    try {
      await reconcileDispatch(dispatch.id);
    } catch (error) {
      syncErrors.push({
        dispatchId: dispatch.id,
        message: error instanceof Error
          ? error.message
          : 'Delegation status could not be refreshed',
      });
    }
  }
  dispatches = await persistence.dispatches.list({
    taskIds,
    limit: Math.min(taskIds.length * 10, 500),
  });
  const [targets, repositories] = await Promise.all([
    listExternalAgents({ includeDeleted: true }),
    configuredRepositories(),
  ]);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const activeTaskIds = new Set(
    dispatches
      .filter((dispatch) => ACTIVE_STATUSES.includes(dispatch.status))
      .flatMap((dispatch) => dispatch.scope.taskIds ?? []),
  );
  const configuredTargets: TaskDelegationTarget[] = [];
  for (const target of targets) {
    if (
      !target.enabled
      || target.deletedAt
      || !SUPPORTED_TARGET_TYPES.has(target.type)
    ) {
      continue;
    }
    const internal = await getExternalAgent(target.id);
    const credentialError = await credentialBlocker(internal);
    const paperclip = target.providerConfig.paperclip;
    configuredTargets.push({
      id: target.id,
      name: target.name,
      type: target.type,
      description: target.description,
      alwaysInstructions: target.providerConfig.alwaysInstructions ?? '',
      executionLocality: target.executionLocality,
      allowedActions: allowedActions(target.capabilities),
      hasCredential: credentialError === null,
      paperclipBinding: paperclip
        ? {
          companyId: paperclip.companyId,
          projectId: paperclip.projectId ?? null,
          assigneeAgentId: paperclip.assigneeAgentId,
          requiredAdapterType: paperclip.requiredAdapterType ?? null,
        }
        : null,
      repositories: target.type === 'copilot-cloud' ? repositories : [],
      eligibility: snapshot.tasks.map((task) => eligibilityFor(
        task,
        connectorTypesByTask.get(task.id) ?? [task.connectorType],
        target,
        activeTaskIds,
        credentialError,
        repositories,
      )),
    });
  }
  return {
    taskIds,
    tasks: snapshot.tasks.map(({ id, title, connectorType }) => ({
      id,
      title,
      connectorType,
    })),
    targets: configuredTargets,
    assignments: dispatches.flatMap((dispatch) => (
      (dispatch.scope.taskIds ?? [])
        .filter((taskId) => taskIds.includes(taskId))
        .map((taskId) => ({
          taskId,
          ...assignmentSummary(dispatch, targetById.get(dispatch.externalAgentId)),
        }))
    )),
    syncErrors,
  };
}

export async function listEligibleTaskDelegationTargets(taskId: string) {
  const context = await getTaskDelegationContext(taskId);
  return context.targets.filter((target) => target.eligibility[0]?.ready);
}

export async function listTaskDelegationSummaries(taskIds: string[]) {
  if (!taskIds.length) return new Map<string, TaskDelegationSummary>();
  const [dispatches, targets] = await Promise.all([
    (await getExternalAgentControlPersistence()).dispatches.listLatestByTaskIds(taskIds),
    listExternalAgents({ includeDeleted: true }),
  ]);
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const summaries = new Map<string, TaskDelegationSummary>();
  for (const dispatch of dispatches) {
    for (const taskId of dispatch.scope.taskIds ?? []) {
      if (!summaries.has(taskId)) {
        summaries.set(taskId, assignmentSummary(
          dispatch,
          targetById.get(dispatch.externalAgentId),
        ));
      }
    }
  }
  return summaries;
}

function normalizeRepository(value: string | undefined) {
  const repository = value?.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ExternalAgentError(
      'A configured owner/repository target is required',
      'VALIDATION_ERROR',
      422,
    );
  }
  return repository;
}

function delegationIdempotencyKey(
  operationId: string,
  taskId: string,
) {
  return `task-delegation:${operationId}:${taskId}`;
}

export async function hasTaskDelegationOperation(
  agentId: string,
  operationId: string,
  taskId: string,
) {
  return Boolean(await (
    await getExternalAgentControlPersistence()
  ).dispatches.findPreview(
    agentId,
    delegationIdempotencyKey(operationId.trim(), taskId),
  ));
}

export async function previewTaskDelegation(input: TaskDelegationPreviewInput) {
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new ExternalAgentError(
      'operationId is required',
      'VALIDATION_ERROR',
      422,
    );
  }
  const context = await getTaskDelegationContext(input.taskId);
  const target = context.targets.find(({ id }) => id === input.agentId);
  const eligibility = target?.eligibility.find(({ taskId }) => taskId === input.taskId);
  const replay = target && eligibility && !eligibility.ready
    ? await hasTaskDelegationOperation(target.id, operationId, input.taskId)
    : false;
  if (!target || !eligibility || (!eligibility.ready && !replay)) {
    throw new ExternalAgentError(
      eligibility?.blocker ?? 'Execution target is not eligible for this task',
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
  const createPullRequest = input.createPullRequest === true;
  if (createPullRequest && !requested.includes('create_pull_request')) {
    throw new ExternalAgentError(
      'Creating a pull request requires the create_pull_request action',
      'CONFIRMATION_REQUIRED',
      422,
    );
  }
  let repository: string | undefined;
  if (target.type === 'copilot-cloud') {
    if (eligibility.repositoryLocked) {
      repository = eligibility.repository ?? undefined;
      if (
        input.repository
        && repository
        && input.repository.toLowerCase() !== repository.toLowerCase()
      ) {
        throw new ExternalAgentError(
          'GitHub-origin tasks are locked to their source repository. Link or create a task in the other repository before delegating.',
          'REPOSITORY_SCOPE_MISMATCH',
          409,
        );
      }
    } else {
      repository = normalizeRepository(input.repository);
      if (!target.repositories.some(
        (option) => option.repository.toLowerCase() === repository!.toLowerCase(),
      )) {
        throw new ExternalAgentError(
          'Repository is not configured and validated for delegation',
          'REPOSITORY_SCOPE_MISMATCH',
          403,
        );
      }
    }
  }
  let paperclipBinding: PaperclipProviderConfig | undefined;
  if (target.type === 'paperclip') {
    paperclipBinding = input.paperclipBinding ?? (
      target.paperclipBinding
        ? {
          companyId: target.paperclipBinding.companyId,
          assigneeAgentId: target.paperclipBinding.assigneeAgentId,
          ...(target.paperclipBinding.projectId
            ? { projectId: target.paperclipBinding.projectId }
            : {}),
          ...(target.paperclipBinding.requiredAdapterType
            ? { requiredAdapterType: target.paperclipBinding.requiredAdapterType }
            : {}),
        }
        : undefined
    );
    const internal = await getExternalAgent(target.id);
    if (!paperclipBinding || !internal?.endpoint) {
      throw new ExternalAgentError(
        'Paperclip company and assignee are required',
        'VALIDATION_ERROR',
        422,
      );
    }
    await validatePaperclipConnection({
      endpoint: internal.endpoint,
      credential: await resolveExternalAgentCredential(internal),
      config: paperclipBinding,
    });
  }
  const idempotencyKey = delegationIdempotencyKey(operationId, input.taskId);
  return createDispatchPreview({
    agentId: target.id,
    instruction: input.instruction,
    scope: target.type === 'copilot-cloud'
      ? {
        taskIds: [input.taskId],
        repository,
        defaultBranch: input.baseRef,
        baseRef: input.baseRef,
        model: input.model,
        createPullRequest,
      }
      : {
        taskIds: [input.taskId],
        ...(paperclipBinding ? { paperclip: paperclipBinding } : {}),
      },
    allowedActions: requested,
    idempotencyKey,
    callbackBaseUrl: input.callbackBaseUrl,
    maxAttempts: input.maxAttempts,
    timeoutMs: input.timeoutMs,
  });
}
