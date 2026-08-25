import { parseTaskInput, parseTaskInputForSubmission } from '@/lib/parse-task-input';
import type { ParseTaskInputOptions } from '@/lib/parse-task-input';
import { normalizePendingTaskText, splitCompoundTask } from '@/lib/paste-parser';
import {
  canEditTaskField,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import type { TaskEditPolicy } from '@/types';
import type {
  QuickAddDestination,
  QuickAddPendingTask,
} from '@/components/add-task/quick-add-types';
import { getLocalToday } from '@/lib/utils/client-date';

export interface VisibleQuickAddProject {
  id: string;
  name: string;
}

export interface QuickAddProjectAffordance {
  ariaLabel: string;
  tooltip: string;
}

export function getVisibleQuickAddProject(
  projectId: string | null,
  projectName: string | null,
): VisibleQuickAddProject | null {
  const name = projectName?.trim();
  return projectId && name ? { id: projectId, name } : null;
}

export function resolveQuickAddProjectId(
  explicitProjectId: string | null,
  contextProject: VisibleQuickAddProject | null,
  contextProjectActive: boolean,
): string | undefined {
  return explicitProjectId || (contextProjectActive ? contextProject?.id : undefined);
}

export function getQuickAddProjectAffordance(
  projectName: string,
  active: boolean,
): QuickAddProjectAffordance {
  if (active) {
    return {
      ariaLabel: `Adding tasks to project ${projectName}. Click to remove.`,
      tooltip: `New tasks will be added to ${projectName}. Click to remove.`,
    };
  }

  return {
    ariaLabel: `Add new tasks to project ${projectName}`,
    tooltip: `Add new tasks to ${projectName}`,
  };
}

export function syncQuickAddProjectActive(
  previousProjectId: string | null,
  nextProjectId: string | null,
  currentActive: boolean,
): boolean {
  return previousProjectId === nextProjectId ? currentActive : Boolean(nextProjectId);
}

export interface ResolvedQuickAddDestination {
  listId?: string;
  listName?: string;
  requiresSelection: boolean;
}

export function resolveQuickAddDestination(
  destination: QuickAddDestination,
  contextListId?: string | null,
  contextListName?: string | null,
): ResolvedQuickAddDestination {
  const listId = destination.listId || contextListId || undefined;
  return {
    listId,
    listName: destination.listName || contextListName || undefined,
    requiresSelection: destination.listSelectionMode === 'required' && !listId,
  };
}

export function prepareQuickAddTasks(
  input: string,
  pendingTasks: QuickAddPendingTask[],
  currentInputParentTaskId?: string,
): QuickAddPendingTask[] {
  const cleanInput = normalizePendingTaskText(input.replace(/^\/\S+\s/, ''));
  if (!cleanInput) return [...pendingTasks];

  const compoundParts = splitCompoundTask(cleanInput);
  const currentTasks = (compoundParts && compoundParts.length >= 2 ? compoundParts : [cleanInput])
    .map((text, index): QuickAddPendingTask => ({
      id: compoundParts ? `current-${index}` : 'current',
      text: normalizePendingTaskText(text),
      parentIndex: null,
      parentTaskId: currentInputParentTaskId,
      isComplete: false,
    }));

  return [...pendingTasks, ...currentTasks];
}

export type QuickAddProjectLoadState = 'loading' | 'ready' | 'error';

export type QuickAddSubmissionBlock =
  | { reason: 'empty' }
  | { reason: 'destination-required' }
  | { reason: 'project-loading'; projectName: string }
  | { reason: 'project-load-error'; projectName: string }
  | { reason: 'project-not-found'; projectName: string };

export interface QuickAddSubmissionPlan {
  tasks: QuickAddPendingTask[];
  destination: ResolvedQuickAddDestination;
  block: QuickAddSubmissionBlock | null;
}

export function planQuickAddSubmission({
  input,
  pendingTasks,
  destination,
  contextListId,
  contextListName,
  parseOptions,
  projectsLoadState,
  currentInputParentTaskId,
}: {
  input: string;
  pendingTasks: QuickAddPendingTask[];
  destination: QuickAddDestination;
  contextListId?: string | null;
  contextListName?: string | null;
  parseOptions?: ParseTaskInputOptions;
  projectsLoadState: QuickAddProjectLoadState;
  currentInputParentTaskId?: string;
}): QuickAddSubmissionPlan {
  const tasks = prepareQuickAddTasks(input, pendingTasks, currentInputParentTaskId);
  const resolvedDestination = resolveQuickAddDestination(
    destination,
    contextListId,
    contextListName,
  );

  if (tasks.length === 0) {
    return { tasks, destination: resolvedDestination, block: { reason: 'empty' } };
  }

  const unresolvedProject = tasks
    .map((task) => parseTaskInput(task.text, parseOptions))
    .find((task) => task.project && !task.projectId);
  if (unresolvedProject?.project) {
    const reason = projectsLoadState === 'loading'
      ? 'project-loading'
      : projectsLoadState === 'error'
        ? 'project-load-error'
        : 'project-not-found';
    return {
      tasks,
      destination: resolvedDestination,
      block: { reason, projectName: unresolvedProject.project },
    };
  }

  if (resolvedDestination.requiresSelection) {
    return {
      tasks,
      destination: resolvedDestination,
      block: { reason: 'destination-required' },
    };
  }

  return { tasks, destination: resolvedDestination, block: null };
}

export interface QuickAddCreatedTask {
  id: string;
  editPolicy: TaskEditPolicy;
}

export interface QuickAddMyDayItem {
  taskId: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  status: 'todo' | 'done';
  editPolicy: TaskEditPolicy;
}

export interface QuickAddSubmissionDependencies {
  fetcher?: typeof fetch;
  getToday?: () => string;
  onMyDayItemAdded?: (item: QuickAddMyDayItem) => void;
  onMyDayAddFailed?: (taskId: string, status: number) => void;
}

export interface CreateQuickAddTaskInput {
  task: QuickAddPendingTask;
  destination: QuickAddDestination;
  resolvedDestination: ResolvedQuickAddDestination;
  defaultTags?: string[] | null;
  addToMyDay: boolean;
  contextProject: VisibleQuickAddProject | null;
  contextProjectActive: boolean;
  parseOptions?: ParseTaskInputOptions;
}

export async function createQuickAddTask(
  dependencies: QuickAddSubmissionDependencies,
  input: CreateQuickAddTaskInput,
): Promise<QuickAddCreatedTask> {
  const fetcher = dependencies.fetcher ?? fetch;
  const taskData = parseTaskInputForSubmission(input.task.text, input.parseOptions);
  const projectId = resolveQuickAddProjectId(
    taskData.projectId,
    input.contextProject,
    input.contextProjectActive,
  );
  const tags = new Set(taskData.tags);
  input.defaultTags?.forEach((tag) => tags.add(tag));

  const response = await fetcher('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: taskData.title,
      dueDate: taskData.dueDate,
      priority: taskData.priority || 'none',
      planningHorizon: taskData.planningHorizon,
      connectorType: input.destination.connectorType,
      connectorInstanceId: input.destination.connectorType === 'local'
        ? undefined
        : input.destination.id,
      sourceListId: input.resolvedDestination.listId,
      sourceListName: input.resolvedDestination.listName,
      estimatedDuration: taskData.estimatedDuration || undefined,
      recurrence: taskData.recurrence || undefined,
      effort: taskData.effort || undefined,
      projectIds: projectId ? [projectId] : undefined,
      tagSlugs: tags.size > 0 ? [...tags] : undefined,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create task: ${input.task.text}`);
  }

  const { id, editPolicy } = await response.json() as {
    id: string;
    editPolicy: TaskEditPolicy;
  };

  if (input.task.isComplete) {
    if (!canEditTaskField(editPolicy, 'status')) {
      throw new Error(taskFieldBlockedReason(editPolicy, 'status'));
    }
    const completionResponse = await fetcher(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    if (!completionResponse.ok) {
      throw new Error(`Failed to mark task complete: ${input.task.text}`);
    }
  }

  if (input.addToMyDay) {
    const myDayResponse = await fetcher('/api/my-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: id, date: dependencies.getToday?.() ?? getLocalToday() }),
    });
    if (myDayResponse.ok) {
      dependencies.onMyDayItemAdded?.({
        taskId: id,
        title: taskData.title,
        priority: taskData.priority || 'none',
        dueDate: taskData.dueDate || null,
        connectorType: input.destination.connectorType || 'local',
        sourceListName: input.resolvedDestination.listName || null,
        status: input.task.isComplete ? 'done' : 'todo',
        editPolicy,
      });
    } else {
      dependencies.onMyDayAddFailed?.(id, myDayResponse.status);
    }
  }

  return { id, editPolicy };
}

export async function createQuickAddSubtask(
  dependencies: Pick<QuickAddSubmissionDependencies, 'fetcher'>,
  {
    task,
    parentId,
    parseOptions,
  }: {
    task: QuickAddPendingTask;
    parentId: string;
    parseOptions?: ParseTaskInputOptions;
  },
): Promise<QuickAddCreatedTask> {
  const fetcher = dependencies.fetcher ?? fetch;
  const taskData = parseTaskInput(task.text, parseOptions);
  const response = await fetcher(`/api/tasks/${parentId}/subtasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: taskData.title }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create subtask: ${task.text}`);
  }

  const { subtask, editPolicy } = await response.json() as {
    subtask?: { id: string };
    editPolicy: TaskEditPolicy;
  };
  if (!subtask?.id) {
    throw new Error(`Subtask response missing ID: ${task.text}`);
  }

  if (task.isComplete) {
    if (!canEditTaskField(editPolicy, 'status')) {
      throw new Error(taskFieldBlockedReason(editPolicy, 'status'));
    }
    const completionResponse = await fetcher(`/api/tasks/${subtask.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    if (!completionResponse.ok) {
      throw new Error(`Failed to mark subtask complete: ${task.text}`);
    }
  }

  return { id: subtask.id, editPolicy };
}

export interface QuickAddFailedItem {
  task: QuickAddPendingTask;
  kind: 'task' | 'subtask';
  error: unknown;
}

export interface QuickAddSubmissionResult {
  status: 'success' | 'partial' | 'failure';
  parentCount: number;
  subtaskCount: number;
  createdTasks: QuickAddCreatedTask[];
  failures: QuickAddFailedItem[];
  failedParentTasks: QuickAddPendingTask[];
  retryTasks: QuickAddPendingTask[];
  singleTaskMeta?: {
    title: string;
    listName: string | null;
    priority: string | null;
    dueDate: string | null;
    dueDateLabel: string | null;
  };
}

export async function submitQuickAdd(
  dependencies: QuickAddSubmissionDependencies,
  {
    plan,
    destination,
    defaultTags,
    addToMyDay,
    contextProject,
    contextProjectActive,
    parseOptions,
  }: {
    plan: QuickAddSubmissionPlan;
    destination: QuickAddDestination;
    defaultTags?: string[] | null;
    addToMyDay: boolean;
    contextProject: VisibleQuickAddProject | null;
    contextProjectActive: boolean;
    parseOptions?: ParseTaskInputOptions;
  },
): Promise<QuickAddSubmissionResult> {
  if (plan.block) {
    throw new Error(`Cannot submit blocked Quick Add plan: ${plan.block.reason}`);
  }

  const parentEntries = plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.parentIndex === null && !task.parentTaskId);
  const subtaskEntries = plan.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.parentIndex !== null || Boolean(task.parentTaskId));

  const parentResults = await Promise.allSettled(parentEntries.map(({ task }) =>
    createQuickAddTask(dependencies, {
      task,
      destination,
      resolvedDestination: plan.destination,
      defaultTags,
      addToMyDay,
      contextProject,
      contextProjectActive,
      parseOptions,
    })
  ));

  const parentIndexToId = new Map<number, string>();
  parentEntries.forEach(({ index }, resultIndex) => {
    const result = parentResults[resultIndex];
    if (result?.status === 'fulfilled') parentIndexToId.set(index, result.value.id);
  });

  const subtaskResults = await Promise.allSettled(subtaskEntries.map(({ task }) => {
    const parentId = task.parentTaskId ?? (
      task.parentIndex === null ? undefined : parentIndexToId.get(task.parentIndex)
    );
    if (!parentId) {
      return Promise.reject(new Error(`Parent task not created for subtask: ${task.text}`));
    }
    return createQuickAddSubtask(dependencies, { task, parentId, parseOptions });
  }));

  const createdTasks = [...parentResults, ...subtaskResults]
    .filter((result): result is PromiseFulfilledResult<QuickAddCreatedTask> =>
      result.status === 'fulfilled'
    )
    .map((result) => result.value);
  const failures: QuickAddFailedItem[] = [
    ...parentResults.flatMap((result, index) => result.status === 'rejected'
      ? [{ task: parentEntries[index].task, kind: 'task' as const, error: result.reason }]
      : []),
    ...subtaskResults.flatMap((result, index) => result.status === 'rejected'
      ? [{ task: subtaskEntries[index].task, kind: 'subtask' as const, error: result.reason }]
      : []),
  ];
  const status = failures.length === 0
    ? 'success'
    : createdTasks.length > 0
      ? 'partial'
      : 'failure';

  let singleTaskMeta: QuickAddSubmissionResult['singleTaskMeta'];
  if (parentEntries.length === 1 && subtaskEntries.length === 0) {
    const taskData = parseTaskInputForSubmission(parentEntries[0].task.text, parseOptions);
    singleTaskMeta = {
      title: taskData.title,
      listName: plan.destination.listName || null,
      priority: taskData.priority,
      dueDate: taskData.dueDate,
      dueDateLabel: taskData.dueDateLabel,
    };
  }

  return {
    status,
    parentCount: parentEntries.length,
    subtaskCount: subtaskEntries.length,
    createdTasks,
    failures,
    failedParentTasks: failures
      .filter((failure) => failure.kind === 'task')
      .map((failure) => failure.task),
    retryTasks: failures.map((failure) => {
      if (failure.task.parentIndex === null) return failure.task;
      const parentTask = plan.tasks[failure.task.parentIndex];
      const retryParentIndex = failures.findIndex(
        (candidate) => candidate.kind === 'task' && candidate.task === parentTask,
      );
      return {
        ...failure.task,
        parentIndex: retryParentIndex >= 0 ? retryParentIndex : null,
        parentTaskId: retryParentIndex >= 0
          ? undefined
          : parentIndexToId.get(failure.task.parentIndex),
      };
    }),
    singleTaskMeta,
  };
}

export function getQuickAddSubmissionMessage(result: QuickAddSubmissionResult): string {
  if (result.status === 'success') {
    if (result.parentCount === 0) {
      return `Added ${result.subtaskCount} ${result.subtaskCount === 1 ? 'subtask' : 'subtasks'}`;
    }
    const subtaskSuffix = result.subtaskCount > 0
      ? ` (${result.subtaskCount} subtask${result.subtaskCount === 1 ? '' : 's'})`
      : '';
    return `Added ${result.parentCount} ${result.parentCount === 1 ? 'task' : 'tasks'}${subtaskSuffix}`;
  }

  const successCount = result.createdTasks.length;
  if (successCount === 0) return 'Unable to add tasks';
  return `Added ${successCount} ${successCount === 1 ? 'item' : 'items'} · ${result.failures.length} still pending`;
}

export class QuickAddRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'QuickAddRequestError';
  }
}

export async function applyQuickAddWorkflowTemplate(
  dependencies: Pick<QuickAddSubmissionDependencies, 'fetcher'>,
  {
    templateId,
    destination,
    selectedIndices,
  }: {
    templateId: string;
    destination: QuickAddDestination;
    selectedIndices: number[];
  },
): Promise<void> {
  const response = await (dependencies.fetcher ?? fetch)('/api/subtask-templates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId,
      connectorType: destination.connectorType,
      sourceListId: destination.listId,
      sourceListName: destination.listName,
      selectedIndices,
    }),
  });
  if (response.ok) return;

  const payload = await response.json().catch(() => null) as { error?: string } | null;
  throw new QuickAddRequestError(
    payload?.error || `Failed to create tasks (${response.status})`,
    response.status,
  );
}

export interface UndoQuickAddResult {
  closedConnectorType?: string;
}

export async function undoQuickAddTasks(
  dependencies: Pick<QuickAddSubmissionDependencies, 'fetcher'>,
  taskIds: string[],
): Promise<UndoQuickAddResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const responses = await Promise.all(
    taskIds.map((id) => fetcher(`/api/tasks/${id}`, { method: 'DELETE' })),
  );
  if (responses.some((response) => !response.ok)) {
    throw new QuickAddRequestError('Undo failed — task could not be removed');
  }

  const bodies = await Promise.all(
    responses.map((response) => response.json().catch(() => ({})) as Promise<{
      action?: string;
      connectorType?: string;
    }>),
  );
  return {
    closedConnectorType: bodies.find((body) => body.action === 'closed')?.connectorType,
  };
}

const SUGGESTION_CONFIDENCE_THRESHOLD = 0.4;

export function filterQuickAddSuggestion(
  suggestion: QuickSortSuggestion,
): QuickSortSuggestion | null {
  const priority = suggestion.priority
    && suggestion.priority.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD
    ? suggestion.priority
    : null;
  const effort = suggestion.effort
    && suggestion.effort.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD
    ? suggestion.effort
    : null;
  const tags = suggestion.tags.filter(
    (tag) => tag.confidence >= SUGGESTION_CONFIDENCE_THRESHOLD,
  );
  if (!priority && !effort && tags.length === 0) return null;
  return { priority, effort, tags };
}

export function mergeQuickAddSuggestions(
  base: QuickSortSuggestion | null | undefined,
  override: QuickSortSuggestion | null | undefined,
): QuickSortSuggestion | null {
  if (!base && !override) return null;
  if (!base) return override ?? null;
  if (!override) return base;

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const tags: QuickSortSuggestion['tags'] = [];
  for (const tag of [...override.tags, ...base.tags]) {
    const normalizedName = tag.name.toLowerCase();
    if (!seenIds.has(tag.id) && !seenNames.has(normalizedName)) {
      seenIds.add(tag.id);
      seenNames.add(normalizedName);
      tags.push(tag);
    }
  }

  const priority = override.priority ?? base.priority;
  const effort = override.effort ?? base.effort;
  if (!priority && !effort && tags.length === 0) return null;
  return { priority, effort, tags };
}

export async function fetchQuickAddSuggestion(
  dependencies: Pick<QuickAddSubmissionDependencies, 'fetcher'>,
  taskId: string,
): Promise<QuickSortSuggestion | null> {
  const response = await (dependencies.fetcher ?? fetch)(
    `/api/tasks/quick-sort/suggestions?taskIds=${taskId}`,
  );
  if (!response.ok) return null;

  const payload = await response.json() as {
    suggestions?: Record<string, QuickSortSuggestion | undefined>;
  };
  const suggestion = payload.suggestions?.[taskId];
  return suggestion ? filterQuickAddSuggestion(suggestion) : null;
}
