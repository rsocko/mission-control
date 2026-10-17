import type { LocalDisposition } from '@/types';

export type TaskRemovalAction = 'dismissed' | 'cancelled' | 'closed' | 'deleted';

export interface TaskRemovalResult {
  action: TaskRemovalAction;
  restorable: boolean;
}

export interface RemovedTask {
  id: string;
  previousLocalDisposition: LocalDisposition;
  result: TaskRemovalResult;
}

export async function removeTask(taskId: string): Promise<TaskRemovalResult> {
  const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({})) as Partial<TaskRemovalResult> & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(data.error || 'Failed to remove task');
  }
  if (
    data.action !== 'dismissed'
    && data.action !== 'cancelled'
    && data.action !== 'closed'
    && data.action !== 'deleted'
  ) {
    throw new Error('Task removal returned an invalid result');
  }
  return {
    action: data.action,
    restorable: data.restorable === true,
  };
}

export function taskRemovalResultLabel(result: TaskRemovalResult): string {
  switch (result.action) {
    case 'dismissed':
      return 'Task dismissed in Mission Control';
    case 'cancelled':
      return 'Task cancelled';
    case 'closed':
      return 'Task closed at source';
    case 'deleted':
      return result.restorable ? 'Task deleted' : 'Task deleted from source';
  }
}

export function canUndoTaskRemoval(result: TaskRemovalResult): boolean {
  return result.restorable || result.action === 'dismissed';
}

export async function undoTaskRemoval(
  taskId: string,
  result: TaskRemovalResult,
  previousLocalDisposition: LocalDisposition,
): Promise<void> {
  const response = result.restorable
    ? await fetch(`/api/tasks/${taskId}/restore`, { method: 'POST' })
    : await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition: previousLocalDisposition }),
      });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || 'Failed to restore task');
  }
}

export async function removeTasks(
  tasks: Array<{ id: string; localDisposition: LocalDisposition }>,
): Promise<{ succeeded: RemovedTask[]; failed: string[] }> {
  const results = await Promise.all(tasks.map(async (task) => {
    try {
      return {
        ok: true as const,
        removed: {
          id: task.id,
          previousLocalDisposition: task.localDisposition,
          result: await removeTask(task.id),
        },
      };
    } catch {
      return { ok: false as const, id: task.id };
    }
  }));
  return {
    succeeded: results.flatMap((result) => result.ok ? [result.removed] : []),
    failed: results.flatMap((result) => result.ok ? [] : [result.id]),
  };
}

export function undoableTaskRemovals(tasks: RemovedTask[]): RemovedTask[] {
  return tasks.filter((task) => canUndoTaskRemoval(task.result));
}

export async function undoTaskRemovals(tasks: RemovedTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => (
    undoTaskRemoval(task.id, task.result, task.previousLocalDisposition)
  )));
  const failureCount = results.filter((result) => result.status === 'rejected').length;
  if (failureCount > 0) {
    throw new Error(`Failed to restore ${failureCount} task${failureCount === 1 ? '' : 's'}`);
  }
}

export function bulkTaskRemovalLabel(removedCount: number, undoableCount: number): string {
  const base = `${removedCount} task${removedCount === 1 ? '' : 's'} removed`;
  if (undoableCount === 0 || undoableCount === removedCount) return base;
  return `${base}; ${undoableCount} can be undone`;
}
