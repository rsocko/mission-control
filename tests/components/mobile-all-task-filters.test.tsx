import { fireEvent, render, screen } from '@testing-library/react';
import { MobileTaskFilters } from '@/components/all-tasks/MobileAllTasksList';

const sources = [
  { type: 'github', name: 'GitHub', icon: 'github' },
  { type: 'mstodo', name: 'Microsoft To Do', icon: 'microsoft' },
];

const sourceLists = [
  {
    id: 'github-list',
    sourceId: 'repo-list',
    connectorInstanceId: 'github-connector',
    name: 'Mission Control',
    taskCount: 12,
    groupId: null,
  },
  {
    id: 'todo-list',
    sourceId: 'work-list',
    connectorInstanceId: 'todo-connector',
    name: 'Work',
    taskCount: 4,
    groupId: null,
  },
];

const syncStatus = [
  { id: 'github-connector', type: 'github', name: 'GitHub', lastSyncedAt: null, enabled: true },
  { id: 'todo-connector', type: 'mstodo', name: 'Microsoft To Do', lastSyncedAt: null, enabled: true },
];

function renderFilters(overrides: Partial<React.ComponentProps<typeof MobileTaskFilters>> = {}) {
  const props: React.ComponentProps<typeof MobileTaskFilters> = {
    activeFilter: 'all',
    sourceFilter: null,
    listFilter: null,
    planningHorizonFilters: [],
    sources,
    sourceLists,
    syncStatus,
    sourceCounts: { github: 12 },
    stats: {
      totalOpen: 16,
      overdue: 1,
      dueToday: 2,
      dueThisWeek: 3,
      noDate: 0,
      highPriority: 2,
      assignedToMe: 0,
      myDay: 0,
      recentlyCreated: 0,
      recentlyClosed: 0,
      waiting: 0,
      inbox: 4,
    },
    hiddenQuickFilters: [],
    quickFilterVisibility: {},
    loading: false,
    onQuickFilterChange: vi.fn(),
    onQuickFilterVisibilityChange: vi.fn(),
    onSourceFilterChange: vi.fn(),
    onListFilterChange: vi.fn(),
    onPlanningHorizonToggle: vi.fn(),
    onPlanningHorizonClear: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };

  render(<MobileTaskFilters {...props} />);
  return props;
}

describe('MobileTaskFilters', () => {
  it('shows configured sources and lists even when response counts are missing', () => {
    renderFilters();

    expect(screen.getByRole('button', { name: /GitHub 12 tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Microsoft To Do 0 tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mission Control GitHub · 12 tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Work Microsoft To Do · 4 tasks/ })).toBeInTheDocument();
  });

  it('selects a list together with its source', () => {
    const props = renderFilters();

    fireEvent.click(screen.getByRole('button', { name: /Work Microsoft To Do · 4 tasks/ }));

    expect(props.onListFilterChange).toHaveBeenCalledWith('work-list', 'mstodo');
  });

  it('searches across source and list names', () => {
    renderFilters();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sources and lists' }), {
      target: { value: 'work' },
    });

    expect(screen.getByRole('button', { name: /Work Microsoft To Do · 4 tasks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mission Control/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Quick filters')).not.toBeInTheDocument();
  });

  it('shows catalog filters and auto-hides empty conditional filters', () => {
    renderFilters();

    expect(screen.getByRole('button', { name: /Due Today/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next 7 Days/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Assigned to Me/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /No Date/ })).not.toBeInTheDocument();
  });

  it('shows and toggles canonical planning horizon filters', () => {
    const props = renderFilters({ planningHorizonFilters: ['next'] });

    expect(screen.getByRole('button', { name: /Next Planned for next/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Not set Needs planning/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Later Planned for later/ }));
    expect(props.onPlanningHorizonToggle).toHaveBeenCalledWith('later');

    fireEvent.click(screen.getByRole('button', { name: /Any horizon/ }));
    expect(props.onPlanningHorizonClear).toHaveBeenCalledTimes(1);
  });
});
