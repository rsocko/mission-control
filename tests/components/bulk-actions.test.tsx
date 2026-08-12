/**
 * Bulk Actions Component Tests
 * Tests for shared bulk action components (issue #127)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  Search: () => <span data-testid="icon-search">S</span>,
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  Tag: () => <span data-testid="icon-tag">T</span>,
  X: () => <span data-testid="icon-x">×</span>,
}));

// Mock date-picker
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ onChange }: { onChange: (v: string) => void; value: string | null; variant?: string; placeholder?: string }) => (
    <input data-testid="date-picker" onChange={(e) => onChange(e.target.value)} />
  ),
}));

// Mock client-date utils
vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-07-18',
  getLocalTomorrow: () => '2026-07-19',
}));

// ─── BulkActionBar ─────────────────────────────────────────────────────

describe('BulkActionBar', () => {
  let BulkActionBar: React.ComponentType<{
    selectedCount: number;
    onCancel: () => void;
    children: React.ReactNode;
  }>;

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/BulkActionBar');
    BulkActionBar = mod.BulkActionBar;
  });

  it('renders toolbar with cancel but hides actions when selectedCount is 0', () => {
    render(
      <BulkActionBar selectedCount={0} onCancel={vi.fn()}>
        <button>Action</button>
      </BulkActionBar>,
    );
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.queryByText('Action')).not.toBeInTheDocument();
  });

  it('renders count and children when selectedCount > 0', () => {
    render(
      <BulkActionBar selectedCount={3} onCancel={vi.fn()}>
        <button>Delete</button>
      </BulkActionBar>,
    );
    expect(screen.getByText('3 selected')).toBeDefined();
    expect(screen.getByText('Delete')).toBeDefined();
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <BulkActionBar selectedCount={2} onCancel={onCancel}>
        <button>Action</button>
      </BulkActionBar>,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('has the correct role for accessibility', () => {
    render(
      <BulkActionBar selectedCount={1} onCancel={vi.fn()}>
        <button>Action</button>
      </BulkActionBar>,
    );
    expect(screen.getByRole('toolbar')).toBeDefined();
  });
});

// ─── BulkPriorityDropdown ───────────────────────────────────────────────

describe('BulkPriorityDropdown', () => {
  let BulkPriorityDropdown: React.ComponentType<{
    onSetPriority: (priority: string) => Promise<void>;
  }>;

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/BulkPriorityDropdown');
    BulkPriorityDropdown = mod.BulkPriorityDropdown;
  });

  it('renders button with label', () => {
    render(<BulkPriorityDropdown onSetPriority={vi.fn()} />);
    expect(screen.getByText('⚑ Priority')).toBeDefined();
  });

  it('shows priority options when clicked', () => {
    render(<BulkPriorityDropdown onSetPriority={vi.fn()} />);
    fireEvent.click(screen.getByText('⚑ Priority'));
    expect(screen.getByText('Critical')).toBeDefined();
    expect(screen.getByText('High')).toBeDefined();
    expect(screen.getByText('Medium')).toBeDefined();
    expect(screen.getByText('Low')).toBeDefined();
    expect(screen.getByText('None')).toBeDefined();
  });

  it('calls onSetPriority with selected value', async () => {
    const onSetPriority = vi.fn().mockResolvedValue(undefined);
    render(<BulkPriorityDropdown onSetPriority={onSetPriority} />);
    fireEvent.click(screen.getByText('⚑ Priority'));
    await act(async () => {
      fireEvent.click(screen.getByText('High'));
    });
    expect(onSetPriority).toHaveBeenCalledWith('high');
  });

  it('toggles dropdown open/closed', () => {
    render(<BulkPriorityDropdown onSetPriority={vi.fn()} />);
    // Open
    fireEvent.click(screen.getByText('⚑ Priority'));
    expect(screen.getByRole('listbox')).toBeDefined();
    // Close
    fireEvent.click(screen.getByText('⚑ Priority'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// ─── BulkStatusDropdown ─────────────────────────────────────────────────

describe('BulkStatusDropdown', () => {
  let BulkStatusDropdown: React.ComponentType<{
    onSetStatus: (status: string) => Promise<void>;
  }>;

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/BulkStatusDropdown');
    BulkStatusDropdown = mod.BulkStatusDropdown;
  });

  it('renders button with label', () => {
    render(<BulkStatusDropdown onSetStatus={vi.fn()} />);
    expect(screen.getByText('◉ Status')).toBeDefined();
  });

  it('shows status options when clicked', () => {
    render(<BulkStatusDropdown onSetStatus={vi.fn()} />);
    fireEvent.click(screen.getByText('◉ Status'));
    expect(screen.getByText('To do')).toBeDefined();
    expect(screen.getByText('In progress')).toBeDefined();
    expect(screen.getByText('Done')).toBeDefined();
    expect(screen.getByText('Cancelled')).toBeDefined();
  });

  it('calls onSetStatus with selected value', async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(<BulkStatusDropdown onSetStatus={onSetStatus} />);
    fireEvent.click(screen.getByText('◉ Status'));
    await act(async () => {
      fireEvent.click(screen.getByText('In progress'));
    });
    expect(onSetStatus).toHaveBeenCalledWith('in_progress');
  });

  it('toggles dropdown open/closed', () => {
    render(<BulkStatusDropdown onSetStatus={vi.fn()} />);
    fireEvent.click(screen.getByText('◉ Status'));
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.click(screen.getByText('◉ Status'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// ─── BulkDueDateDropdown ────────────────────────────────────────────────

describe('BulkDueDateDropdown', () => {
  let BulkDueDateDropdown: React.ComponentType<{
    onSetDate: (date: string) => Promise<void>;
  }>;

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/BulkDueDateDropdown');
    BulkDueDateDropdown = mod.BulkDueDateDropdown;
  });

  it('renders button with label', () => {
    render(<BulkDueDateDropdown onSetDate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Due date/ })).toBeDefined();
  });

  it('shows date options when clicked', () => {
    render(<BulkDueDateDropdown onSetDate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Due date/ }));
    expect(screen.getByText('Due today')).toBeDefined();
    expect(screen.getByText('Due tomorrow')).toBeDefined();
    expect(screen.getByText('Pick a date…')).toBeDefined();
    expect(screen.getByText('Clear due date')).toBeDefined();
  });

  it('calls onSetDate with today when "Due today" is clicked', async () => {
    const onSetDate = vi.fn().mockResolvedValue(undefined);
    render(<BulkDueDateDropdown onSetDate={onSetDate} />);
    fireEvent.click(screen.getByRole('button', { name: /Due date/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Due today'));
    });
    expect(onSetDate).toHaveBeenCalledWith('2026-07-18');
  });

  it('calls onSetDate with empty string when "Clear due date" is clicked', async () => {
    const onSetDate = vi.fn().mockResolvedValue(undefined);
    render(<BulkDueDateDropdown onSetDate={onSetDate} />);
    fireEvent.click(screen.getByRole('button', { name: /Due date/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('Clear due date'));
    });
    expect(onSetDate).toHaveBeenCalledWith('');
  });
});

// ─── BulkTagDropdown ────────────────────────────────────────────────────

describe('BulkTagDropdown', () => {
  let BulkTagDropdown: React.ComponentType<{
    availableTags: Array<{ id: string; name: string; slug: string; color: string | null }>;
    onAddTag: (tagId: string) => Promise<void>;
  }>;

  const tags = [
    { id: 't1', name: 'Bug', slug: 'bug', color: '#ef4444' },
    { id: 't2', name: 'Feature', slug: 'feature', color: '#3b82f6' },
    { id: 't3', name: 'Docs', slug: 'docs', color: null },
  ];

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/BulkTagDropdown');
    BulkTagDropdown = mod.BulkTagDropdown;
  });

  it('renders button with label', () => {
    render(<BulkTagDropdown availableTags={tags} onAddTag={vi.fn()} />);
    expect(screen.getByText('Tag')).toBeDefined();
  });

  it('shows all tags when clicked', () => {
    render(<BulkTagDropdown availableTags={tags} onAddTag={vi.fn()} />);
    fireEvent.click(screen.getByText('Tag'));
    expect(screen.getByText('Bug')).toBeDefined();
    expect(screen.getByText('Feature')).toBeDefined();
    expect(screen.getByText('Docs')).toBeDefined();
  });

  it('filters tags by search input', () => {
    render(<BulkTagDropdown availableTags={tags} onAddTag={vi.fn()} />);
    fireEvent.click(screen.getByText('Tag'));
    const searchInput = screen.getByPlaceholderText('Search tags…');
    fireEvent.change(searchInput, { target: { value: 'bug' } });
    expect(screen.getByText('Bug')).toBeDefined();
    expect(screen.queryByText('Feature')).toBeNull();
  });

  it('calls onAddTag when a tag is selected', async () => {
    const onAddTag = vi.fn().mockResolvedValue(undefined);
    render(<BulkTagDropdown availableTags={tags} onAddTag={onAddTag} />);
    fireEvent.click(screen.getByText('Tag'));
    await act(async () => {
      fireEvent.click(screen.getByText('Feature'));
    });
    expect(onAddTag).toHaveBeenCalledWith('t2');
  });

  it('shows empty state when search yields no results', () => {
    render(<BulkTagDropdown availableTags={tags} onAddTag={vi.fn()} />);
    fireEvent.click(screen.getByText('Tag'));
    const searchInput = screen.getByPlaceholderText('Search tags…');
    fireEvent.change(searchInput, { target: { value: 'zzz' } });
    expect(screen.getByText('No tags found')).toBeDefined();
  });
});

// ─── BulkMoveDropdown ───────────────────────────────────────────────────

describe('BulkMoveDropdown', () => {
  let BulkMoveDropdown: React.ComponentType<{
    sourceLists: Array<{ id: string; sourceId: string; name: string }>;
    onMove: (targetListId: string) => Promise<void>;
  }>;

  const lists = [
    { id: 'l1', sourceId: 's1', name: 'Backlog' },
    { id: 'l2', sourceId: 's2', name: 'Sprint 1' },
    { id: 'l3', sourceId: 's3', name: 'Inbox' },
  ];

  beforeEach(async () => {
    localStorage.clear();
    const mod = await import('@/components/bulk-actions/BulkMoveDropdown');
    BulkMoveDropdown = mod.BulkMoveDropdown;
  });

  it('renders button with label', () => {
    render(<BulkMoveDropdown sourceLists={lists} onMove={vi.fn()} />);
    expect(screen.getByText('Move to list')).toBeDefined();
  });

  it('shows all lists when clicked', () => {
    render(<BulkMoveDropdown sourceLists={lists} onMove={vi.fn()} />);
    fireEvent.click(screen.getByText('Move to list'));
    expect(screen.getByText('Backlog')).toBeDefined();
    expect(screen.getByText('Sprint 1')).toBeDefined();
    expect(screen.getByText('Inbox')).toBeDefined();
  });

  it('filters lists by search', () => {
    render(<BulkMoveDropdown sourceLists={lists} onMove={vi.fn()} />);
    fireEvent.click(screen.getByText('Move to list'));
    const searchInput = screen.getByPlaceholderText('Search lists…');
    fireEvent.change(searchInput, { target: { value: 'sprint' } });
    expect(screen.getByText('Sprint 1')).toBeDefined();
    expect(screen.queryByText('Backlog')).toBeNull();
  });

  it('calls onMove when a list is selected', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    render(<BulkMoveDropdown sourceLists={lists} onMove={onMove} />);
    fireEvent.click(screen.getByText('Move to list'));
    await act(async () => {
      fireEvent.click(screen.getByText('Sprint 1'));
    });
    expect(onMove).toHaveBeenCalledWith('l2');
  });
});

// ─── useBulkSelection ───────────────────────────────────────────────────

describe('useBulkSelection', () => {
  let useBulkSelection: () => ReturnType<typeof import('@/components/bulk-actions/useBulkSelection').useBulkSelection>;
  let resolveSelectionAnchorIndex: typeof import('@/components/bulk-actions/useBulkSelection').resolveSelectionAnchorIndex;
  let result: ReturnType<typeof useBulkSelection>;

  function TestComponent() {
    result = useBulkSelection();
    return null;
  }

  beforeEach(async () => {
    const mod = await import('@/components/bulk-actions/useBulkSelection');
    useBulkSelection = mod.useBulkSelection;
    resolveSelectionAnchorIndex = mod.resolveSelectionAnchorIndex;
  });

  it('starts with empty selection and bulkMode off', () => {
    render(<TestComponent />);
    expect(result.bulkMode).toBe(false);
    expect(result.bulkSelected.size).toBe(0);
  });

  it('toggleItem adds and removes items', () => {
    render(<TestComponent />);
    act(() => result.toggleItem('a'));
    expect(result.bulkSelected.has('a')).toBe(true);
    act(() => result.toggleItem('a'));
    expect(result.bulkSelected.has('a')).toBe(false);
  });

  it('selectRange selects a range of ids', () => {
    render(<TestComponent />);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    act(() => result.selectRange(ids, 1, 3));
    expect(result.bulkSelected.has('b')).toBe(true);
    expect(result.bulkSelected.has('c')).toBe(true);
    expect(result.bulkSelected.has('d')).toBe(true);
    expect(result.bulkSelected.has('a')).toBe(false);
    expect(result.bulkSelected.has('e')).toBe(false);
  });

  it('uses the selected item as the first shift-click range anchor', () => {
    expect(resolveSelectionAnchorIndex(['a', 'b', 'c', 'd'], null, 'a')).toBe(0);
  });

  it('keeps the last bulk click as the range anchor', () => {
    expect(resolveSelectionAnchorIndex(['a', 'b', 'c', 'd'], 2, 'a')).toBe(2);
  });

  it('falls back to the selected item when the previous index is stale', () => {
    expect(resolveSelectionAnchorIndex(['a', 'b', 'c', 'd'], 8, 'b')).toBe(1);
  });

  it('clearSelection resets everything', () => {
    render(<TestComponent />);
    act(() => {
      result.enterBulkMode();
      result.toggleItem('x');
    });
    expect(result.bulkMode).toBe(true);
    expect(result.bulkSelected.size).toBe(1);
    act(() => result.clearSelection());
    expect(result.bulkMode).toBe(false);
    expect(result.bulkSelected.size).toBe(0);
  });

  it('enterBulkMode sets bulkMode to true', () => {
    render(<TestComponent />);
    act(() => result.enterBulkMode());
    expect(result.bulkMode).toBe(true);
  });
});

// ─── executeBulkOperation ─────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { executeBulkOperation } from '@/components/bulk-actions/executeBulkOperation';
import { toast } from 'sonner';

describe('executeBulkOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports all successes', async () => {
    const op = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeBulkOperation(['a', 'b'], op, 'Done!');
    expect(result.succeeded).toEqual(['a', 'b']);
    expect(result.failed).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith('Done!');
  });

  it('reports partial failures', async () => {
    const op = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    const result = await executeBulkOperation(['a', 'b'], op, 'Done!');
    expect(result.succeeded).toEqual(['a']);
    expect(result.failed).toEqual(['b']);
    expect(toast.warning).toHaveBeenCalledWith('1 succeeded, 1 failed');
  });

  it('reports all failures', async () => {
    const op = vi.fn().mockRejectedValue(new Error('network'));
    const result = await executeBulkOperation(['a', 'b'], op, 'Done!');
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual(['a', 'b']);
    expect(toast.error).toHaveBeenCalledWith('All 2 operations failed');
  });

  it('treats void return as success', async () => {
    const op = vi.fn().mockResolvedValue(undefined);
    const result = await executeBulkOperation(['a'], op, 'Done!');
    expect(result.succeeded).toEqual(['a']);
    expect(result.failed).toEqual([]);
  });
});
