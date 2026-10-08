'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  normalizeTaskFilterContext,
  taskFilterContextFromSavedView,
  taskFilterContextToDashboard,
  taskFilterContextToSavedView,
  withoutTaskFilterQueryTypes,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type { SavedQuickFilter, SavedView } from '@/types/dashboard';
import type {
  DashboardFilterActions,
  DashboardFilterState,
} from '@/lib/hooks/useDashboardFilterState';
import clientLogger from '@/lib/client-logger';
import { toast } from '@/lib/toast';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';

const SAVED_VIEWS_STORAGE_KEY = 'mission-control:saved-views';
const SAVED_QUICK_FILTERS_STORAGE_KEY = 'mission-control:saved-quick-filters';
const DEFAULT_SAVED_VIEW_ICON = 'bookmark';
const DEFAULT_QUICK_FILTER_ICON = 'lucide:filter';

type SavedItemKind = 'view' | 'quick-filter';

type PresentationState = Pick<
  DashboardFilterState,
  'sortBy' | 'sortDirection' | 'groupBy' | 'viewDensity'
>;

function setOptionalSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined || value === '') searchParams.delete(key);
  else searchParams.set(key, String(value));
}

interface UseDashboardSavedViewsOptions {
  taskFilterContext: TaskFilterContext;
  presentationState: PresentationState;
  filterActions: DashboardFilterActions;
  searchParams: string;
  pathname: string;
  replaceUrl: (href: string) => void;
}

export function useDashboardSavedViews({
  taskFilterContext,
  presentationState,
  filterActions,
  searchParams,
  pathname,
  replaceUrl,
}: UseDashboardSavedViewsOptions) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedQuickFilters, setSavedQuickFilters] = useState<SavedQuickFilter[]>([]);
  const [editorKind, setEditorKind] = useState<SavedItemKind | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemName, setItemName] = useState('');
  const [itemIcon, setItemIcon] = useState(DEFAULT_SAVED_VIEW_ICON);
  const [itemIconColor, setItemIconColor] = useState('');

  useEffect(() => {
    try {
      setSavedViews(readSavedViews(localStorage.getItem(SAVED_VIEWS_STORAGE_KEY)));
      setSavedQuickFilters(readSavedQuickFilters(
        localStorage.getItem(SAVED_QUICK_FILTERS_STORAGE_KEY),
      ));
    } catch (error) {
      clientLogger.warn('Failed to load saved task collections', { error });
      setSavedViews([]);
      setSavedQuickFilters([]);
    }
  }, []);

  const resetViewEditor = useCallback(() => {
    setEditorKind(null);
    setEditingItemId(null);
    setItemName('');
    setItemIcon(DEFAULT_SAVED_VIEW_ICON);
    setItemIconColor('');
  }, []);

  const startNewView = useCallback(() => {
    resetViewEditor();
    setItemIcon(DEFAULT_SAVED_VIEW_ICON);
    setEditorKind('view');
  }, [resetViewEditor]);

  const editView = useCallback((view: SavedView) => {
    setEditingItemId(view.id);
    setItemName(view.name);
    setItemIcon(view.icon || DEFAULT_SAVED_VIEW_ICON);
    setItemIconColor(view.iconColor ?? '');
    setEditorKind('view');
  }, []);

  const startNewQuickFilter = useCallback(() => {
    resetViewEditor();
    setItemIcon(DEFAULT_QUICK_FILTER_ICON);
    setEditorKind('quick-filter');
  }, [resetViewEditor]);

  const editQuickFilter = useCallback((filter: SavedQuickFilter) => {
    setEditingItemId(filter.id);
    setItemName(filter.name);
    setItemIcon(filter.icon || DEFAULT_QUICK_FILTER_ICON);
    setItemIconColor(filter.iconColor ?? '');
    setEditorKind('quick-filter');
  }, []);

  const saveCurrentItem = useCallback(() => {
    const name = itemName.trim();
    if (!name || !editorKind) return;
    const iconColor = itemIconColor || undefined;

    try {
      if (editorKind === 'view') {
        const updated = editingItemId
          ? savedViews.map((view) => view.id === editingItemId
            ? { ...view, name, icon: itemIcon, iconColor }
            : view)
          : [...savedViews, {
              id: `view-${Date.now()}`,
              name,
              icon: itemIcon,
              iconColor,
              filters: taskFilterContextToSavedView(taskFilterContext),
              filterContext: taskFilterContext,
              presentation: presentationState,
            }];
        localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(updated));
        setSavedViews(updated);
      } else {
        const filterContext = taskFilterContextForQuickFilter(taskFilterContext);
        const updated = editingItemId
          ? savedQuickFilters.map((filter) => filter.id === editingItemId
            ? { ...filter, name, icon: itemIcon, iconColor }
            : filter)
          : [...savedQuickFilters, {
              id: `quick-filter-${Date.now()}`,
              name,
              icon: itemIcon,
              iconColor,
              filters: taskFilterContextToSavedView(filterContext),
              filterContext,
            }];
        localStorage.setItem(SAVED_QUICK_FILTERS_STORAGE_KEY, JSON.stringify(updated));
        setSavedQuickFilters(updated);
      }
      resetViewEditor();
    } catch (error) {
      clientLogger.error('Failed to save task collection', { error, editorKind });
      toast.error(`Could not save ${editorKind === 'view' ? 'view' : 'quick filter'}`);
    }
  }, [
    editingItemId,
    editorKind,
    itemIcon,
    itemIconColor,
    itemName,
    presentationState,
    resetViewEditor,
    savedQuickFilters,
    savedViews,
    taskFilterContext,
  ]);

  const applyContext = useCallback((
    context: TaskFilterContext,
    presentation?: SavedView['presentation'],
  ) => {
    const dashboardFilters = taskFilterContextToDashboard(context);
    filterActions.setSourceFilter(dashboardFilters.sourceFilter);
    filterActions.setListFilter(dashboardFilters.listFilter);
    filterActions.setListGroupFilter(dashboardFilters.listGroupFilter);
    filterActions.setTagFilter(dashboardFilters.tagFilter);
    filterActions.setProjectFilter(dashboardFilters.projectFilter);
    filterActions.setPriorityFilter(dashboardFilters.priorityFilter);
    filterActions.setStatusFilter(dashboardFilters.statusFilter);
    filterActions.setQuickFilter(dashboardFilters.quickFilter);
    filterActions.setShowCompleted(dashboardFilters.showCompleted);
    filterActions.setTextFilter(dashboardFilters.textFilter);
    if (presentation) {
      filterActions.setSortBy(presentation.sortBy);
      filterActions.setSortDirection(presentation.sortDirection);
      filterActions.setGroupBy(presentation.groupBy);
      filterActions.setViewDensity(presentation.viewDensity);
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    setOptionalSearchParam(nextSearchParams, 'myDayDate', dashboardFilters.myDayDate);
    setOptionalSearchParam(nextSearchParams, 'ageMin', dashboardFilters.ageMinDays);
    setOptionalSearchParam(nextSearchParams, 'ageMax', dashboardFilters.ageMaxDays);
    const nextQuery = nextSearchParams.toString();
    replaceUrl(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [filterActions, pathname, replaceUrl, searchParams]);

  const applyView = useCallback((view: SavedView) => {
    applyContext(
      view.filterContext ?? taskFilterContextFromSavedView(view.filters),
      view.presentation ?? {
        sortBy: 'priority',
        sortDirection: 'asc',
        groupBy: 'none',
        viewDensity: 'comfortable',
      },
    );
  }, [applyContext]);

  const applyQuickFilter = useCallback((filter: SavedQuickFilter) => {
    const savedContext = filter.filterContext ?? taskFilterContextFromSavedView(filter.filters);
    applyContext(normalizeTaskFilterContext({
      ...savedContext,
      query: [taskFilterScopeQuery(taskFilterContext), savedContext.query]
        .filter(Boolean)
        .join(' '),
      sources: taskFilterContext.sources,
      listIds: taskFilterContext.listIds,
      listGroupId: taskFilterContext.listGroupId,
      projectId: taskFilterContext.projectId,
    }));
  }, [applyContext, taskFilterContext]);

  const clearQuickFilter = useCallback(() => {
    applyContext(normalizeTaskFilterContext({
      ...EMPTY_TASK_FILTER_CONTEXT,
      query: taskFilterScopeQuery(taskFilterContext),
      sources: taskFilterContext.sources,
      listIds: taskFilterContext.listIds,
      listGroupId: taskFilterContext.listGroupId,
      projectId: taskFilterContext.projectId,
    }));
  }, [applyContext, taskFilterContext]);

  const deleteView = useCallback((id: string) => {
    const updated = savedViews.filter((view) => view.id !== id);
    try {
      localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(updated));
      setSavedViews(updated);
      if (editorKind === 'view' && editingItemId === id) resetViewEditor();
    } catch (error) {
      clientLogger.error('Failed to delete saved view', { error, id });
      toast.error('Could not delete saved view');
    }
  }, [editingItemId, editorKind, resetViewEditor, savedViews]);

  const deleteQuickFilter = useCallback((id: string) => {
    const updated = savedQuickFilters.filter((filter) => filter.id !== id);
    try {
      localStorage.setItem(SAVED_QUICK_FILTERS_STORAGE_KEY, JSON.stringify(updated));
      setSavedQuickFilters(updated);
      if (editorKind === 'quick-filter' && editingItemId === id) resetViewEditor();
    } catch (error) {
      clientLogger.error('Failed to delete saved quick filter', { error, id });
      toast.error('Could not delete quick filter');
    }
  }, [editingItemId, editorKind, resetViewEditor, savedQuickFilters]);

  const activeQuickFilterId = useMemo(() => {
    const current = taskFilterContextForQuickFilter(taskFilterContext);
    return savedQuickFilters.find((filter) => (
      JSON.stringify(filter.filterContext ?? taskFilterContextFromSavedView(filter.filters))
      === JSON.stringify(current)
    ))?.id ?? null;
  }, [savedQuickFilters, taskFilterContext]);

  const state = useMemo(() => ({
    savedViews,
    savedQuickFilters,
    activeQuickFilterId,
    editorKind,
    editingItemId,
    itemName,
    itemIcon,
    itemIconColor,
  }), [
    activeQuickFilterId,
    editingItemId,
    editorKind,
    itemIcon,
    itemIconColor,
    itemName,
    savedQuickFilters,
    savedViews,
  ]);

  const actions = useMemo(() => ({
    startNewView,
    startNewQuickFilter,
    cancelViewEditor: resetViewEditor,
    editView,
    editQuickFilter,
    setItemName,
    setItemIcon,
    setItemIconColor,
    saveCurrentItem,
    applyView,
    applyQuickFilter,
    clearQuickFilter,
    deleteView,
    deleteQuickFilter,
  }), [
    applyQuickFilter,
    applyView,
    clearQuickFilter,
    deleteQuickFilter,
    deleteView,
    editQuickFilter,
    editView,
    resetViewEditor,
    saveCurrentItem,
    startNewQuickFilter,
    startNewView,
  ]);

  return { state, actions };
}

function taskFilterContextForQuickFilter(context: TaskFilterContext): TaskFilterContext {
  return normalizeTaskFilterContext({
    ...context,
    query: withoutTaskFilterQueryTypes(
      context.query,
      ['source', 'list', 'listid', 'project', 'phase'],
    ),
    sources: [],
    listIds: [],
    listGroupId: null,
    projectId: null,
  });
}

function taskFilterScopeQuery(context: TaskFilterContext): string {
  const scopeTypes = new Set(['source', 'list', 'listid', 'project', 'phase']);
  return parseFilterQuery(context.query).tokens
    .filter((token) => scopeTypes.has(token.type))
    .map((token) => token.raw)
    .join(' ');
}

function readSavedViews(stored: string | null): SavedView[] {
  return readSavedItems(stored)
    .map((item) => normalizeSavedView(item))
    .filter((item): item is SavedView => item !== null);
}

function readSavedQuickFilters(stored: string | null): SavedQuickFilter[] {
  return readSavedItems(stored)
    .map((item) => normalizeSavedQuickFilter(item))
    .filter((item): item is SavedQuickFilter => item !== null);
}

function readSavedItems(stored: string | null): unknown[] {
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeSavedView(value: unknown): SavedView | null {
  if (!isRecord(value) || !stringValue(value.id) || !stringValue(value.name)) return null;
  const filters = stringRecord(value.filters);
  return {
    id: stringValue(value.id)!,
    name: stringValue(value.name)!,
    icon: stringValue(value.icon) ?? DEFAULT_SAVED_VIEW_ICON,
    iconColor: stringValue(value.iconColor) ?? undefined,
    filters,
    filterContext: isRecord(value.filterContext)
      ? normalizeTaskFilterContext(value.filterContext)
      : undefined,
    presentation: normalizePresentation(value.presentation),
  };
}

function normalizeSavedQuickFilter(value: unknown): SavedQuickFilter | null {
  if (!isRecord(value) || !stringValue(value.id) || !stringValue(value.name)) return null;
  const filters = stringRecord(value.filters);
  const filterContext = isRecord(value.filterContext)
    ? taskFilterContextForQuickFilter(normalizeTaskFilterContext(value.filterContext))
    : taskFilterContextForQuickFilter(taskFilterContextFromSavedView(filters));
  return {
    id: stringValue(value.id)!,
    name: stringValue(value.name)!,
    icon: stringValue(value.icon) ?? DEFAULT_QUICK_FILTER_ICON,
    iconColor: stringValue(value.iconColor) ?? undefined,
    filters: taskFilterContextToSavedView(filterContext),
    filterContext,
  };
}

function normalizePresentation(value: unknown): SavedView['presentation'] {
  if (!isRecord(value)) return undefined;
  return {
    sortBy: stringValue(value.sortBy) ?? 'priority',
    sortDirection: value.sortDirection === 'desc' ? 'desc' : 'asc',
    groupBy: stringValue(value.groupBy) ?? 'none',
    viewDensity: value.viewDensity === 'compact' ? 'compact' : 'comfortable',
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
