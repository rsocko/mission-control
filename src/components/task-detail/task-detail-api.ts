import type {
  HubProject,
  TagConnectorCaps,
  TaskDetail,
  TaskTag,
  WritableConnector,
} from './task-detail-types';
import type { DuplicateCandidate } from './DuplicateTaskPreview';

/**
 * Network primitives behind the task detail panel.
 *
 * These are deliberately free of React so data and mutation workflows can be
 * exercised without rendering the panel.
 */

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Result of a task field mutation, including the parsed response body. */
export interface TaskMutationResult {
  ok: boolean;
  data: Record<string, unknown>;
}

export interface OwlTaskActionUpdate {
  status: string;
  statusReason: string | null;
  snoozedUntil: string | null;
  priority: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
  syncStatus: string;
  title?: string;
  description?: string | null;
  dueDate?: string | null;
}

export interface OwlTaskActionResult {
  ok: boolean;
  task?: OwlTaskActionUpdate;
  error?: string;
}

function isOwlTaskActionUpdate(value: unknown): value is OwlTaskActionUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Partial<OwlTaskActionUpdate>;
  return typeof task.status === 'string'
    && (typeof task.statusReason === 'string' || task.statusReason === null)
    && (typeof task.snoozedUntil === 'string' || task.snoozedUntil === null)
    && typeof task.priority === 'string'
    && !!task.metadata
    && typeof task.metadata === 'object'
    && !Array.isArray(task.metadata)
    && typeof task.updatedAt === 'string'
    && typeof task.syncStatus === 'string'
    && (task.title === undefined || typeof task.title === 'string')
    && (task.description === undefined || typeof task.description === 'string' || task.description === null)
    && (task.dueDate === undefined || typeof task.dueDate === 'string' || task.dueDate === null);
}

/** Apply one source-backed OWL lifecycle or extraction-feedback action. */
export async function postOwlTaskAction(
  taskId: string,
  action: Record<string, unknown>,
): Promise<OwlTaskActionResult> {
  const response = await fetch(`/api/tasks/${taskId}/owl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  const data = await readJson(response);
  return {
    ok: response.ok,
    task: response.ok && isOwlTaskActionUpdate(data.task) ? data.task : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
  };
}

/** Fetch the full task record. Returns null when the API omits it. */
export async function fetchTaskDetail(taskId: string): Promise<TaskDetail | null> {
  const response = await fetch(`/api/tasks/${taskId}`);
  const data = await response.json() as { task?: TaskDetail };
  return data.task ?? null;
}

/** PATCH one or more task fields. */
export async function patchTask(
  taskId: string,
  updates: Record<string, unknown>,
): Promise<TaskMutationResult> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return { ok: response.ok, data: await readJson(response) };
}

/** Permanently remove a task. Throws when the API rejects the request. */
export async function deleteTask(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete task');
}

/** Build the `/api/tags` URL for the task's tag scope and write-back support. */
export function buildTagsUrl(options: {
  connectorCaps?: TagConnectorCaps | null;
  sourceListId?: string | null;
  connectorType?: string | null;
}): string {
  const params = new URLSearchParams();
  if (options.connectorCaps?.tagScope === 'per-list' && options.sourceListId) {
    params.set('listId', options.sourceListId);
  }
  // When the source doesn't support tag write-back, only show tags from that source
  if (options.connectorCaps && !options.connectorCaps.tagWriteBack && options.connectorType) {
    params.set('source', options.connectorType);
  }
  return params.toString() ? `/api/tags?${params.toString()}` : '/api/tags';
}

/** Load selectable tags for the task's scope. */
export async function fetchTagOptions(options: {
  connectorCaps?: TagConnectorCaps | null;
  sourceListId?: string | null;
  connectorType?: string | null;
}): Promise<TaskTag[]> {
  const response = await fetch(buildTagsUrl(options));
  const data = await response.json() as { tags?: TaskTag[] };
  return data.tags ?? [];
}

/** Result of adding tags to a task. */
export interface AddTagsResult {
  ok: boolean;
  addedTagIds: string[];
  rejectedTags: string[];
  error?: string;
}

/** Add tags by name to a task. */
export async function addTaskTags(taskId: string, tags: string[]): Promise<AddTagsResult> {
  const response = await fetch(`/api/tasks/${taskId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  if (!response.ok) {
    const error = await readJson(response);
    return {
      ok: false,
      addedTagIds: [],
      rejectedTags: [],
      error: typeof error.error === 'string' ? error.error : undefined,
    };
  }
  const data = await response.json() as { addedTagIds?: string[]; rejectedTags?: string[] };
  return {
    ok: true,
    addedTagIds: data.addedTagIds ?? [],
    rejectedTags: data.rejectedTags ?? [],
  };
}

/** Remove a single tag from a task. Resolves to false when the API rejects it. */
export async function removeTaskTag(taskId: string, tagId: string): Promise<boolean> {
  const response = await fetch(`/api/tasks/${taskId}/tags`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagId }),
  });
  return response.ok;
}

/** Add a task to a hub project. */
export async function addTaskToProject(projectId: string, taskId: string): Promise<boolean> {
  const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  return response.ok;
}

/** Remove a task from a hub project. */
export async function removeTaskFromProject(projectId: string, taskId: string): Promise<boolean> {
  const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  return response.ok;
}

/** Result of a My Day membership change. */
export interface MyDayMutationResult {
  ok: boolean;
  writeBackAttempted: boolean;
  writeBackSucceeded: boolean;
  error?: string;
}

/** Add the task to, or remove it from, My Day for the given local date. */
export async function setMyDayMembership(options: {
  taskId: string;
  date: string;
  isInMyDay: boolean;
}): Promise<MyDayMutationResult> {
  const response = options.isInMyDay
    ? await fetch(`/api/my-day?${new URLSearchParams({ taskId: options.taskId, date: options.date })}`, {
        method: 'DELETE',
      })
    : await fetch('/api/my-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: options.taskId, date: options.date }),
      });
  const data = await response.json() as {
    error?: string;
    writeBack?: { attempted?: boolean; success?: boolean };
  };
  return {
    ok: response.ok,
    writeBackAttempted: Boolean(data.writeBack?.attempted),
    writeBackSucceeded: Boolean(data.writeBack?.success),
    error: data.error,
  };
}

/** Fetch potential duplicates for a task. */
export async function fetchDuplicateCandidates(taskId: string): Promise<DuplicateCandidate[]> {
  const response = await fetch(`/api/tasks/detect-duplicates?taskId=${taskId}`);
  const data = await response.json() as { duplicates?: DuplicateCandidate[] };
  return data.duplicates ?? [];
}

/** Tag, attachment, and subtask support derived from a connector's capabilities. */
export interface ConnectorSupport {
  connectorCaps: TagConnectorCaps | null;
  supportsAttachments: boolean;
  supportsSubtasks: boolean;
}

/** Local tasks always support attachments and subtasks regardless of connector reports. */
export function isLocalTaskSource(task: {
  connectorType: string;
  sourceId?: string | null;
}): boolean {
  return task.connectorType === 'local' || Boolean(task.sourceId?.startsWith('local:'));
}

/** Translate raw connector capabilities into the panel's support flags. */
export function deriveConnectorSupport(
  capabilities: Record<string, unknown> | undefined,
  isLocal: boolean,
): ConnectorSupport {
  if (!capabilities) {
    return { connectorCaps: null, supportsAttachments: isLocal, supportsSubtasks: isLocal };
  }
  return {
    connectorCaps: {
      tagWriteBack: !!capabilities.tagWriteBack,
      tagCreationMode: (capabilities.tagCreationMode as 'freeform' | 'predefined') || 'freeform',
      tagScope: (capabilities.tagScope as 'global' | 'per-list') || 'global',
    },
    supportsAttachments: isLocal || !!capabilities.attachments,
    supportsSubtasks: isLocal || !!capabilities.subtasks,
  };
}

/** Load connector support flags for the connector instance owning the task. */
export async function fetchConnectorSupport(
  connectorInstanceId: string,
  isLocal: boolean,
  signal?: AbortSignal,
): Promise<ConnectorSupport> {
  const response = await fetch('/api/features', { signal });
  const data = await response.json() as {
    taskDestinations?: Array<{ id: string; capabilities: Record<string, unknown> }>;
  };
  const destination = data.taskDestinations?.find((candidate) => candidate.id === connectorInstanceId);
  return deriveConnectorSupport(destination?.capabilities, isLocal);
}

/** Load every hub project, including hidden ones. */
export async function fetchHubProjects(): Promise<HubProject[]> {
  const response = await fetch('/api/hub-projects?includeHidden=true');
  const data = await response.json() as { projects?: HubProject[] };
  return data.projects ?? [];
}

/** Load connectors that accept newly created tasks. */
export async function fetchWritableConnectors(): Promise<WritableConnector[]> {
  const response = await fetch('/api/connectors');
  const data = await response.json() as {
    connectors?: Array<{ id: string; type: string; name: string; capabilities: Record<string, unknown> }>;
  };
  return (data.connectors ?? [])
    .filter((connector) => connector.capabilities?.taskCreate)
    .map((connector) => ({ id: connector.id, type: connector.type, name: connector.name }));
}

/** Fetch an AI micro-status suggestion for the task, if one exists. */
export async function fetchMicroStatusSuggestion(
  taskId: string,
): Promise<{ status: string; reason: string } | null> {
  const response = await fetch('/api/ai/suggest-micro-status');
  if (!response.ok) return null;
  const data = await response.json() as {
    suggestions?: Array<{ taskId: string; suggestedStatus: string; reason: string }>;
  };
  const match = data.suggestions?.find((suggestion) => suggestion.taskId === taskId);
  return match ? { status: match.suggestedStatus, reason: match.reason } : null;
}

/**
 * Apply an optimistic change, run a mutation, and roll back when it fails.
 *
 * Rollback runs for both rejected mutations and thrown errors, so callers get
 * one consistent recovery path.
 */
export async function runOptimisticMutation(options: {
  apply: () => void;
  mutate: () => Promise<boolean>;
  rollback: () => void;
  onError?: (error: unknown) => void;
}): Promise<boolean> {
  options.apply();
  try {
    const succeeded = await options.mutate();
    if (!succeeded) {
      options.rollback();
      options.onError?.(undefined);
    }
    return succeeded;
  } catch (error) {
    options.rollback();
    options.onError?.(error);
    return false;
  }
}
