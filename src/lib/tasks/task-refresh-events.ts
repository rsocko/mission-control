'use client';

export const TASKS_REFRESH_REQUESTED_EVENT = 'mission-control:tasks-refresh-requested';

export function requestTaskRefresh(taskIds: string[]) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TASKS_REFRESH_REQUESTED_EVENT, {
    detail: { taskIds: [...new Set(taskIds)] },
  }));
}
