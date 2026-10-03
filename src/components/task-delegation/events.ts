import { requestTaskRefresh } from '@/lib/tasks/task-refresh-events';

export const TASK_DELEGATION_OPEN_EVENT = 'mission-control:open-task-delegation';
export const TASK_DELEGATION_UPDATED_EVENT = 'mission-control:delegation-updated';

export function openTaskDelegation(taskIds: string[]) {
  const unique = [...new Set(taskIds.filter(Boolean))];
  if (!unique.length || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TASK_DELEGATION_OPEN_EVENT, {
    detail: { taskIds: unique },
  }));
}

export function notifyTaskDelegationUpdated(taskIds: string[]) {
  const unique = [...new Set(taskIds.filter(Boolean))];
  if (!unique.length || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TASK_DELEGATION_UPDATED_EVENT, {
    detail: { taskIds: unique },
  }));
  requestTaskRefresh(unique);
}
