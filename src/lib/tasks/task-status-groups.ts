export const TASK_STATUS_GROUP_LABELS = {
  completed: 'Completed',
  cancelled: 'Cancelled',
  inProgress: 'In Progress',
  todo: 'To Do',
} as const;

export type TaskStatusGroupLabel =
  typeof TASK_STATUS_GROUP_LABELS[keyof typeof TASK_STATUS_GROUP_LABELS];

const NON_TODO_STATUS_GROUPS = {
  done: TASK_STATUS_GROUP_LABELS.completed,
  cancelled: TASK_STATUS_GROUP_LABELS.cancelled,
  in_progress: TASK_STATUS_GROUP_LABELS.inProgress,
} as const;

export function getTaskStatusGroupLabel(status: string): TaskStatusGroupLabel {
  return NON_TODO_STATUS_GROUPS[status as keyof typeof NON_TODO_STATUS_GROUPS]
    ?? TASK_STATUS_GROUP_LABELS.todo;
}

export function getTaskStatusGroupFilter(groupLabel: string):
  | { mode: 'include'; statuses: string[] }
  | { mode: 'exclude'; statuses: string[] }
  | null {
  switch (groupLabel) {
    case TASK_STATUS_GROUP_LABELS.completed:
      return { mode: 'include', statuses: ['done'] };
    case TASK_STATUS_GROUP_LABELS.cancelled:
      return { mode: 'include', statuses: ['cancelled'] };
    case TASK_STATUS_GROUP_LABELS.inProgress:
      return { mode: 'include', statuses: ['in_progress'] };
    case TASK_STATUS_GROUP_LABELS.todo:
      return { mode: 'exclude', statuses: ['done', 'cancelled', 'in_progress'] };
    default:
      return null;
  }
}
