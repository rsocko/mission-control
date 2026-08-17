import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardFilterState } from '@/lib/hooks/useDashboardFilterState';
import { useDashboardSavedViews } from '@/lib/hooks/useDashboardSavedViews';
import { useDashboardUiState } from '@/lib/hooks/useDashboardUiState';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { normalizeTaskFilterContext } from '@/lib/task-filter-context';

vi.mock('@/lib/hooks/useSidebarExpanded', () => ({
  useSidebarExpanded: () => ({
    sidebarExpanded: false,
    sidebarMode: 'normal',
    setSidebarExpanded: vi.fn(),
    setSidebarMode: vi.fn(),
  }),
}));

beforeEach(() => {
  localStorage.clear();
  useDashboardViewStore.getState().resetFilters();
  useDashboardViewStore.setState({
    collapsedListGroups: [],
    collapsedSections: [],
  });
});

describe('dashboard state modules', () => {
  it('updates structured filters and removes duplicate text tokens', () => {
    useDashboardViewStore.setState({ textFilter: 'source:github urgent' });
    const { result } = renderHook(() => useDashboardFilterState());

    act(() => result.current.actions.setSourceFilter('microsoft-todo'));

    expect(result.current.state.sourceFilter).toBe('microsoft-todo');
    expect(result.current.state.textFilter).toBe('urgent');
  });

  it('persists, applies, and deletes saved views independently', () => {
    const filterActions = {
      setSourceFilter: vi.fn(),
      setListFilter: vi.fn(),
      setListGroupFilter: vi.fn(),
      setTagFilter: vi.fn(),
      setQuickFilter: vi.fn(),
      setProjectFilter: vi.fn(),
      setPriorityFilter: vi.fn(),
      setStatusFilter: vi.fn(),
      setTextFilter: vi.fn(),
      setSortBy: vi.fn(),
      setSortDirection: vi.fn(),
      setGroupBy: vi.fn(),
      setViewDensity: vi.fn(),
      setShowCompleted: vi.fn(),
      toggleQuickFilterVisibility: vi.fn(),
    };
    const replaceUrl = vi.fn();
    const { result } = renderHook(() => useDashboardSavedViews({
      taskFilterContext: normalizeTaskFilterContext({ tagSlugs: ['planning'] }),
      filterActions,
      searchParams: '',
      pathname: '/',
      replaceUrl,
    }));

    act(() => {
      result.current.actions.setViewName('Planning');
    });
    act(() => {
      result.current.actions.saveCurrentView();
    });

    expect(result.current.state.savedViews).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('mission-control:saved-views') ?? '[]')).toHaveLength(1);

    act(() => result.current.actions.applyView(result.current.state.savedViews[0]));
    expect(filterActions.setTagFilter).toHaveBeenCalledWith(['planning']);
    expect(replaceUrl).toHaveBeenCalledWith('/');

    act(() => result.current.actions.deleteView(result.current.state.savedViews[0].id));
    expect(result.current.state.savedViews).toEqual([]);
  });

  it('owns sidebar and selection UI state without dashboard data dependencies', () => {
    const { result } = renderHook(() => useDashboardUiState('task-1'));

    expect(result.current.state.selectedTaskId).toBe('task-1');
    act(() => result.current.actions.toggleSection('sources'));
    expect(result.current.state.collapsedSections.has('sources')).toBe(true);
    expect(useDashboardViewStore.getState().collapsedSections).toEqual(['sources']);
  });
});
