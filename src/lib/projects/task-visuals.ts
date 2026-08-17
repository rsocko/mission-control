import { FolderGit2, ListChecks, ListTodo } from 'lucide-react';
import { LocalSourceIcon } from '@/components/ui/LocalSourceIcon';
import type { TaskPriority } from '@/types';

export const PROJECT_TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  none: '—',
};

export function getProjectTaskPriorityColor(priority: TaskPriority | string) {
  switch (priority) {
    case 'critical':
      return 'var(--danger)';
    case 'high':
      return 'var(--warning)';
    case 'medium':
      return 'var(--accent-500)';
    case 'low':
      return 'var(--text-secondary)';
    default:
      return 'var(--border-strong)';
  }
}

export function getProjectTaskConnectorIcon(connectorType: string) {
  if (connectorType === 'local') return LocalSourceIcon;
  if (connectorType === 'github-issues') return FolderGit2;
  if (connectorType === 'microsoft-todo' || connectorType === 'ms-todo') {
    return ListTodo;
  }
  return ListChecks;
}
