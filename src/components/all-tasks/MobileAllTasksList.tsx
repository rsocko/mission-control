'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Check, Filter, ListChecks, Loader2, Search } from 'lucide-react';
import { MobileSwipeTaskRow } from '@/components/today/MobileSwipeTaskRow';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { MobileSheet } from '@/components/ui/MobileSheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { useDashboardData } from '@/lib/hooks/useDashboardData';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import {
  PLANNING_HORIZONS,
  PLANNING_HORIZON_LABELS,
  type PlanningHorizonFilter,
} from '@/lib/tasks/planning-horizon';
import { parseFilterQuery, replacePositiveFilterValues } from '@/lib/utils/parseFilterQuery';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import {
  getQuickFilterDefinition,
  getQuickFilterVisibility,
  isQuickFilterVisible,
  QUICK_FILTERS,
  type QuickFilterVisibility,
} from '@/lib/tasks/quick-filters';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import type { TaskListStatsDto } from '@/types/api';
import { cn } from '@/lib/utils';
import type {
  DashboardTaskViewModel as Task,
  EnabledSource,
  SourceList,
  SyncStatusEntry,
} from '@/types/dashboard';
import type { MyDayItem } from '@/components/today/types';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

interface TaskGroup {
  key: string;
  label: string;
  items: MyDayItem[];
}

/** Convert a Task from dashboard data into a MyDayItem shape for swipe rows */
function taskToMyDayItem(task: Task): MyDayItem {
  return {
    id: task.id,
    taskId: task.id,
    order: 0,
    isAutoIncluded: false,
    addedAt: '',
    title: task.title,
    status: task.status,
    priority: task.priority,
    planningHorizon: task.planningHorizon,
    dueDate: task.dueDate,
    connectorType: task.connectorType,
    connectorInstanceId: task.connectorInstanceId,
    sourceId: task.sourceId ?? undefined,
    sourceListName: task.sourceListName,
    createdAt: null,
    completedAt: null,
    tags: task.tags ?? [],
    metadata: task.metadata,
    subtaskTotal: task.subtaskTotal,
    subtaskDone: task.subtaskDone,
    smartScore: task.smartScore,
    scoreBreakdown: task.scoreBreakdown,
    hubProjectIds: task.hubProjectIds,
    effort: task.effort,
    estimatedDuration: task.estimatedDuration,
    hasDescription: task.hasDescription,
    localDisposition: task.localDisposition,
    taskSourceModel: task.taskSourceModel,
    editPolicy: task.editPolicy,
  };
}

/**
 * Mobile-optimized All Tasks view following the Today view pattern.
 * Features: compact filters, priority-grouped tasks, swipe actions, pull-to-refresh.
 */
export function MobileAllTasksList() {
  const { state, actions, computed } = useDashboardData();
  const textFilter = useDashboardViewStore((viewState) => viewState.textFilter);
  const setTextFilter = useDashboardViewStore((viewState) => viewState.setTextFilter);
  const selectedTaskId = state.selectedTaskId;
  const setSelectedTaskId = actions.setSelectedTaskId;
  const activeFilter = getQuickFilterDefinition(state.quickFilter)?.id ?? 'all';
  const [activeScheduleTrayId, setActiveScheduleTrayId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const filterHeaderRef = useRef<HTMLDivElement>(null);
  const [filterHeaderHeight, setFilterHeaderHeight] = useState(0);

  useEffect(() => {
    const header = filterHeaderRef.current;
    if (!header) return;

    const observer = new ResizeObserver(() => {
      setFilterHeaderHeight(header.offsetHeight);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [state.loading]);

  const today = getLocalToday();
  const tomorrow = getLocalTomorrow();

  // Pull-to-refresh
  const isSheetOpen = Boolean(selectedTaskId) || showFilters;
  const onRefresh = useCallback(async () => {
    await actions.fetchData(false, true);
  }, [actions]);
  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({ onRefresh, enabled: !isSheetOpen });

  const filteredTasks = state.taskResponse.tasks;

  // Group tasks by priority
  const groups: TaskGroup[] = useMemo(() => {
    if (activeFilter === 'recentlyClosed') {
      return filteredTasks.length > 0
        ? [{
            key: 'recently-closed',
            label: 'Recently Closed',
            items: filteredTasks.map(taskToMyDayItem),
          }]
        : [];
    }

    const active = filteredTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const sortByPriority = (a: Task, b: Task) =>
      (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4);

    const overdue: Task[] = [];
    const dueToday: Task[] = [];
    const upcoming: Task[] = [];
    const noDue: Task[] = [];

    for (const task of active) {
      const dueDateStr = task.dueDate?.split('T')[0] ?? null;
      if (dueDateStr && dueDateStr < today) {
        overdue.push(task);
      } else if (dueDateStr === today) {
        dueToday.push(task);
      } else if (dueDateStr && dueDateStr > today) {
        upcoming.push(task);
      } else {
        noDue.push(task);
      }
    }

    overdue.sort(sortByPriority);
    dueToday.sort(sortByPriority);
    upcoming.sort(sortByPriority);
    noDue.sort(sortByPriority);

    const result: TaskGroup[] = [];
    if (overdue.length > 0) result.push({ key: 'overdue', label: 'Overdue', items: overdue.map(taskToMyDayItem) });
    if (dueToday.length > 0) result.push({ key: 'due-today', label: 'Due Today', items: dueToday.map(taskToMyDayItem) });
    if (upcoming.length > 0) result.push({ key: 'upcoming', label: 'Upcoming', items: upcoming.map(taskToMyDayItem) });
    if (noDue.length > 0) result.push({ key: 'no-due', label: 'No Due Date', items: noDue.map(taskToMyDayItem) });
    return result;
  }, [activeFilter, filteredTasks, today]);

  const totalActive = useMemo(
    () => activeFilter === 'recentlyClosed'
      ? filteredTasks.length
      : filteredTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
    [activeFilter, filteredTasks],
  );

  // Task actions
  const handleSetDueDate = useCallback(async (taskId: string, date: string) => {
    await actions.setTaskDueDate(taskId, date);
  }, [actions]);

  const handleScheduleTomorrow = useCallback((taskId: string) => {
    void handleSetDueDate(taskId, tomorrow);
  }, [handleSetDueDate, tomorrow]);

  const handleSchedulePickDay = useCallback((taskId: string) => {
    window.dispatchEvent(new CustomEvent('mission-control:open-schedule-modal', { detail: { taskId } }));
  }, []);

  const handleSnooze = useCallback((taskId: string) => {
    const tomorrowMorning = new Date(tomorrow + 'T09:00:00');
    void actions.snoozeTask(taskId, tomorrowMorning.toISOString());
  }, [actions, tomorrow]);

  const activeListName = useMemo(() => {
    if (!state.listFilter) return null;
    return state.sourceLists.find((list) => matchesSourceListFilter(list, state.listFilter))?.name ?? null;
  }, [state.listFilter, state.sourceLists]);

  const activeSourceName = useMemo(
    () => state.enabledSources.find((source) => source.type === state.sourceFilter)?.name ?? state.sourceFilter,
    [state.enabledSources, state.sourceFilter]
  );
  const planningHorizonFilters = useMemo(
    () => parseFilterQuery(textFilter).horizonTokens.filter(isPlanningHorizonFilter),
    [textFilter],
  );
  const activeFilterCount = Number(activeFilter !== 'all')
    + Number(Boolean(state.sourceFilter))
    + Number(Boolean(state.listFilter))
    + planningHorizonFilters.length;
  const planningHorizonSummary = planningHorizonFilters
    .map((horizon) => horizon === 'none' ? 'Not set' : PLANNING_HORIZON_LABELS[horizon])
    .join(', ');
  const filterSummary = planningHorizonSummary
    || activeListName
    || activeSourceName
    || getQuickFilterDefinition(activeFilter)?.label
    || 'All tasks';

  const clearFilters = useCallback(() => {
    actions.setQuickFilter(null);
    actions.setSourceFilter(null);
    actions.setListFilter(null);
    setTextFilter('');
  }, [actions, setTextFilter]);

  const togglePlanningHorizon = useCallback((horizon: PlanningHorizonFilter) => {
    const next = planningHorizonFilters.includes(horizon)
      ? planningHorizonFilters.filter((value) => value !== horizon)
      : [...planningHorizonFilters, horizon];
    setTextFilter(replacePositiveFilterValues(textFilter, 'horizon', next));
  }, [planningHorizonFilters, setTextFilter, textFilter]);

  if (state.loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12" role="status" aria-label="Loading tasks">
        <Loader2 size={24} className="animate-spin text-[var(--accent-400)]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={`relative h-full overscroll-y-contain ${isSheetOpen ? 'overflow-hidden' : 'overflow-y-auto'}`} ref={containerRef} {...containerProps}>
      {/* Pull-to-refresh indicator — absolutely positioned */}
      {(pullDistance > 0 || isRefreshing) && (
        <div className="absolute left-0 right-0 top-0 z-50 flex items-center justify-center pointer-events-none" style={{ height: `${pullDistance}px` }}>
          <Loader2
            size={18}
            className={`text-[var(--accent-400)] ${isRefreshing ? 'animate-spin' : ''}`}
            style={{ opacity: Math.min(pullDistance / 32, 1), transform: `rotate(${pullDistance * 3}deg)` }}
          />
        </div>
      )}

      <div style={contentStyle}>
      {/* Compact filter bar */}
      <div ref={filterHeaderRef} className="sticky top-0 z-20 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-0)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => setShowFilters(true)}
          className={cn(
            'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 text-left transition-colors',
            activeFilterCount > 0
              ? 'border-[var(--accent-400)]/30 bg-[var(--accent-900)]/30'
              : 'border-[var(--border)] bg-[var(--surface-2)] active:bg-[var(--surface-3)]'
          )}
          aria-label="Open task filters"
        >
          <Filter size={16} className={activeFilterCount > 0 ? 'text-[var(--accent-400)]' : 'text-[var(--text-tertiary)]'} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              Filters
            </span>
            <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
              {activeFilterCount > 0 ? filterSummary : 'All tasks'}
            </span>
          </span>
          {activeFilterCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent)] px-1.5 text-xs font-bold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>
        <span className="shrink-0 text-xs tabular-nums text-[var(--text-tertiary)]">
          {totalActive} active
        </span>
      </div>

      {totalActive === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/30 flex items-center justify-center mb-5">
            <ListChecks size={28} className="text-cyan-400" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
            No tasks found
          </h3>
          <p className="text-sm text-[var(--text-secondary)] mb-4 max-w-[260px] leading-relaxed">
            {activeFilterCount > 0 ? 'Try changing your filters to see more tasks.' : 'All caught up! Check your connected sources.'}
          </p>
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="text-sm text-[var(--accent-400)] font-medium"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="pb-24">
          {groups.map((group) => (
            <section key={group.key} className="mb-1">
              {/* Section header */}
              <div className="sticky z-10 bg-[var(--surface-0)]/95 backdrop-blur-sm px-4 py-2 border-b border-[var(--border-subtle)]" style={{ top: filterHeaderHeight }}>
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${
                  group.key === 'overdue' ? 'text-red-400' :
                  group.key === 'due-today' ? 'text-amber-400' :
                  group.key === 'upcoming' ? 'text-blue-400' :
                  'text-[var(--text-muted)]'
                }`}>
                  {group.label}
                  <span className="ml-1.5 text-[var(--text-muted)] font-normal">({group.items.length})</span>
                </h3>
              </div>

              {/* Task rows */}
              {group.items.map((item) => (
                <MobileSwipeTaskRow
                  key={item.id}
                  item={item}
                  onComplete={(taskId) => { void actions.completeTask(taskId); }}
                  onRemoveFromDay={(taskId) => { handleSnooze(taskId); }}
                  onSetLocalDisposition={(taskId, disposition) => {
                    void actions.setTaskLocalDisposition(taskId, disposition);
                  }}
                  onTap={(tappedItem) => { setActiveScheduleTrayId(null); setSelectedTaskId(tappedItem.taskId); }}
                  onScheduleTomorrow={handleScheduleTomorrow}
                  onSchedulePickDay={handleSchedulePickDay}
                  onSnooze={(taskId) => handleSnooze(taskId)}
                  isCompleting={state.completingIds.has(item.taskId)}
                  showAiChip={item.priority === 'critical' || item.priority === 'high'}
                  projects={state.projects}
                  scheduleTrayOpen={activeScheduleTrayId === item.taskId}
                  onScheduleTrayChange={(open) => setActiveScheduleTrayId(open ? item.taskId : null)}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      {/* Task detail bottom sheet */}
      </div>
      <MobileSheet
        isOpen={!!selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        ariaLabel="Task details"
        height="full"
      >
        {selectedTaskId && (
          <TaskDetailPanel
            taskId={selectedTaskId}
            mode="mobile"
            onClose={() => setSelectedTaskId(null)}
            onUpdate={() => actions.fetchData(false, true)}
            onSubtaskCountChange={(done, total) => actions.updateSubtaskCount(selectedTaskId, done, total)}
            sourceLists={state.sourceLists}
            onMoveToList={(targetListId) => actions.moveTaskToList(selectedTaskId, targetListId)}
            isInMyDay={state.myDayTaskIds.has(selectedTaskId)}
            onToggleMyDay={() => state.myDayTaskIds.has(selectedTaskId)
              ? actions.removeFromMyDay(selectedTaskId)
              : actions.addToMyDay(selectedTaskId)}
          />
        )}
      </MobileSheet>

      {/* Filter bottom sheet */}
      <MobileSheet
        isOpen={showFilters}
        onClose={() => setShowFilters(false)}
        title="Filter tasks"
        height="85%"
      >
        <MobileTaskFilters
          activeFilter={activeFilter}
          sourceFilter={state.sourceFilter}
          listFilter={state.listFilter}
          planningHorizonFilters={planningHorizonFilters}
          sources={state.enabledSources}
          sourceLists={state.sourceLists}
          syncStatus={state.syncStatus}
          sourceCounts={computed.sidebarSourceCounts}
          stats={state.taskResponse.stats}
          hiddenQuickFilters={state.hiddenQuickFilters}
          quickFilterVisibility={state.quickFilterVisibility}
          loading={state.loading}
          onQuickFilterChange={(filter) => actions.setQuickFilter(filter === 'all' ? null : filter)}
          onQuickFilterVisibilityChange={actions.setQuickFilterVisibility}
          onSourceFilterChange={(source) => {
            actions.setSourceFilter(source);
            actions.setListFilter(null);
          }}
          onListFilterChange={(list, source) => {
            actions.setSourceFilter(source);
            actions.setListFilter(list);
          }}
          onPlanningHorizonToggle={togglePlanningHorizon}
          onPlanningHorizonClear={() => setTextFilter(replacePositiveFilterValues(textFilter, 'horizon', []))}
          onClear={clearFilters}
        />
      </MobileSheet>
    </div>
  );
}

interface MobileTaskFiltersProps {
  activeFilter: string;
  sourceFilter: string | null;
  listFilter: string | null;
  planningHorizonFilters: PlanningHorizonFilter[];
  sources: EnabledSource[];
  sourceLists: SourceList[];
  syncStatus: SyncStatusEntry[];
  sourceCounts: Record<string, number>;
  stats: TaskListStatsDto;
  hiddenQuickFilters: string[];
  quickFilterVisibility: Record<string, QuickFilterVisibility>;
  loading: boolean;
  onQuickFilterChange: (filter: string) => void;
  onQuickFilterVisibilityChange: (filter: string, visibility: QuickFilterVisibility) => void;
  onSourceFilterChange: (source: string | null) => void;
  onListFilterChange: (list: string | null, source: string | null) => void;
  onPlanningHorizonToggle: (horizon: PlanningHorizonFilter) => void;
  onPlanningHorizonClear: () => void;
  onClear: () => void;
}

export function MobileTaskFilters({
  activeFilter,
  sourceFilter,
  listFilter,
  planningHorizonFilters,
  sources,
  sourceLists,
  syncStatus,
  sourceCounts,
  stats,
  hiddenQuickFilters,
  quickFilterVisibility,
  loading,
  onQuickFilterChange,
  onQuickFilterVisibilityChange,
  onSourceFilterChange,
  onListFilterChange,
  onPlanningHorizonToggle,
  onPlanningHorizonClear,
  onClear,
}: MobileTaskFiltersProps) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const availableSources = useMemo(
    () => [...new Map(
      sources
        .filter((source) => !source.notificationOnly)
        .map((source) => [source.type, source])
    ).values()].sort((a, b) => a.name.localeCompare(b.name)),
    [sources]
  );
  const sourceTypeByConnector = useMemo(
    () => new Map(syncStatus.map((status) => [status.id, status.type])),
    [syncStatus]
  );
  const sourceNameByType = useMemo(
    () => new Map(availableSources.map((source) => [source.type, source.name])),
    [availableSources]
  );
  const filteredSources = availableSources.filter((source) =>
    !normalizedSearch || source.name.toLowerCase().includes(normalizedSearch)
  );
  const filteredLists = sourceLists
    .filter((list) => !list.hidden)
    .filter((list) => {
      const sourceType = sourceTypeByConnector.get(list.connectorInstanceId);
      const sourceName = sourceType ? sourceNameByType.get(sourceType) : undefined;
      return !normalizedSearch
        || list.name.toLowerCase().includes(normalizedSearch)
        || sourceName?.toLowerCase().includes(normalizedSearch);
    })
    .sort((a, b) => {
      const sourceA = sourceNameByType.get(sourceTypeByConnector.get(a.connectorInstanceId) ?? '') ?? '';
      const sourceB = sourceNameByType.get(sourceTypeByConnector.get(b.connectorInstanceId) ?? '') ?? '';
      return sourceA.localeCompare(sourceB)
        || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        || a.name.localeCompare(b.name);
    });
  const hasActiveFilters = activeFilter !== 'all'
    || Boolean(sourceFilter)
    || Boolean(listFilter)
    || planningHorizonFilters.length > 0;
  const visibleQuickFilters = QUICK_FILTERS.filter((filter) => isQuickFilterVisible(
    filter,
    stats,
    quickFilterVisibility,
    {
      activeFilter,
      loading,
      legacyHiddenFilters: hiddenQuickFilters,
    },
  ));

  return (
    <div className="px-4 pb-6">
      <div className="sticky top-0 z-10 -mx-4 flex gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-4 py-3">
        <label className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <span className="sr-only">Search sources and lists</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sources and lists"
            className="min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-0)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
          />
        </label>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClear}
            className="min-h-11 rounded-xl px-3 text-xs font-semibold text-[var(--accent-400)] active:bg-[var(--surface-2)]"
          >
            Clear all
          </button>
        )}
      </div>

      {!normalizedSearch && (
        <>
          <FilterSection title="Quick filters">
            <div className="grid grid-cols-2 gap-2">
              <FilterOptionButton
                active={activeFilter === 'all'}
                label="All tasks"
                detail="Any date or priority"
                onClick={() => onQuickFilterChange('all')}
              />
              {visibleQuickFilters.map((filter) => (
                <FilterOptionButton
                  key={filter.id}
                  active={activeFilter === filter.id}
                  label={filter.label}
                  detail={filter.description}
                  onClick={() => onQuickFilterChange(filter.id)}
                />
              ))}
            </div>
          </FilterSection>
          <FilterSection title="Horizon">
            <div className="grid grid-cols-2 gap-2">
              <FilterOptionButton
                active={planningHorizonFilters.length === 0}
                label="Any horizon"
                detail="Do not limit by plan"
                onClick={onPlanningHorizonClear}
              />
              {[...PLANNING_HORIZONS, 'none' as const].map((horizon) => (
                <FilterOptionButton
                  key={horizon}
                  active={planningHorizonFilters.includes(horizon)}
                  label={horizon === 'none' ? 'Not set' : PLANNING_HORIZON_LABELS[horizon]}
                  detail={horizon === 'none' ? 'Needs planning' : `Planned for ${PLANNING_HORIZON_LABELS[horizon].toLowerCase()}`}
                  onClick={() => onPlanningHorizonToggle(horizon)}
                />
              ))}
            </div>
          </FilterSection>
          <details className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface-0)]">
            <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Customize quick filters
            </summary>
            <div className="space-y-2 border-t border-[var(--border-subtle)] p-3">
              {QUICK_FILTERS.map((filter) => (
                <div key={filter.id} className="flex min-h-11 items-center justify-between gap-3 text-sm text-[var(--text-primary)]">
                  <span>{filter.label}</span>
                  <Select
                    value={getQuickFilterVisibility(filter, quickFilterVisibility, hiddenQuickFilters)}
                    onValueChange={(visibility) => onQuickFilterVisibilityChange(
                      filter.id,
                      visibility as QuickFilterVisibility,
                    )}
                  >
                    <SelectTrigger
                      aria-label={`${filter.label} visibility`}
                      className="min-h-11 w-36 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">Always</SelectItem>
                      <SelectItem value="when-not-empty">When not empty</SelectItem>
                      <SelectItem value="hidden">Hidden</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      <FilterSection title="Sources">
        {!normalizedSearch && (
          <FilterOptionButton
            active={!sourceFilter}
            label="All sources"
            detail="Tasks from every connection"
            onClick={() => onSourceFilterChange(null)}
          />
        )}
        {filteredSources.map((source) => (
          <FilterOptionButton
            key={source.type}
            active={sourceFilter === source.type}
            label={source.name}
            detail={`${sourceCounts[source.type] ?? 0} tasks`}
            icon={CONNECTOR_ICONS[source.type]}
            onClick={() => onSourceFilterChange(sourceFilter === source.type ? null : source.type)}
          />
        ))}
      </FilterSection>

      <FilterSection title="Lists">
        {!normalizedSearch && (
          <FilterOptionButton
            active={!listFilter}
            label="All lists"
            detail="Do not limit by list"
            onClick={() => onListFilterChange(null, sourceFilter)}
          />
        )}
        {filteredLists.map((list) => {
          const sourceType = sourceTypeByConnector.get(list.connectorInstanceId) ?? null;
          const sourceName = sourceType ? sourceNameByType.get(sourceType) : null;
          return (
            <FilterOptionButton
              key={list.id}
              active={matchesSourceListFilter(list, listFilter)}
              label={list.name}
              detail={`${sourceName ? `${sourceName} · ` : ''}${list.taskCount} tasks`}
              onClick={() => onListFilterChange(
                matchesSourceListFilter(list, listFilter) ? null : list.sourceId,
                sourceType
              )}
            />
          );
        })}
      </FilterSection>

      {normalizedSearch && filteredSources.length === 0 && filteredLists.length === 0 && (
        <p className="py-10 text-center text-sm text-[var(--text-muted)]">No matching sources or lists</p>
      )}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-5">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function FilterOptionButton({
  active,
  label,
  detail,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  detail: string;
  icon?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
        active
          ? 'border-[var(--accent-400)]/30 bg-[var(--accent-900)]/30'
          : 'border-transparent bg-[var(--surface-2)] active:bg-[var(--surface-3)]'
      )}
    >
      {icon && <Image src={icon} alt="" width={18} height={18} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', active ? 'text-[var(--accent-300)]' : 'text-[var(--text-primary)]')}>
          {label}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{detail}</span>
      </span>
      {active && <Check size={16} className="shrink-0 text-[var(--accent-400)]" aria-hidden="true" />}
    </button>
  );
}

function matchesSourceListFilter(sourceList: SourceList, listFilter: string | null): boolean {
  return listFilter === sourceList.sourceId
    || listFilter === `${sourceList.connectorInstanceId}:${sourceList.sourceId}`;
}

function isPlanningHorizonFilter(value: string): value is PlanningHorizonFilter {
  return value === 'none' || (PLANNING_HORIZONS as readonly string[]).includes(value);
}
