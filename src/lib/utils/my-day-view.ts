import type { HubProject } from '@/components/task-list/TaskContextMenu';
import type { MyDayItem } from '@/components/today/types';
import { getLocalToday } from '@/lib/utils/client-date';
import { filterTasksByKeyword } from '@/lib/utils/filterTasksByKeyword';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { PLANNING_HORIZON_LABELS } from '@/lib/tasks/planning-horizon';

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const PLANNING_HORIZON_ORDER: Record<string, number> = {
  now: 0,
  next: 1,
  later: 2,
  someday: 3,
};

const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In Progress',
  todo: 'To Do',
  done: 'Completed',
  cancelled: 'Cancelled',
};

export interface MyDayTaskGroup {
  id: string;
  label: string;
  items: MyDayItem[];
}

export interface MyDayStatusBuckets {
  open: MyDayItem[];
  completed: MyDayItem[];
  cancelled: MyDayItem[];
}

export function partitionMyDayItems(items: MyDayItem[]): MyDayStatusBuckets {
  return items.reduce<MyDayStatusBuckets>((buckets, item) => {
    // Some connectors represent a cancelled upstream task as done, but retain its close reason.
    const hasCancellationReason = item.statusReason !== undefined
      && item.statusReason !== null
      && item.statusReason !== 'completed';
    if (item.status === 'cancelled' || (item.status === 'done' && hasCancellationReason)) {
      buckets.cancelled.push(item);
    } else if (item.status === 'done') {
      buckets.completed.push(item);
    } else if (!isInactiveTaskStatus(item.status)) {
      buckets.open.push(item);
    }
    return buckets;
  }, { open: [], completed: [], cancelled: [] });
}

export function getMyDayCompletionPercentage(items: MyDayItem[]): number {
  const { open, completed } = partitionMyDayItems(items);
  const actionableCount = open.length + completed.length;
  return actionableCount > 0
    ? Math.round((completed.length / actionableCount) * 100)
    : 0;
}

export function resolveMyDaySortSelection(
  nextSortBy: string,
  currentGroupBy: string,
): { sortBy: string; groupBy: string } {
  return {
    sortBy: nextSortBy,
    groupBy: nextSortBy === 'manual' ? 'none' : currentGroupBy,
  };
}

export function resolveMyDayGroupSelection(
  nextGroupBy: string,
  currentSortBy: string,
  lastComputedSortBy: string,
): { sortBy: string; groupBy: string } {
  return {
    sortBy: nextGroupBy !== 'none' && currentSortBy === 'manual'
      ? lastComputedSortBy
      : currentSortBy,
    groupBy: nextGroupBy,
  };
}

export function filterMyDayItems(items: MyDayItem[], query: string): MyDayItem[] {
  return filterTasksByKeyword(items, query);
}

export function sortMyDayItems(
  items: MyDayItem[],
  sortBy: string,
  sortDirection: 'asc' | 'desc',
): MyDayItem[] {
  if (sortBy === 'manual') return [...items];

  return [...items].sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'priority':
        comparison = (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4);
        break;
      case 'effort':
        comparison = (a.effort ?? Number.MAX_SAFE_INTEGER) - (b.effort ?? Number.MAX_SAFE_INTEGER);
        break;
      case 'planningHorizon':
        comparison = (PLANNING_HORIZON_ORDER[a.planningHorizon ?? ''] ?? 4)
          - (PLANNING_HORIZON_ORDER[b.planningHorizon ?? ''] ?? 4);
        break;
      case 'dueDate':
        comparison = compareNullableText(a.dueDate, b.dueDate);
        break;
      case 'title':
        comparison = a.title.localeCompare(b.title);
        break;
      case 'createdAt':
        comparison = compareNullableText(b.createdAt, a.createdAt);
        break;
      case 'updated':
        comparison = b.addedAt.localeCompare(a.addedAt);
        break;
      case 'sourceList':
        comparison = compareNullableText(a.sourceListName, b.sourceListName);
        break;
      case 'smartScore':
        comparison = (b.smartScore ?? -1) - (a.smartScore ?? -1);
        break;
    }
    return sortDirection === 'desc' ? -comparison : comparison;
  });
}

export function sortCompletedMyDayItems(items: MyDayItem[]): MyDayItem[] {
  return [...items].sort((a, b) => {
    if (!a.completedAt && b.completedAt) return 1;
    if (a.completedAt && !b.completedAt) return -1;
    const comparison = b.completedAt?.localeCompare(a.completedAt || '') ?? 0;
    return comparison !== 0 ? comparison : b.addedAt.localeCompare(a.addedAt);
  });
}

export function reorderMyDayItems(
  items: MyDayItem[],
  activeId: string,
  overId: string,
): MyDayItem[] {
  const oldIndex = items.findIndex((item) => item.id === activeId);
  const newIndex = items.findIndex((item) => item.id === overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return items;

  const reordered = [...items];
  const [moved] = reordered.splice(oldIndex, 1);
  reordered.splice(newIndex, 0, moved);
  return reordered.map((item, index) => ({ ...item, order: index + 1 }));
}

export function applyMyDayItemOrder(
  items: MyDayItem[],
  orderedIds: string[],
): MyDayItem[] {
  const orderById = new Map(orderedIds.map((id, index) => [id, index]));
  return [...items]
    .sort((a, b) => {
      const aOrder = orderById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = orderById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    })
    .map((item, index) => ({ ...item, order: index + 1 }));
}

export function groupMyDayItems(
  items: MyDayItem[],
  groupBy: string,
  projects: HubProject[],
): MyDayTaskGroup[] {
  if (groupBy === 'none') {
    return [{ id: 'all', label: '', items }];
  }

  const groups = new Map<string, MyDayItem[]>();
  for (const item of items) {
    const labels = getGroupLabels(item, groupBy, projects);
    for (const label of labels) {
      const groupedItems = groups.get(label) ?? [];
      groupedItems.push(item);
      groups.set(label, groupedItems);
    }
  }

  const result = [...groups.entries()].map(([label, groupedItems]) => ({
    id: `${groupBy}:${label}`,
    label,
    items: groupedItems,
  }));
  if (groupBy === 'status') {
    const statusOrder = new Map([
      ['In Progress', 0],
      ['To Do', 1],
      ['Completed', 2],
      ['Cancelled', 3],
    ]);
    result.sort((a, b) => (statusOrder.get(a.label) ?? 4) - (statusOrder.get(b.label) ?? 4));
  } else if (groupBy === 'priority') {
    const priorityOrder = new Map([
      ['Critical', 0],
      ['High', 1],
      ['Medium', 2],
      ['Low', 3],
      ['None', 4],
    ]);
    result.sort((a, b) => (priorityOrder.get(a.label) ?? 5) - (priorityOrder.get(b.label) ?? 5));
  } else if (groupBy === 'planningHorizon') {
    const planningHorizonOrder = new Map([
      ['Now', 0],
      ['Next', 1],
      ['Later', 2],
      ['Someday', 3],
      ['Not set', 4],
    ]);
    result.sort((a, b) => (
      (planningHorizonOrder.get(a.label) ?? 5) - (planningHorizonOrder.get(b.label) ?? 5)
    ));
  } else if (groupBy === 'effort') {
    result.sort((a, b) => numericGroupValue(a.label, 'Effort ') - numericGroupValue(b.label, 'Effort '));
  } else if (groupBy === 'dueDate') {
    result.sort((a, b) => dueDateGroupOrder(a.label) - dueDateGroupOrder(b.label));
  } else {
    result.sort((a, b) => compareGroupLabels(a.label, b.label));
  }
  return result;
}

function getGroupLabels(item: MyDayItem, groupBy: string, projects: HubProject[]): string[] {
  switch (groupBy) {
    case 'source':
      return [humanize(item.connectorType)];
    case 'list':
      return [item.sourceListName || 'No List'];
    case 'status':
      return [STATUS_LABELS[item.status] || humanize(item.status)];
    case 'tag':
      return visibleTagGroups(item);
    case 'priority':
      return [humanize(item.priority || 'none')];
    case 'planningHorizon':
      return [item.planningHorizon
        ? PLANNING_HORIZON_LABELS[item.planningHorizon]
        : 'Not set'];
    case 'effort':
      return [item.effort ? `Effort ${item.effort}` : 'No Effort'];
    case 'dueDate':
      return [dueDateGroup(item.dueDate)];
    case 'project':
      return projectGroups(item, projects);
    default:
      return ['Other'];
  }
}

function dueDateGroup(dueDate: string | null): string {
  if (!dueDate) return 'No Due Date';
  const date = dueDate.split('T')[0];
  const today = getLocalToday();
  if (date < today) return 'Overdue';
  if (date === today) return 'Today';
  return date;
}

function projectGroups(item: MyDayItem, projects: HubProject[]): string[] {
  if (!item.projectPhaseMemberships?.length) return ['No Project'];

  return [...new Set(item.projectPhaseMemberships.map((membership) => {
    const projectName = projects.find((project) => project.id === membership.projectId)?.name || 'Unknown Project';
    return membership.phaseName
      ? `${projectName} / ${membership.phaseName}`
      : `${projectName} / Unphased`;
  }))];
}

function visibleTagGroups(item: MyDayItem): string[] {
  const labels = item.tags
    .filter((tag) => !isSyntheticTag(tag.name))
    .map((tag) => tag.name);
  return labels.length ? [...new Set(labels)] : ['Untagged'];
}

function numericGroupValue(label: string, prefix: string): number {
  if (!label.startsWith(prefix)) return Number.MAX_SAFE_INTEGER;
  const value = Number(label.slice(prefix.length));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function dueDateGroupOrder(label: string): number {
  if (label === 'Overdue') return 0;
  if (label === 'Today') return 1;
  if (label === 'No Due Date') return Number.MAX_SAFE_INTEGER;
  const timestamp = Date.parse(label);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER - 1 : timestamp;
}

function compareGroupLabels(a: string, b: string): number {
  const aEmpty = a.startsWith('No ') || a === 'Untagged';
  const bEmpty = b.startsWith('No ') || b === 'Untagged';
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  return a.localeCompare(b);
}

function compareNullableText(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
