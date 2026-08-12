import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MobileInsightsScreen } from '@/components/mobile/MobileInsightsScreen';

// Mock motion/react
vi.mock('motion/react', async () => {
  const React = await import('react');

  const MockMotionDiv = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'> & {
    variants?: unknown;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  }>(({ children, variants, initial, animate, exit, transition, ...props }, ref) => (
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
  ArrowDown: () => <span data-testid="icon-arrow-down">↓</span>,
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  ArrowUp: () => <span data-testid="icon-arrow-up">↑</span>,
  Brain: () => <span data-testid="icon-brain">🧠</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">💡</span>,
  Loader2: () => <span data-testid="icon-loader">⏳</span>,
  Sparkles: () => <span data-testid="icon-sparkles">✨</span>,
  TrendingDown: () => <span data-testid="icon-trending-down">↓</span>,
  TrendingUp: () => <span data-testid="icon-trending-up">↑</span>,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
vi.mock('@/components/insights/ActivityHeatmap', () => ({
  ActivityHeatmap: ({ compact }: { compact?: boolean }) => (
    <div data-testid="activity-heatmap" data-compact={compact ? 'true' : 'false'} />
  ),
}));
vi.mock('@/lib/stats/insights', () => ({}));

const mockSnapshot = {
  period: 7,
  periodStart: '2026-07-22',
  periodEnd: '2026-07-29',
  kpis: {
    completed: { label: 'Completed', value: 15, previousValue: 12, delta: 25 },
    created: { label: 'Created', value: 8, previousValue: 10, delta: -20 },
    netChange: { label: 'Net', value: 7, delta: 10 },
    avgTaskAge: { label: 'Avg Age', value: 4.2, unit: 'days', delta: -5 },
    streak: { label: 'Streak', value: 5, delta: 0 },
  },
  trends: [
    { date: '2026-07-23', completed: 2, created: 1 },
    { date: '2026-07-24', completed: 3, created: 2 },
    { date: '2026-07-25', completed: 1, created: 0 },
    { date: '2026-07-26', completed: 4, created: 2 },
    { date: '2026-07-27', completed: 2, created: 1 },
    { date: '2026-07-28', completed: 1, created: 1 },
    { date: '2026-07-29', completed: 2, created: 1 },
  ],
  sourceBreakdown: [],
  taskAge: [],
  projectActivity: [],
  routineHeatmap: [],
  activityHeatmap: [
    { date: '2026-07-29', taskCompletions: 2, routineCompletions: 1 },
  ],
};

const mockObservations = {
  observations: [
    {
      type: 'streak',
      title: 'Strong streak!',
      body: 'You have maintained a 5-day streak.',
      sentiment: 'positive',
      confidence: 0.9,
    },
    {
      type: 'recommendation',
      title: 'Review backlog',
      body: 'Some tasks are aging. Consider a weekly review.',
      sentiment: 'warning',
      confidence: 0.8,
    },
  ],
  generatedAt: '2026-07-29T12:00:00Z',
};

const originalFetch = global.fetch;

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function mockInsightsFetch(observations = mockObservations) {
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const period = Number(new URL(url, 'http://localhost').searchParams.get('period') ?? '7');

    if (url.includes('/api/insights/observations')) {
      return jsonResponse(observations);
    }

    if (url.includes('/api/insights')) {
      return jsonResponse({ ...mockSnapshot, period });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe('MobileInsightsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsightsFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders loading state initially', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;

    const { container } = render(<MobileInsightsScreen onBack={vi.fn()} />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders headline stat and KPI grid after fetch completes', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Analytics')).toBeInTheDocument();
      expect(screen.getByText('Insights')).toBeInTheDocument();
      expect(screen.getByText('15')).toBeInTheDocument();
      expect(screen.getByText('tasks completed this week')).toBeInTheDocument();
      expect(screen.getByText('Tasks created')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
      expect(screen.getByTestId('activity-heatmap')).toHaveAttribute('data-compact', 'true');
    });
  });

  it('shows period toggle (Week, Month, Quarter)', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Week' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Quarter' })).toBeInTheDocument();
    });
  });

  it('shows trend chart section', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Productivity by Day')).toBeInTheDocument();
    });
  });

  it('shows AI observations section with observation cards', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('AI Observations')).toBeInTheDocument();
      expect(screen.getByText('Strong streak!')).toBeInTheDocument();
      expect(screen.getByText('You have maintained a 5-day streak.')).toBeInTheDocument();
    });
  });

  it('shows recommendations section', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Recommendations')).toBeInTheDocument();
      expect(screen.getAllByText('Some tasks are aging. Consider a weekly review.').length).toBeGreaterThan(0);
    });
  });

  it('calls onBack when back button clicked', async () => {
    const onBack = vi.fn();
    render(<MobileInsightsScreen onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('switches period when period pill clicked (refetches)', async () => {
    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('tasks completed this week')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/insights?period=30', { cache: 'no-store' });
      expect(global.fetch).toHaveBeenCalledWith('/api/insights/observations?period=30', { cache: 'no-store' });
    });
  });

  it('shows empty/fallback state when no observations', async () => {
    mockInsightsFetch({ observations: [], generatedAt: '2026-07-29T12:00:00Z' });

    render(<MobileInsightsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('AI Observations')).toBeInTheDocument();
      expect(screen.getByText('No observations yet - complete more work to unlock AI insights.')).toBeInTheDocument();
    });
  });
});
