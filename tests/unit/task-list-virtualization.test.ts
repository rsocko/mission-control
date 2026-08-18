import { describe, expect, it } from 'vitest';
import { buildTaskListRows } from '@/lib/hooks/useTaskListVirtualization';
import type {
  DashboardTaskResponseViewModel as TaskResponse,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';

function task(id: string, status: string): Task {
  return {
    id,
    title: id,
    status,
    priority: 'none',
    connectorType: 'local',
  } as Task;
}

function response(tasks: Task[], total: number, hasMore = true): TaskResponse {
  return {
    tasks,
    total,
    hasMore,
    stats: {
      totalOpen: total,
      overdue: 0,
      dueThisWeek: 0,
      highPriority: 0,
      assignedToMe: 0,
      myDay: 0,
      recentlyCreated: 0,
      recentlyClosed: 0,
      waiting: 0,
      inbox: 0,
    },
    sourceCounts: {},
    availableTags: [],
  };
}

describe('grouped task rows', () => {
  it('shows server-counted groups that are absent from the loaded page', () => {
    const rows = buildTaskListRows({
      taskResponse: response([task('todo-1', 'todo')], 3),
      groupBy: 'status',
      collapsedGroups: new Set(),
      groupTotalCounts: { 'To Do': 1, 'In Progress': 2 },
    });

    expect(rows).toContainEqual({
      type: 'header',
      label: 'In Progress',
      count: 0,
      totalCount: 2,
    });
    expect(rows).toContainEqual({
      type: 'load-more-group',
      label: 'In Progress',
      remaining: 2,
    });
  });

  it('does not mix global offset pagination into a counted grouped view', () => {
    const rows = buildTaskListRows({
      taskResponse: response([task('todo-1', 'todo')], 2),
      groupBy: 'status',
      collapsedGroups: new Set(),
      groupTotalCounts: { 'To Do': 2 },
    });

    expect(rows.some((row) => row.type === 'load-more')).toBe(false);
    expect(rows).toContainEqual({
      type: 'load-more-group',
      label: 'To Do',
      remaining: 1,
    });
  });

  it('retains global pagination as a fallback until group totals are available', () => {
    const rows = buildTaskListRows({
      taskResponse: response([task('todo-1', 'todo')], 2),
      groupBy: 'status',
      collapsedGroups: new Set(),
      groupTotalCounts: {},
    });

    expect(rows.at(-1)).toEqual({ type: 'load-more' });
  });
});
