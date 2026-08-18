'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useDashboardFilterState } from '@/lib/hooks/useDashboardFilterState';
import { useDashboardUiState } from '@/lib/hooks/useDashboardUiState';
import { useDashboardSavedViews } from '@/lib/hooks/useDashboardSavedViews';
import { useDashboardTaskActions } from '@/lib/hooks/useDashboardTaskActions';
import { MAX_TASK_PAGE_SIZE } from '@/app/api/tasks/pagination';
import {
  DASHBOARD_TASK_ENTITY_LIMIT,
  dashboardKeys,
  flattenTaskPages,
  useDashboardQueries,
  useTagsQuery,
} from '@/lib/hooks/useDashboardQueries';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { CONNECTOR_COLORS } from '@/lib/constants/colors';
import { uiLogger } from '@/lib/client-logger';
import {
  taskFilterContextFromDashboard,
  parseTaskFilterContext,
  TASK_FILTER_CONTEXT_PARAM,
  taskFilterContextToDashboard,
  taskFilterContextToTaskQuery,
} from '@/lib/task-filter-context';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskResponseViewModel as TaskResponse,
  DashboardTaskTagViewModel as TaskTag,
  ListGroup,
  SourceList,
  EnabledSource,
  SyncStatusEntry,
  SavedView,
} from '@/types/dashboard';
import { PAGE_SIZE } from '@/types/dashboard';
import type { LocalDisposition } from '@/types';
import {
  resolveGroupLoadOffset,
  updateGroupCountsForTaskChange,
} from '@/lib/tasks/task-grouping';

function isRecentQuickFilter(quickFilter: string | null): boolean {
  return quickFilter === 'recentlyCreated' || quickFilter === 'recentlyClosed';
}

function getRecentQuickFilterSortBy(quickFilter: string | null, fallback: string): string {
  if (quickFilter === 'recentlyCreated') return 'createdAt';
  if (quickFilter === 'recentlyClosed') return 'completedAt';
  return fallback;
}

const EMPTY_GROUP_TOTAL_COUNTS: Record<string, number> = {};

export interface TaskDestination {
  id: string;
  label: string;
  connectorType: string;
  account: 'personal' | 'work' | null;
  color: string;
}

function setOptionalSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined || value === '') {
    searchParams.delete(key);
  } else {
    searchParams.set(key, String(value));
  }
}

export interface DashboardState {
  // Data
  taskResponse: TaskResponse;
  projects: HubProject[];
  allTags: TaskTag[];
  allAssignees: string[];
  enabledSources: EnabledSource[];
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  syncStatus: SyncStatusEntry[];
  myDayTaskIds: Set<string>;
  savedViews: SavedView[];
  addTaskDestinations: TaskDestination[];

  // Loading states
  loading: boolean;
  loadingMore: boolean;
  loadingMoreGroups: Set<string>;
  refreshing: boolean;
  isSyncing: boolean;

  // Filters
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];

  // View options
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  groupBy: string;
  viewDensity: 'compact' | 'comfortable';
  showCompleted: boolean;
  hiddenQuickFilters: string[];

  // UI state
  selectedTaskId: string | null;
  bulkMode: boolean;
  bulkSelected: Set<string>;
  collapsedGroups: Set<string>;
  sidebarExpanded: boolean;
  sidebarMode: import('@/lib/hooks/useSidebarExpanded').SidebarMode;
  completingIds: Set<string>;
  exitingTasks: Array<{ id: string; title: string; yOffset: number; reason: 'complete' | 'remove' }>;
  groupTotalCounts: Record<string, number>;  confirmDialog: { open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void };
  saveTemplateTask: { id: string; title: string; subtasks?: string[] } | null;
  detailMode: 'panel' | 'dialog' | 'workspace';
  showAddTaskModal: boolean;
  addTaskInitialDest: TaskDestination | null;
  addTaskInitialListId: string | undefined;

  // Sidebar UI
  collapsedSections: Set<string>;
  expandedSourceLists: Set<string>;
  collapsedListGroups: Set<string>;
  listSearch: string;
  tagSearch: string;
  tagsExpanded: boolean;
  allSourceCounts: Record<string, number>;

  // View saving
  savingView: boolean;
  viewName: string;
}

export interface DashboardActions {
  // Data actions
  fetchData: (append?: boolean, silent?: boolean, preserveCount?: boolean) => Promise<void>;
  loadMoreForGroup: (groupLabel: string) => Promise<void>;
  setRefreshTrigger: React.Dispatch<React.SetStateAction<number>>;
  patchTaskInList: (taskId: string, fields: Record<string, unknown>) => void;

  // Filter actions
  setSourceFilter: (v: string | null) => void;
  setListFilter: (v: string | null) => void;
  setListGroupFilter: (v: string | null) => void;
  setTagFilter: React.Dispatch<React.SetStateAction<string[]>>;
  setQuickFilter: (v: string | null) => void;
  setProjectFilter: (v: string | null) => void;
  setPriorityFilter: React.Dispatch<React.SetStateAction<string[]>>;
  setStatusFilter: React.Dispatch<React.SetStateAction<string[]>>;

  // View options
  setSortBy: (v: string) => void;
  setSortDirection: (v: 'asc' | 'desc') => void;
  setGroupBy: (v: string) => void;
  setViewDensity: (v: 'compact' | 'comfortable') => void;
  setShowCompleted: (v: boolean) => void;
  toggleQuickFilterVisibility: (filterId: string) => void;

  // Task actions
  completeTask: (taskId: string) => Promise<void>;
  snoozeTask: (taskId: string, snoozedUntil: string | null) => Promise<void>;
  deleteTask: (taskId: string) => void;
  setTaskDueDate: (taskId: string, date: string | null) => Promise<void>;
  setTaskPriority: (taskId: string, newPriority: string) => Promise<void>;
  setTaskStatus: (taskId: string, newStatus: string) => Promise<void>;
  setTaskLocalDisposition: (taskId: string, disposition: LocalDisposition) => Promise<void>;
  moveTaskToList: (taskId: string, targetListId: string) => Promise<void>;
  addTaskToProject: (taskId: string, projectId: string, phaseId?: string | null) => Promise<void>;
  addToMyDay: (taskId: string) => Promise<void>;
  removeFromMyDay: (taskId: string) => Promise<void>;

  // UI actions
  setSelectedTaskId: (id: string | null) => void;
  setBulkMode: (v: boolean) => void;
  setBulkSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSidebarExpanded: (v: boolean) => void;
  setSidebarMode: (mode: import('@/lib/hooks/useSidebarExpanded').SidebarMode) => void;
  setConfirmDialog: React.Dispatch<React.SetStateAction<DashboardState['confirmDialog']>>;
  setSaveTemplateTask: (v: DashboardState['saveTemplateTask']) => void;
  setDetailMode: (v: 'panel' | 'dialog' | 'workspace') => void;
  setShowAddTaskModal: (v: boolean) => void;
  setAddTaskInitialDest: (v: TaskDestination | null) => void;
  setAddTaskInitialListId: (v: string | undefined) => void;

  // Sidebar UI actions
  toggleSection: (section: string) => void;
  setExpandedSourceLists: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedListGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  setListSearch: (v: string) => void;
  setTagSearch: (v: string) => void;
  setTagsExpanded: (v: boolean) => void;

  // View save actions
  setSavingView: (v: boolean) => void;
  setViewName: (v: string) => void;
  saveCurrentView: () => void;
  applyView: (view: SavedView) => void;
  deleteView: (id: string) => void;

  // Subtask optimistic update
  updateSubtaskCount: (taskId: string, done: number, total: number) => void;

  // Computed helpers
  animateTaskExit: (taskId: string, title: string, reason?: 'complete' | 'remove') => void;
}

export interface DashboardComputed {
  taskFilterContext: import('@/lib/task-filter-context').TaskFilterContext;
  sidebarSourceCounts: Record<string, number>;
  visibleSourceLists: SourceList[];
  groupedSourceLists: {
    groups: Array<{ group: ListGroup; sourceLists: SourceList[] }>;
    ungroupedLists: SourceList[];
  };
  sourceHasLists: (sourceType: string) => boolean;
  getSourceListsForType: (sourceType: string) => SourceList[];
  syncProgress: { refetchKey: number };
  listRef: React.RefObject<HTMLDivElement | null>;
  lastClickedIndexRef: React.MutableRefObject<number | null>;
}

export function useDashboardData(options: { includeScoreBreakdown?: boolean } = {}): {
  state: DashboardState;
  actions: DashboardActions;
  computed: DashboardComputed;
} {
  const { progress: syncProgress } = useSyncStream();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const ageMinParam = searchParams.get('ageMin');
  const ageMaxParam = searchParams.get('ageMax');
  const myDayDateParam = searchParams.get('myDayDate');
  const queryClient = useQueryClient();
  const includeScoreBreakdown = options.includeScoreBreakdown === true;
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [loadingMoreGroups, setLoadingMoreGroups] = useState<Set<string>>(new Set());
  const groupLoadOffsetsRef = useRef(new Map<string, number>());
  const groupLoadedTaskGroupsRef = useRef(new Map<string, string>());

  const { state: filterState, actions: filterActions } = useDashboardFilterState();
  const {
    sourceFilter, listFilter, listGroupFilter, tagFilter, quickFilter, projectFilter,
    priorityFilter, statusFilter, textFilter, sortBy, sortDirection, groupBy,
    viewDensity, showCompleted, hiddenQuickFilters,
  } = filterState;
  const {
    setSourceFilter, setListFilter, setListGroupFilter, setTagFilter, setQuickFilter,
    setProjectFilter, setPriorityFilter, setStatusFilter, setSortBy, setSortDirection,
    setGroupBy, setViewDensity, setShowCompleted, toggleQuickFilterVisibility,
  } = filterActions;
  const [allTags, setAllTags] = useState<TaskTag[]>([]);
  const filterOptionsQuery = useQuery<{ assignees: string[] }>({
    queryKey: ['dashboard', 'task-filter-options'],
    queryFn: async () => {
      const response = await fetch('/api/tasks/filter-options');
      if (!response.ok) throw new Error('Failed to fetch task filter options');
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const allAssignees = filterOptionsQuery.data?.assignees ?? [];
  const dashboardUi = useDashboardUiState();
  const {
    bulkMode, bulkSelected, collapsedGroups, selectedTaskId, sidebarExpanded, sidebarMode,
    listSearch, collapsedListGroups, confirmDialog, saveTemplateTask, collapsedSections,
    expandedSourceLists, tagSearch, tagsExpanded, detailMode, showAddTaskModal,
    addTaskInitialDest, addTaskInitialListId,
  } = dashboardUi.state;
  const {
    setBulkMode, setBulkSelected, setCollapsedGroups, setSelectedTaskId,
    setSidebarExpanded, setSidebarMode, setListSearch, setCollapsedListGroups,
    setConfirmDialog, setSaveTemplateTask, setExpandedSourceLists, setTagSearch,
    setTagsExpanded, setDetailMode,
    setShowAddTaskModal, setAddTaskInitialDest, setAddTaskInitialListId, toggleSection,
  } = dashboardUi.actions;
  const [enabledSources, setEnabledSources] = useState<EnabledSource[]>([]);
  const [sourceLists, setSourceLists] = useState<SourceList[]>([]);
  const [listGroups, setListGroups] = useState<ListGroup[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusEntry[]>([]);
  const { listRef, lastClickedIndexRef } = dashboardUi;
  const hasHydratedUrlFiltersRef = useRef(false);
  const [allSourceCounts, setAllSourceCounts] = useState<Record<string, number>>({});
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [exitingTasks, setExitingTasks] = useState<Array<{ id: string; title: string; yOffset: number; reason: 'complete' | 'remove' }>>([]);
  const [groupTotalsState, setGroupTotalsState] = useState<{
    scope: string;
    counts: Record<string, number>;
  }>({ scope: '', counts: EMPTY_GROUP_TOTAL_COUNTS });
  const [groupCountsRefreshTrigger, setGroupCountsRefreshTrigger] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [myDayTaskIds, setMyDayTaskIds] = useState<Set<string>>(new Set());
  const [myDayItemStatuses, setMyDayItemStatuses] = useState<Map<string, string>>(new Map());
  const [addTaskDestinations, setAddTaskDestinations] = useState<TaskDestination[]>([
    { id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' },
  ]);

  // Restore a canonical collection snapshot carried by contextual Graph back navigation.
  useEffect(() => {
    const serialized = searchParams.get(TASK_FILTER_CONTEXT_PARAM);
    if (!serialized) return;

    const hydration = parseTaskFilterContext(serialized);
    const restored = taskFilterContextToDashboard(hydration.context);
    useDashboardViewStore.setState({
      sourceFilter: restored.sourceFilter,
      listFilter: restored.listFilter,
      listGroupFilter: restored.listGroupFilter,
      tagFilter: restored.tagFilter,
      quickFilter: restored.quickFilter,
      projectFilter: restored.projectFilter,
      priorityFilter: restored.priorityFilter,
      statusFilter: restored.statusFilter,
      textFilter: restored.textFilter,
      showCompleted: restored.showCompleted,
    });

    const next = new URLSearchParams(searchParams.toString());
    next.delete(TASK_FILTER_CONTEXT_PARAM);
    setOptionalSearchParam(next, 'ageMin', hydration.context.ageMinDays);
    setOptionalSearchParam(next, 'ageMax', hydration.context.ageMaxDays);
    if (hydration.context.quickFilter === 'myDay' && hydration.context.myDayDate) {
      next.set('myDayDate', hydration.context.myDayDate);
    } else {
      next.delete('myDayDate');
    }
    if (hydration.issues.length) {
      toast.warning(`Some saved filters could not be restored: ${hydration.issues.join('; ')}`);
    }
    router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  // Initialize filters from URL search params (e.g. from Insights clickable charts)
  useEffect(() => {
    if (hasHydratedUrlFiltersRef.current) return;
    hasHydratedUrlFiltersRef.current = true;
    if (searchParams.has(TASK_FILTER_CONTEXT_PARAM)) return;
    const urlSource = searchParams.get('source');
    const urlListId = searchParams.get('listId');
    const urlTag = searchParams.get('tag');
    if (urlSource || urlListId || urlTag) {
      setSourceFilter(urlSource);
      setListFilter(urlListId);
      setTagFilter(urlTag ? [urlTag] : []);
    }
  }, [searchParams, setListFilter, setSourceFilter, setTagFilter]);

  // Load available destinations for the Add Task modal
  useEffect(() => {
    let cancelled = false;
    fetch('/api/features')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.taskDestinations && data.taskDestinations.length > 0) {
          const dests = data.taskDestinations.map((td: { id: string; type: string; name: string; account?: string }) => ({
            id: td.id,
            label: td.name,
            connectorType: td.type,
            account: (td.account as 'personal' | 'work') || null,
            color: CONNECTOR_COLORS[td.type] || 'var(--text-muted)',
          }));
          dests.push({ id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' });
          setAddTaskDestinations(dests);
        }
      })
      .catch(() => { /* keep local-only fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for cross-component task selection (e.g. from Zen Mode)
  useEffect(() => {
    const handler = (e: Event) => {
      const taskId = (e as CustomEvent).detail?.taskId;
      if (taskId) {
        e.preventDefault();
        setSelectedTaskId(taskId);
      }
    };
    window.addEventListener('mc:select-task', handler);
    return () => window.removeEventListener('mc:select-task', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push active filters to the QuickAddBar context
  const { setQuickAddFilter, clearQuickAddFilter } = useQuickAddContext();
  useEffect(() => {
    const listInfo = listFilter
      ? sourceLists.find(sl =>
          sl.sourceId === listFilter
          || `${sl.connectorInstanceId}:${sl.sourceId}` === listFilter
        )
      : null;
    setQuickAddFilter({
      sourceFilter,
      listFilter,
      listFilterName: listInfo?.name || null,
      listFilterConnectorType: listInfo
        ? (syncStatus.find(s => s.id === listInfo.connectorInstanceId)?.type || sourceFilter)
        : null,
      projectFilter,
      projectFilterName: projectFilter
        ? (projects.find(project => project.id === projectFilter)?.name || null)
        : null,
    });
  }, [sourceFilter, listFilter, projectFilter, projects, sourceLists, syncStatus, setQuickAddFilter]);

  useEffect(() => {
    return () => clearQuickAddFilter();
  }, [clearQuickAddFilter]);

  // Zustand store handles persistence — no need for manual localStorage/sessionStorage restore

  // Listen for toolbar events
  useEffect(() => {
    const handleSortChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'object' && detail !== null) {
        setSortBy(detail.sortBy);
        setSortDirection(detail.direction);
      } else {
        setSortBy(detail);
      }
    };
    const handleGroupChange = (e: Event) => { setGroupBy((e as CustomEvent).detail); setCollapsedGroups(new Set()); };
    const handleDensityChange = (e: Event) => setViewDensity((e as CustomEvent).detail);
    // Note: sync-complete refetch is handled by the SSE refetchKey mechanism
    // (useSyncStream + the refetchKey effect below), so no listener here.
    const handleTaskAdded = () => {
      setRefreshTrigger((n) => n + 1);
      fetch('/api/connectors')
        .then((r) => r.json())
        .then((data) => {
          if (data.sourceLists) setSourceLists(data.sourceLists);
        })
        .catch((err) => { uiLogger.error('Failed to refresh source list counts', { err }); });
      // Delayed refetch to pick up write-through metadata (e.g. GitHub issue #)
      writeThroughRefetchTimer = window.setTimeout(() => {
        setRefreshTrigger((n) => n + 1);
      }, 3000);
    };
    let writeThroughRefetchTimer: number | undefined;

    window.addEventListener('mission-control:sort-change', handleSortChange);
    window.addEventListener('mission-control:group-change', handleGroupChange);
    window.addEventListener('mission-control:density-change', handleDensityChange);
    window.addEventListener('mission-control:task-added', handleTaskAdded);
    return () => {
      window.removeEventListener('mission-control:sort-change', handleSortChange);
      window.removeEventListener('mission-control:group-change', handleGroupChange);
      window.removeEventListener('mission-control:density-change', handleDensityChange);
      window.removeEventListener('mission-control:task-added', handleTaskAdded);
      if (writeThroughRefetchTimer) window.clearTimeout(writeThroughRefetchTimer);
    };
  }, []);

  // Quick filter sort/group overrides
  const effectiveSortBy = getRecentQuickFilterSortBy(quickFilter, sortBy);
  const effectiveSortDirection = isRecentQuickFilter(quickFilter) ? 'desc' : sortDirection;
  const effectiveGroupBy = isRecentQuickFilter(quickFilter) ? 'none' : groupBy;
  const taskFilterContext = useMemo(() => taskFilterContextFromDashboard({
    sourceFilter,
    listFilter,
    listGroupFilter,
    tagFilter,
    quickFilter,
    projectFilter,
    priorityFilter,
    statusFilter,
    textFilter,
    showCompleted,
    myDayDate: myDayDateParam,
    ageMinDays: ageMinParam === null ? null : Number(ageMinParam),
    ageMaxDays: ageMaxParam === null ? null : Number(ageMaxParam),
  }, {
    minDays: ageMinParam === null ? null : Number(ageMinParam),
    maxDays: ageMaxParam === null ? null : Number(ageMaxParam),
  }), [
    ageMaxParam,
    ageMinParam,
    listFilter,
    listGroupFilter,
    myDayDateParam,
    priorityFilter,
    projectFilter,
    quickFilter,
    showCompleted,
    sourceFilter,
    statusFilter,
    tagFilter,
    textFilter,
  ]);
  const replaceDashboardUrl = useCallback((href: string) => {
    router.replace(href, { scroll: false });
  }, [router]);
  const savedViewsState = useDashboardSavedViews({
    taskFilterContext,
    filterActions,
    searchParams: searchParams.toString(),
    pathname,
    replaceUrl: replaceDashboardUrl,
  });
  const { savedViews, savingView, viewName } = savedViewsState.state;
  const {
    setSavingView, setViewName, saveCurrentView, applyView, deleteView,
  } = savedViewsState.actions;
  const completionScopeKey = JSON.stringify({
    taskFilterContext,
    sortBy: effectiveSortBy,
    sortDirection: effectiveSortDirection,
    groupBy: effectiveGroupBy,
  });
  const groupCountScopeKey = JSON.stringify({
    taskFilterContext,
    groupBy: effectiveGroupBy,
  });
  const groupTotalCounts = groupTotalsState.scope === groupCountScopeKey
    ? groupTotalsState.counts
    : EMPTY_GROUP_TOTAL_COUNTS;

  useEffect(() => {
    groupLoadOffsetsRef.current.clear();
    groupLoadedTaskGroupsRef.current.clear();
  }, [completionScopeKey]);

  // Initial data fetch (features, connectors, list-groups, source counts)
  // These use React Query for caching — re-visits show stale data instantly
  const taskParams = useMemo(() => {
    const initial = new URLSearchParams();
    initial.set('parentOnly', 'true');
    initial.set('limit', String(PAGE_SIZE));
    if (includeScoreBreakdown) initial.set('includeScoreBreakdown', 'true');
    const params = taskFilterContextToTaskQuery(taskFilterContext, initial);
    if (effectiveSortBy && effectiveSortBy !== 'priority') params.set('sortBy', effectiveSortBy);
    if (effectiveSortDirection && effectiveSortDirection !== 'asc') params.set('sortDirection', effectiveSortDirection);
    if (effectiveGroupBy && effectiveGroupBy !== 'none') params.set('groupBy', effectiveGroupBy);
    return params.toString();
  }, [effectiveGroupBy, effectiveSortBy, effectiveSortDirection, includeScoreBreakdown, taskFilterContext]);
  const connectorsRQ = useDashboardQueries(taskParams);
  const taskResponse = useMemo(
    () => flattenTaskPages(connectorsRQ.tasksQuery.data),
    [connectorsRQ.tasksQuery.data],
  );
  const loading = connectorsRQ.tasksQuery.isPending;
  const loadingMore = connectorsRQ.tasksQuery.isFetchingNextPage;
  const refreshing = connectorsRQ.tasksQuery.isFetching && !loading && !loadingMore;
  const isSyncing = syncProgress.isSyncing;
  const taskQueryKey = useMemo(() => dashboardKeys.tasks(taskParams), [taskParams]);
  const setTaskResponse = useCallback((action: React.SetStateAction<TaskResponse>) => {
    queryClient.setQueryData<InfiniteData<TaskResponse, number>>(taskQueryKey, (current) => {
      // Never seed a new filter key from placeholder data belonging to the
      // previous filter. The server mutation still proceeds without optimism.
      if (!current) return current;
      const previous = flattenTaskPages(current);
      const next = typeof action === 'function' ? action(previous) : action;
      const boundedTasks = next.tasks.slice(0, DASHBOARD_TASK_ENTITY_LIMIT);
      return {
        pages: [{
          ...next,
          tasks: boundedTasks,
          hasMore: next.total > boundedTasks.length
            && boundedTasks.length < DASHBOARD_TASK_ENTITY_LIMIT,
        }],
        pageParams: [0],
      };
    });
  }, [queryClient, taskQueryKey]);

  // Task payloads are large, so retain only the active filter/sort variant.
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: ['dashboard', 'tasks'],
      type: 'inactive',
      predicate: (query) => query.queryKey[2] !== taskQueryKey[2],
    });
  }, [queryClient, taskQueryKey]);

  // Sync React Query connector data into local state
  useEffect(() => {
    if (connectorsRQ.connectorsQuery.data) {
      setSyncStatus(connectorsRQ.connectorsQuery.data.syncStatus);
      setSourceLists(connectorsRQ.connectorsQuery.data.sourceLists);
    }
  }, [connectorsRQ.connectorsQuery.data]);

  useEffect(() => {
    if (connectorsRQ.featuresQuery.data) {
      setEnabledSources(connectorsRQ.featuresQuery.data);
    }
  }, [connectorsRQ.featuresQuery.data]);

  useEffect(() => {
    if (connectorsRQ.listGroupsQuery.data) {
      setListGroups(connectorsRQ.listGroupsQuery.data);
    }
  }, [connectorsRQ.listGroupsQuery.data]);

  useEffect(() => {
    if (connectorsRQ.sourceCountsQuery.data) {
      setAllSourceCounts(prev => sourceFilter ? prev : connectorsRQ.sourceCountsQuery.data!);
    }
  }, [connectorsRQ.sourceCountsQuery.data, sourceFilter]);

  useEffect(() => {
    if (connectorsRQ.projectsQuery.data) setProjects(connectorsRQ.projectsQuery.data);
  }, [connectorsRQ.projectsQuery.data]);

  useEffect(() => {
    if (!connectorsRQ.myDayIdsQuery.data) return;
    setMyDayTaskIds(connectorsRQ.myDayIdsQuery.data.ids);
    setMyDayItemStatuses(connectorsRQ.myDayIdsQuery.data.statuses);
  }, [connectorsRQ.myDayIdsQuery.data]);

  // Reactive tags fetch (via React Query)
  const tagsRQ = useTagsQuery(sourceFilter, listFilter, enabledSources, sourceLists);
  useEffect(() => {
    if (tagsRQ.data) {
      setAllTags(tagsRQ.data as TaskTag[]);
    }
  }, [tagsRQ.data]);

  useEffect(() => {
    if (taskResponse.sourceCounts && !sourceFilter) {
      setAllSourceCounts((prev) => ({ ...prev, ...taskResponse.sourceCounts }));
    }
  }, [sourceFilter, taskResponse.sourceCounts]);

  const buildTaskParams = useCallback((offset: number, currentSortBy: string, currentSortDirection: 'asc' | 'desc') => {
    const initial = new URLSearchParams();
    initial.set('parentOnly', 'true');
    initial.set('limit', String(PAGE_SIZE));
    initial.set('offset', String(offset));
    if (includeScoreBreakdown) initial.set('includeScoreBreakdown', 'true');
    const params = taskFilterContextToTaskQuery(taskFilterContext, initial);

    const eSortBy = getRecentQuickFilterSortBy(quickFilter, currentSortBy);
    const eSortDir = isRecentQuickFilter(quickFilter) ? 'desc' : currentSortDirection;
    const eGroupBy = isRecentQuickFilter(quickFilter) ? 'none' : groupBy;
    if (eSortBy && eSortBy !== 'priority') params.set('sortBy', eSortBy);
    if (eSortDir && eSortDir !== 'asc') params.set('sortDirection', eSortDir);
    if (eGroupBy && eGroupBy !== 'none') params.set('groupBy', eGroupBy);
    return params;
  }, [groupBy, includeScoreBreakdown, quickFilter, taskFilterContext]);

  const fetchData = useCallback(async (append = false, silent = false, preserveCount = false) => {
    try {
      if (append) {
        await connectorsRQ.tasksQuery.fetchNextPage();
      } else {
        if (!silent && listRef.current) {
          listRef.current.scrollTo({ top: 0 });
        }
        const tasksPromise = preserveCount
          ? Promise.all(Array.from(
              {
                length: Math.ceil(
                  Math.max(taskResponse.tasks.length, PAGE_SIZE) / MAX_TASK_PAGE_SIZE,
                ),
              },
              async (_, pageIndex) => {
                const offset = pageIndex * MAX_TASK_PAGE_SIZE;
                const params = buildTaskParams(offset, sortBy, sortDirection);
                params.set('limit', String(Math.min(
                  MAX_TASK_PAGE_SIZE,
                  Math.max(taskResponse.tasks.length, PAGE_SIZE) - offset,
                )));
                const response = await fetch(`/api/tasks?${params.toString()}`);
                if (!response.ok) throw new Error(`Failed to refresh tasks (${response.status})`);
                const payload: TaskResponse = await response.json();
                return payload;
              },
            )).then((pages) => flattenTaskPages({
              pages,
              pageParams: pages.map((_, index) => index * MAX_TASK_PAGE_SIZE),
            }))
          : connectorsRQ.tasksQuery.refetch().then((result) => (
              result.data ? flattenTaskPages(result.data) : taskResponse
            ));
        const [refreshedTasks, projectsResult, myDayResult] = await Promise.all([
          tasksPromise,
          connectorsRQ.projectsQuery.refetch(),
          connectorsRQ.myDayIdsQuery.refetch(),
        ]);
        if (preserveCount) setTaskResponse(refreshedTasks);
        if (refreshedTasks.sourceCounts && !sourceFilter) {
          setAllSourceCounts((prev) => ({ ...prev, ...refreshedTasks.sourceCounts }));
        }
        if (projectsResult.data) setProjects(projectsResult.data);
        if (myDayResult.data) {
          setMyDayTaskIds(myDayResult.data.ids);
          setMyDayItemStatuses(myDayResult.data.statuses);
        }
      }
    } catch (err) {
      uiLogger.error('Failed to fetch dashboard data', { err });
    }
  }, [
    buildTaskParams,
    connectorsRQ.myDayIdsQuery,
    connectorsRQ.projectsQuery,
    connectorsRQ.tasksQuery,
    setTaskResponse,
    sortBy,
    sortDirection,
    sourceFilter,
    taskResponse,
  ]);

  useEffect(() => {
    if (refreshTrigger === 0) return;
    void Promise.all([
      connectorsRQ.tasksQuery.refetch(),
      connectorsRQ.projectsQuery.refetch(),
      connectorsRQ.myDayIdsQuery.refetch(),
    ]);
    // Query observer methods are stable; the explicit trigger owns this refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  useEffect(() => {
    const refreshGroupCounts = () => setGroupCountsRefreshTrigger((value) => value + 1);
    window.addEventListener('mc:task-completed', refreshGroupCounts);
    return () => window.removeEventListener('mc:task-completed', refreshGroupCounts);
  }, []);

  useEffect(() => {
    const activeGroupBy = isRecentQuickFilter(quickFilter) ? 'none' : groupBy;
    if (!activeGroupBy || activeGroupBy === 'none') {
      setGroupTotalsState({ scope: groupCountScopeKey, counts: EMPTY_GROUP_TOTAL_COUNTS });
      return;
    }
    const initial = new URLSearchParams({ groupBy: activeGroupBy, parentOnly: 'true' });
    const params = taskFilterContextToTaskQuery(taskFilterContext, initial);
    const controller = new AbortController();
    fetch(`/api/tasks/group-counts?${params.toString()}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch group counts (${response.status})`);
        return response.json();
      })
      .then((data) => setGroupTotalsState({
        scope: groupCountScopeKey,
        counts: data.counts || {},
      }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        uiLogger.error('Failed to fetch task group counts', { error });
      });
    return () => controller.abort();
  }, [
    groupBy,
    groupCountsRefreshTrigger,
    groupCountScopeKey,
    quickFilter,
    refreshTrigger,
    syncProgress.refetchKey,
    taskFilterContext,
  ]);

  const updateTaskGroupCounts = useCallback((
    previousTask: TaskResponse['tasks'][number] | null,
    nextTask: TaskResponse['tasks'][number] | null,
  ) => {
    if (!effectiveGroupBy || effectiveGroupBy === 'none') return;
    const today = effectiveGroupBy === 'dueDate' ? getClientToday() : '';
    setGroupTotalsState((current) => (
      current.scope === groupCountScopeKey
        ? {
            ...current,
            counts: updateGroupCountsForTaskChange(
              current.counts,
              effectiveGroupBy,
              today,
              previousTask,
              nextTask,
            ),
          }
        : current
    ));
  }, [effectiveGroupBy, groupCountScopeKey]);

  // ─── Load More For Group ────────────────────────────────────────────────────

  const loadMoreForGroup = useCallback(async (groupLabel: string) => {
    const activeGroupBy = isRecentQuickFilter(quickFilter) ? 'none' : groupBy;
    if (!activeGroupBy || activeGroupBy === 'none') return;

    setLoadingMoreGroups((prev) => new Set(prev).add(groupLabel));

    try {
      const today = activeGroupBy === 'dueDate' ? getClientToday() : '';
      const resolvedOffset = resolveGroupLoadOffset({
        tasks: taskResponse.tasks,
        groupBy: activeGroupBy,
        groupLabel,
        today,
        loadedTaskGroups: groupLoadedTaskGroupsRef.current,
        savedOffset: groupLoadOffsetsRef.current.get(groupLabel),
      });
      for (const taskId of resolvedOffset.staleTaskIds) {
        groupLoadedTaskGroupsRef.current.delete(taskId);
      }
      for (const staleGroupLabel of resolvedOffset.staleGroupLabels) {
        groupLoadOffsetsRef.current.delete(staleGroupLabel);
      }
      let nextOffset = resolvedOffset.offset;
      const remainingCapacity = DASHBOARD_TASK_ENTITY_LIMIT - taskResponse.tasks.length;
      if (remainingCapacity <= 0) {
        return;
      }

      const existingIds = new Set(taskResponse.tasks.map((task) => task.id));
      const newTasks: TaskResponse['tasks'] = [];
      let groupTotal = groupTotalCounts[groupLabel] ?? Number.POSITIVE_INFINITY;

      while (nextOffset < groupTotal && newTasks.length < Math.min(PAGE_SIZE, remainingCapacity)) {
        const params = buildTaskParams(nextOffset, sortBy, sortDirection);
        params.set('groupBy', activeGroupBy);
        params.set('groupValue', groupLabel);
        params.set('offset', String(nextOffset));
        params.set('limit', String(PAGE_SIZE));

        const res = await fetch(`/api/tasks?${params.toString()}`);
        if (!res.ok) throw new Error(`Failed to load more tasks for group (${res.status})`);
        const data: TaskResponse = await res.json();
        groupTotal = data.total;

        let consumed = 0;
        for (const task of data.tasks) {
          consumed += 1;
          if (existingIds.has(task.id)) continue;
          existingIds.add(task.id);
          newTasks.push(task);
          if (newTasks.length >= Math.min(PAGE_SIZE, remainingCapacity)) break;
        }
        nextOffset += consumed;
        if (data.tasks.length === 0) break;
      }

      groupLoadOffsetsRef.current.set(groupLabel, nextOffset);
      setGroupTotalsState((current) => (
        current.scope === groupCountScopeKey
          ? { ...current, counts: { ...current.counts, [groupLabel]: groupTotal } }
          : current
      ));

      if (newTasks.length) {
        for (const task of newTasks) groupLoadedTaskGroupsRef.current.set(task.id, groupLabel);
        setTaskResponse((current) => {
          const existingIds = new Set(current.tasks.map((t) => t.id));
          const uniqueNewTasks = newTasks
            .filter((t) => !existingIds.has(t.id))
            .slice(0, remainingCapacity);
          return { ...current, tasks: [...current.tasks, ...uniqueNewTasks] };
        });
      }
    } catch (err) {
      uiLogger.error('Failed to load more for group', { err, groupLabel });
    } finally {
      setLoadingMoreGroups((prev) => {
        const next = new Set(prev);
        next.delete(groupLabel);
        return next;
      });
    }
  }, [
    buildTaskParams,
    groupBy,
    groupCountScopeKey,
    groupTotalCounts,
    quickFilter,
    sortBy,
    sortDirection,
    taskResponse.tasks,
  ]);

  const taskActions = useDashboardTaskActions({
    taskResponse,
    setTaskResponse,
    sourceLists,
    projects,
    quickFilter,
    textFilter,
    myDayItemStatuses,
    setMyDayItemStatuses,
    setMyDayTaskIds,
    setExitingTasks,
    setConfirmDialog,
    listRef,
    completionScopeKey,
    runTaskCompletion,
    fetchData,
    updateTaskGroupCounts,
  });
  const {
    completeTask,
    snoozeTask,
    deleteTask,
    setTaskDueDate,
    setTaskPriority,
    setTaskStatus,
    setTaskLocalDisposition,
    moveTaskToList,
    addTaskToProject,
    addToMyDay,
    removeFromMyDay,
    patchTaskInList,
    updateSubtaskCount,
    animateTaskExit,
  } = taskActions;

  // ─── Computed Values ───────────────────────────────────────────────────────

  const sidebarSourceCounts = allSourceCounts;

  const visibleSourceLists = useMemo(() => {
    if (!sourceFilter) return [];
    const connectorIds = syncStatus
      .filter((status) => status.type === sourceFilter)
      .map((status) => status.id);
    return sourceLists
      .filter((sourceList) => connectorIds.includes(sourceList.connectorInstanceId) && !sourceList.hidden)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  }, [sourceFilter, sourceLists, syncStatus]);

  const getSourceListsForType = useCallback((sourceType: string) => {
    const connectorIds = syncStatus
      .filter((status) => status.type === sourceType)
      .map((status) => status.id);
    return sourceLists
      .filter((sourceList) => connectorIds.includes(sourceList.connectorInstanceId) && !sourceList.hidden)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  }, [sourceLists, syncStatus]);

  const groupedSourceLists = useMemo(() => {
    const knownGroupIds = new Set(listGroups.map((group) => group.id));
    const sourceListsByGroup = new Map<string, SourceList[]>();
    const ungroupedLists: SourceList[] = [];

    for (const sourceList of visibleSourceLists) {
      if (sourceList.groupId && knownGroupIds.has(sourceList.groupId)) {
        const existing = sourceListsByGroup.get(sourceList.groupId) || [];
        sourceListsByGroup.set(sourceList.groupId, [...existing, sourceList]);
      } else {
        ungroupedLists.push(sourceList);
      }
    }

    return {
      groups: [...listGroups]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .filter((group) => sourceListsByGroup.has(group.id))
        .map((group) => ({
          group,
          sourceLists: (sourceListsByGroup.get(group.id) || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
        })),
      ungroupedLists,
    };
  }, [listGroups, visibleSourceLists]);

  const sourceHasLists = useCallback((sourceType: string) => {
    const connectorIds = syncStatus
      .filter((status) => status.type === sourceType)
      .map((status) => status.id);
    return sourceLists.some((sl) => connectorIds.includes(sl.connectorInstanceId) && !sl.hidden);
  }, [sourceLists, syncStatus]);

  return {
    state: {
      taskResponse, projects, allTags, allAssignees, enabledSources, sourceLists, listGroups,
      syncStatus, myDayTaskIds, savedViews, addTaskDestinations,
      loading, loadingMore, loadingMoreGroups, refreshing, isSyncing,
      sourceFilter, listFilter, listGroupFilter, tagFilter, quickFilter, projectFilter,
      priorityFilter, statusFilter,
      sortBy, sortDirection, groupBy, viewDensity, showCompleted, hiddenQuickFilters,
      selectedTaskId, bulkMode, bulkSelected, collapsedGroups, sidebarExpanded, sidebarMode,
      completingIds, exitingTasks, confirmDialog, saveTemplateTask, detailMode,
      showAddTaskModal, addTaskInitialDest, addTaskInitialListId, groupTotalCounts,
      collapsedSections, expandedSourceLists, collapsedListGroups, listSearch,
      tagSearch, tagsExpanded, allSourceCounts,
      savingView, viewName,
    },
    actions: {
      fetchData, loadMoreForGroup, setRefreshTrigger, patchTaskInList, updateSubtaskCount,
      setSourceFilter, setListFilter, setListGroupFilter, setTagFilter, setQuickFilter, setProjectFilter,
      setPriorityFilter, setStatusFilter,
      setSortBy, setSortDirection, setGroupBy, setViewDensity, setShowCompleted,
      toggleQuickFilterVisibility,
      completeTask, snoozeTask, deleteTask,
      setTaskDueDate, setTaskPriority, setTaskStatus, setTaskLocalDisposition,
      moveTaskToList, addTaskToProject, addToMyDay, removeFromMyDay,
      setSelectedTaskId, setBulkMode, setBulkSelected, setCollapsedGroups,
      setSidebarExpanded, setSidebarMode, setConfirmDialog, setSaveTemplateTask, setDetailMode,
      setShowAddTaskModal, setAddTaskInitialDest, setAddTaskInitialListId,
      toggleSection, setExpandedSourceLists, setCollapsedListGroups, setListSearch,
      setTagSearch, setTagsExpanded,
      setSavingView, setViewName, saveCurrentView, applyView, deleteView,
      animateTaskExit,
    },
    computed: {
      taskFilterContext, sidebarSourceCounts, visibleSourceLists,
      groupedSourceLists, sourceHasLists, getSourceListsForType, syncProgress,
      listRef, lastClickedIndexRef,
    },
  };
}
