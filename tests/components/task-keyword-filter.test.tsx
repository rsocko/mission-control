import { act, fireEvent, render, screen } from '@testing-library/react';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

const defaultProps = {
  filteredCount: 4,
  sources: [{ type: 'github-issues', name: 'GitHub Issues', icon: 'github' }],
  sourceLists: [{
    id: 'list-1',
    sourceId: 'source-list-1',
    connectorInstanceId: 'connector-1',
    name: 'Mission Control',
    taskCount: 4,
    groupId: null,
  }],
  tags: [],
  assignees: [],
  projects: [],
  listGroups: [],
};

describe('TaskKeywordFilter applied sidebar filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDashboardViewStore.getState().resetFilters();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders sidebar filters in the unified input and removes dependent source filters', () => {
    useDashboardViewStore.setState({
      sourceFilter: 'github-issues',
      listFilter: 'source-list-1',
    });

    render(<TaskKeywordFilter {...defaultProps} />);

    expect(screen.getByText('source:github-issues')).toBeInTheDocument();
    expect(screen.getByText('list:Mission Control')).toBeInTheDocument();
    expect(screen.getByText('4 matches')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove source:github-issues filter' }));

    expect(useDashboardViewStore.getState().sourceFilter).toBeNull();
    expect(useDashboardViewStore.getState().listFilter).toBeNull();

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().sourceFilter).toBe('github-issues');
    expect(useDashboardViewStore.getState().listFilter).toBe('source-list-1');
  });

  it('clears sidebar and typed filters together and restores the entire filter set', () => {
    useDashboardViewStore.setState({
      tagFilter: ['phase-3'],
      textFilter: 'priority:high',
    });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));

    expect(useDashboardViewStore.getState().tagFilter).toEqual([]);
    expect(useDashboardViewStore.getState().textFilter).toBe('');

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().tagFilter).toEqual(['phase-3']);
    expect(useDashboardViewStore.getState().textFilter).toBe('priority:high');
  });

  it('removes the last sidebar pill with Backspace and labels quick filters accurately', () => {
    useDashboardViewStore.setState({
      sourceFilter: 'github-issues',
      quickFilter: 'assigned',
    });

    render(<TaskKeywordFilter {...defaultProps} />);

    expect(screen.getByText('quick:Assigned to Me')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });

    expect(useDashboardViewStore.getState().quickFilter).toBeNull();
    expect(useDashboardViewStore.getState().sourceFilter).toBe('github-issues');
  });

  it('restores a removed query token', () => {
    useDashboardViewStore.setState({ textFilter: 'priority:high status:todo' });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority:high filter' }));

    expect(useDashboardViewStore.getState().textFilter).toBe('status:todo');

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().textFilter).toBe('priority:high status:todo');
  });

  it('offers undo when the builder deselects an active token', () => {
    useDashboardViewStore.setState({ textFilter: 'priority:high' });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('button', { name: /P1 High/ }));

    expect(useDashboardViewStore.getState().textFilter).toBe('');

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().textFilter).toBe('priority:high');
  });

  it('preserves a pending text query when removing a sidebar filter', () => {
    useDashboardViewStore.setState({ sourceFilter: 'github-issues' });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'waiting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove source:github-issues filter' }));

    expect(useDashboardViewStore.getState().sourceFilter).toBeNull();
    expect(useDashboardViewStore.getState().textFilter).toBe('waiting');

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().sourceFilter).toBe('github-issues');
    expect(useDashboardViewStore.getState().textFilter).toBe('waiting');
  });

  it('clears only the text search and hides its clear button while editing', () => {
    useDashboardViewStore.setState({
      sourceFilter: 'github-issues',
      textFilter: 'priority:high 1257',
    });

    render(<TaskKeywordFilter {...defaultProps} />);

    const input = screen.getByRole('textbox');
    const clearSearch = screen.getByRole('button', { name: 'Clear text search' });
    expect(input).toHaveStyle({ width: 'calc(4ch + 4px)' });

    fireEvent.focus(input);
    expect(clearSearch).toHaveClass('opacity-0', 'pointer-events-none');

    fireEvent.blur(input);
    expect(clearSearch).not.toHaveClass('opacity-0', 'pointer-events-none');

    fireEvent.click(clearSearch);

    expect(useDashboardViewStore.getState().sourceFilter).toBe('github-issues');
    expect(useDashboardViewStore.getState().textFilter).toBe('priority:high');
    expect(input).toHaveValue('');

    undoLastFilterChange();

    expect(useDashboardViewStore.getState().textFilter).toBe('priority:high 1257');
  });

  it('invalidates undo after a subsequent filter change', () => {
    useDashboardViewStore.setState({ textFilter: 'priority:high status:todo' });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority:high filter' }));

    act(() => useDashboardViewStore.getState().setTagFilter(['new-filter']));

    expect(toast.dismiss).toHaveBeenCalledWith('filter-undo');
    undoLastFilterChange();

    expect(useDashboardViewStore.getState().textFilter).toBe('status:todo');
    expect(useDashboardViewStore.getState().tagFilter).toEqual(['new-filter']);
  });

  it('invalidates undo before a pending text edit reaches the store', () => {
    vi.useFakeTimers();
    useDashboardViewStore.setState({ textFilter: 'priority:high' });

    render(<TaskKeywordFilter {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority:high filter' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'waiting' } });

    expect(toast.dismiss).toHaveBeenCalledWith('filter-undo');
    undoLastFilterChange();
    act(() => vi.advanceTimersByTime(200));
    expect(useDashboardViewStore.getState().textFilter).toBe('waiting');
    expect(useDashboardViewStore.getState().textFilter).toBe('waiting');
  });
});

function undoLastFilterChange() {
  const options = vi.mocked(toast).mock.calls.at(-1)?.[1] as
    | { action?: { label: string; onClick: () => void } }
    | undefined;

  expect(options?.action?.label).toBe('Undo');
  act(() => options?.action?.onClick());
}
