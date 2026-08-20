export const TASK_CHANGED_EVENT = 'mission-control:task-changed';

export interface TaskChangedEventDetail {
  taskId: string;
}

export function notifyTaskChanged(taskId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<TaskChangedEventDetail>(
    TASK_CHANGED_EVENT,
    { detail: { taskId } },
  ));
}
