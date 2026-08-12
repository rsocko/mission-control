'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Loader2, ListChecks, Filter } from 'lucide-react';
import { MobileSwipeTaskRow } from '@/components/today/MobileSwipeTaskRow';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { useDashboardData } from '@/lib/hooks/useDashboardData';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import { CONNECTOR_LABELS } from '@/lib/constants/colors';
import { cn } from '@/lib/utils';
import type { Task, SourceList } from '@/types/dashboard';
import type { MyDayItem } from '@/components/today/types';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

type FilterMode = 'all' | 'overdue' | 'due-today' | 'high-priority' | string;

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
    dueDate: task.dueDate,
    connectorType: task.connectorType,
    connectorInstanceId: task.connectorInstanceId,
    sourceId: task.sourceId ?? undefined,
    sourceListName: task.sourceListName,
    createdAt: null,
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
 * Features: source filter chips, priority-grouped tasks, swipe actions, pull-to-refresh.
 */
export function MobileAllTasksList() {
  const { state, actions, computed } = useDashboardData();
  const selectedTaskId = state.selectedTaskId;
  const setSelectedTaskId = actions.setSelectedTaskId;
  const [activeFilter, setActiveFilter] = useState<FilterMode>('all');
  const [activeScheduleTrayId, setActiveScheduleTrayId] = useState<string | null>(null);
  const [showListPicker, setShowListPicker] = useState(false);
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
  const isSheetOpen = !!selectedTaskId;
  const onRefresh = useCallback(async () => {
    await actions.fetchData(false, true);
  }, [actions]);
  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({ onRefresh, enabled: !isSheetOpen });

  // Filter tasks based on active quick-filter (source filtering is handled server-side via actions.setSourceFilter)
  const filteredTasks = useMemo(() => {
    const tasks = state.taskResponse.tasks;

    if (activeFilter === 'overdue') {
      return tasks.filter((t) => {
        const d = t.dueDate?.split('T')[0];
        return d && d < today && t.status !== 'done';
      });
    } else if (activeFilter === 'due-today') {
      return tasks.filter((t) => t.dueDate?.split('T')[0] === today && t.status !== 'done');
    } else if (activeFilter === 'high-priority') {
      return tasks.filter((t) => (t.priority === 'critical' || t.priority === 'high') && t.status !== 'done');
    }

    return tasks;
  }, [state.taskResponse.tasks, activeFilter, today]);

  // Group tasks by priority
  const groups: TaskGroup[] = useMemo(() => {
    const active = filteredTasks.filter((t) => t.status !== 'done');
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
  }, [filteredTasks, today]);

  const totalActive = useMemo(() => filteredTasks.filter((t) => t.status !== 'done').length, [filteredTasks]);

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

  // Source counts for filter chips
  const sourceCounts = state.taskResponse.sourceCounts;

  // Available source lists for the list filter (already filtered by active source via computed)
  const availableLists: SourceList[] = computed.visibleSourceLists;

  const activeListName = useMemo(() => {
    if (!state.listFilter) return null;
    return state.sourceLists.find((sl) => sl.sourceId === state.listFilter)?.name ?? null;
  }, [state.listFilter, state.sourceLists]);

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
      {/* Filter chips */}
      <div ref={filterHeaderRef} className="sticky top-0 z-20 bg-[var(--surface-0)] border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div className="flex gap-2 overflow-x-auto pb-0.5 -mx-1 px-1 scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
          <FilterChip
            active={activeFilter === 'all' && !state.sourceFilter}
            label={`All · ${state.taskResponse.total}`}
            onClick={() => { setActiveFilter('all'); actions.setSourceFilter(null); actions.setListFilter(null); }}
          />
          <FilterChip
            active={activeFilter === 'overdue'}
            label="Overdue"
            color="text-red-400"
            onClick={() => { setActiveFilter('overdue'); actions.setSourceFilter(null); actions.setListFilter(null); }}
          />
          <FilterChip
            active={activeFilter === 'due-today'}
            label="Due Today"
            color="text-amber-400"
            onClick={() => { setActiveFilter('due-today'); actions.setSourceFilter(null); actions.setListFilter(null); }}
          />
          <FilterChip
            active={activeFilter === 'high-priority'}
            label="High Priority"
            color="text-orange-400"
            onClick={() => { setActiveFilter('high-priority'); actions.setSourceFilter(null); actions.setListFilter(null); }}
          />
          {Object.entries(sourceCounts).map(([source, count]) => (
            <FilterChip
              key={source}
              active={activeFilter === source || state.sourceFilter === source}
              label={`${CONNECTOR_LABELS[source] || source} · ${count}`}
              icon={CONNECTOR_ICONS[source]}
              onClick={() => { setActiveFilter(source); actions.setSourceFilter(source); actions.setListFilter(null); }}
            />
          ))}
        </div>

        {/* List filter button */}
        {availableLists.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => setShowListPicker(true)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors min-h-[32px]',
                state.listFilter
                  ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)] border-[var(--accent-400)]/30'
                  : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border)] active:bg-[var(--surface-3)]'
              )}
            >
              <Filter size={12} />
              {activeListName || 'Filter by list'}
            </button>
            {state.listFilter && (
              <button
                onClick={() => actions.setListFilter(null)}
                className="text-xs text-[var(--text-tertiary)] active:text-[var(--text-secondary)]"
                aria-label="Clear list filter"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {/* Task count subtitle */}
      <div className="px-4 pt-2 pb-1">
        <p className="text-xs text-[var(--text-tertiary)]">
          {totalActive} active task{totalActive !== 1 ? 's' : ''}
        </p>
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
            {activeFilter !== 'all' ? 'Try changing your filter to see more tasks.' : 'All caught up! Check your connected sources.'}
          </p>
          {activeFilter !== 'all' && (
            <button
              onClick={() => { setActiveFilter('all'); actions.setSourceFilter(null); }}
              className="text-sm text-[var(--accent-400)] font-medium"
            >
              Clear filter
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

      {/* List picker bottom sheet */}
      <MobileSheet
        isOpen={showListPicker}
        onClose={() => setShowListPicker(false)}
        title="Filter by List"
        height="60%"
      >
        <div className="px-4 py-2 overflow-y-auto">
          {/* Clear filter option */}
          <button
            onClick={() => { actions.setListFilter(null); setShowListPicker(false); }}
            className={cn(
              'w-full text-left px-4 py-3 rounded-lg text-sm font-medium transition-colors mb-1',
              !state.listFilter
                ? 'bg-[var(--accent-900)]/30 text-[var(--accent-400)]'
                : 'text-[var(--text-secondary)] active:bg-[var(--surface-2)]'
            )}
          >
            All Lists
          </button>
          {availableLists.map((list) => (
            <button
              key={list.sourceId}
              onClick={() => { actions.setListFilter(list.sourceId); setShowListPicker(false); }}
              className={cn(
                'w-full text-left px-4 py-3 rounded-lg text-sm transition-colors mb-1 flex items-center justify-between',
                state.listFilter === list.sourceId
                  ? 'bg-[var(--accent-900)]/30 text-[var(--accent-400)] font-medium'
                  : 'text-[var(--text-secondary)] active:bg-[var(--surface-2)]'
              )}
            >
              <span className="truncate">{list.name}</span>
              <span className="text-xs text-[var(--text-muted)] ml-2 flex-shrink-0">{list.taskCount}</span>
            </button>
          ))}
        </div>
      </MobileSheet>
    </div>
  );
}

/** Filter chip button */
function FilterChip({ active, label, color, icon, onClick }: {
  active: boolean;
  label: string;
  color?: string;
  icon?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors flex items-center gap-1.5 min-h-[32px]',
        active
          ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)] border-[var(--accent-400)]/30'
          : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border)] active:bg-[var(--surface-3)]'
      )}
    >
      {icon && <Image src={icon} alt="" width={12} height={12} />}
      <span className={active ? undefined : color}>{label}</span>
    </button>
  );
}
