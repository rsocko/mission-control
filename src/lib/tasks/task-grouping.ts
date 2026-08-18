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

export function updateGroupCountsForTaskChange(
  counts: Record<string, number>,
  groupBy: string,
  today: string,
  previousTask: Task | null,
  nextTask: Task | null,
): Record<string, number> {
  const previousLabels = new Set(
    previousTask ? getTaskGroupLabels(previousTask, groupBy, today) : [],
  );
  const nextLabels = new Set(
    nextTask ? getTaskGroupLabels(nextTask, groupBy, today) : [],
  );
  const nextCounts = { ...counts };

  for (const label of previousLabels) {
    if (!nextLabels.has(label) && label in nextCounts) {
      nextCounts[label] = Math.max(0, nextCounts[label] - 1);
    }
  }
  for (const label of nextLabels) {
    if (!previousLabels.has(label)) {
      nextCounts[label] = (nextCounts[label] ?? 0) + 1;
    }
  }

  return nextCounts;
}

interface ResolveGroupLoadOffsetOptions {
  tasks: Task[];
  groupBy: string;
  groupLabel: string;
  today: string;
  loadedTaskGroups: ReadonlyMap<string, string>;
  savedOffset?: number;
}

export function resolveGroupLoadOffset({
  tasks,
  groupBy,
  groupLabel,
  today,
  loadedTaskGroups,
  savedOffset,
}: ResolveGroupLoadOffsetOptions): {
  offset: number;
  staleTaskIds: string[];
  staleGroupLabels: string[];
} {
  const visibleTasks = new Map<string, Task>();
  for (const task of tasks) visibleTasks.set(task.id, task);
  const staleTaskIds: string[] = [];
  const staleGroupLabels = new Set<string>();
  for (const [taskId, loadedFromGroup] of loadedTaskGroups) {
    const visibleTask = visibleTasks.get(taskId);
    if (
      !visibleTask
      || !getTaskGroupLabels(visibleTask, groupBy, today).includes(loadedFromGroup)
    ) {
      staleTaskIds.push(taskId);
      staleGroupLabels.add(loadedFromGroup);
    }
  }
  const reset = staleGroupLabels.has(groupLabel);
  const initialOffset = countLoadedTasksForGroup(
    tasks,
    groupBy,
    groupLabel,
    today,
    new Set(loadedTaskGroups.keys()),
  );

  return {
    offset: reset ? initialOffset : savedOffset ?? initialOffset,
    staleTaskIds,
    staleGroupLabels: [...staleGroupLabels],
  };
}
