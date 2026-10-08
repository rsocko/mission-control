import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarFilters } from '@/components/sidebar/SidebarFilters';
import { MobileTodayList } from '@/components/today/MobileTodayList';
import { TodayViewSwitcher } from '@/components/today/TodayMainPanel';
import {
  normalizeTaskFilterContext,
  serializeTaskFilterContext,
} from '@/lib/task-filter-context';
import { EMPTY_TASK_RESPONSE } from '@/types/dashboard';

describe('View in Graph collection surfaces', () => {
  it('links the desktop My Day switcher with explicit date semantics', () => {
    render(
      <TodayViewSwitcher
        todayISO="2026-08-01"
        view="list"
        onViewChange={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: 'View My Day in Graph' });
    const url = new URL(link.getAttribute('href') ?? '', 'https://mission-control.example');
    expect(url.pathname).toBe('/graph/universe');
    expect(url.searchParams.get('tf')).toContain('"myDayDate":"2026-08-01"');
    expect(url.searchParams.get('from')).toBe('/today');
  });

  it('links the mobile My Day collection to Graph', () => {
    render(
      <MobileTodayList
        items={[]}
        loading={false}
        completingIds={new Set()}
        suggestions={{
          yesterday: [],
          overdue: [],
          dueToday: [],
          dueThisWeek: [],
          highPriority: [],
          aiRecommended: [],
          recentlyAdded: [],
          carriedForward: [],
        }}
        onCompleteTask={vi.fn()}
        onRemoveFromDay={vi.fn()}
        onSetTaskDueDate={vi.fn()}
        onSetTaskLocalDisposition={vi.fn()}
        onAddToDay={vi.fn()}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        fetchData={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'View My Day in Graph' }))
      .toHaveAttribute('href', expect.stringContaining('/graph/universe?'));
  });

  it('opens a saved view in Graph without applying it to Dashboard', () => {
    const applyView = vi.fn();
    const applyQuickFilter = vi.fn();
    const editView = vi.fn();
    const startNewQuickFilter = vi.fn();
    const originContext = serializeTaskFilterContext(
      normalizeTaskFilterContext({ tagSlugs: ['current'] }),
    );
    render(
      <SidebarFilters
        data={{
          taskResponse: EMPTY_TASK_RESPONSE,
          enabledSources: [],
          sourceLists: [],
          listGroups: [],
          allTags: [],
          projects: [],
          savedViews: [{
            id: 'planning',
            name: 'Planning',
            icon: 'pin',
            filters: { tag: 'planning' },
          }],
          savedQuickFilters: [{
            id: 'triage',
            name: 'Needs triage',
            icon: 'lucide:list-filter',
            iconColor: '#22c55e',
            filters: { query: 'tag:triage' },
          }],
          allSourceCounts: {},
          loading: false,
        }}
        filters={{
          sourceFilter: null,
          listFilter: null,
          listGroupFilter: null,
          tagFilter: [],
          quickFilter: null,
          projectFilter: null,
          priorityFilter: [],
          statusFilter: [],
          hiddenQuickFilters: [],
          quickFilterVisibility: {},
          activeSavedQuickFilterId: null,
        }}
        sidebar={{
          sidebarExpanded: false,
          sidebarMode: 'normal',
          collapsedSections: new Set(),
          expandedSourceLists: new Set(),
          collapsedListGroups: new Set(),
          listSearch: '',
          tagSearch: '',
          tagsExpanded: false,
        }}
        actions={{
          setSourceFilter: vi.fn(),
          setListFilter: vi.fn(),
          setListGroupFilter: vi.fn(),
          setTagFilter: vi.fn(),
          setQuickFilter: vi.fn(),
          setProjectFilter: vi.fn(),
          setPriorityFilter: vi.fn(),
          setStatusFilter: vi.fn(),
          setSidebarExpanded: vi.fn(),
          setSidebarMode: vi.fn(),
          toggleSection: vi.fn(),
          setExpandedSourceLists: vi.fn(),
          setCollapsedListGroups: vi.fn(),
          setListSearch: vi.fn(),
          setTagSearch: vi.fn(),
          setTagsExpanded: vi.fn(),
          applyView,
          editView,
          deleteView: vi.fn(),
          startNewQuickFilter,
          applyQuickFilter,
          clearSavedQuickFilter: vi.fn(),
          editQuickFilter: vi.fn(),
          deleteQuickFilter: vi.fn(),
          setQuickFilterVisibility: vi.fn(),
        }}
        computed={{
          sourceHasLists: () => false,
          getSourceListsForType: () => [],
          graphOrigin: { href: `/?tf=${encodeURIComponent(originContext)}`, label: 'Dashboard' },
        }}
      />,
    );

    expect(screen.getByRole('img', { name: 'lucide:pin' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'lucide:list-filter' })).toBeInTheDocument();
    expect(screen.queryByText('pin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save current filters as a quick filter' }));
    expect(startNewQuickFilter).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'lucide:list-filter Needs triage' }));
    expect(applyQuickFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 'triage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Planning' }));
    expect(editView).toHaveBeenCalledWith(expect.objectContaining({ id: 'planning' }));
    const graphLink = screen.getByRole('link', { name: 'View Planning in Graph' });
    fireEvent.click(graphLink);
    expect(applyView).not.toHaveBeenCalled();
    expect(graphLink).toHaveAttribute('href', expect.stringContaining('fromLabel=Dashboard'));
  });
});
