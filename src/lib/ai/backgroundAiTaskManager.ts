/**
 * Background AI Task Manager — Mission Control
 *
 * Singleton that manages AI tasks (chat, insights, agent dispatch)
 * independently of React component lifecycle. Tasks survive page navigation —
 * if a user sends a chat message and navigates away, the streaming response
 * continues and its result is cached for retrieval when they return.
 *
 * Adapted from RyMessage's backgroundAiTaskManager.
 */

import { uiLogger } from '@/lib/client-logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type BackgroundAiTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type BackgroundAiTaskCategory = 'chat' | 'insight' | 'agent-dispatch' | 'general';

export interface BackgroundAiTask<T = unknown> {
  id: string;
  category: BackgroundAiTaskCategory;
  /** Human-readable label for toast/UI (e.g., "Chat: Plan my day") */
  label: string;
  status: BackgroundAiTaskStatus;
  result?: T;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export type BackgroundAiTaskEvent =
  | { type: 'task-started'; task: BackgroundAiTask }
  | { type: 'task-completed'; task: BackgroundAiTask }
  | { type: 'task-failed'; task: BackgroundAiTask }
  | { type: 'task-cancelled'; task: BackgroundAiTask }
  | { type: 'tasks-cleared' };

type TaskEventListener = (event: BackgroundAiTaskEvent) => void;

function warnClient(message: string, payload?: unknown): void {
  uiLogger.warn(message, payload ? { payload } : undefined);
}

interface SubmitTaskOptions<T> {
  /** Unique key — if a task with this ID is already running, it won't be duplicated */
  id: string;
  category: BackgroundAiTaskCategory;
  label: string;
  /** The async work to execute. Receives an AbortSignal for cooperative cancellation. */
  execute: (signal: AbortSignal) => Promise<T>;
}

// ── Internal State ───────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 3;
const MAX_COMPLETED_TASKS = 50;
const COMPLETED_TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes

const tasks = new Map<string, BackgroundAiTask>();
const abortControllers = new Map<string, AbortController>();
const listeners = new Set<TaskEventListener>();
const taskExecutors = new Map<string, { execute: (signal: AbortSignal) => Promise<unknown>; controller: AbortController }>();
let runningCount = 0;
const pendingQueue: string[] = [];

// ── Event Emitter ────────────────────────────────────────────────────────────

function emit(event: BackgroundAiTaskEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      warnClient('Task event listener error', { err });
    }
  }
}

/**
 * Subscribe to task lifecycle events.
 * Returns an unsubscribe function.
 */
export function onBackgroundAiTaskEvent(listener: TaskEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Submit an AI task to run in the background.
 * If a task with the same `id` is already running or pending, returns the existing task.
 */
export function submitBackgroundAiTask<T>(options: SubmitTaskOptions<T>): BackgroundAiTask<T> {
  const existing = tasks.get(options.id);
  if (existing && (existing.status === 'running' || existing.status === 'pending')) {
    return existing as BackgroundAiTask<T>;
  }

  const task: BackgroundAiTask<T> = {
    id: options.id,
    category: options.category,
    label: options.label,
    status: 'pending',
    createdAt: Date.now(),
  };

  tasks.set(options.id, task);

  const controller = new AbortController();
  abortControllers.set(options.id, controller);
  taskExecutors.set(options.id, { execute: options.execute as (signal: AbortSignal) => Promise<unknown>, controller });

  if (runningCount < MAX_CONCURRENCY) {
    executeTask(task, options.execute, controller);
  } else {
    pendingQueue.push(options.id);
  }

  emit({ type: 'task-started', task });
  return task;
}

function executeTask<T>(
  task: BackgroundAiTask<T>,
  execute: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
): void {
  task.status = 'running';
  runningCount++;

  execute(controller.signal)
    .then((result) => {
      if (controller.signal.aborted) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        emit({ type: 'task-cancelled', task });
      } else {
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        emit({ type: 'task-completed', task });
      }
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        emit({ type: 'task-cancelled', task });
      } else {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = Date.now();
        emit({ type: 'task-failed', task });
        warnClient('Background AI task failed', { err, taskId: task.id, label: task.label });
      }
    })
    .finally(() => {
      runningCount--;
      abortControllers.delete(task.id);
      taskExecutors.delete(task.id);
      drainPendingQueue();
      pruneCompletedTasks();
    });
}

function drainPendingQueue(): void {
  while (runningCount < MAX_CONCURRENCY && pendingQueue.length > 0) {
    const nextId = pendingQueue.shift()!;
    const task = tasks.get(nextId);
    const executor = taskExecutors.get(nextId);
    if (task && executor && task.status === 'pending') {
      executeTask(task, executor.execute, executor.controller);
    }
  }
}

function pruneCompletedTasks(): void {
  const now = Date.now();
  const completedEntries: Array<[string, BackgroundAiTask]> = [];

  for (const [id, task] of tasks) {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      completedEntries.push([id, task]);
    }
  }

  // Remove tasks older than TTL
  for (const [id, task] of completedEntries) {
    if (task.completedAt && now - task.completedAt > COMPLETED_TASK_TTL_MS) {
      tasks.delete(id);
    }
  }

  // Enforce max completed count
  if (completedEntries.length > MAX_COMPLETED_TASKS) {
    const sorted = completedEntries.sort(
      (a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0),
    );
    for (const [id] of sorted.slice(0, completedEntries.length - MAX_COMPLETED_TASKS)) {
      tasks.delete(id);
    }
  }
}

/**
 * Cancel a running or pending task.
 */
export function cancelBackgroundAiTask(taskId: string): void {
  const controller = abortControllers.get(taskId);
  if (controller) {
    controller.abort();
  }

  const pendingIndex = pendingQueue.indexOf(taskId);
  if (pendingIndex !== -1) {
    pendingQueue.splice(pendingIndex, 1);
    const task = tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      emit({ type: 'task-cancelled', task });
    }
  }
}

/**
 * Get a task by ID (for retrieving cached results).
 */
export function getBackgroundAiTask<T = unknown>(taskId: string): BackgroundAiTask<T> | undefined {
  return tasks.get(taskId) as BackgroundAiTask<T> | undefined;
}

/**
 * Get all tasks, optionally filtered by category and/or status.
 */
export function getBackgroundAiTasks(filter?: {
  category?: BackgroundAiTaskCategory;
  status?: BackgroundAiTaskStatus | BackgroundAiTaskStatus[];
}): BackgroundAiTask[] {
  let result = [...tasks.values()];

  if (filter?.category) {
    result = result.filter((t) => t.category === filter.category);
  }

  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    result = result.filter((t) => statuses.includes(t.status));
  }

  return result;
}

/**
 * Check if any tasks are currently running or pending.
 */
export function hasActiveBackgroundAiTasks(category?: BackgroundAiTaskCategory): boolean {
  for (const task of tasks.values()) {
    if (task.status === 'running' || task.status === 'pending') {
      if (!category || task.category === category) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get the count of active (running + pending) tasks.
 */
export function getActiveBackgroundAiTaskCount(category?: BackgroundAiTaskCategory): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === 'running' || task.status === 'pending') {
      if (!category || task.category === category) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Clear all completed/failed/cancelled results. Running tasks are unaffected.
 */
export function clearCompletedBackgroundAiTasks(): void {
  for (const [id, task] of tasks) {
    if (task.status !== 'running' && task.status !== 'pending') {
      tasks.delete(id);
    }
  }
  emit({ type: 'tasks-cleared' });
}
