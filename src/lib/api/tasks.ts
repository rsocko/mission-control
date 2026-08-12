/**
 * Client-side API layer for task operations.
 *
 * Centralizes all `/api/tasks` fetch calls into typed, reusable functions.
 * Every function returns the parsed JSON response and throws on HTTP errors.
 */
import { normalizeTraceId } from '@/lib/trace-id';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, code?: string, traceId?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.traceId = traceId;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error || `Request failed: ${res.status} ${res.statusText}`;
    throw new ApiRequestError(
      message,
      res.status,
      typeof body?.code === 'string' ? body.code : undefined,
      normalizeTraceId(body?.traceId),
    );
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  title: string;
  description?: string;
  dueDate?: string;
  priority?: string;
  connectorType?: string;
  sourceListId?: string;
  sourceListName?: string;
  tags?: string[];
  projectIds?: string[];
  subtasks?: { title: string }[];
  estimatedDuration?: number;
  recurrence?: string;
}

/** POST /api/tasks — create a new task. */
export function createTask(payload: CreateTaskPayload) {
  return request<{ id: string }>('/api/tasks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

/** GET /api/tasks/:id — fetch a single task by ID. */
export function getTask<T = Record<string, unknown>>(taskId: string) {
  return request<T>(`/api/tasks/${taskId}`);
}

/** PATCH /api/tasks/:id — update one or more fields on a task. */
export function updateTask(taskId: string, updates: Record<string, unknown>) {
  return request<Record<string, unknown>>(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(updates),
  });
}

/** DELETE /api/tasks/:id — delete a task. */
export function deleteTask(taskId: string) {
  return request<void>(`/api/tasks/${taskId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Status shortcuts
// ---------------------------------------------------------------------------

/** Mark a task as done. */
export function completeTask(taskId: string) {
  return updateTask(taskId, { status: 'done' });
}

/** Re-open a completed task. */
export function reopenTask(taskId: string) {
  return updateTask(taskId, { status: 'todo', completedAt: null });
}

// ---------------------------------------------------------------------------
// Tag operations
// ---------------------------------------------------------------------------

/** POST /api/tasks/:id/tags — add tags to a task. */
export function addTaskTags(taskId: string, tags: string[]) {
  return request<Record<string, unknown>>(`/api/tasks/${taskId}/tags`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ tags }),
  });
}

/** DELETE /api/tasks/:id/tags — remove a tag from a task. */
export function removeTaskTag(taskId: string, tagId: string) {
  return request<void>(`/api/tasks/${taskId}/tags`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
    body: JSON.stringify({ tagId }),
  });
}

// ---------------------------------------------------------------------------
// Move / list operations
// ---------------------------------------------------------------------------

/** POST /api/tasks/:id/move-to-list — move a task to a different list. */
export function moveTaskToList(
  taskId: string,
  targetListId: string,
  targetListName?: string,
) {
  return request<Record<string, unknown>>(`/api/tasks/${taskId}/move-to-list`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ targetListId, targetListName }),
  });
}

export interface MovePreviewRequest {
  taskId: string;
  targetConnectorInstanceId: string;
  targetSourceListId?: string;
}

export interface MoveFieldMapping {
  field: string;
  status: 'mapped' | 'converted' | 'lossy' | 'dropped';
  sourceValue: string | null;
  targetValue: string | null;
  warning?: string;
}

export interface MovePreviewResponse {
  task: { id: string; title: string; connectorType: string; connectorInstanceId: string; sourceListId?: string };
  targetConnector: { id: string; type: string; name: string };
  targetLists: Array<{ id: string; name: string; sourceId: string; groupId?: string | null; groupName?: string | null }>;
  fieldMappings: MoveFieldMapping[];
  subtasks: {
    count: number;
    strategy: 'move-as-subtasks' | 'flatten-to-checklist' | 'preserve-details-and-steps';
    warning?: string;
  } | null;
  hasLossyFields: boolean;
  isNativeTransfer: boolean;
  nativeTransferNote: string | null;
  sourceActions: Array<{ action: 'move' | 'copy'; label: string; description: string }>;
  suggestion: string | null;
}

/** POST /api/tasks/move/preview — preview field mapping for a cross-source move. */
export function previewTaskMove(payload: MovePreviewRequest) {
  return request<MovePreviewResponse>('/api/tasks/move/preview', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export interface MoveExecuteRequest {
  taskId: string;
  targetConnectorInstanceId: string;
  targetSourceListId: string;
  sourceAction: 'move' | 'copy';
  subtaskStrategy?: 'move-as-subtasks' | 'flatten-to-checklist' | 'preserve-details-and-steps';
  addCrossReference?: boolean;
}

export interface MoveExecuteResponse {
  newTaskId: string;
  newSourceId: string;
  sourceAction: 'move' | 'copy';
  nativeTransfer?: boolean;
  subtasksMoved: number;
  warnings: string[];
}

/** POST /api/tasks/move/execute — execute a cross-source task move or copy. */
export function executeTaskMove(payload: MoveExecuteRequest) {
  return request<MoveExecuteResponse>('/api/tasks/move/execute', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Subtask operations
// ---------------------------------------------------------------------------

/** GET /api/tasks/:id/subtasks — fetch subtasks for a task. */
export function getSubtasks<T = { subtasks: unknown[] }>(taskId: string) {
  return request<T>(`/api/tasks/${taskId}/subtasks`);
}

/** POST /api/tasks/:id/subtasks — create a subtask. */
export function createSubtask(taskId: string, title: string) {
  return request<{ id: string }>(`/api/tasks/${taskId}/subtasks`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });
}
