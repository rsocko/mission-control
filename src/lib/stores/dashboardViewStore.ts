import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  MatrixAxisMode,
  MatrixColorMode,
  MatrixMobileView,
  MatrixSizeMode,
} from '@/lib/matrix/scales';

interface DashboardViewState {
  // Filters (session-scoped but survive navigation)
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];
  textFilter: string;

  // View options (persist across sessions)
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  groupBy: string;
  viewDensity: 'compact' | 'comfortable';
  showCompleted: boolean;
  matrixAxisMode: MatrixAxisMode;
  matrixSizeMode: MatrixSizeMode;
  matrixColorMode: MatrixColorMode;
  matrixColorCustomized: boolean;
  matrixMobileView: MatrixMobileView;

  // Quick filter visibility (persist across sessions)
  hiddenQuickFilters: string[];

  // Sidebar state
  collapsedListGroups: string[];
  collapsedSections: string[];

  // Actions
  setSourceFilter: (v: string | null) => void;
  setListFilter: (v: string | null) => void;
  setListGroupFilter: (v: string | null) => void;
  setTagFilter: (v: string[]) => void;
  setQuickFilter: (v: string | null) => void;
  setProjectFilter: (v: string | null) => void;
  setPriorityFilter: (v: string[]) => void;
  setStatusFilter: (v: string[]) => void;
  setTextFilter: (v: string) => void;
  setSortBy: (v: string) => void;
  setSortDirection: (v: 'asc' | 'desc') => void;
  setGroupBy: (v: string) => void;
  setViewDensity: (v: 'compact' | 'comfortable') => void;
  setShowCompleted: (v: boolean) => void;
  setMatrixAxisMode: (v: MatrixAxisMode) => void;
  setMatrixSizeMode: (v: MatrixSizeMode) => void;
  setMatrixColorMode: (v: MatrixColorMode) => void;
  setMatrixMobileView: (v: MatrixMobileView) => void;
  setHiddenQuickFilters: (v: string[]) => void;
  toggleQuickFilterVisibility: (filterId: string) => void;
  setCollapsedListGroups: (v: string[]) => void;
  setCollapsedSections: (v: string[]) => void;
  resetFilters: () => void;
}

export const useDashboardViewStore = create<DashboardViewState>()(
  persist(
    (set, get) => ({
      // Defaults
      sourceFilter: null,
      listFilter: null,
      listGroupFilter: null,
      tagFilter: [],
      quickFilter: null,
      projectFilter: null,
      priorityFilter: [],
      statusFilter: [],
      textFilter: '',
      sortBy: 'priority',
      sortDirection: 'asc',
      groupBy: 'none',
      viewDensity: 'comfortable',
      showCompleted: false,
      matrixAxisMode: 'priority-urgency',
      matrixSizeMode: 'smart-score',
      matrixColorMode: 'project',
      matrixColorCustomized: false,
      matrixMobileView: 'table',
      hiddenQuickFilters: [],
      collapsedListGroups: [],
      collapsedSections: [],

      // Actions
      setSourceFilter: (v) => set({ sourceFilter: v }),
      setListFilter: (v) => set({ listFilter: v }),
      setListGroupFilter: (v) => set({ listGroupFilter: v }),
      setTagFilter: (v) => set({ tagFilter: v }),
      setQuickFilter: (v) => set({ quickFilter: v }),
      setProjectFilter: (v) => set({ projectFilter: v }),
      setPriorityFilter: (v) => set({ priorityFilter: v }),
      setStatusFilter: (v) => set({ statusFilter: v }),
      setTextFilter: (v) => set({ textFilter: v }),
      setSortBy: (v) => set({ sortBy: v }),
      setSortDirection: (v) => set({ sortDirection: v }),
      setGroupBy: (v) => set({ groupBy: v }),
      setViewDensity: (v) => set({ viewDensity: v }),
      setShowCompleted: (v) => set({ showCompleted: v }),
      setMatrixAxisMode: (v) => set({
        matrixAxisMode: v,
        matrixColorMode: get().matrixColorCustomized
          ? get().matrixColorMode
          : (v === 'priority-effort' ? 'urgency' : 'project'),
      }),
      setMatrixSizeMode: (v) => set({ matrixSizeMode: v }),
      setMatrixColorMode: (v) => set({ matrixColorMode: v, matrixColorCustomized: true }),
      setMatrixMobileView: (v) => set({ matrixMobileView: v }),
      setHiddenQuickFilters: (v) => set({ hiddenQuickFilters: v }),
      toggleQuickFilterVisibility: (filterId) => {
        const current = get().hiddenQuickFilters;
        if (current.includes(filterId)) {
          set({ hiddenQuickFilters: current.filter(id => id !== filterId) });
        } else {
          set({ hiddenQuickFilters: [...current, filterId] });
        }
      },
      setCollapsedListGroups: (v) => set({ collapsedListGroups: v }),
      setCollapsedSections: (v) => set({ collapsedSections: v }),
      resetFilters: () =>
        set({
          sourceFilter: null,
          listFilter: null,
          listGroupFilter: null,
          tagFilter: [],
          quickFilter: null,
          projectFilter: null,
          priorityFilter: [],
          statusFilter: [],
          textFilter: '',
        }),
    }),
    {
      name: 'mission-control:dashboard-view',
      partialize: (state) => ({
        sortBy: state.sortBy,
        sortDirection: state.sortDirection,
        groupBy: state.groupBy,
        viewDensity: state.viewDensity,
        showCompleted: state.showCompleted,
        matrixAxisMode: state.matrixAxisMode,
        matrixSizeMode: state.matrixSizeMode,
        matrixColorMode: state.matrixColorMode,
        matrixColorCustomized: state.matrixColorCustomized,
        matrixMobileView: state.matrixMobileView,
        hiddenQuickFilters: state.hiddenQuickFilters,
        collapsedListGroups: state.collapsedListGroups,
        collapsedSections: state.collapsedSections,
        sourceFilter: state.sourceFilter,
        listFilter: state.listFilter,
        listGroupFilter: state.listGroupFilter,
        tagFilter: state.tagFilter,
        quickFilter: state.quickFilter,
        projectFilter: state.projectFilter,
        priorityFilter: state.priorityFilter,
        statusFilter: state.statusFilter,
        textFilter: state.textFilter,
      }),
    }
  )
);
