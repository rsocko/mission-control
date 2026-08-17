'use client';

import { useEffect, useMemo, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  GripVertical,
  Loader2,
  Moon,
  Sun,
  Target,
  Timer,
  Trash2,
  Network,
  Wand2,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  BulkActionBar,
  BulkDispositionButtons,
  BulkDueDateDropdown,
  BulkMoveDropdown,
  BulkMoveToSourceButton,
  BulkPriorityDropdown,
  BulkStatusDropdown,
  executeBulkOperation,
  resolveSelectionAnchorIndex,
  useBulkSelection,
} from '@/components/bulk-actions';
import { TodayRoutinesSection } from '@/components/routines/TodayRoutinesSection';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { GroupByDropdown } from '@/components/toolbar/GroupByDropdown';
import { DEFAULT_SORT_OPTIONS, SortDropdown, type SortOption } from '@/components/toolbar/SortDropdown';
import { ViewDensityToggle, type ViewDensity } from '@/components/toolbar/ViewDensityToggle';
import { CONNECTOR_ICONS, type EnabledSource, type HubProject, type ListGroup, type TaskTag } from '@/types/dashboard';
import { AIRecommendation } from '@/components/today/AIRecommendation';
import { EnergyCheckIn, EnergyIndicator } from '@/components/today/EnergyCheckIn';
import { Focus3Panel } from '@/components/today/Focus3Panel';
import { InteractiveTimeline } from '@/components/today/InteractiveTimeline';
import { MobileSuggestions } from '@/components/today/MobileSuggestions';
import { ConnectorIcon, SortableTaskRow } from '@/components/today/SortableTaskRow';
import { TimerPanel } from '@/components/today/TimerPanel';
import { uiLogger } from '@/lib/client-logger';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { useViewMode } from '@/lib/hooks/useViewMode';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { buildGraphUniverseHref } from '@/lib/graph/graph-navigation';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  taskFilterContextForToday,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';
import { useTaskContextMenuActionFactory } from '@/lib/hooks/useTaskContextMenuActionFactory';
import {
  canEditTaskField,
  selectedTaskFieldBlockedReason,
  selectedTaskRemovalBlockedReason,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import {
  filterMyDayItems,
  getMyDayCompletionPercentage,
  groupMyDayItems,
  applyMyDayItemOrder,
  partitionMyDayItems,
  reorderMyDayItems,
  resolveMyDayGroupSelection,
  resolveMyDaySortSelection,
  sortMyDayItems,
} from '@/lib/utils/my-day-view';
import type {
  CalendarEvent,
  ConfirmDialogState,
  DayPlan,
  EnergyLevel,
  MyDayItem,
  SaveTemplateTask,
  ScheduledTask,
  SourceList,
  SuggestionGroups,
  TodayView,
} from './types';
import type { LocalDisposition } from '@/types';

const MY_DAY_SORT_KEY = 'mission-control:my-day-sort-by';
const MY_DAY_SORT_DIRECTION_KEY = 'mission-control:my-day-sort-direction';
const MY_DAY_GROUP_KEY = 'mission-control:my-day-group-by';
const MY_DAY_LAST_COMPUTED_SORT_KEY = 'mission-control:my-day-last-computed-sort';
const MY_DAY_SORT_OPTIONS: readonly SortOption[] = [
  { value: 'manual', label: 'Manual Order', supportsDirection: false },
  ...DEFAULT_SORT_OPTIONS,
];

interface TodayMainPanelProps {
  data: {
    items: MyDayItem[];
    scheduled: ScheduledTask[];
    calendarEvents: CalendarEvent[];
    loading: boolean;
    energyLevel: EnergyLevel | null;
    todayISO: string;
    sourceLists: SourceList[];
    listGroups?: ListGroup[];
    projects: HubProject[];
    completingIds: Set<string>;
    suggestions?: SuggestionGroups;
  };
  taskActions: {
    setItems: Dispatch<SetStateAction<MyDayItem[]>>;
    fetchData: (options?: { skipSync?: boolean }) => Promise<void>;
    completeTask: (taskId: string) => Promise<boolean>;
    removeFromDay: (taskId: string) => Promise<void>;
    setPriority: (taskId: string, priority: string) => Promise<void>;
    setStatus: (taskId: string, status: string) => Promise<void>;
    setDueDate: (taskId: string, date: string | null) => Promise<void>;
    setLocalDisposition: (taskId: string, disposition: LocalDisposition) => Promise<boolean>;
    moveToList: (taskId: string, targetListId: string) => Promise<void>;
    deleteTask: (taskId: string) => Promise<void>;
    addToProject: (taskId: string, projectId: string, phaseId?: string | null) => Promise<void>;
    saveTemplateTask: Dispatch<SetStateAction<SaveTemplateTask | null>>;
    openNotes: (taskId: string, mode: 'read' | 'edit') => void;
    addToDay?: (taskId: string) => void;
    moveToSource?: (taskId: string) => void;
  };
  selection: {
    selectedTaskId: string | null;
    selectTask: (taskId: string | null) => void;
    doubleClickTask?: (taskId: string) => void;
    cancelPendingTaskSelection?: () => void;
  };
  focus: {
    showTimer: boolean;
    setShowTimer: Dispatch<SetStateAction<boolean>>;
    focusTask: MyDayItem | null;
    setFocusTask: Dispatch<SetStateAction<MyDayItem | null>>;
    startFocus: (item: MyDayItem) => void;
  };
  planning: {
    openScheduleModal: (taskId: string | null) => void;
    whatsNextResult: string | null;
    setWhatsNextResult: Dispatch<SetStateAction<string | null>>;
    getWhatsNext: () => Promise<void>;
    dayPlan: DayPlan | null;
    setDayPlan: Dispatch<SetStateAction<DayPlan | null>>;
    planningDay: boolean;
    planMyDay: () => Promise<void>;
    scheduleAtTime: (taskId: string, time: string, duration: number) => Promise<void>;
    unscheduleTask: (taskId: string) => Promise<void>;
    resizeScheduledTask: (taskId: string, newDuration: number) => Promise<void>;
    setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  };
  setEnergyLevel: Dispatch<SetStateAction<EnergyLevel | null>>;
}

export function TodayViewSwitcher({
  todayISO,
  view,
  onViewChange,
}: {
  todayISO: string;
  view: TodayView;
  onViewChange: (view: TodayView) => void;
}) {
  return (
    <div className="flex bg-[var(--surface-2)] rounded-md p-0.5">
      <button onClick={() => onViewChange('list')} className={`px-3 py-1 text-xs rounded ${view === 'list' ? 'bg-[var(--surface-1)] shadow-sm font-medium' : 'text-[var(--text-tertiary)]'}`}>List</button>
      <button onClick={() => onViewChange('timeline')} className={`px-3 py-1 text-xs rounded ${view === 'timeline' ? 'bg-[var(--surface-1)] shadow-sm font-medium' : 'text-[var(--text-tertiary)]'}`}>Timeline</button>
      <Link
        href={buildGraphUniverseHref({
          context: taskFilterContextForToday(todayISO),
          origin: { href: '/today', label: 'My Day' },
        })}
        aria-label="View My Day in Graph"
        className="flex items-center gap-1 rounded px-3 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
      >
        <Network size={12} aria-hidden="true" /> Graph
      </Link>
    </div>
  );
}

export function TodayMainPanel({
  data,
  taskActions,
  selection,
  focus,
  planning,
  setEnergyLevel: onSetEnergyLevel,
}: TodayMainPanelProps) {
  const {
    items, scheduled, calendarEvents, loading, energyLevel, todayISO, sourceLists,
    listGroups, projects, completingIds, suggestions,
  } = data;
  const {
    setItems, fetchData, completeTask: onCompleteTask, removeFromDay: onRemoveFromDay,
    setPriority: onSetTaskPriority, setStatus: onSetTaskStatus,
    setDueDate: onSetTaskDueDate, setLocalDisposition: onSetTaskLocalDisposition,
    moveToList: onMoveTaskToList, deleteTask: onDeleteTask,
    addToProject: onAddTaskToProject, saveTemplateTask: onSaveTemplateTask,
    openNotes: onOpenTaskNotes, addToDay: onAddToDay, moveToSource: onMoveToSource,
  } = taskActions;
  const {
    selectedTaskId, selectTask: onSelectTask, doubleClickTask: onDoubleClickTask,
    cancelPendingTaskSelection: onCancelPendingTaskSelection,
  } = selection;
  const {
    showTimer, setShowTimer: onSetShowTimer, focusTask, setFocusTask: onSetFocusTask,
    startFocus: onStartFocus,
  } = focus;
  const {
    openScheduleModal: onOpenScheduleModal, whatsNextResult,
    setWhatsNextResult: onSetWhatsNextResult, getWhatsNext: onGetWhatsNext, dayPlan,
    setDayPlan: onSetDayPlan, planningDay, planMyDay: onPlanMyDay,
    scheduleAtTime: onScheduleAtTime, unscheduleTask: onUnscheduleTask,
    resizeScheduledTask: onResizeScheduledTask, setConfirmDialog: onSetConfirmDialog,
  } = planning;
  const bulk = useBulkSelection();
  const selectedBulkItems = items.filter((item) => bulk.bulkSelected.has(item.taskId));
  const selectedBulkPolicies = selectedBulkItems.map((item) => item.editPolicy);
  const bulkStatusBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'status');
  const bulkPriorityBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'priority');
  const bulkDueDateBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'dueDate');
  const bulkMoveBlockedReason = selectedBulkItems.find((item) => !item.editPolicy.sourceMoveSupported)?.editPolicy.sourceMoveReason;
  const bulkRemovalBlockedReason = selectedTaskRemovalBlockedReason(selectedBulkPolicies);
  const { toggleCalm } = useViewMode();
  const [view, setView] = useState<TodayView>('list');
  const [showCalendar, setShowCalendar] = useState(true);
  const [sortBy, setSortBy] = useState('priority');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [groupBy, setGroupBy] = useState('none');
  const [viewDensity, setViewDensity] = useState<ViewDensity>('comfortable');
  const [showCancelled, setShowCancelled] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const lastComputedSort = useRef('priority');
  const [filterContext, setFilterContext] = useState<TaskFilterContext>(() => ({
    ...EMPTY_TASK_FILTER_CONTEXT,
    completion: 'all',
  }));
  const today = useMemo(
    () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    [],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Pull-to-refresh for mobile
  const onRefresh = useCallback(async () => { await fetchData(); }, [fetchData]);
  const { containerRef: pullRef, isRefreshing, pullDistance, containerProps: pullProps } = usePullToRefresh({ onRefresh });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'T') {
        event.preventDefault();
        onSetShowTimer((current) => !current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSetShowTimer]);

  useEffect(() => {
    const storedSort = localStorage.getItem(MY_DAY_SORT_KEY)
      || localStorage.getItem('mission-control:sort-by');
    const storedDirection = localStorage.getItem(MY_DAY_SORT_DIRECTION_KEY)
      || localStorage.getItem('mission-control:sort-direction');
    const storedGroup = localStorage.getItem(MY_DAY_GROUP_KEY)
      || localStorage.getItem('mission-control:group-by');
    const storedLastComputedSort = localStorage.getItem(MY_DAY_LAST_COMPUTED_SORT_KEY);

    if (storedLastComputedSort) lastComputedSort.current = storedLastComputedSort;
    if (storedSort) {
      setSortBy(storedSort);
      if (storedSort !== 'manual') {
        lastComputedSort.current = storedSort;
        localStorage.setItem(MY_DAY_LAST_COMPUTED_SORT_KEY, storedSort);
      }
    }
    if (storedDirection === 'asc' || storedDirection === 'desc') setSortDirection(storedDirection);
    if (storedSort === 'manual') {
      setGroupBy('none');
      localStorage.setItem(MY_DAY_GROUP_KEY, 'none');
    } else if (storedGroup) {
      setGroupBy(storedGroup);
    }
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const storedDensity = localStorage.getItem('mission-control:view-density') as ViewDensity | null;
      if (storedDensity === 'compact' || storedDensity === 'comfortable') setViewDensity(storedDensity);
    });

    const densityHandler = (event: Event) => setViewDensity((event as CustomEvent<ViewDensity>).detail);
    window.addEventListener('mission-control:density-change', densityHandler);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('mission-control:density-change', densityHandler);
    };
  }, []);

  const allItemsByStatus = useMemo(() => partitionMyDayItems(items), [items]);
  const completionPercentage = useMemo(() => getMyDayCompletionPercentage(items), [items]);
  const filteredItems = useMemo(
    () => filterMyDayItems(items, filterContext.query),
    [filterContext.query, items],
  );
  const filteredItemsByStatus = useMemo(
    () => partitionMyDayItems(filteredItems),
    [filteredItems],
  );
  const activeItems = useMemo(
    () => sortMyDayItems(filteredItemsByStatus.open, sortBy, sortDirection),
    [filteredItemsByStatus.open, sortBy, sortDirection],
  );
  const completedItems = useMemo(
    () => sortMyDayItems(filteredItemsByStatus.completed, sortBy, sortDirection),
    [filteredItemsByStatus.completed, sortBy, sortDirection],
  );
  const cancelledItems = useMemo(
    () => sortMyDayItems(filteredItemsByStatus.cancelled, sortBy, sortDirection),
    [filteredItemsByStatus.cancelled, sortBy, sortDirection],
  );
  const taskGroups = useMemo(
    () => groupMyDayItems(activeItems, groupBy, projects),
    [activeItems, groupBy, projects],
  );
  const inProgressItems = useMemo(
    () => items.filter((item) => item.status === 'in_progress'),
    [items],
  );
  const filterSources = useMemo<EnabledSource[]>(() => {
    const sourceTypes = new Set(items.map((item) => item.connectorType));
    return [...sourceTypes].map((type) => ({
      type,
      name: type.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()),
      icon: CONNECTOR_ICONS[type] || '',
    }));
  }, [items]);
  const filterTags = useMemo<TaskTag[]>(() => {
    const uniqueTags = new Map<string, TaskTag>();
    for (const item of items) {
      for (const tag of item.tags) uniqueTags.set(tag.slug, tag);
    }
    return [...uniqueTags.values()];
  }, [items]);
  const filterAssignees = useMemo(() => {
    const assignees = new Set<string>();
    for (const item of items) {
      const assignee = item.assignee?.trim();
      if (assignee) assignees.add(assignee);
    }
    return [...assignees].sort((a, b) => a.localeCompare(b));
  }, [items]);
  const activeTagFilters = useMemo(
    () => parseFilterQuery(filterContext.query).tagTokens,
    [filterContext.query],
  );
  const hasFilters = filterContext.query.trim().length > 0;
  const manualOrderActive = sortBy === 'manual';
  const canReorder = manualOrderActive && groupBy === 'none' && !hasFilters && !savingOrder;

  function handleSortChange(nextSortBy: string, nextDirection: 'asc' | 'desc') {
    const nextMode = resolveMyDaySortSelection(nextSortBy, groupBy);
    if (nextMode.groupBy !== groupBy) {
      setGroupBy(nextMode.groupBy);
      localStorage.setItem(MY_DAY_GROUP_KEY, nextMode.groupBy);
      toast.info('Grouping turned off to enable manual ordering.');
    }
    if (nextSortBy !== 'manual') {
      lastComputedSort.current = nextSortBy;
      localStorage.setItem(MY_DAY_LAST_COMPUTED_SORT_KEY, nextSortBy);
    }
    setSortBy(nextMode.sortBy);
    setSortDirection(nextDirection);
    localStorage.setItem(MY_DAY_SORT_KEY, nextMode.sortBy);
    localStorage.setItem(MY_DAY_SORT_DIRECTION_KEY, nextDirection);
  }

  function handleGroupChange(nextGroupBy: string) {
    const nextMode = resolveMyDayGroupSelection(
      nextGroupBy,
      sortBy,
      lastComputedSort.current,
    );
    if (nextMode.sortBy !== sortBy) {
      setSortBy(nextMode.sortBy);
      localStorage.setItem(MY_DAY_SORT_KEY, nextMode.sortBy);
      toast.info('Manual ordering turned off while tasks are grouped.');
    }
    if (nextMode.sortBy !== 'manual') {
      lastComputedSort.current = nextMode.sortBy;
      localStorage.setItem(MY_DAY_LAST_COMPUTED_SORT_KEY, nextMode.sortBy);
    }
    setGroupBy(nextMode.groupBy);
    localStorage.setItem(MY_DAY_GROUP_KEY, nextMode.groupBy);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!canReorder || !over || active.id === over.id) return;

    const previousOrder = items.map((item) => item.id);
    const reorderedItems = reorderMyDayItems(items, String(active.id), String(over.id));
    if (reorderedItems === items) return;

    setItems(reorderedItems);
    setSavingOrder(true);
    try {
      const response = await fetch('/api/my-day', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: todayISO,
          orderedItemIds: reorderedItems.map((item) => item.id),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Failed to save My Day order');
      }
      setItems((current) => applyMyDayItemOrder(
        current,
        reorderedItems.map((item) => item.id),
      ));
      await fetchData({ skipSync: true });
    } catch (error) {
      setItems((current) => applyMyDayItemOrder(current, previousOrder));
      toast.error(error instanceof Error ? error.message : 'Failed to save My Day order');
      await fetchData({ skipSync: true });
    } finally {
      setSavingOrder(false);
    }
  }

  const getContextMenuActions = useTaskContextMenuActionFactory({
    complete: onCompleteTask,
    setPriority: onSetTaskPriority,
    setStatus: onSetTaskStatus,
    removeFromMyDay: onRemoveFromDay,
    setDueDate: onSetTaskDueDate,
    setLocalDisposition: onSetTaskLocalDisposition,
    moveToList: onMoveTaskToList,
    moveToSource: onMoveToSource,
    addToProject: onAddTaskToProject,
    deleteTask: onDeleteTask,
    saveAsTemplate: onSaveTemplateTask,
  });

  const totalMinutes = scheduled
    .filter((task) => task.status !== 'cancelled')
    .reduce((sum, task) => sum + (task.estimatedDuration || 30), 0);
  const clearFilters = useCallback(() => {
    setFilterContext({ ...EMPTY_TASK_FILTER_CONTEXT, completion: 'all' });
  }, []);
  const toggleTagFilter = useCallback((tagSlug: string) => {
    setFilterContext((current) => {
      const parsed = parseFilterQuery(current.query);
      const existing = parsed.tokens.findIndex(
        (token) => token.type === 'tag' && token.value === tagSlug && !token.negated,
      );
      const tokens = existing >= 0
        ? parsed.tokens.filter((_, index) => index !== existing)
        : [...parsed.tokens, {
            type: 'tag' as const,
            value: tagSlug,
            raw: `tag:${tagSlug}`,
            negated: false,
          }];
      return { ...current, query: tokens.map((token) => token.raw).join(' ') };
    });
  }, []);

  const handleModifierClick = useCallback((taskId: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const items = activeItems;
    const clickedIndex = items.findIndex((item) => item.taskId === taskId);
    if (e.shiftKey && groupBy === 'none') {
      const enteringBulk = !bulk.bulkMode;
      if (enteringBulk) bulk.enterBulkMode();
      const lastIndex = resolveSelectionAnchorIndex(
        items.map((item) => item.taskId),
        bulk.lastClickedIndexRef.current,
        enteringBulk ? selectedTaskId : null,
      );
      if (lastIndex !== null && lastIndex !== clickedIndex) {
        const start = Math.min(lastIndex, clickedIndex);
        const end = Math.max(lastIndex, clickedIndex);
        bulk.setBulkSelected((prev) => {
          const next = new Set(prev);
          if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
          for (let i = start; i <= end; i++) {
            const item = items[i];
            if (item) next.add(item.taskId);
          }
          return next;
        });
      } else {
        bulk.setBulkSelected((prev) => {
          const next = new Set(prev);
          if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
          next.add(taskId);
          return next;
        });
      }
      bulk.lastClickedIndexRef.current = clickedIndex;
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const enteringBulk = !bulk.bulkMode;
      if (enteringBulk) bulk.enterBulkMode();
      bulk.setBulkSelected((prev) => {
        const next = new Set(prev);
        if (enteringBulk && selectedTaskId) next.add(selectedTaskId);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
      bulk.lastClickedIndexRef.current = clickedIndex;
    }
  }, [activeItems, bulk, groupBy, selectedTaskId]);

  return (
    <div className="hidden min-w-0 flex-1 overflow-y-auto p-4 sm:block sm:p-6" ref={pullRef} {...pullProps}>
      {/* Pull-to-refresh indicator */}
      {(pullDistance > 0 || isRefreshing) && (
        <div className="flex items-center justify-center overflow-hidden sm:hidden" style={{ height: `${pullDistance}px` }}>
          <Loader2
            size={18}
            className={`text-[var(--accent-400)] ${isRefreshing ? 'animate-spin' : ''}`}
            style={{ opacity: Math.min(pullDistance / 32, 1), transform: `rotate(${pullDistance * 3}deg)` }}
          />
        </div>
      )}
      <div className={`mx-auto ${view === 'timeline' ? 'max-w-6xl' : 'max-w-4xl'}`}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-[var(--text-primary)] flex items-center gap-2"><Sun size={20} className="text-amber-500" /> My Day</h2>
            <p className="text-sm text-[var(--text-tertiary)] mt-0.5">{today}</p>
          </div>
          <div className="flex items-center gap-2">
            <TodayViewSwitcher todayISO={todayISO} view={view} onViewChange={setView} />
            <button onClick={() => setShowCalendar((current) => !current)} aria-pressed={showCalendar} className={`px-3 py-1.5 text-xs rounded-md border font-medium flex items-center gap-1 transition-colors ${showCalendar ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/20' : 'bg-transparent text-[var(--text-tertiary)] border-[var(--border)] hover:bg-[var(--surface-1)]'}`}><Calendar size={12} />Calendar</button>
            <button onClick={() => onSetShowTimer((current) => !current)} aria-pressed={showTimer} className={`px-3 py-1.5 text-xs rounded-md border font-medium flex items-center gap-1 transition-colors ${showTimer ? 'bg-blue-500/15 text-blue-300 border-blue-500/30 hover:bg-blue-500/20' : 'bg-transparent text-[var(--text-tertiary)] border-[var(--border)] hover:bg-[var(--surface-1)]'}`}><Timer size={12} />Timer</button>
            <button onClick={() => { void onGetWhatsNext(); }} className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded-md hover:bg-purple-700 font-medium flex items-center gap-1"><Target size={12} /> What&apos;s Next?</button>
            <button onClick={() => { void onPlanMyDay(); }} disabled={planningDay} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium flex items-center gap-1 disabled:opacity-50">{planningDay ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}{planningDay ? 'Planning...' : 'AI Plan Day'}</button>
            {allItemsByStatus.open.length > 0 && (
              <button onClick={() => toggleCalm({ type: 'my-day', taskIds: allItemsByStatus.open.map(i => i.taskId), label: 'My Day' })} className="px-3 py-1.5 text-xs bg-transparent text-[var(--text-tertiary)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-1)] font-medium flex items-center gap-1"><Moon size={12} />Calm</button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 mb-6 p-3 bg-[var(--surface-0)] rounded-lg border border-[var(--border)]">
          <div className="text-center"><p className="text-lg font-semibold text-[var(--text-primary)]">{allItemsByStatus.open.length}</p><p className="text-xs text-[var(--text-tertiary)] uppercase">Open</p></div>
          <div className="w-px h-8 bg-gray-200" />
          <div className="text-center"><p className="text-lg font-semibold text-[var(--text-primary)]">{allItemsByStatus.completed.length}</p><p className="text-xs text-[var(--text-tertiary)] uppercase">Done</p></div>
          <div className="w-px h-8 bg-gray-200" />
          <div className="text-center"><p className="text-lg font-semibold text-[var(--text-primary)]">{allItemsByStatus.cancelled.length}</p><p className="text-xs text-[var(--text-tertiary)] uppercase">Cancelled</p></div>
          <div className="w-px h-8 bg-gray-200" />
          <div className="text-center"><p className="text-lg font-semibold text-[var(--text-primary)]">{Math.round(totalMinutes / 60 * 10) / 10}h</p><p className="text-xs text-[var(--text-tertiary)] uppercase">Scheduled Time</p></div>
          <div className="w-px h-8 bg-gray-200" />
          <div className="flex-1">
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-green-500 rounded-full transition-[width]" style={{ width: `${completionPercentage}%` }} /></div>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{completionPercentage}% complete</p>
          </div>
          {energyLevel && (
            <div className="ml-auto">
              <EnergyIndicator
                level={energyLevel}
                onChange={async (level) => {
                  onSetEnergyLevel(level);
                  await fetch('/api/energy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }) }).catch((err) => { uiLogger.error('Failed to save energy level', { err }); });
                }}
              />
            </div>
          )}
        </div>

        <EnergyCheckIn currentLevel={energyLevel} onEnergySet={(level) => onSetEnergyLevel(level)} />

        {focusTask && (
          <div className="mb-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-[var(--accent-400)]"><Target size={11} /> Focusing On</p>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{focusTask.title}</h3>
                <p className="text-xs text-[var(--text-tertiary)] mt-0.5"><ConnectorIcon type={focusTask.connectorType} size={12} /> {focusTask.sourceListName || focusTask.connectorType}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => onSetShowTimer((current) => !current)} className={`px-3 py-1.5 text-xs rounded-md font-medium flex items-center gap-1 transition-[background-color,color] duration-150 ${showTimer ? 'bg-blue-600 text-white' : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'}`}><Timer size={11} /> Timer</button>
                <button
                  disabled={!canEditTaskField(focusTask.editPolicy, 'status')}
                  title={!canEditTaskField(focusTask.editPolicy, 'status') ? taskFieldBlockedReason(focusTask.editPolicy, 'status') : undefined}
                  onClick={() => {
                    const taskId = focusTask.taskId;
                    void onCompleteTask(taskId).then((succeeded) => {
                      if (succeeded) {
                        onSetFocusTask((current) => current?.taskId === taskId ? null : current);
                      }
                    });
                  }}
                  className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 font-medium flex items-center gap-1"
                >
                  <Check size={12} /> Done
                </button>
                <button onClick={() => onSetFocusTask(null)} className="px-3 py-1.5 text-xs bg-gray-200 text-[var(--text-secondary)] rounded-md hover:bg-[var(--surface-3)] font-medium">Stop</button>
              </div>
            </div>
          </div>
        )}

        {whatsNextResult && (
          <AIRecommendation
            recommendation={whatsNextResult}
            onDismiss={() => onSetWhatsNextResult(null)}
          />
        )}

        {dayPlan && (
          <div className="mb-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <div className="flex items-center justify-between mb-3"><p className="text-xs font-medium text-blue-400 uppercase tracking-wide flex items-center gap-1"><Wand2 size={11} /> AI Day Plan</p><button onClick={() => onSetDayPlan(null)} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-xs">?</button></div>
            <p className="text-sm text-[var(--text-secondary)] mb-3">{dayPlan.summary}</p>
            <div className="space-y-1">
              {dayPlan.plan.map((block, index) => (
                <div key={index} className={`flex items-center gap-3 rounded-md border px-3 py-2 text-xs ${block.type === 'calendar' ? 'border-amber-500/40 bg-amber-900/20' : block.type === 'break' ? 'border-[var(--border)] bg-[var(--surface-0)]' : block.type === 'focus' ? 'border-[var(--accent)]/40 bg-[var(--accent-muted)]/20' : 'border-cyan-500/40 bg-cyan-900/20'}`}>
                  <span className="text-[var(--text-muted)] font-mono w-12 shrink-0">{block.time}</span>
                  <span className="text-[var(--text-primary)] flex-1 font-medium">{block.title}</span>
                  <span className="text-[var(--text-muted)]">{block.duration}m</span>
                </div>
              ))}
            </div>
            {dayPlan.suggestions.length > 0 && <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]"><p className="text-xs text-[var(--text-muted)] uppercase font-semibold mb-1">Suggestions</p>{dayPlan.suggestions.map((suggestion, index) => <p key={index} className="text-xs text-[var(--text-tertiary)]">� {suggestion}</p>)}</div>}
          </div>
        )}

        {(showTimer || focusTask) && <div className="mb-6"><TimerPanel taskTitle={focusTask?.title} taskDeadline={focusTask?.dueDate || undefined} /></div>}

        {loading ? (
          <div className="space-y-4 py-4 animate-pulse">
            <div className="h-7 w-48 rounded bg-[var(--surface-secondary)]" />
            <div className="h-4 w-32 rounded bg-[var(--surface-secondary)]" />
            <div className="space-y-0 mt-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
                  <div className="h-4 w-4 rounded-full bg-[var(--surface-secondary)]" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-3/4 rounded bg-[var(--surface-secondary)]" />
                    <div className="h-3 w-1/3 rounded bg-[var(--surface-secondary)]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : view === 'list' ? (
          <>
            <div className="mb-6 grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
              <Focus3Panel onRefresh={fetchData} compact />
              <InProgressPanel
                items={inProgressItems}
                onSelectTask={onSelectTask}
                onStartFocus={onStartFocus}
              />
            </div>
            <TodayRoutinesSection />
            <section className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">Open Tasks ({activeItems.length})</h3>
                {activeItems.length > 0 && !bulk.bulkMode && <button onClick={bulk.enterBulkMode} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">Select</button>}
              </div>
              <TaskKeywordFilter
                filteredCount={filteredItems.length}
                sources={filterSources}
                sourceLists={sourceLists}
                tags={filterTags}
                assignees={filterAssignees}
                projects={projects}
                listGroups={listGroups || []}
                controller={{
                  context: filterContext,
                  setContext: setFilterContext,
                  clear: clearFilters,
                }}
                placeholder="Filter My Day... (press / to focus, ? for help)"
                className="mb-3"
                secondaryContent={
                  <div className="flex items-center gap-1">
                    <ViewDensityToggle />
                    <GroupByDropdown value={groupBy} onChange={handleGroupChange} />
                    <SortDropdown
                      options={MY_DAY_SORT_OPTIONS}
                      value={sortBy}
                      direction={sortDirection}
                      onChange={handleSortChange}
                    />
                  </div>
                }
              />
              {manualOrderActive && (
                <div
                  aria-live="polite"
                  className={`mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                    hasFilters
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                      : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-tertiary)]'
                  }`}
                >
                  <GripVertical size={14} aria-hidden="true" />
                  {hasFilters ? (
                    <>
                      <span className="flex-1">Reordering is paused while filters are active.</span>
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="font-medium text-amber-100 underline underline-offset-2 hover:text-white"
                      >
                        Clear filters to reorder
                      </button>
                    </>
                  ) : savingOrder ? (
                    <span>Saving manual order...</span>
                  ) : (
                    <span>Manual order is active. Drag tasks to reorder.</span>
                  )}
                </div>
              )}
              {bulk.bulkMode && (
                <BulkActionBar selectedCount={bulk.bulkSelected.size} onCancel={bulk.clearSelection}>
                  <button
                    disabled={Boolean(bulkStatusBlockedReason)}
                    title={bulkStatusBlockedReason}
                    onClick={() => {
                      const count = bulk.bulkSelected.size;
                      onSetConfirmDialog({
                        open: true,
                        title: `Complete ${count} task${count > 1 ? 's' : ''}?`,
                        message: `This will mark ${count} task${count > 1 ? 's' : ''} as completed.`,
                        confirmLabel: 'Complete All',
                        variant: 'warning',
                        onConfirm: () => {
                          onSetConfirmDialog((dialog) => ({ ...dialog, open: false }));
                          requestAnimationFrame(async () => {
                            const ids = Array.from(bulk.bulkSelected);
                            const { failed } = await executeBulkOperation(ids, async (id) => {
                              if (!await onCompleteTask(id)) throw new Error('Failed to complete task');
                            }, `Completed ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                            if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                            else bulk.clearSelection();
                          });
                        },
                      });
                    }}
                    className="text-xs px-2 py-1 bg-green-900/30 text-green-300 border border-green-800/40 rounded-[var(--radius-sm)] hover:bg-green-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Check size={12} className="inline" /> Complete
                  </button>
                  <BulkPriorityDropdown
                    disabled={Boolean(bulkPriorityBlockedReason)}
                    disabledReason={bulkPriorityBlockedReason}
                    onSetPriority={async (priority) => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(ids, (id) => onSetTaskPriority(id, priority) as Promise<void>, `Priority set on ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                    }}
                  />
                  <BulkStatusDropdown
                    disabled={Boolean(bulkStatusBlockedReason)}
                    disabledReason={bulkStatusBlockedReason}
                    onSetStatus={async (status) => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(ids, (id) => onSetTaskStatus(id, status) as Promise<void>, `Status set on ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                    }}
                  />
                  <BulkDispositionButtons
                    tasks={selectedBulkItems}
                    onSetDisposition={async (localDisposition) => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(
                        ids,
                        (id) => fetch(`/api/tasks/${id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ localDisposition }),
                        }),
                        localDisposition === 'handled'
                          ? `Marked ${ids.length} task${ids.length > 1 ? 's' : ''} handled in Mission Control`
                          : `Dismissed ${ids.length} task${ids.length > 1 ? 's' : ''} in Mission Control`,
                      );
                      setItems((current) => current.filter((item) => (
                        !ids.includes(item.taskId) || failed.includes(item.taskId)
                      )));
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                    }}
                  />
                  <BulkDueDateDropdown
                    disabled={Boolean(bulkDueDateBlockedReason)}
                    disabledReason={bulkDueDateBlockedReason}
                    onSetDate={async (date) => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(
                        ids,
                        (id) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dueDate: date || null }) }),
                        date ? `Due date set on ${ids.length} task${ids.length > 1 ? 's' : ''}` : `Due date cleared on ${ids.length} task${ids.length > 1 ? 's' : ''}`,
                      );
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                      void fetchData();
                    }}
                  />
                  <BulkMoveDropdown
                    sourceLists={sourceLists}
                    disabled={Boolean(bulkMoveBlockedReason)}
                    disabledReason={bulkMoveBlockedReason}
                    onMove={async (targetListId) => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(ids, (id) => onMoveTaskToList(id, targetListId) as Promise<void>, `Moved ${ids.length} task${ids.length > 1 ? 's' : ''}`);
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                    }}
                  />
                  <BulkMoveToSourceButton
                    selectedTaskIds={Array.from(bulk.bulkSelected)}
                    onComplete={() => {
                      bulk.clearSelection();
                      void fetchData();
                    }}
                  />
                  <button
                    onClick={async () => {
                      const ids = Array.from(bulk.bulkSelected);
                      const { failed } = await executeBulkOperation(ids, (id) => onRemoveFromDay(id) as Promise<void>, `Removed ${ids.length} task${ids.length > 1 ? 's' : ''} from My Day`);
                      if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                      else bulk.clearSelection();
                    }}
                    className="text-xs px-2 py-1 bg-slate-900/30 text-slate-300 border border-slate-800/40 rounded-[var(--radius-sm)] hover:bg-slate-900/50 transition-colors duration-100"
                  >
                    <Sun size={12} className="inline" /> Remove from My Day
                  </button>
                  <button
                    onClick={() => {
                      const count = bulk.bulkSelected.size;
                      onSetConfirmDialog({
                        open: true,
                        title: `Delete ${count} task${count > 1 ? 's' : ''}?`,
                        message: 'Each selected task will be deleted locally, cancelled locally, closed, or deleted at its source according to its task policy.',
                        confirmLabel: 'Remove tasks',
                        variant: 'danger',
                        onConfirm: () => {
                          onSetConfirmDialog((dialog) => ({ ...dialog, open: false }));
                          requestAnimationFrame(async () => {
                            const ids = Array.from(bulk.bulkSelected);
                            const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }), `${ids.length} task${ids.length > 1 ? 's' : ''} deleted`);
                            if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                            else bulk.clearSelection();
                            void fetchData();
                          });
                        },
                      });
                    }}
                    disabled={Boolean(bulkRemovalBlockedReason)}
                    title={bulkRemovalBlockedReason}
                    className="text-xs px-2 py-1 bg-red-900/30 text-red-300 border border-red-800/40 rounded-[var(--radius-sm)] hover:bg-red-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={12} className="inline" /> Delete
                  </button>
                </BulkActionBar>
              )}
              {allItemsByStatus.open.length === 0 ? (
                <div className="bg-[var(--surface-1)] rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-[var(--text-muted)]">
                  {allItemsByStatus.completed.length + allItemsByStatus.cancelled.length > 0 ? (
                    <p className="text-sm">No open tasks remain.</p>
                  ) : (
                    <><p className="text-sm mb-2">A fresh day &mdash; let&apos;s pick your focus!</p><p className="text-xs">Grab something from the suggestions panel, or tap &quot;What&apos;s Next?&quot; and let AI pick for you.</p></>
                  )}
                </div>
              ) : activeItems.length === 0 ? (
                <div className="bg-[var(--surface-1)] rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-[var(--text-muted)]">
                  <p className="text-sm mb-2">No My Day tasks match these filters.</p>
                  <button type="button" onClick={clearFilters} className="text-xs font-medium text-[var(--accent-400)] hover:text-[var(--accent-300)]">Clear filters</button>
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext
                    items={taskGroups.flatMap((group) =>
                      group.items.map((item) => groupBy === 'none' ? item.id : `${group.id}:${item.id}`),
                    )}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className={groupBy === 'none' ? '' : 'space-y-4'}>
                      {taskGroups.map((group) => (
                        <section key={group.id}>
                          {group.label && (
                            <div className="mb-2 flex items-center gap-2 px-1">
                              <h4 className="text-xs font-semibold text-[var(--text-secondary)]">{group.label}</h4>
                              <span className="text-xs text-[var(--text-muted)]">{group.items.length}</span>
                            </div>
                          )}
                          <div className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] divide-y divide-[var(--border-subtle)]">
                            <AnimatePresence initial={false}>
                              {group.items.map((item) => {
                                const taskSchedule = scheduled.find((task) => task.taskId === item.taskId);
                                return (
                                  <motion.div key={item.id} layout initial={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0, overflow: 'hidden' }} transition={{ duration: 0.3, ease: 'easeInOut' }}>
                                    <SortableTaskRow
                                      item={item}
                                      taskSchedule={taskSchedule}
                                      onComplete={(taskId) => { void onCompleteTask(taskId); }}
                                      onFocus={onStartFocus}
                                      onSchedule={onOpenScheduleModal}
                                      onRemove={(taskId) => { void onRemoveFromDay(taskId); }}
                                      onSelect={onSelectTask}
                                      onDoubleClick={onDoubleClickTask}
                                      onModifierClick={(taskId, event) => {
                                        onCancelPendingTaskSelection?.();
                                        handleModifierClick(taskId, event);
                                      }}
                                      isSelected={selectedTaskId === item.taskId}
                                      isCompleting={completingIds.has(item.taskId)}
                                      bulkMode={bulk.bulkMode}
                                      bulkSelected={bulk.bulkSelected.has(item.taskId)}
                                      onBulkToggle={() => {
                                        onCancelPendingTaskSelection?.();
                                        bulk.toggleItem(item.taskId);
                                      }}
                                      contextMenuActions={getContextMenuActions({
                                        id: item.taskId,
                                        title: item.title,
                                        dueDate: item.dueDate,
                                        metadata: item.metadata,
                                        isInMyDay: true,
                                      })}
                                      onSetDueDate={(date) => onSetTaskDueDate(item.taskId, date)}
                                      onSetPriority={(priority) => onSetTaskPriority(item.taskId, priority)}
                                      onSetStatus={(status) => onSetTaskStatus(item.taskId, status)}
                                      onOpenNotes={(mode) => onOpenTaskNotes(item.taskId, mode)}
                                      sourceLists={sourceLists}
                                      listGroups={listGroups}
                                      projects={projects}
                                      compact={viewDensity === 'compact'}
                                      draggable={canReorder}
                                      sortableId={groupBy === 'none' ? item.id : `${group.id}:${item.id}`}
                                      activeTagFilters={activeTagFilters}
                                      onToggleTagFilter={toggleTagFilter}
                                    />
                                  </motion.div>
                                );
                              })}
                            </AnimatePresence>
                          </div>
                        </section>
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </section>

            {completedItems.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-3">Completed ({completedItems.length})</h3>
                <div className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] divide-y divide-[var(--border-subtle)] opacity-60">
                  {completedItems.map((item) => (
                    <div
                      key={item.id}
                      className={`px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-[var(--surface-2)] transition-colors ${selectedTaskId === item.taskId ? 'ring-1 ring-inset ring-[var(--accent-400)] bg-[var(--accent-500)]/8 rounded-sm' : ''}`}
                      onClick={() => onSelectTask(item.taskId)}
                    >
                      <span className="text-green-400"><Check size={12} /></span>
                      <span className="text-sm text-[var(--text-tertiary)] line-through">{item.title}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {cancelledItems.length > 0 && (
              <section className="mt-6">
                <button
                  type="button"
                  aria-expanded={showCancelled}
                  aria-controls="my-day-cancelled-tasks"
                  onClick={() => setShowCancelled((current) => !current)}
                  className="mb-3 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                >
                  {showCancelled ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Cancelled ({cancelledItems.length})
                </button>
                {showCancelled && (
                  <div id="my-day-cancelled-tasks" className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
                    {cancelledItems.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--surface-2)] ${selectedTaskId === item.taskId ? 'ring-1 ring-inset ring-[var(--accent-400)] bg-[var(--accent-500)]/8' : ''}`}
                        onClick={() => onSelectTask(item.taskId)}
                      >
                        <CircleDot size={12} className="text-[var(--text-tertiary)]" />
                        <span className="text-sm text-[var(--text-secondary)]">{item.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        ) : (
          <section className="mb-6">
            <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-3">Timeline</h3>
            <div className="h-[600px]">
              <InteractiveTimeline items={items} scheduled={scheduled} calendarEvents={showCalendar ? calendarEvents : []} todayISO={todayISO} onSchedule={onScheduleAtTime} onUnschedule={onUnscheduleTask} onResize={onResizeScheduledTask} />
            </div>
          </section>
        )}

        {/* Mobile suggestions — visible only on small screens at the bottom of scroll */}
        {suggestions && onAddToDay && (
          <MobileSuggestions suggestions={suggestions} onAddToDay={onAddToDay} onSelectTask={(taskId) => onSelectTask(taskId)} />
        )}
      </div>
    </div>
  );
}

export function InProgressPanel({
  items,
  onSelectTask,
  onStartFocus,
}: {
  items: MyDayItem[];
  onSelectTask: (taskId: string) => void;
  onStartFocus: (item: MyDayItem) => void;
}) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-blue-500/35 bg-[var(--surface-1)]">
      <div className="flex items-center justify-between border-b border-blue-500/15 px-4 py-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-blue-300">
          <CircleDot size={13} className="text-blue-400" />
          In Progress
          <span className="text-blue-400">({items.length})</span>
        </h3>
      </div>
      {items.length === 0 ? (
        <div className="flex min-h-36 items-center justify-center px-5 text-center">
          <div>
            <p className="text-sm text-[var(--text-secondary)]">Nothing is in progress yet.</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Change a task&apos;s status to make active work visible here.</p>
          </div>
        </div>
      ) : (
        <div className="px-3 py-2">
          {items.slice(0, 3).map((item) => (
            <div
              key={item.taskId}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-blue-500/10"
            >
              <button
                type="button"
                onClick={() => onSelectTask(item.taskId)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600/25 text-blue-300">
                  <CircleDot size={12} />
                </span>
                <ConnectorIcon type={item.connectorType} size={13} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{item.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{item.sourceListName || item.connectorType}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onStartFocus(item)}
                aria-label={`Focus on ${item.title}`}
                className="rounded-full border border-blue-500/35 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-300 opacity-70 transition-opacity group-hover:opacity-100"
              >
                Focus
              </button>
            </div>
          ))}
          {items.length > 3 && (
            <p className="px-2 pb-1 pt-2 text-xs text-[var(--text-muted)]">+{items.length - 3} more in progress</p>
          )}
        </div>
      )}
    </section>
  );
}
