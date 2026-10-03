export const TASK_DELEGATION_OPEN_EVENT = 'mission-control:open-task-delegation';

export function openTaskDelegation(taskIds: string[]) {
  const unique = [...new Set(taskIds.filter(Boolean))];
  if (!unique.length || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TASK_DELEGATION_OPEN_EVENT, {
    detail: { taskIds: unique },
  }));
}
