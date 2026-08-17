import { FolderGit2, ListChecks, ListTodo } from 'lucide-react';
import { LocalSourceIcon } from '@/components/ui/LocalSourceIcon';
import type { TaskPriority } from '@/types';
import { getTaskPriorityVisual, PRIORITY_LABELS } from '@/lib/constants/task-formatting';

export const PROJECT_TASK_PRIORITY_LABELS = PRIORITY_LABELS as Record<TaskPriority, string>;

export function getProjectTaskPriorityColor(priority: TaskPriority | string) {
  return getTaskPriorityVisual(priority).color;
}

export function getProjectTaskConnectorIcon(connectorType: string) {
  if (connectorType === 'local') return LocalSourceIcon;
  if (connectorType === 'github-issues') return FolderGit2;
  if (connectorType === 'microsoft-todo' || connectorType === 'ms-todo') {
    return ListTodo;
  }
  return ListChecks;
}
