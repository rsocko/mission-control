import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import { getTaskStatusGroupLabel } from './task-status-groups';

export const NO_EFFORT_GROUP_LABEL = 'No Effort';

export function getTaskGroupLabels(task: Task, groupBy: string, today: string): string[] {
  switch (groupBy) {
    case 'source':
      return [task.connectorType || 'local'];
    case 'list':
      return [task.sourceListName || 'No List'];
    case 'status':
      return [getTaskStatusGroupLabel(task.status)];
    case 'priority':
      return [task.priority || 'none'];
    case 'effort':
      return [task.effort == null ? NO_EFFORT_GROUP_LABEL : String(task.effort)];
    case 'dueDate':
      if (!task.dueDate) return ['No Due Date'];
      if (task.dueDate < today) return ['Overdue'];
      if (task.dueDate === today) return ['Today'];
      return [task.dueDate];
    case 'tag':
      return task.tags?.length
        ? [...new Set(task.tags.map((tag) => tag.name))]
        : ['Untagged'];
    case 'project':
      return task.projectPhaseMemberships?.length
        ? [...new Set(task.projectPhaseMemberships.map((membership) => (
            membership.phaseName
              ? `${membership.projectName} › ${membership.phaseName}`
              : `${membership.projectName} › Unphased`
          )))]
        : ['No Project'];
    default:
      return ['All'];
  }
}

export function countLoadedTasksForGroup(
  tasks: Task[],
  groupBy: string,
  groupLabel: string,
  today: string,
  ignoredTaskIds: ReadonlySet<string> = new Set(),
): number {
  return tasks.filter(
    (task) => !ignoredTaskIds.has(task.id)
      && getTaskGroupLabels(task, groupBy, today).includes(groupLabel),
  ).length;
}
