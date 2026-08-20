'use client';

import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { withoutTaskFilterQueryTypes } from '@/lib/task-filter-context';
import type { QuickFilterVisibility } from '@/lib/tasks/quick-filters';

export interface DashboardFilterState {
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];
  textFilter: string;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  groupBy: string;
  viewDensity: 'compact' | 'comfortable';
  showCompleted: boolean;
  hiddenQuickFilters: string[];
  quickFilterVisibility: Record<string, QuickFilterVisibility>;
}

export interface DashboardFilterActions {
  setSourceFilter: (value: string | null) => void;
  setListFilter: (value: string | null) => void;
  setListGroupFilter: (value: string | null) => void;
  setTagFilter: Dispatch<SetStateAction<string[]>>;
  setQuickFilter: (value: string | null) => void;
  setProjectFilter: (value: string | null) => void;
  setPriorityFilter: Dispatch<SetStateAction<string[]>>;
  setStatusFilter: Dispatch<SetStateAction<string[]>>;
  setTextFilter: (value: string) => void;
  setSortBy: (value: string) => void;
  setSortDirection: (value: 'asc' | 'desc') => void;
  setGroupBy: (value: string) => void;
  setViewDensity: (value: 'compact' | 'comfortable') => void;
  setShowCompleted: (value: boolean) => void;
  toggleQuickFilterVisibility: (filterId: string) => void;
  setQuickFilterVisibility: (filterId: string, visibility: QuickFilterVisibility) => void;
}

export function useDashboardFilterState(): {
  state: DashboardFilterState;
  actions: DashboardFilterActions;
} {
  const viewStore = useDashboardViewStore();
  const {
    setSourceFilter: setStoredSourceFilter,
    setListFilter: setStoredListFilter,
    setTagFilter: setStoredTagFilter,
    setPriorityFilter: setStoredPriorityFilter,
    setStatusFilter: setStoredStatusFilter,
    setTextFilter,
  } = viewStore;

  const setSourceFilter = useCallback((value: string | null) => {
    setStoredSourceFilter(value);
    if (value) {
      setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['source'],
      ));
    }
  }, [setStoredSourceFilter, setTextFilter]);

  const setListFilter = useCallback((value: string | null) => {
    setStoredListFilter(value);
    if (value) {
      setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['listid'],
      ));
    }
  }, [setStoredListFilter, setTextFilter]);

  const setTagFilter: Dispatch<SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().tagFilter;
    const next = typeof action === 'function' ? action(current) : action;
    setStoredTagFilter(next);
    if (next.length) {
      setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['tag'],
      ));
    }
  }, [setStoredTagFilter, setTextFilter]);

  const setPriorityFilter: Dispatch<SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().priorityFilter;
    const next = typeof action === 'function' ? action(current) : action;
    setStoredPriorityFilter(next);
    if (next.length) {
      setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['priority'],
      ));
    }
  }, [setStoredPriorityFilter, setTextFilter]);

  const setStatusFilter: Dispatch<SetStateAction<string[]>> = useCallback((action) => {
    const current = useDashboardViewStore.getState().statusFilter;
    const next = typeof action === 'function' ? action(current) : action;
    setStoredStatusFilter(next);
    if (next.length) {
      setTextFilter(withoutTaskFilterQueryTypes(
        useDashboardViewStore.getState().textFilter,
        ['status'],
      ));
    }
  }, [setStoredStatusFilter, setTextFilter]);

  const state = useMemo<DashboardFilterState>(() => ({
    sourceFilter: viewStore.sourceFilter,
    listFilter: viewStore.listFilter,
    listGroupFilter: viewStore.listGroupFilter,
    tagFilter: viewStore.tagFilter,
    quickFilter: viewStore.quickFilter,
    projectFilter: viewStore.projectFilter,
    priorityFilter: viewStore.priorityFilter,
    statusFilter: viewStore.statusFilter,
    textFilter: viewStore.textFilter,
    sortBy: viewStore.sortBy,
    sortDirection: viewStore.sortDirection,
    groupBy: viewStore.groupBy,
    viewDensity: viewStore.viewDensity,
    showCompleted: viewStore.showCompleted,
    hiddenQuickFilters: viewStore.hiddenQuickFilters,
    quickFilterVisibility: viewStore.quickFilterVisibility,
  }), [
    viewStore.groupBy,
    viewStore.hiddenQuickFilters,
    viewStore.quickFilterVisibility,
    viewStore.listFilter,
    viewStore.listGroupFilter,
    viewStore.priorityFilter,
    viewStore.projectFilter,
    viewStore.quickFilter,
    viewStore.showCompleted,
    viewStore.sortBy,
    viewStore.sortDirection,
    viewStore.sourceFilter,
    viewStore.statusFilter,
    viewStore.tagFilter,
    viewStore.textFilter,
    viewStore.viewDensity,
  ]);

  const actions = useMemo<DashboardFilterActions>(() => ({
    setSourceFilter,
    setListFilter,
    setListGroupFilter: viewStore.setListGroupFilter,
    setTagFilter,
    setQuickFilter: viewStore.setQuickFilter,
    setProjectFilter: viewStore.setProjectFilter,
    setPriorityFilter,
    setStatusFilter,
    setTextFilter: viewStore.setTextFilter,
    setSortBy: viewStore.setSortBy,
    setSortDirection: viewStore.setSortDirection,
    setGroupBy: viewStore.setGroupBy,
    setViewDensity: viewStore.setViewDensity,
    setShowCompleted: viewStore.setShowCompleted,
    toggleQuickFilterVisibility: viewStore.toggleQuickFilterVisibility,
    setQuickFilterVisibility: viewStore.setQuickFilterVisibility,
  }), [
    setListFilter,
    setPriorityFilter,
    setSourceFilter,
    setStatusFilter,
    setTagFilter,
    viewStore.setGroupBy,
    viewStore.setListGroupFilter,
    viewStore.setProjectFilter,
    viewStore.setQuickFilter,
    viewStore.setShowCompleted,
    viewStore.setSortBy,
    viewStore.setSortDirection,
    viewStore.setTextFilter,
    viewStore.setViewDensity,
    viewStore.toggleQuickFilterVisibility,
    viewStore.setQuickFilterVisibility,
  ]);

  return { state, actions };
}
