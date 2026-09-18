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
    hiddenQuickFilters: [],
    quickFilterVisibility: {},
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

  it('persists and applies saved views as complete workspace snapshots', () => {
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
      setQuickFilterVisibility: vi.fn(),
    };
    const replaceUrl = vi.fn();
    const { result } = renderHook(() => useDashboardSavedViews({
      taskFilterContext: normalizeTaskFilterContext({
        sources: ['github-issues'],
        tagSlugs: ['planning'],
      }),
      presentationState: {
        sortBy: 'dueDate',
        sortDirection: 'desc',
        groupBy: 'project',
        viewDensity: 'compact',
      },
      filterActions,
      searchParams: '',
      pathname: '/',
      replaceUrl,
    }));

    act(() => {
      result.current.actions.startNewView();
      result.current.actions.setItemName('Planning');
      result.current.actions.setItemIcon('lucide:clipboard-check');
      result.current.actions.setItemIconColor('#3b82f6');
    });
    act(() => {
      result.current.actions.saveCurrentItem();
    });

    expect(result.current.state.savedViews).toHaveLength(1);
    expect(result.current.state.savedViews[0]).toMatchObject({
      name: 'Planning',
      icon: 'lucide:clipboard-check',
      iconColor: '#3b82f6',
      presentation: {
        sortBy: 'dueDate',
        sortDirection: 'desc',
        groupBy: 'project',
        viewDensity: 'compact',
      },
    });
    expect(result.current.state.itemIcon).toBe('bookmark');
    expect(result.current.state.itemIconColor).toBe('');
    expect(JSON.parse(localStorage.getItem('mission-control:saved-views') ?? '[]')).toHaveLength(1);

    const savedFilters = result.current.state.savedViews[0].filters;
    act(() => result.current.actions.editView(result.current.state.savedViews[0]));
    expect(result.current.state).toMatchObject({
      editorKind: 'view',
      editingItemId: result.current.state.savedViews[0].id,
      itemName: 'Planning',
      itemIcon: 'lucide:clipboard-check',
      itemIconColor: '#3b82f6',
    });
    act(() => {
      result.current.actions.setItemName('Weekly planning');
      result.current.actions.setItemIcon('lucide:calendar');
      result.current.actions.setItemIconColor('');
    });
    act(() => result.current.actions.saveCurrentItem());
    expect(result.current.state.savedViews).toHaveLength(1);
    expect(result.current.state.savedViews[0]).toMatchObject({
      name: 'Weekly planning',
      icon: 'lucide:calendar',
      filters: savedFilters,
    });
    expect(result.current.state.savedViews[0].iconColor).toBeUndefined();

    act(() => result.current.actions.applyView(result.current.state.savedViews[0]));
    expect(filterActions.setSourceFilter).toHaveBeenCalledWith('github-issues');
    expect(filterActions.setTagFilter).toHaveBeenCalledWith(['planning']);
    expect(filterActions.setSortBy).toHaveBeenCalledWith('dueDate');
    expect(filterActions.setSortDirection).toHaveBeenCalledWith('desc');
    expect(filterActions.setGroupBy).toHaveBeenCalledWith('project');
    expect(filterActions.setViewDensity).toHaveBeenCalledWith('compact');
    expect(replaceUrl).toHaveBeenCalledWith('/');

    act(() => result.current.actions.deleteView(result.current.state.savedViews[0].id));
    expect(result.current.state.savedViews).toEqual([]);
  });

  it('saves reusable quick filters without scope and reapplies them within the current scope', () => {
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
      setQuickFilterVisibility: vi.fn(),
    };
    const { result } = renderHook(() => useDashboardSavedViews({
      taskFilterContext: normalizeTaskFilterContext({
        sources: ['github-issues'],
        listIds: ['connector:list'],
        projectId: 'project-1',
        tagSlugs: ['planning'],
        query: 'due:today',
      }),
      presentationState: {
        sortBy: 'priority',
        sortDirection: 'asc',
        groupBy: 'none',
        viewDensity: 'comfortable',
      },
      filterActions,
      searchParams: '',
      pathname: '/',
      replaceUrl: vi.fn(),
    }));

    act(() => {
      result.current.actions.startNewQuickFilter();
      result.current.actions.setItemName('Plan today');
      result.current.actions.setItemIcon('lucide:calendar-check');
      result.current.actions.setItemIconColor('#22c55e');
    });
    act(() => result.current.actions.saveCurrentItem());

    expect(result.current.state.savedQuickFilters[0]).toMatchObject({
      name: 'Plan today',
      icon: 'lucide:calendar-check',
      iconColor: '#22c55e',
      filterContext: {
        sources: [],
        listIds: [],
        listGroupId: null,
        projectId: null,
        tagSlugs: ['planning'],
        query: 'due:today',
      },
    });
    expect(result.current.state.activeQuickFilterId).toBe(
      result.current.state.savedQuickFilters[0].id,
    );

    act(() => result.current.actions.applyQuickFilter(result.current.state.savedQuickFilters[0]));
    expect(filterActions.setSourceFilter).toHaveBeenCalledWith('github-issues');
    expect(filterActions.setListFilter).toHaveBeenCalledWith('connector:list');
    expect(filterActions.setProjectFilter).toHaveBeenCalledWith('project-1');
    expect(filterActions.setTagFilter).toHaveBeenCalledWith(['planning']);
    expect(filterActions.setTextFilter).toHaveBeenCalledWith('due:today');
    expect(filterActions.setSortBy).not.toHaveBeenCalled();

    act(() => result.current.actions.deleteQuickFilter(
      result.current.state.savedQuickFilters[0].id,
    ));
    expect(result.current.state.savedQuickFilters).toEqual([]);
  });

  it('loads legacy filter-only views and applies default presentation state', () => {
    localStorage.setItem('mission-control:saved-views', JSON.stringify([{
      id: 'legacy',
      name: 'Legacy view',
      icon: 'bookmark',
      filters: { source: 'todoist', tag: 'old' },
    }]));
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
      setQuickFilterVisibility: vi.fn(),
    };
    const { result } = renderHook(() => useDashboardSavedViews({
      taskFilterContext: normalizeTaskFilterContext({ sources: ['github-issues'] }),
      presentationState: {
        sortBy: 'createdAt',
        sortDirection: 'desc',
        groupBy: 'source',
        viewDensity: 'compact',
      },
      filterActions,
      searchParams: '',
      pathname: '/',
      replaceUrl: vi.fn(),
    }));

    act(() => result.current.actions.applyView(result.current.state.savedViews[0]));

    expect(filterActions.setSourceFilter).toHaveBeenCalledWith('todoist');
    expect(filterActions.setTagFilter).toHaveBeenCalledWith(['old']);
    expect(filterActions.setSortBy).toHaveBeenCalledWith('priority');
    expect(filterActions.setSortDirection).toHaveBeenCalledWith('asc');
    expect(filterActions.setGroupBy).toHaveBeenCalledWith('none');
    expect(filterActions.setViewDensity).toHaveBeenCalledWith('comfortable');
  });

  it('owns sidebar and selection UI state without dashboard data dependencies', () => {
    window.history.replaceState({}, '', '/?taskId=task-1');
    const { result } = renderHook(() => useDashboardUiState());

    expect(result.current.state.selectedTaskId).toBe('task-1');
    act(() => result.current.actions.toggleSection('sources'));
    expect(result.current.state.collapsedSections.has('sources')).toBe(true);
    expect(useDashboardViewStore.getState().collapsedSections).toEqual(['sources']);
  });
});
