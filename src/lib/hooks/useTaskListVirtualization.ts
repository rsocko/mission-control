'use client';

import { useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { getTaskGroupLabels, NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import { DASHBOARD_TASK_ENTITY_LIMIT } from '@/lib/hooks/useDashboardQueries';
import type {
  DashboardTaskResponseViewModel as TaskResponse,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';

export type VirtualRow =
  | { type: 'task'; task: Task }
  | { type: 'header'; label: string; count: number; totalCount?: number }
  | { type: 'load-more' }
  | { type: 'load-more-group'; label: string; remaining: number };

interface UseTaskListVirtualizationOptions {
  taskResponse: TaskResponse;
  groupBy: string;
  collapsedGroups: Set<string>;
  viewDensity: 'compact' | 'comfortable';
  listRef: React.RefObject<HTMLDivElement | null>;
  groupTotalCounts?: Record<string, number>;
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const STATUS_ORDER: Record<string, number> = {
  'To Do': 0,
  'In Progress': 1,
  'Completed': 2,
  'Cancelled': 3,
};

const DUE_DATE_FIXED_ORDER: Record<string, number> = {
  'Overdue': 0,
  'Today': 1,
  // Actual date strings sort naturally after these
  'No Due Date': Number.MAX_SAFE_INTEGER,
};

const EFFORT_ORDER: Record<string, number> = {
  '1': 0,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
  [NO_EFFORT_GROUP_LABEL]: 5,
};
const PLANNING_HORIZON_ORDER: Record<string, number> = {
  Now: 0,
  Next: 1,
  Later: 2,
  Someday: 3,
  'Not set': 4,
};

function getCanonicalGroupOrder(groupBy: string): ((a: string, b: string) => number) | null {
  if (groupBy === 'priority') {
    return (a, b) => (PRIORITY_ORDER[a] ?? 99) - (PRIORITY_ORDER[b] ?? 99);
  }
  if (groupBy === 'status') {
    return (a, b) => (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99);
  }
  if (groupBy === 'effort') {
    return (a, b) => (EFFORT_ORDER[a] ?? 99) - (EFFORT_ORDER[b] ?? 99);
  }
  if (groupBy === 'planningHorizon') {
    return (a, b) => (
      (PLANNING_HORIZON_ORDER[a] ?? 99) - (PLANNING_HORIZON_ORDER[b] ?? 99)
    );
  }
  if (groupBy === 'source') {
    // Keep sources in a stable alphabetical order, with 'local' last
    return (a, b) => {
      if (a === 'local' && b !== 'local') return 1;
      if (b === 'local' && a !== 'local') return -1;
      return a.localeCompare(b);
    };
  }
  if (groupBy === 'dueDate') {
    return (a, b) => {
      const orderA = DUE_DATE_FIXED_ORDER[a] ?? null;
      const orderB = DUE_DATE_FIXED_ORDER[b] ?? null;
      // Both are fixed keys
      if (orderA !== null && orderB !== null) return orderA - orderB;
      // Fixed keys come before/after date strings
      if (orderA !== null) return orderA === Number.MAX_SAFE_INTEGER ? 1 : -1;
      if (orderB !== null) return orderB === Number.MAX_SAFE_INTEGER ? -1 : 1;
      // Both are date strings — sort chronologically
      return a.localeCompare(b);
    };
  }
  if (groupBy === 'list' || groupBy === 'tag') {
    return (a, b) => {
      const aEmpty = a === 'No List' || a === 'Untagged';
      const bEmpty = b === 'No List' || b === 'Untagged';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      return a.localeCompare(b);
    };
  }
  if (groupBy === 'project') {
    return (a, b) => {
      if (a === 'No Project' && b === 'No Project') return 0;
      if (a === 'No Project') return 1;
      if (b === 'No Project') return -1;
      return a.localeCompare(b);
    };
  }
  return null;
}

export function useTaskListVirtualization({
  taskResponse,
  groupBy,
  collapsedGroups,
  viewDensity,
  listRef,
  groupTotalCounts,
}: UseTaskListVirtualizationOptions) {
  const virtualRows = useMemo(
    () => buildTaskListRows({ taskResponse, groupBy, collapsedGroups, groupTotalCounts }),
    [taskResponse.tasks, taskResponse.hasMore, groupBy, collapsedGroups, groupTotalCounts],
  );

  const rowVirtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => {
      const row = virtualRows[index];
      if (!row) return 48;
      if (row.type === 'header') return 32;
      if (row.type === 'load-more' || row.type === 'load-more-group') return 48;
      return viewDensity === 'compact' ? 36 : 56;
    },
    overscan: 8,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  return {
    virtualRows,
    rowVirtualizer,
    virtualItems,
  };
}

type BuildTaskListRowsOptions = Pick<
  UseTaskListVirtualizationOptions,
  'taskResponse' | 'groupBy' | 'collapsedGroups' | 'groupTotalCounts'
>;

export function buildTaskListRows({
  taskResponse,
  groupBy,
  collapsedGroups,
  groupTotalCounts,
}: BuildTaskListRowsOptions): VirtualRow[] {
  const tasks = taskResponse.tasks;
  if (groupBy === 'none' || !tasks.length) {
    const rows: VirtualRow[] = tasks.map((task) => ({ type: 'task', task }));
    if (taskResponse.hasMore) rows.push({ type: 'load-more' });
    return rows;
  }

  const today = groupBy === 'dueDate' ? getClientToday() : '';
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    for (const label of getTaskGroupLabels(task, groupBy, today)) {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(task);
    }
  }

  // Include groups not represented on the first page so each can load independently.
  const groupKeys = new Set(groups.keys());
  for (const [label, count] of Object.entries(groupTotalCounts ?? {})) {
    if (count > 0) groupKeys.add(label);
  }

  // Sort groups by canonical order; tasks within each group keep their API sort order.
  const comparator = getCanonicalGroupOrder(groupBy);
  const sortedKeys = comparator
    ? Array.from(groupKeys).sort(comparator)
    : Array.from(groupKeys);

  const rows: VirtualRow[] = [];
  for (const label of sortedKeys) {
    const groupTasks = groups.get(label) ?? [];
    const totalCount = groupTotalCounts?.[label];
    rows.push({ type: 'header', label, count: groupTasks.length, totalCount });
    if (!collapsedGroups.has(label)) {
      for (const task of groupTasks) rows.push({ type: 'task', task });
      if (
        tasks.length < DASHBOARD_TASK_ENTITY_LIMIT
        && totalCount !== undefined
        && totalCount > groupTasks.length
      ) {
        rows.push({ type: 'load-more-group', label, remaining: totalCount - groupTasks.length });
      }
    }
  }
  if (Object.keys(groupTotalCounts ?? {}).length === 0 && taskResponse.hasMore) {
    rows.push({ type: 'load-more' });
  }
  return rows;
}
