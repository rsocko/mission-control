/**
 * Component Tests - RecentWins widget
 * Tests #100
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { TooltipProvider } from '@/components/ui/Tooltip';

// ─── Mocks ──────────────────────────────────────────────────────────────────

type MockDivProps = React.ComponentPropsWithoutRef<'div'>;
type MockSpanProps = React.ComponentPropsWithoutRef<'span'>;
type MockButtonProps = React.ComponentPropsWithoutRef<'button'>;

const MockMotionDiv = React.forwardRef<HTMLDivElement, MockDivProps>(
  ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
);
MockMotionDiv.displayName = 'MockMotionDiv';

const MockMotionButton = React.forwardRef<HTMLButtonElement, MockButtonProps>(
  ({ children, ...props }, ref) => <button ref={ref} {...props}>{children}</button>
);
MockMotionButton.displayName = 'MockMotionButton';

const MockMotionSpan = React.forwardRef<HTMLSpanElement, MockSpanProps>(
  ({ children, ...props }, ref) => <span ref={ref} {...props}>{children}</span>
);
MockMotionSpan.displayName = 'MockMotionSpan';

function MockAnimatePresence({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

vi.mock('motion/react', () => ({
  motion: {
    div: MockMotionDiv,
    button: MockMotionButton,
    span: MockMotionSpan,
  },
  AnimatePresence: MockAnimatePresence,
}));

vi.mock('lucide-react', () => ({
  Trophy: () => <span data-testid="icon-trophy">🏆</span>,
  Check: () => <span data-testid="icon-check">✓</span>,
  X: () => <span data-testid="icon-x">×</span>,
  ChevronDown: () => <span data-testid="icon-chevron">v</span>,
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
  Flame: () => <span data-testid="icon-flame">🔥</span>,
  Settings: () => <span data-testid="icon-settings">⚙</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  Trash2: () => <span data-testid="icon-trash">🗑</span>,
}));

vi.mock('@/lib/motion', () => ({
  staggerContainer: {},
  fadeSlideUp: {},
  dropdownVariants: {},
}));

// ─── Fetch mock ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockWinsResponse(data: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function renderRecentWins(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RecentWins component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading skeleton initially', async () => {
    // Never resolve fetch so it stays loading
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { RecentWins } = await import('@/components/RecentWins');
    const { container } = renderRecentWins(<RecentWins />);
    // Should render the pulse skeleton
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders nothing when totalCount is 0', async () => {
    mockWinsResponse({ totalCount: 0, items: [], groups: [] });

    const { RecentWins } = await import('@/components/RecentWins');
    const { container } = renderRecentWins(<RecentWins />);

    await waitFor(() => {
      // Once loaded with 0 count, component returns null
      expect(container.querySelector('.animate-pulse')).toBeNull();
    });
    expect(screen.queryByText('Recent Wins')).toBeNull();
  });

  it('renders nothing when snoozed', async () => {
    mockWinsResponse({ totalCount: 5, items: [], groups: [], snoozed: true });

    const { RecentWins } = await import('@/components/RecentWins');
    const { container } = renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(container.querySelector('.animate-pulse')).toBeNull();
    });
    expect(screen.queryByText('Recent Wins')).toBeNull();
  });

  it('renders win pills and total count', async () => {
    mockWinsResponse({
      totalCount: 3,
      items: [
        { id: 'w1', title: 'Ship feature', priority: 'high', connectorType: 'todoist', sourceListName: 'Work', badge: null, score: 35 },
        { id: 'w2', title: 'Fix auth bug', priority: 'critical', connectorType: 'todoist', sourceListName: 'Work', badge: 'overdue cleared', score: 80 },
      ],
      groups: [{ connectorType: 'todoist', listName: 'Work', count: 3 }],
    });

    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(screen.getByText('Recent Wins')).toBeInTheDocument();
    });

    expect(screen.getByText('3 completed this week')).toBeInTheDocument();
    expect(screen.getByText('Ship feature')).toBeInTheDocument();
    expect(screen.getByText('Fix auth bug')).toBeInTheDocument();
  });

  it('calls onTaskClick when a win pill is clicked', async () => {
    mockWinsResponse({
      totalCount: 1,
      items: [
        { id: 'w1', title: 'Ship it', priority: 'high', connectorType: 'todoist', sourceListName: 'Work', badge: null, score: 35 },
      ],
      groups: [],
    });

    const onTaskClick = vi.fn();
    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins onTaskClick={onTaskClick} />);

    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Ship it'));
    expect(onTaskClick).toHaveBeenCalledWith('w1');
  });

  it('hides widget on hide-session dismiss', async () => {
    mockWinsResponse({
      totalCount: 2,
      items: [
        { id: 'w1', title: 'Task A', priority: 'medium', connectorType: 'todoist', sourceListName: 'Work', badge: null, score: 15 },
      ],
      groups: [],
    });

    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(screen.getByText('Recent Wins')).toBeInTheDocument();
    });

    // Click the X (hide) button
    const hideButton = screen.getByLabelText('Hide recent wins');
    fireEvent.click(hideButton);

    await waitFor(() => {
      expect(screen.queryByText('Recent Wins')).toBeNull();
    });
  });

  it('renders "+N more" when there are more items than displayed', async () => {
    // Items with low scores so only one shows
    mockWinsResponse({
      totalCount: 10,
      items: [
        { id: 'w1', title: 'Only one', priority: 'none', connectorType: 'todoist', sourceListName: 'Work', badge: null, score: 0 },
      ],
      groups: [],
    });

    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(screen.getByText('Recent Wins')).toBeInTheDocument();
    });

    expect(screen.getByText('+9 more')).toBeInTheDocument();
  });

  it('renders badge icons for overdue-cleared wins', async () => {
    mockWinsResponse({
      totalCount: 1,
      items: [
        { id: 'w1', title: 'Overdue task', priority: 'high', connectorType: 'todoist', sourceListName: 'Work', badge: 'overdue cleared', score: 65 },
      ],
      groups: [],
    });

    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(screen.getByText('Overdue task')).toBeInTheDocument();
    });

    // The flame icon should appear for overdue cleared badge
    expect(screen.getByTestId('icon-flame')).toBeInTheDocument();
  });

  it('opens settings panel on settings button click', async () => {
    mockWinsResponse({
      totalCount: 1,
      items: [
        { id: 'w1', title: 'Task', priority: 'medium', connectorType: 'todoist', sourceListName: 'Work', badge: null, score: 15 },
      ],
      groups: [],
    });
    // Settings fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ deprioritizedLists: ['Groceries'] }),
    });

    const { RecentWins } = await import('@/components/RecentWins');
    renderRecentWins(<RecentWins />);

    await waitFor(() => {
      expect(screen.getByText('Recent Wins')).toBeInTheDocument();
    });

    const settingsButton = screen.getByLabelText('Recent wins settings');
    fireEvent.click(settingsButton);

    await waitFor(() => {
      expect(screen.getByText('Deprioritized Lists')).toBeInTheDocument();
    });
  });
});
