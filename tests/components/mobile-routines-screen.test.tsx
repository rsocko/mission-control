import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MobileRoutinesScreen } from '@/components/mobile/MobileRoutinesScreen';

// Mock motion/react
vi.mock('motion/react', async () => {
  const React = await import('react');

  const MockMotionDiv = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'> & {
    whileTap?: unknown;
    variants?: unknown;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  }>(({ children, whileTap, variants, initial, animate, exit, transition, ...props }, ref) => (
    <div ref={ref} {...props}>{children}</div>
  ));
  MockMotionDiv.displayName = 'MockMotionDiv';

  const MockMotionButton = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'> & {
    whileTap?: unknown;
    variants?: unknown;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  }>(({ children, whileTap, variants, initial, animate, exit, transition, ...props }, ref) => (
    <button ref={ref} {...props}>{children}</button>
  ));
  MockMotionButton.displayName = 'MockMotionButton';

  function MockAnimatePresence({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }

  return {
    motion: { div: MockMotionDiv, section: MockMotionDiv, aside: MockMotionDiv, button: MockMotionButton },
    AnimatePresence: MockAnimatePresence,
    useReducedMotion: () => false,
  };
});

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  CalendarDays: () => <span data-testid="icon-calendar-days">🗓</span>,
  Check: () => <span data-testid="icon-check">✓</span>,
  Flame: () => <span data-testid="icon-flame">🔥</span>,
  Loader2: () => <span data-testid="icon-loader">⏳</span>,
  Moon: () => <span data-testid="icon-moon">🌙</span>,
  Plus: () => <span data-testid="icon-plus">＋</span>,
  Repeat: () => <span data-testid="icon-repeat">↻</span>,
  Sun: () => <span data-testid="icon-sun">☀️</span>,
}));

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('@/lib/motion', () => ({ fadeSlideUp: {}, staggerContainer: {} }));
vi.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));
vi.mock('@/lib/hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    containerRef: { current: null },
    isRefreshing: false,
    pullDistance: 0,
    containerProps: {},
    contentStyle: {},
  }),
}));
vi.mock('@/components/ui/PullToRefreshIndicator', () => ({
  PullToRefreshIndicator: () => null,
}));
vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-07-29',
}));
vi.mock('@/lib/utils/date-format', () => ({
  formatDateLocal: (date: Date) => date.toISOString().slice(0, 10),
  getWeekMonday: () => '2026-07-27',
  getWeekDates: () => [
    '2026-07-27',
    '2026-07-28',
    '2026-07-29',
    '2026-07-30',
    '2026-07-31',
    '2026-08-01',
    '2026-08-02',
  ],
}));

const mockRoutines = [
  {
    id: 'r1',
    name: 'Morning meditation',
    icon: '🧘',
    cadenceType: 'daily',
    cadenceConfig: {},
    streak: 12,
    weekCompletions: [],
    intervalStatus: null,
    weeklyProgress: null,
  },
  {
    id: 'r2',
    name: 'Read 30 min',
    icon: '📚',
    cadenceType: 'specific_days',
    cadenceConfig: { days: [1, 3, 5] },
    streak: 3,
    weekCompletions: [{ date: '2026-07-28', id: 'c1' }],
    intervalStatus: null,
    weeklyProgress: null,
  },
  {
    id: 'r3',
    name: 'Stretch',
    icon: '🤸',
    cadenceType: 'daily',
    cadenceConfig: {},
    streak: 0,
    weekCompletions: [{ date: '2026-07-29', id: 'c2' }],
    intervalStatus: null,
    weeklyProgress: null,
  },
];

const mockHistory = [
  { id: 'h1', routineId: 'r2', date: '2026-07-28' },
  { id: 'h2', routineId: 'r3', date: '2026-07-29' },
];

const originalFetch = global.fetch;

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function mockRoutineFetch({
  routines = mockRoutines,
  completions = mockHistory,
  completionStatus = 200,
}: {
  routines?: typeof mockRoutines;
  completions?: typeof mockHistory;
  completionStatus?: number;
} = {}) {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url.startsWith('/api/routines?') && method === 'GET') {
      return jsonResponse({ routines });
    }

    if (url.startsWith('/api/routines/completions?') && method === 'GET') {
      return jsonResponse({ completions });
    }

    if (url === '/api/routines/completions' && method === 'POST') {
      return jsonResponse({}, { status: completionStatus });
    }

    if (url.startsWith('/api/routines/completions?') && method === 'DELETE') {
      return jsonResponse({});
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

describe('MobileRoutinesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders loading state initially', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;

    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
  });

  it('renders routines after fetch completes', async () => {
    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Daily Habits')).toBeInTheDocument();
      expect(screen.getByText('Routines')).toBeInTheDocument();
      expect(screen.getAllByText('Morning meditation').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Read 30 min').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Stretch').length).toBeGreaterThan(0);
    });
  });

  it('shows progress and streak details for routines', async () => {
    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Morning meditation').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
    expect(screen.getByText('1 of 1 done')).toBeInTheDocument();
    expect(screen.getByText('12 day streak')).toBeInTheDocument();
  });

  it('shows daily and weekly toggle buttons', async () => {
    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Daily')[0].closest('button')).toBeInTheDocument();
      expect(screen.getAllByText('Weekly')[0].closest('button')).toBeInTheDocument();
    });
  });

  it('toggles view mode when clicking "Weekly"', async () => {
    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Weekly' })).toBeInTheDocument();
    });

    const weeklyButton = screen.getByRole('button', { name: 'Weekly' });
    fireEvent.click(weeklyButton);

    expect(weeklyButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Jul 27 - Aug 2')).toBeInTheDocument();
  });

  it('calls onBack when back button is clicked', async () => {
    const onBack = vi.fn();
    render(<MobileRoutinesScreen onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('quick-complete clicking checkbox calls POST /api/routines/completions', async () => {
    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Morning meditation').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete Morning meditation' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/routines/completions', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routineId: 'r1', date: '2026-07-29' }),
      }));
    });
  });

  it('shows empty state when no routines returned', async () => {
    mockRoutineFetch({ routines: [], completions: [] });

    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Nothing scheduled for today.')).toBeInTheDocument();
    });
  });

  it('shows error toast on failed completion toggle', async () => {
    mockRoutineFetch({ completionStatus: 500 });

    render(<MobileRoutinesScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Morning meditation').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete Morning meditation' }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Could not update routine. Please try again.');
    });
  });
});
