'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  taskFilterContextFromSavedView,
  taskFilterContextToDashboard,
  taskFilterContextToSavedView,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type { SavedView } from '@/types/dashboard';
import type { DashboardFilterActions } from '@/lib/hooks/useDashboardFilterState';

const SAVED_VIEWS_STORAGE_KEY = 'mission-control:saved-views';
const DEFAULT_SAVED_VIEW_ICON = 'bookmark';

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
  filterActions: DashboardFilterActions;
  searchParams: string;
  pathname: string;
  replaceUrl: (href: string) => void;
}

export function useDashboardSavedViews({
  taskFilterContext,
  filterActions,
  searchParams,
  pathname,
  replaceUrl,
}: UseDashboardSavedViewsOptions) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [viewName, setViewName] = useState('');
  const [viewIcon, setViewIcon] = useState(DEFAULT_SAVED_VIEW_ICON);
  const [viewIconColor, setViewIconColor] = useState('');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SAVED_VIEWS_STORAGE_KEY);
      if (stored) setSavedViews(JSON.parse(stored));
    } catch {
      setSavedViews([]);
    }
  }, []);

  const resetViewEditor = useCallback(() => {
    setSavingView(false);
    setEditingViewId(null);
    setViewName('');
    setViewIcon(DEFAULT_SAVED_VIEW_ICON);
    setViewIconColor('');
  }, []);

  const startNewView = useCallback(() => {
    resetViewEditor();
    setSavingView(true);
  }, [resetViewEditor]);

  const editView = useCallback((view: SavedView) => {
    setEditingViewId(view.id);
    setViewName(view.name);
    setViewIcon(view.icon || DEFAULT_SAVED_VIEW_ICON);
    setViewIconColor(view.iconColor ?? '');
    setSavingView(true);
  }, []);

  const saveCurrentView = useCallback(() => {
    if (!viewName.trim()) return;
    const iconColor = viewIconColor || undefined;
    const updated = editingViewId
      ? savedViews.map((view) => view.id === editingViewId
        ? { ...view, name: viewName.trim(), icon: viewIcon, iconColor }
        : view)
      : [...savedViews, {
          id: `custom-${Date.now()}`,
          name: viewName.trim(),
          icon: viewIcon,
          iconColor,
          filters: taskFilterContextToSavedView(taskFilterContext),
          filterContext: taskFilterContext,
        }];
    localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(updated));
    setSavedViews(updated);
    resetViewEditor();
  }, [
    editingViewId,
    resetViewEditor,
    savedViews,
    taskFilterContext,
    viewIcon,
    viewIconColor,
    viewName,
  ]);

  const applyView = useCallback((view: SavedView) => {
    const dashboardFilters = taskFilterContextToDashboard(
      view.filterContext ?? taskFilterContextFromSavedView(view.filters),
    );
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

    const nextSearchParams = new URLSearchParams(searchParams);
    setOptionalSearchParam(nextSearchParams, 'myDayDate', dashboardFilters.myDayDate);
    setOptionalSearchParam(nextSearchParams, 'ageMin', dashboardFilters.ageMinDays);
    setOptionalSearchParam(nextSearchParams, 'ageMax', dashboardFilters.ageMaxDays);
    const nextQuery = nextSearchParams.toString();
    replaceUrl(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [filterActions, pathname, replaceUrl, searchParams]);

  const deleteView = useCallback((id: string) => {
    const updated = savedViews.filter((view) => view.id !== id);
    localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(updated));
    setSavedViews(updated);
    if (editingViewId === id) resetViewEditor();
  }, [editingViewId, resetViewEditor, savedViews]);

  const state = useMemo(() => ({
    savedViews,
    savingView,
    editingViewId,
    viewName,
    viewIcon,
    viewIconColor,
  }), [editingViewId, savedViews, savingView, viewIcon, viewIconColor, viewName]);

  const actions = useMemo(() => ({
    startNewView,
    cancelViewEditor: resetViewEditor,
    editView,
    setViewName,
    setViewIcon,
    setViewIconColor,
    saveCurrentView,
    applyView,
    deleteView,
  }), [applyView, deleteView, editView, resetViewEditor, saveCurrentView, startNewView]);

  return { state, actions };
}
