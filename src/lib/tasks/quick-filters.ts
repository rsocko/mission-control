import type { TaskListStatsDto } from '@/types/api';

export type QuickFilterVisibility = 'always' | 'when-not-empty' | 'hidden';

export type QuickFilterIcon =
  | 'sun'
  | 'inbox'
  | 'flame'
  | 'calendar'
  | 'star'
  | 'clock'
  | 'user'
  | 'sparkles'
  | 'completed'
  | 'waiting'
  | 'no-date';

export interface QuickFilterDefinition {
  id: string;
  label: string;
  description: string;
  statKey: keyof TaskListStatsDto;
  icon: QuickFilterIcon;
  iconClassName: string;
  defaultVisibility: QuickFilterVisibility;
}

export const QUICK_FILTERS: readonly QuickFilterDefinition[] = [
  {
    id: 'myDay',
    label: 'My Day',
    description: 'Tasks selected for today',
    statKey: 'myDay',
    icon: 'sun',
    iconClassName: 'text-amber-400',
    defaultVisibility: 'always',
  },
  {
    id: 'inbox',
    label: 'Inbox',
    description: 'Tasks not yet organized',
    statKey: 'inbox',
    icon: 'inbox',
    iconClassName: 'text-teal-400',
    defaultVisibility: 'always',
  },
  {
    id: 'overdue',
    label: 'Overdue',
    description: 'Past the due date',
    statKey: 'overdue',
    icon: 'flame',
    iconClassName: 'text-red-400',
    defaultVisibility: 'always',
  },
  {
    id: 'today',
    label: 'Due Today',
    description: 'Due today across every list',
    statKey: 'dueToday',
    icon: 'calendar',
    iconClassName: 'text-sky-400',
    defaultVisibility: 'always',
  },
  {
    id: 'high',
    label: 'High Priority',
    description: 'Critical and high-priority tasks',
    statKey: 'highPriority',
    icon: 'star',
    iconClassName: 'text-amber-400',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'week',
    label: 'Next 7 Days',
    description: 'Due within the next seven days',
    statKey: 'dueThisWeek',
    icon: 'clock',
    iconClassName: 'text-blue-400',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'assigned',
    label: 'Assigned to Me',
    description: 'Tasks assigned to you',
    statKey: 'assignedToMe',
    icon: 'user',
    iconClassName: 'text-[var(--text-muted)]',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'waiting',
    label: 'Waiting / Blocked',
    description: 'Waiting on someone or an external dependency',
    statKey: 'waiting',
    icon: 'waiting',
    iconClassName: 'text-orange-400',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'recentlyCreated',
    label: 'Recently Created',
    description: 'Created in the last seven days',
    statKey: 'recentlyCreated',
    icon: 'sparkles',
    iconClassName: 'text-emerald-400',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'recentlyClosed',
    label: 'Recently Closed',
    description: 'Completed or cancelled in the last seven days',
    statKey: 'recentlyClosed',
    icon: 'completed',
    iconClassName: 'text-violet-400',
    defaultVisibility: 'when-not-empty',
  },
  {
    id: 'noDate',
    label: 'No Date',
    description: 'Unscheduled tasks without a due date',
    statKey: 'noDate',
    icon: 'no-date',
    iconClassName: 'text-slate-400',
    defaultVisibility: 'hidden',
  },
] as const;

export function getQuickFilterDefinition(id: string | null): QuickFilterDefinition | undefined {
  return QUICK_FILTERS.find((filter) => filter.id === id);
}

export function getQuickFilterVisibility(
  filter: QuickFilterDefinition,
  overrides: Readonly<Record<string, QuickFilterVisibility>>,
  legacyHiddenFilters: readonly string[] = [],
): QuickFilterVisibility {
  if (overrides[filter.id]) return overrides[filter.id];
  if (legacyHiddenFilters.includes(filter.id)) return 'hidden';
  return filter.defaultVisibility;
}

export function isQuickFilterVisible(
  filter: QuickFilterDefinition,
  stats: TaskListStatsDto,
  overrides: Readonly<Record<string, QuickFilterVisibility>>,
  options: {
    activeFilter?: string | null;
    countsAvailable?: boolean;
    loading?: boolean;
    legacyHiddenFilters?: readonly string[];
  } = {},
): boolean {
  const visibility = getQuickFilterVisibility(
    filter,
    overrides,
    options.legacyHiddenFilters,
  );
  if (options.activeFilter === filter.id) return true;
  if (visibility === 'hidden') return false;
  if (visibility === 'always' || options.loading || options.countsAvailable === false) return true;
  return stats[filter.statKey] > 0;
}
