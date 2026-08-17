'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { pushUndoWithToast, useUndoStore } from '@/lib/stores/undoStore';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useDashboardQueries, useTagsQuery, dashboardKeys } from '@/lib/hooks/useDashboardQueries';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';
import { getNextRecurringDate, extractRecurrenceFromMetadata } from '@/lib/utils/recurrence';
import {
  removeTaskFromResponse,
  replaceTaskInKeywordFilteredResponse,
  restoreTaskToResponse,
} from '@/lib/utils/dashboard-helpers';
import { CONNECTOR_COLORS } from '@/lib/constants/colors';
import { uiLogger } from '@/lib/client-logger';
import {
  taskFilterContextFromDashboard,
  taskFilterContextFromSavedView,
  parseTaskFilterContext,
  TASK_FILTER_CONTEXT_PARAM,
  taskFilterContextToDashboard,
  taskFilterContextToSavedView,
  taskFilterContextToTaskQuery,
  withoutTaskFilterQueryTypes,
} from '@/lib/task-filter-context';
import type {
  Task,
  TaskTag,
  TaskResponse,
  HubProject,
  ListGroup,
  SourceList,
  EnabledSource,
  SyncStatusEntry,
  SavedView,
} from '@/types/dashboard';
import { PAGE_SIZE, EMPTY_TASK_RESPONSE } from '@/types/dashboard';
import type { LocalDisposition } from '@/types';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
  taskRemovalConfirmation,
} from '@/lib/tasks/client-edit-policy';
import type { TaskField } from '@/types';

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
  const viewStore = useDashboardViewStore();
  const includeScoreBreakdown = options.includeScoreBreakdown === true;
  const [taskResponse, setTaskResponse] = useState<TaskResponse>(EMPTY_TASK_RESPONSE);
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreGroups, setLoadingMoreGroups] = useState<Set<string>>(new Set());

  // Use zustand store for persisted filter/view state
  const sourceFilter = viewStore.sourceFilter;
  const setSourceFilter = useCallback((value: string | null) => {
    viewStore.setSourceFilter(value);
    if (value) {
      viewStore.setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['source'],
      ));
    }
  }, [viewStore]);
  const listFilter = viewStore.listFilter;
  const setListFilter = useCallback((value: string | null) => {
    viewStore.setListFilter(value);
    if (value) {
      viewStore.setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['listid'],
      ));
    }
  }, [viewStore]);
  const listGroupFilter = viewStore.listGroupFilter;
  const setListGroupFilter = viewStore.setListGroupFilter;
  const tagFilter = viewStore.tagFilter;
  const setTagFilter: React.Dispatch<React.SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().tagFilter;
    const next = typeof action === 'function' ? action(current) : action;
    viewStore.setTagFilter(next);
    if (next.length) {
      viewStore.setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['tag'],
      ));
    }
  }, [viewStore]);
  const quickFilter = viewStore.quickFilter;
  const setQuickFilter = viewStore.setQuickFilter;
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
  const projectFilter = viewStore.projectFilter;
  const setProjectFilter = viewStore.setProjectFilter;
  const priorityFilter = viewStore.priorityFilter;
  const setPriorityFilter: React.Dispatch<React.SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().priorityFilter;
    const next = typeof action === 'function' ? action(current) : action;
    viewStore.setPriorityFilter(next);
    if (next.length) {
      viewStore.setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['priority'],
      ));
    }
  }, [viewStore]);
  const statusFilter = viewStore.statusFilter;
  const setStatusFilter: React.Dispatch<React.SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().statusFilter;
    const next = typeof action === 'function' ? action(current) : action;
    viewStore.setStatusFilter(next);
    if (next.length) {
      viewStore.setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['status'],
      ));
    }
  }, [viewStore]);
  const textFilter = viewStore.textFilter;
  const sortBy = viewStore.sortBy;
  const setSortBy = viewStore.setSortBy;
  const sortDirection = viewStore.sortDirection;
  const setSortDirection = viewStore.setSortDirection;
  const groupBy = viewStore.groupBy;
  const setGroupBy = viewStore.setGroupBy;
  const viewDensity = viewStore.viewDensity;
  const setViewDensity = viewStore.setViewDensity;
  const showCompleted = viewStore.showCompleted;
  const setShowCompleted = viewStore.setShowCompleted;
  const hiddenQuickFilters = viewStore.hiddenQuickFilters;
  const toggleQuickFilterVisibility = viewStore.toggleQuickFilterVisibility;
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(searchParams.get('taskId'));
  const { sidebarExpanded, setSidebarExpanded, sidebarMode, setSidebarMode } = useSidebarExpanded();
  const [listSearch, setListSearch] = useState('');
  const [collapsedListGroups, setCollapsedListGroups] = useState<Set<string>>(new Set(viewStore.collapsedListGroups));
  const [confirmDialog, setConfirmDialog] = useState<DashboardState['confirmDialog']>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  const [saveTemplateTask, setSaveTemplateTask] = useState<DashboardState['saveTemplateTask']>(null);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [enabledSources, setEnabledSources] = useState<EnabledSource[]>([]);
  const [sourceLists, setSourceLists] = useState<SourceList[]>([]);
  const [listGroups, setListGroups] = useState<ListGroup[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusEntry[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const loadedTaskCountRef = useRef(0);
  const hasInitialLoadRef = useRef(false);
  const hasHydratedUrlFiltersRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastClickedIndexRef = useRef<number | null>(null);
  const [allSourceCounts, setAllSourceCounts] = useState<Record<string, number>>({});
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [exitingTasks, setExitingTasks] = useState<Array<{ id: string; title: string; yOffset: number; reason: 'complete' | 'remove' }>>([]);
  const [groupTotalCounts, setGroupTotalCounts] = useState<Record<string, number>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [myDayTaskIds, setMyDayTaskIds] = useState<Set<string>>(new Set());
  const [myDayItemStatuses, setMyDayItemStatuses] = useState<Map<string, string>>(new Map());
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(viewStore.collapsedSections));
  const [expandedSourceLists, setExpandedSourceLists] = useState<Set<string>>(new Set());
  const [tagSearch, setTagSearch] = useState('');
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [detailMode, setDetailMode] = useState<'panel' | 'dialog' | 'workspace'>('panel');
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [addTaskInitialDest, setAddTaskInitialDest] = useState<TaskDestination | null>(null);
  const [addTaskInitialListId, setAddTaskInitialListId] = useState<string | undefined>(undefined);
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
        const url = new URL(window.location.href);
        url.searchParams.set('taskId', taskId);
        window.history.replaceState(null, '', url);
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

  // Poll sync status (fallback for when SSE is unavailable)
  // The SSE refetchKey mechanism is the primary refetch trigger after sync.
  // This poll only updates the isSyncing flag for UI indicators; it does NOT
  // trigger a data refetch to avoid double-fetching with the SSE path.
  useEffect(() => {
    let mounted = true;
    const checkSync = async () => {
      try {
        const res = await fetch('/api/sync');
        if (!res.ok) return;
        const data = await res.json();
        if (mounted) {
          const syncing = data.isSyncing === true;
          setIsSyncing(syncing);
          if (syncing && !syncPollRef.current) {
            syncPollRef.current = setInterval(checkSync, 2000);
          } else if (!syncing && syncPollRef.current) {
            clearInterval(syncPollRef.current);
            syncPollRef.current = null;
            // Don't bump refreshTrigger here — the SSE sync:complete event
            // already bumps refetchKey which triggers a single refetch.
          }
        }
      } catch { /* ignore */ }
    };
    checkSync();
    const idlePoll = setInterval(checkSync, 30000);
    return () => {
      mounted = false;
      clearInterval(idlePoll);
      if (syncPollRef.current) clearInterval(syncPollRef.current);
    };
  }, []);

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

  // Sync collapsed state to zustand store
  useEffect(() => {
    viewStore.setCollapsedListGroups([...collapsedListGroups]);
  }, [collapsedListGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewStore.setCollapsedSections([...collapsedSections]);
  }, [collapsedSections]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quick filter sort/group overrides
  const effectiveSortBy = quickFilter === 'recentlyCreated' ? 'createdAt' : sortBy;
  const effectiveSortDirection = quickFilter === 'recentlyCreated' ? 'desc' : sortDirection;
  const effectiveGroupBy = quickFilter === 'recentlyCreated' ? 'none' : groupBy;
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
  const completionScopeKey = JSON.stringify({
    taskFilterContext,
    sortBy: effectiveSortBy,
    sortDirection: effectiveSortDirection,
    groupBy: effectiveGroupBy,
  });
  const completionScopeKeyRef = useRef(completionScopeKey);
  completionScopeKeyRef.current = completionScopeKey;

  // Initial data fetch (features, connectors, list-groups, source counts)
  // These use React Query for caching — re-visits show stale data instantly
  const connectorsRQ = useDashboardQueries(
    useMemo(() => {
      const initial = new URLSearchParams();
      initial.set('parentOnly', 'true');
      initial.set('limit', String(PAGE_SIZE));
      initial.set('offset', '0');
      if (includeScoreBreakdown) initial.set('includeScoreBreakdown', 'true');
      const params = taskFilterContextToTaskQuery(taskFilterContext, initial);
      if (effectiveSortBy && effectiveSortBy !== 'priority') params.set('sortBy', effectiveSortBy);
      if (effectiveSortDirection && effectiveSortDirection !== 'asc') params.set('sortDirection', effectiveSortDirection);
      if (effectiveGroupBy && effectiveGroupBy !== 'none') params.set('groupBy', effectiveGroupBy);
      return params.toString();
    }, [effectiveGroupBy, effectiveSortBy, effectiveSortDirection, includeScoreBreakdown, taskFilterContext])
  );

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

  // Load saved views from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('mission-control:saved-views');
      if (stored) setSavedViews(JSON.parse(stored));
    } catch {}
  }, []);

  // Reactive tags fetch (via React Query)
  const tagsRQ = useTagsQuery(sourceFilter, listFilter, enabledSources, sourceLists);
  useEffect(() => {
    if (tagsRQ.data) {
      setAllTags(tagsRQ.data as TaskTag[]);
    }
  }, [tagsRQ.data]);

  // Use React Query cached tasks to show data instantly on re-visit
  useEffect(() => {
    if (connectorsRQ.tasksQuery.data && !hasInitialLoadRef.current) {
      const tasksData = connectorsRQ.tasksQuery.data;
      setTaskResponse({
        tasks: tasksData.tasks || [],
        total: tasksData.total || 0,
        stats: tasksData.stats || EMPTY_TASK_RESPONSE.stats,
        hasMore: tasksData.hasMore || false,
        sourceCounts: tasksData.sourceCounts || {},
        availableTags: tasksData.availableTags || [],
      });
      if (tasksData.sourceCounts && !sourceFilter) {
        setAllSourceCounts(prev => ({ ...prev, ...tasksData.sourceCounts }));
      }
      setLoading(false);
      hasInitialLoadRef.current = true;
    }
  }, [connectorsRQ.tasksQuery.data, sourceFilter]);

  const buildTaskParams = useCallback((offset: number, currentSortBy: string, currentSortDirection: 'asc' | 'desc') => {
    const initial = new URLSearchParams();
    initial.set('parentOnly', 'true');
    initial.set('limit', String(PAGE_SIZE));
    initial.set('offset', String(offset));
    if (includeScoreBreakdown) initial.set('includeScoreBreakdown', 'true');
    const params = taskFilterContextToTaskQuery(taskFilterContext, initial);

    const eSortBy = quickFilter === 'recentlyCreated' ? 'createdAt' : currentSortBy;
    const eSortDir = quickFilter === 'recentlyCreated' ? 'desc' : currentSortDirection;
    const eGroupBy = quickFilter === 'recentlyCreated' ? 'none' : groupBy;
    if (eSortBy && eSortBy !== 'priority') params.set('sortBy', eSortBy);
    if (eSortDir && eSortDir !== 'asc') params.set('sortDirection', eSortDir);
    if (eGroupBy && eGroupBy !== 'none') params.set('groupBy', eGroupBy);
    return params;
  }, [groupBy, includeScoreBreakdown, quickFilter, taskFilterContext]);

  useEffect(() => {
    loadedTaskCountRef.current = taskResponse.tasks.length;
  }, [taskResponse.tasks.length]);

  const fetchData = useCallback(async (append = false, silent = false, preserveCount = false) => {
    const requestId = ++requestIdRef.current;
    const offset = append ? loadedTaskCountRef.current : 0;
    // When preserveCount is true, fetch up to the current loaded count so
    // scroll position and "load more" state are preserved.
    const effectiveLimit = preserveCount
      ? Math.max(loadedTaskCountRef.current, PAGE_SIZE)
      : PAGE_SIZE;

    if (append) {
      setLoadingMore(true);
    } else if (!silent) {
      if (!hasInitialLoadRef.current) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      if (listRef.current) {
        listRef.current.scrollTo({ top: 0 });
      }
    }

    try {
      if (append) {
        const tasksRes = await fetch(`/api/tasks?${buildTaskParams(offset, sortBy, sortDirection).toString()}`);
        const tasksData = await tasksRes.json();
        if (requestId !== requestIdRef.current) return;
        setTaskResponse((current) => ({
          tasks: [...current.tasks, ...(tasksData.tasks || [])],
          total: tasksData.total || 0,
          stats: tasksData.stats || EMPTY_TASK_RESPONSE.stats,
          hasMore: tasksData.hasMore || false,
          sourceCounts: tasksData.sourceCounts || {},
          availableTags: tasksData.availableTags || [],
        }));
        if (tasksData.sourceCounts) {
          setAllSourceCounts((prev) => sourceFilter ? prev : { ...prev, ...tasksData.sourceCounts });
        }
      } else {
        const taskParams = buildTaskParams(0, sortBy, sortDirection);
        if (preserveCount) taskParams.set('limit', String(effectiveLimit));
        const [tasksRes, projectsRes, myDayRes] = await Promise.all([
          fetch(`/api/tasks?${taskParams.toString()}`),
          fetch('/api/hub-projects?includePhases=true'),
          fetch(`/api/my-day?date=${getClientToday()}`),
        ]);
        const [tasksData, projectsData, myDayData] = await Promise.all([
          tasksRes.json(), projectsRes.json(), myDayRes.json(),
        ]);
        if (requestId !== requestIdRef.current) return;
        setTaskResponse({
          tasks: tasksData.tasks || [],
          total: tasksData.total || 0,
          stats: tasksData.stats || EMPTY_TASK_RESPONSE.stats,
          hasMore: tasksData.hasMore || false,
          sourceCounts: tasksData.sourceCounts || {},
          availableTags: tasksData.availableTags || [],
        });
        if (tasksData.sourceCounts) {
          setAllSourceCounts((prev) => sourceFilter ? prev : { ...prev, ...tasksData.sourceCounts });
        }
        setProjects(projectsData.projects || []);
        const myDayItemsArr = (myDayData.items || []) as Array<{ taskId: string; status: string }>;
        setMyDayTaskIds(new Set(myDayItemsArr.map(i => i.taskId)));
        setMyDayItemStatuses(new Map(myDayItemsArr.map(i => [i.taskId, i.status])));

        // Fetch group total counts when groupBy is active
        const activeGroupBy = quickFilter === 'recentlyCreated' ? 'none' : groupBy;
        if (activeGroupBy && activeGroupBy !== 'none') {
          const initial = new URLSearchParams({
            groupBy: activeGroupBy,
            parentOnly: 'true',
          });
          const gcParams = taskFilterContextToTaskQuery(taskFilterContext, initial);
          fetch(`/api/tasks/group-counts?${gcParams.toString()}`)
            .then(r => r.json())
            .then(data => {
              if (requestId === requestIdRef.current && data.counts) {
                setGroupTotalCounts(data.counts);
              }
            })
            .catch(() => { /* non-critical */ });
        } else {
          setGroupTotalCounts({});
        }
      }
    } catch (err) {
      uiLogger.error('Failed to fetch dashboard data', { err });
    } finally {
      if (requestId === requestIdRef.current) {
        hasInitialLoadRef.current = true;
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, [buildTaskParams, groupBy, quickFilter, sourceFilter, sortBy, sortDirection, taskFilterContext]);

  useEffect(() => {
    void fetchData(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, refreshTrigger]);

  // Keep a ref to the latest fetchData so the sync-complete effect can call it
  // without listing fetchData as a dependency (which would cause spurious re-fires
  // on every filter change and race with the primary fetch above).
  const fetchDataRef = useRef(fetchData);
  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

  // Re-fetch when sync completes (debounced to avoid request storms)
  const prevRefetchKeyRef = useRef(syncProgress.refetchKey);
  useEffect(() => {
    // Only trigger when refetchKey actually increments (sync completed),
    // not on every filter change.
    if (syncProgress.refetchKey > prevRefetchKeyRef.current) {
      prevRefetchKeyRef.current = syncProgress.refetchKey;
      const timeoutId = window.setTimeout(() => {
        void fetchDataRef.current(false, true);
        fetch('/api/connectors')
          .then((r) => r.json())
          .then((data) => { if (data.sourceLists) setSourceLists(data.sourceLists); })
          .catch((err) => { uiLogger.error('Failed to refresh source lists after sync', { err }); });
      }, 500);
      return () => window.clearTimeout(timeoutId);
    }
  }, [syncProgress.refetchKey]);

  // ─── Load More For Group ────────────────────────────────────────────────────

  const loadMoreForGroup = useCallback(async (groupLabel: string) => {
    const activeGroupBy = quickFilter === 'recentlyCreated' ? 'none' : groupBy;
    if (!activeGroupBy || activeGroupBy === 'none') return;

    setLoadingMoreGroups((prev) => new Set(prev).add(groupLabel));

    try {
      // Count how many tasks in this group are already loaded
      const existingCount = taskResponse.tasks.filter((task) => {
        if (activeGroupBy === 'list') return (task.sourceListName || 'No List') === groupLabel;
        if (activeGroupBy === 'status') {
          const mapped = task.status === 'done' ? 'Completed' : task.status === 'cancelled' ? 'Cancelled' : task.status === 'in_progress' ? 'In Progress' : 'To Do';
          return mapped === groupLabel;
        }
        if (activeGroupBy === 'priority') return (task.priority || 'none') === groupLabel;
        if (activeGroupBy === 'dueDate') {
          const today = getClientToday();
          if (!task.dueDate) return groupLabel === 'No Due Date';
          if (task.dueDate < today) return groupLabel === 'Overdue';
          if (task.dueDate === today) return groupLabel === 'Today';
          return task.dueDate === groupLabel;
        }
        if (activeGroupBy === 'tag') {
          if (!task.tags?.length) return groupLabel === 'Untagged';
          return task.tags.some((t) => t.name === groupLabel);
        }
        if (activeGroupBy === 'project') {
          if (!task.projectPhaseMemberships?.length) return groupLabel === 'No Project';
          return task.projectPhaseMemberships.some((m) => {
            const key = m.phaseName
              ? `${m.projectName} › ${m.phaseName}`
              : `${m.projectName} › Unphased`;
            return key === groupLabel;
          });
        }
        return false;
      }).length;

      const params = buildTaskParams(existingCount, sortBy, sortDirection);
      params.set('groupBy', activeGroupBy);
      params.set('groupValue', groupLabel);
      params.set('offset', String(existingCount));
      params.set('limit', String(PAGE_SIZE));

      const res = await fetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();

      if (data.tasks?.length) {
        setTaskResponse((current) => {
          // Deduplicate: only add tasks not already in the list
          const existingIds = new Set(current.tasks.map((t) => t.id));
          const newTasks = (data.tasks as Task[]).filter((t) => !existingIds.has(t.id));
          return { ...current, tasks: [...current.tasks, ...newTasks] };
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
  }, [buildTaskParams, groupBy, quickFilter, sortBy, sortDirection, taskResponse.tasks]);

  // ─── Task Actions ──────────────────────────────────────────────────────────

  function animateTaskExit(taskId: string, title: string, reason: 'complete' | 'remove' = 'remove') {
    const el = listRef.current?.querySelector(`[data-task-id="${taskId}"]`);
    const containerRect = listRef.current?.getBoundingClientRect();
    if (el && containerRect) {
      const elRect = el.getBoundingClientRect();
      const yOffset = elRect.top - containerRect.top + listRef.current!.scrollTop;
      setExitingTasks((prev) => [...prev, { id: taskId, title, yOffset, reason }]);
      setTimeout(() => {
        setExitingTasks((prev) => prev.filter((t) => t.id !== taskId));
      }, 500);
    }
  }

  function ensureTaskFieldEditable(taskId: string, field: TaskField): Task | null {
    const task = taskResponse.tasks.find((candidate) => candidate.id === taskId) ?? null;
    if (task && canEditTaskField(task.editPolicy, field)) return task;
    toast.error(taskFieldBlockedReason(task?.editPolicy, field));
    return null;
  }

  async function completeTask(taskId: string) {
    const task = ensureTaskFieldEditable(taskId, 'status');
    if (!task) return;

    const scopeKey = completionScopeKey;
    const taskIndex = taskResponse.tasks.findIndex((candidate) => candidate.id === taskId);
    const previousMyDayStatus = myDayItemStatuses.get(taskId);
    let removedFromVisibleResponse = false;
    let optimisticTaskResponse: TaskResponse | null = null;
    let optimisticMyDayStatuses: Map<string, string> | null = null;
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        if (completionScopeKeyRef.current !== scopeKey) return;
        animateTaskExit(taskId, task.title, 'complete');
        setTaskResponse((current) => {
          removedFromVisibleResponse = current.tasks.some((candidate) => candidate.id === taskId);
          const next = removeTaskFromResponse(current, taskId, task);
          optimisticTaskResponse = next === current ? null : next;
          return next;
        });
        setMyDayItemStatuses((current) => {
          if (!current.has(taskId)) return current;
          const next = new Map(current);
          next.set(taskId, 'done');
          optimisticMyDayStatuses = next;
          return next;
        });
      },
      request: async () => {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!res.ok) throw new Error('Failed');
      },
      rollback: () => {
        if (!removedFromVisibleResponse || completionScopeKeyRef.current !== scopeKey) return;
        setTaskResponse((current) => (
          current === optimisticTaskResponse
            ? restoreTaskToResponse(current, task, taskIndex)
            : current
        ));
        setMyDayItemStatuses((current) => {
          if (previousMyDayStatus === undefined || current !== optimisticMyDayStatuses) return current;
          const next = new Map(current);
          next.set(taskId, previousMyDayStatus);
          return next;
        });
        void fetchDataRef.current(false, true, true);
      },
    });

    if (outcome === 'completed') {
      pushUndoWithToast(`"${task.title}" completed`, async () => {
        await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'todo' }),
        });
        void fetchDataRef.current(false, true, true);
        window.dispatchEvent(new CustomEvent('mc:task-completed'));
      });
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
      // Delay background refetch to pick up server-side effects (e.g. recurrence)
      // without resetting scroll position or undoing "load more" expansion.
      setTimeout(() => void fetchDataRef.current(false, true, true), 3000);
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }

  function updateSubtaskCount(taskId: string, done: number, total: number) {
    setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((t) =>
        t.id === taskId ? { ...t, subtaskDone: done, subtaskTotal: total } : t
      ),
    }));
  }

  async function snoozeTask(taskId: string, snoozedUntil: string | null) {
    const task = ensureTaskFieldEditable(taskId, 'snoozedUntil');
    if (!task) return;
    const previous = taskResponse;
    setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((t) => t.id === taskId ? { ...t, snoozedUntil } : t),
    }));

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snoozedUntil }),
      });
      if (!res.ok) throw new Error('Failed');
      pushUndoWithToast(snoozedUntil ? 'Task snoozed' : 'Snooze cleared', () => {
        setTaskResponse(previous);
        fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snoozedUntil: task?.snoozedUntil || null }),
        }).then(() => void fetchData(false, true, true))
          .catch(() => toast.error('Failed to undo snooze'));
      }, { type: 'info' });
      setTimeout(() => void fetchData(false, true, true), 3000);
    } catch {
      setTaskResponse(previous);
      toast.error('Failed to snooze task');
    }
  }

  async function addToMyDay(taskId: string) {
    try {
      const res = await fetch('/api/my-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, date: getClientToday() }),
      });
      const data = await res.json();
      setMyDayTaskIds((prev) => new Set(prev).add(taskId));
      // Track status so badge count stays accurate
      const task = taskResponse.tasks.find((t) => t.id === taskId);
      setMyDayItemStatuses((prev) => {
        const next = new Map(prev);
        next.set(taskId, task?.status || 'todo');
        return next;
      });
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      if (data.writeBack?.attempted && !data.writeBack?.success) {
        toast.warning('Added to My Day locally, but failed to sync to Microsoft To Do');
      } else {
        toast.success('Added to My Day');
      }
    } catch {}
  }

  async function removeFromMyDay(taskId: string) {
    try {
      const params = new URLSearchParams({ taskId, date: getClientToday() });
      const res = await fetch(`/api/my-day?${params.toString()}`, { method: 'DELETE' });
      const data = await res.json();
      setMyDayTaskIds((prev) => { const next = new Set(prev); next.delete(taskId); return next; });
      setMyDayItemStatuses((prev) => { const next = new Map(prev); next.delete(taskId); return next; });
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      if (data.writeBack?.attempted && !data.writeBack?.success) {
        toast.warning('Removed from My Day locally, but failed to sync to Microsoft To Do');
      } else {
        toast.success('Removed from My Day');
      }
      void fetchData(false, true);
    } catch {}
  }

  async function setTaskDueDateAction(taskId: string, date: string | null) {
    const task = ensureTaskFieldEditable(taskId, 'dueDate');
    if (!task) return;
    const previous = taskResponse;
    const willLeaveView = task && quickFilter === 'overdue' && (date === null || date >= getClientToday());

    if (willLeaveView && task) {
      animateTaskExit(taskId, task.title);
      setTaskResponse((current) => removeTaskFromResponse(current, taskId, task));
    } else {
      setTaskResponse((current) => ({
        ...current,
        tasks: current.tasks.map((t) => t.id === taskId ? { ...t, dueDate: date } : t),
      }));
    }

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: date }),
      });
      if (!res.ok) throw new Error('Failed');
      toast.success('Due date updated');
      void fetchData(false, true);
    } catch {
      setTaskResponse(previous);
      toast.error('Failed to update due date');
    }
  }

  async function setTaskPriorityAction(taskId: string, newPriority: string) {
    if (!ensureTaskFieldEditable(taskId, 'priority')) return;
    const previous = taskResponse;
    setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((t) => t.id === taskId ? { ...t, priority: newPriority } : t),
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: newPriority }),
      });
      if (!res.ok) throw new Error('Failed');
      void fetchData(false, true);
    } catch {
      setTaskResponse(previous);
      toast.error('Failed to update priority');
    }
  }

  async function setTaskStatusAction(taskId: string, newStatus: string) {
    if (!ensureTaskFieldEditable(taskId, 'status')) return;
    const previous = taskResponse;
    setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((t) => t.id === taskId ? { ...t, status: newStatus } : t),
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed');
      void fetchData(false, true);
    } catch {
      setTaskResponse(previous);
      toast.error('Failed to update status');
    }
  }

  async function setTaskLocalDispositionAction(
    taskId: string,
    disposition: LocalDisposition,
  ) {
    const previous = taskResponse;
    const task = taskResponse.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (!canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, disposition)) {
      toast.error(taskDispositionBlockedReason(
        task.editPolicy,
        task.localDisposition,
        disposition,
      ));
      return;
    }
    setTaskResponse((current) => disposition === 'active'
      ? {
          ...current,
          tasks: current.tasks.map((candidate) => candidate.id === taskId
            ? { ...candidate, localDisposition: disposition }
            : candidate),
        }
      : removeTaskFromResponse(current, taskId, task));

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition: disposition }),
      });
      const data = await response.json() as {
        fields?: { localDisposition?: { persisted?: boolean } };
      };
      if (!response.ok || data.fields?.localDisposition?.persisted !== true) {
        throw new Error('Mission Control state was not saved');
      }
      toast.success(disposition === 'handled'
        ? 'Marked handled in Mission Control; upstream task unchanged'
        : disposition === 'dismissed'
          ? 'Dismissed in Mission Control; upstream task unchanged'
          : 'Restored in Mission Control');
      void fetchData(false, true);
    } catch (error) {
      setTaskResponse(previous);
      toast.error(error instanceof Error
        ? error.message
        : 'Failed to update the Mission Control disposition');
    }
  }

  /** Optimistically patch a task's fields in the list without refetching. */
  function patchTaskInList(taskId: string, fields: Record<string, unknown>) {
    setTaskResponse((current) => ({
      ...current,
      tasks: current.tasks.map((t) => t.id === taskId ? { ...t, ...fields } : t),
    }));
  }

  function deleteTask(taskId: string) {
    const task = taskResponse.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!canRemoveTask(task.editPolicy)) {
      toast.error(task.editPolicy.removalReason ?? 'This task cannot be removed');
      return;
    }
    const confirmation = taskRemovalConfirmation(task.editPolicy, task.title);
    setConfirmDialog({
      open: true,
      ...confirmation,
      variant: 'danger',
      onConfirm: () => {
        setConfirmDialog((d) => ({ ...d, open: false }));
        // Defer heavy state updates to the next frame so Radix can finish its
        // close sequence (removing pointer-events:none from <body>) before React
        // re-renders the task list.
        requestAnimationFrame(() => {
          animateTaskExit(taskId, task.title);
          const previous = taskResponse;
          setTaskResponse((prev) => ({
            ...prev,
            tasks: prev.tasks.filter((t) => t.id !== taskId),
            total: prev.total - 1,
          }));
          let undone = false;
          const undoId = useUndoStore.getState().pushUndo({
            label: 'Task deleted',
            undo: () => { undone = true; setTaskResponse(previous); },
          });
          toast.success('Task deleted', {
            action: { label: 'Undo', onClick: () => { undone = true; useUndoStore.getState().removeEntry(undoId); setTaskResponse(previous); } },
            duration: 5000,
          });
          setTimeout(async () => {
            if (!undone) {
              try {
                const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}));
                  setTaskResponse(previous);
                  toast.error(data.error || 'Failed to delete task');
                }
              } catch {
                setTaskResponse(previous);
                toast.error('Failed to delete task');
              }
            }
          }, 5500);
        });
      },
    });
  }

  async function moveTaskToList(taskId: string, targetListId: string) {
    const task = taskResponse.tasks.find((t) => t.id === taskId);
    const targetList = sourceLists.find((l) => l.id === targetListId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/move-to-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetListId }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      if (data.previousListId) {
        pushUndoWithToast(`Moved to ${targetList?.name || 'list'}`, async () => {
          await fetch(`/api/tasks/${taskId}/move-to-list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetListId: data.previousListId }),
          });
          void fetchData(false, true);
        });
      } else {
        toast.success(`Moved to ${targetList?.name || 'list'}`);
      }
      if (task) {
        animateTaskExit(taskId, task.title, 'remove');
        setTaskResponse((current) => removeTaskFromResponse(current, taskId, task));
      } else {
        void fetchData(false, true);
      }
    } catch {
      toast.error('Failed to move task');
    }
  }

  async function addTaskToProject(taskId: string, projectId: string, phaseId?: string | null) {
    const project = projects.find((p) => p.id === projectId);
    try {
      const res = await fetch(`/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phaseId: phaseId ?? null }),
      });
      if (!res.ok) throw new Error('Failed to add to project');

      const phaseName = phaseId
        ? project?.phases?.find((p) => p.id === phaseId)?.name ?? null
        : null;
      const label = phaseName
        ? `Moved to ${project?.name || 'project'} → ${phaseName}`
        : `Moved to ${project?.name || 'project'} → No phase`;
      toast.success(label);

      setTaskResponse((current) => {
        const task = current.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return current;

        const updatedTask: Task = {
          ...task,
          hubProjectIds: [...(task.hubProjectIds || []).filter((id) => id !== projectId), projectId],
          projectPhaseMemberships: [
            ...(task.projectPhaseMemberships || []).filter((membership) => membership.projectId !== projectId),
            {
              projectId,
              projectName: project?.name || 'Unknown Project',
              phaseId: phaseId ?? null,
              phaseName,
            },
          ],
        };
        return replaceTaskInKeywordFilteredResponse(current, updatedTask, textFilter);
      });
    } catch {
      toast.error('Failed to add task to project');
    }
  }

  // ─── View Save Actions ─────────────────────────────────────────────────────

  function saveCurrentView() {
    if (!viewName.trim()) return;
    const newView: SavedView = {
      id: `custom-${Date.now()}`,
      name: viewName,
      icon: 'pin',
      filters: taskFilterContextToSavedView(taskFilterContext),
      filterContext: taskFilterContext,
    };
    const updated = [...savedViews, newView];
    setSavedViews(updated);
    localStorage.setItem('mission-control:saved-views', JSON.stringify(updated));
    setSavingView(false);
    setViewName('');
  }

  function applyView(view: SavedView) {
    const dashboardFilters = taskFilterContextToDashboard(
      view.filterContext
        ? view.filterContext
        : taskFilterContextFromSavedView(view.filters),
    );
    setSourceFilter(dashboardFilters.sourceFilter);
    setListFilter(dashboardFilters.listFilter);
    setListGroupFilter(dashboardFilters.listGroupFilter);
    setTagFilter(dashboardFilters.tagFilter);
    setProjectFilter(dashboardFilters.projectFilter);
    setPriorityFilter(dashboardFilters.priorityFilter);
    setStatusFilter(dashboardFilters.statusFilter);
    setQuickFilter(dashboardFilters.quickFilter);
    setShowCompleted(dashboardFilters.showCompleted);
    viewStore.setTextFilter(dashboardFilters.textFilter);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    setOptionalSearchParam(nextSearchParams, 'myDayDate', dashboardFilters.myDayDate);
    setOptionalSearchParam(nextSearchParams, 'ageMin', dashboardFilters.ageMinDays);
    setOptionalSearchParam(nextSearchParams, 'ageMax', dashboardFilters.ageMaxDays);
    const nextQuery = nextSearchParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }

  function deleteView(id: string) {
    const updated = savedViews.filter((view) => view.id !== id);
    setSavedViews(updated);
    localStorage.setItem('mission-control:saved-views', JSON.stringify(updated));
  }

  function toggleSection(section: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

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
      setTaskDueDate: setTaskDueDateAction, setTaskPriority: setTaskPriorityAction, setTaskStatus: setTaskStatusAction,
      setTaskLocalDisposition: setTaskLocalDispositionAction,
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
