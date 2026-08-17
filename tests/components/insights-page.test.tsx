import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

const { replaceSpy, setSearchParams, getSearchParams } = vi.hoisted(() => {
  let searchParams = '';
  return {
    replaceSpy: vi.fn(),
    setSearchParams: (value: string) => { searchParams = value; },
    getSearchParams: () => searchParams,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/insights',
  useSearchParams: () => new URLSearchParams(getSearchParams()),
}));

type MockDivProps = React.ComponentPropsWithoutRef<'div'>;
const MockMotionDiv = React.forwardRef<HTMLDivElement, MockDivProps>(({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>);
MockMotionDiv.displayName = 'MockMotionDiv';

vi.mock('motion/react', () => ({
  motion: {
    div: MockMotionDiv,
    section: MockMotionDiv,
  },
}));

vi.mock('lucide-react', () => ({
  ArrowDown: () => <span>↓</span>,
  ArrowUp: () => <span>↑</span>,
  Check: () => <span>check</span>,
  ChevronDown: () => <span>down</span>,
  ChevronUp: () => <span>up</span>,
  Flame: () => <span>🔥</span>,
  Lightbulb: () => <span>💡</span>,
}));

vi.mock('@/components/insights/CompletionTrendChart', () => ({
  CompletionTrendChart: () => <div data-testid="completion-trend-chart" />,
}));
vi.mock('@/components/insights/SourceBreakdownChart', () => ({
  SourceBreakdownChart: () => <div data-testid="source-breakdown-chart" />,
}));
vi.mock('@/components/insights/TaskAgeChart', () => ({
  TaskAgeChart: () => <div data-testid="task-age-chart" />,
}));
vi.mock('@/components/insights/RoutineHeatmap', () => ({
  RoutineHeatmap: () => <div data-testid="routine-heatmap" />,
}));
vi.mock('@/components/insights/ProjectActivity', () => ({
  ProjectActivity: () => <div data-testid="project-activity" />,
}));
vi.mock('@/components/insights/DeliveryTrendChart', () => ({
  DeliveryTrendChart: () => <div data-testid="delivery-trend-chart" />,
}));
vi.mock('@/components/insights/LeadTimeChart', () => ({
  LeadTimeChart: () => <div data-testid="lead-time-chart" />,
}));
vi.mock('@/components/insights/ActivityHeatmap', () => ({
  ActivityHeatmap: () => <div data-testid="activity-heatmap" />,
}));
vi.mock('@/components/insights/FlowInsightsSection', () => ({
  FlowInsightsSection: () => <section aria-label="Flow reports">Flow reports</section>,
}));

vi.mock('@/components/ui/AnimatedCounter', () => ({
  AnimatedCounter: ({ value, className }: { value: number; className?: string }) => (
    <span className={className}>{value}</span>
  ),
}));

const insightsPayload = {
  period: 7,
  periodStart: '2026-07-20',
  periodEnd: '2026-07-27',
  kpis: {
    completed: { value: 4, delta: 0 },
    created: { value: 5, delta: 0 },
    netChange: { value: 1, delta: 0 },
    avgTaskAge: { value: 3, delta: 0 },
    streak: { value: 2, delta: 0 },
  },
  trends: [],
  sourceBreakdown: [],
  taskAge: [],
  projectActivity: [],
  routineHeatmap: [],
  delivery: {
    throughput: {
      interval: 'week',
      total: 0,
      averagePerInterval: 0,
      points: [],
    },
    velocity: {
      interval: 'week',
      measure: 'tasks',
      rollingWindow: 3,
      points: [],
    },
    leadTime: {
      summary: { count: 0, averageDays: null, medianDays: null, p85Days: null, p95Days: null },
      distribution: [],
      trend: [],
      outliers: [],
    },
    excluded: { nonCompletionClosures: 0, invalidTimestamps: 0 },
  },
  deliveryFilters: {
    interval: 'week',
    projectId: null,
    source: null,
    timeZone: 'UTC',
    projects: [{ value: 'project-1', label: 'Project One' }],
    sources: [{ value: '', label: 'Unknown' }, { value: 'github', label: 'GitHub' }],
  },
  deliverySemantics: {
    completion: 'Final completion.',
    intervals: 'Calendar weeks start Monday.',
    leadTime: 'Creation to completion.',
    exclusions: 'Cancellations excluded.',
    unsupportedMeasures: 'Count only.',
  },
  activityHeatmap: [
    { date: '2026-07-27', taskCompletions: 4, routineCompletions: 2 },
  ],
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setSearchParams('');
  replaceSpy.mockReset();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/insights/observations')) {
      return new Response(JSON.stringify({ observations: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const requestedPeriod = Number(new URL(url, 'http://localhost').searchParams.get('period') ?? '7');
    return new Response(JSON.stringify({ ...insightsPayload, period: requestedPeriod }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function latestInsightsRequest(): URL {
  const call = [...fetchSpy.mock.calls]
    .reverse()
    .find(([input]) => (
      typeof input === 'string'
      && input.startsWith('/api/insights?')
      && input.includes('section=delivery')
    ));
  if (!call || typeof call[0] !== 'string') throw new Error('No insights request found');
  return new URL(call[0], 'http://localhost');
}

function insightsRequestForSection(section: string): URL {
  const call = fetchSpy.mock.calls.find(([input]) => (
    typeof input === 'string'
    && input.startsWith('/api/insights?')
    && input.includes(`section=${section}`)
  ));
  if (!call || typeof call[0] !== 'string') throw new Error(`No ${section} insights request found`);
  return new URL(call[0], 'http://localhost');
}

describe('InsightsPage', () => {
  it('replaces each group skeleton as that group finishes loading', async () => {
    let resolveSummary!: (response: Response) => void;
    const summaryResponse = new Promise<Response>(resolve => {
      resolveSummary = resolve;
    });
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      if (url.pathname === '/api/insights/observations') {
        return new Response(JSON.stringify({ observations: [] }), { status: 200 });
      }
      if (url.searchParams.get('section') === 'summary') return summaryResponse;
      return new Response(JSON.stringify(insightsPayload), { status: 200 });
    });

    const mod = await import('@/app/insights/page');
    render(<mod.default />);

    expect(screen.getByRole('status', { name: 'Loading summary insights' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Delivery')).toBeInTheDocument());

    await act(async () => {
      resolveSummary(new Response(JSON.stringify(insightsPayload), { status: 200 }));
      await summaryResponse;
    });

    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Loading summary insights' })).not.toBeInTheDocument();
      expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    });
  });

  it('defaults to a 7-day period', async () => {
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    });
    expect(latestInsightsRequest().searchParams.get('period')).toBe('7');
    expect(latestInsightsRequest().searchParams.get('interval')).toBe('week');
    expect(fetchSpy).toHaveBeenCalledWith('/api/insights/observations?period=7');
    expect(screen.getByTestId('activity-heatmap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('requests routine activity in the browser timezone', async () => {
    const mod = await import('@/app/insights/page');
    render(<mod.default />);

    await waitFor(() => {
      expect(screen.getByTestId('routine-heatmap')).toBeInTheDocument();
    });

    expect(insightsRequestForSection('activity').searchParams.get('timezone')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    );
  });

  it('reads initial period from the route query', async () => {
    setSearchParams('period=30');
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    });
    expect(latestInsightsRequest().searchParams.get('period')).toBe('30');
    expect(fetchSpy).toHaveBeenCalledWith('/api/insights/observations?period=30');
  });

  it('updates the URL when selecting a different period', async () => {
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    });

    expect(replaceSpy).toHaveBeenCalledWith('/insights?period=90', { scroll: false });
  });

  it('loads delivery filters from the URL and preserves them when one changes', async () => {
    setSearchParams('period=30&interval=month&project=project-1&source=github');
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });

    await waitFor(() => expect(screen.getByText('Delivery')).toBeInTheDocument());
    const request = latestInsightsRequest();
    expect(request.searchParams.get('period')).toBe('30');
    expect(request.searchParams.get('interval')).toBe('month');
    expect(request.searchParams.get('project')).toBe('project-1');
    expect(request.searchParams.get('source')).toBe('github');

    fireEvent.click(screen.getByLabelText('Filter delivery by source'));
    fireEvent.click(screen.getByRole('option', { name: 'All sources' }));
    expect(replaceSpy).toHaveBeenCalledWith(
      '/insights?period=30&interval=month&project=project-1',
      { scroll: false },
    );
  });

  it('composes rapid filter updates against pending URL state', async () => {
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });
    await waitFor(() => expect(screen.getByText('Delivery')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Filter delivery by project'));
    fireEvent.click(screen.getByRole('option', { name: 'Project One' }));
    fireEvent.click(screen.getByLabelText('Filter delivery by source'));
    fireEvent.click(screen.getByRole('option', { name: 'GitHub' }));

    expect(replaceSpy).toHaveBeenLastCalledWith(
      '/insights?project=project-1&source=github',
      { scroll: false },
    );
  });

  it('does not refetch AI observations when only delivery filters change', async () => {
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;
    const rendered = render(<InsightsPage />);

    await waitFor(() => expect(screen.getByText('Delivery')).toBeInTheDocument());
    fetchSpy.mockClear();
    setSearchParams('project=project-1');

    await act(async () => {
      rendered.rerender(<InsightsPage />);
    });

    await waitFor(() => {
      expect(latestInsightsRequest().searchParams.get('project')).toBe('project-1');
    });
    expect(fetchSpy.mock.calls.some((call: Parameters<typeof fetch>) =>
      typeof call[0] === 'string' && call[0].includes('/api/insights/observations')
    )).toBe(false);
  });

  it('hides observations from the previous period while the next period loads', async () => {
    let resolveNextObservations!: (response: Response) => void;
    const nextObservations = new Promise<Response>(resolve => {
      resolveNextObservations = resolve;
    });
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, 'http://localhost');
      const requestedPeriod = Number(url.searchParams.get('period') ?? '7');
      if (url.pathname === '/api/insights/observations') {
        if (requestedPeriod === 30) return nextObservations;
        return new Response(JSON.stringify({
          observations: [{
            id: 'old-period',
            type: 'pattern',
            title: 'Old period observation',
            description: 'Only valid for seven days.',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ...insightsPayload, period: requestedPeriod }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;
    const rendered = render(<InsightsPage />);
    await waitFor(() => expect(screen.getByText('Old period observation')).toBeInTheDocument());

    setSearchParams('period=30');
    await act(async () => {
      rendered.rerender(<InsightsPage />);
    });

    await waitFor(() => expect(screen.getByText('Loading observations...')).toBeInTheDocument());
    expect(screen.queryByText('Old period observation')).not.toBeInTheDocument();

    await act(async () => {
      resolveNextObservations(new Response(JSON.stringify({ observations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await nextObservations;
    });
  });

  it('uses custom dates without showing observations from an unrelated period', async () => {
    setSearchParams('period=custom&start=2026-06-01&end=2026-06-30');
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;

    await act(async () => {
      render(<InsightsPage />);
    });

    await waitFor(() => expect(latestInsightsRequest().searchParams.get('period')).toBe('custom'));
    const request = latestInsightsRequest();
    expect(request.searchParams.get('start')).toBe('2026-06-01');
    expect(request.searchParams.get('end')).toBe('2026-06-30');
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/insights/observations'),
      expect.anything(),
    );
    expect(screen.getByText('AI observations are available for 7, 30, and 90-day periods.'))
      .toBeInTheDocument();
  });

  it('aborts an in-flight request when the page unmounts', async () => {
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;
    const { unmount } = render(<InsightsPage />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const insightsCall = fetchSpy.mock.calls.find(
      (call: Parameters<typeof fetch>) => String(call[0]).includes('/api/insights?'),
    );
    const signal = insightsCall?.[1]?.signal;

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('surfaces actionable API validation errors', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/insights/observations')) {
        return new Response(JSON.stringify({ observations: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Custom range cannot exceed 366 days' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    setSearchParams('period=custom&start=2025-01-01&end=2026-07-01');
    const mod = await import('@/app/insights/page');
    const InsightsPage = mod.default;
    render(<InsightsPage />);

    expect((await screen.findAllByText('Custom range cannot exceed 366 days')).length).toBeGreaterThan(0);
  });

  it('does not show stale groups when a period refresh fails', async () => {
    const mod = await import('@/app/insights/page');
    const rendered = render(<mod.default />);
    await waitFor(() => expect(screen.getByTestId('completion-trend-chart')).toBeInTheDocument());

    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes('/api/insights/observations')) {
        return new Response(JSON.stringify({ observations: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Refresh failed' }), { status: 500 });
    });
    setSearchParams('period=30');

    await act(async () => {
      rendered.rerender(<mod.default />);
    });

    await waitFor(() => expect(screen.getAllByText('Refresh failed').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('completion-trend-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-activity')).not.toBeInTheDocument();
  });

  it('shows loaded observations when the summary group fails', async () => {
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/insights/observations') {
        return new Response(JSON.stringify({
          observations: [{
            id: 'independent-observation',
            type: 'pattern',
            title: 'Observation loaded independently',
            description: 'Summary data is not required.',
          }],
        }), { status: 200 });
      }
      if (url.searchParams.get('section') === 'summary') {
        return new Response(JSON.stringify({ error: 'Summary failed' }), { status: 500 });
      }
      return new Response(JSON.stringify(insightsPayload), { status: 200 });
    });

    const mod = await import('@/app/insights/page');
    render(<mod.default />);

    expect(await screen.findByText('Observation loaded independently')).toBeInTheDocument();
    expect(screen.queryByText('Loading observations...')).not.toBeInTheDocument();
  });
});
