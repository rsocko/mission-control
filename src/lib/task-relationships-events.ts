export const TASK_RELATIONSHIPS_CHANGED_EVENT = 'mission-control:task-relationships-changed';

export interface TaskRelationshipsChangedDetail {
  taskIds: string[];
  source?: string;
}

export function announceTaskRelationshipsChanged(taskIds: string[], source?: string) {
  window.dispatchEvent(new CustomEvent<TaskRelationshipsChangedDetail>(
    TASK_RELATIONSHIPS_CHANGED_EVENT,
    { detail: { taskIds, source } },
  ));
}
