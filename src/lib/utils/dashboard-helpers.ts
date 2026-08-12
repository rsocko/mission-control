import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { filterTasksByKeyword } from '@/lib/utils/filterTasksByKeyword';
import type { Task, TaskResponse } from '@/types/dashboard';

export function removeTaskFromResponse(response: TaskResponse, taskId: string, task: Task): TaskResponse {
  if (!response.tasks.some((candidate) => candidate.id === taskId)) return response;

  const nextTasks = response.tasks.filter((candidate) => candidate.id !== taskId);
  const nextSourceCounts = { ...response.sourceCounts };
  const currentSourceCount = nextSourceCounts[task.connectorType] || 0;
  if (currentSourceCount > 0) {
    nextSourceCounts[task.connectorType] = currentSourceCount - 1;
  }

  return {
    ...response,
    tasks: nextTasks,
    total: Math.max(0, response.total - 1),
    sourceCounts: nextSourceCounts,
    stats: {
      ...response.stats,
      totalOpen: Math.max(0, response.stats.totalOpen - 1),
      overdue: task.dueDate && task.dueDate < getClientToday()
        ? Math.max(0, response.stats.overdue - 1)
        : response.stats.overdue,
      dueThisWeek: task.dueDate && isDueThisWeek(task.dueDate)
        ? Math.max(0, response.stats.dueThisWeek - 1)
        : response.stats.dueThisWeek,
      highPriority: task.priority === 'high' || task.priority === 'critical'
        ? Math.max(0, response.stats.highPriority - 1)
        : response.stats.highPriority,
      assignedToMe: isAssignedToMe(task)
        ? Math.max(0, response.stats.assignedToMe - 1)
        : response.stats.assignedToMe,
    },
  };
}

export function restoreTaskToResponse(response: TaskResponse, task: Task, index: number): TaskResponse {
  if (response.tasks.some((candidate) => candidate.id === task.id)) return response;

  const nextTasks = [...response.tasks];
  nextTasks.splice(Math.min(index, nextTasks.length), 0, task);

  return {
    ...response,
    tasks: nextTasks,
    total: response.total + 1,
    sourceCounts: {
      ...response.sourceCounts,
      [task.connectorType]: (response.sourceCounts[task.connectorType] || 0) + 1,
    },
    stats: {
      ...response.stats,
      totalOpen: response.stats.totalOpen + 1,
      overdue: task.dueDate && task.dueDate < getClientToday()
        ? response.stats.overdue + 1
        : response.stats.overdue,
      dueThisWeek: task.dueDate && isDueThisWeek(task.dueDate)
        ? response.stats.dueThisWeek + 1
        : response.stats.dueThisWeek,
      highPriority: task.priority === 'high' || task.priority === 'critical'
        ? response.stats.highPriority + 1
        : response.stats.highPriority,
      assignedToMe: isAssignedToMe(task)
        ? response.stats.assignedToMe + 1
        : response.stats.assignedToMe,
    },
  };
}

export function replaceTaskInKeywordFilteredResponse(
  response: TaskResponse,
  updatedTask: Task,
  keywordFilter: string,
): TaskResponse {
  const previousTask = response.tasks.find((task) => task.id === updatedTask.id);
  if (!previousTask) return response;

  if (keywordFilter.trim() && filterTasksByKeyword([updatedTask], keywordFilter).length === 0) {
    return removeTaskFromResponse(response, updatedTask.id, previousTask);
  }

  return {
    ...response,
    tasks: response.tasks.map((task) => task.id === updatedTask.id ? updatedTask : task),
  };
}

export function isAssignedToMe(task: Pick<Task, 'connectorType' | 'assignee'>) {
  if (task.connectorType === 'microsoft-todo' || task.connectorType === 'ms-todo' || task.connectorType === 'local') {
    return true;
  }
  return !!task.assignee;
}

export function isDueThisWeek(dueDate: string) {
  const today = getClientToday();
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const weekFromNow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return dueDate >= today && dueDate <= weekFromNow;
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const datePart = dateStr.split('T')[0];
  const parts = datePart.split('-');
  if (parts.length < 3) return '';
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d || isNaN(y) || isNaN(m) || isNaN(d)) return '';
  const taskDate = new Date(y, m - 1, d);
  if (isNaN(taskDate.getTime())) return '';
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((taskDate.getTime() - todayMidnight.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays < -1) return `${Math.abs(diffDays)}d ago`;
  if (diffDays <= 7) return `In ${diffDays}d`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (taskDate.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return taskDate.toLocaleDateString('en-US', opts);
}

export function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function formatSyncTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
