import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { TodayRoutinesSection } from '@/components/routines/TodayRoutinesSection';
import type { TodayRoutine } from '@/components/routines/today-routines';

vi.mock('motion/react', async () => {
  const React = await import('react');
  const MockDiv = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'> & {
    variants?: unknown;
    initial?: unknown;
    animate?: unknown;
  }>((props, ref) => {
    const { variants, initial, animate, ...domProps } = props;
    void variants;
    void initial;
    void animate;
    return <div ref={ref} {...domProps} />;
  });
  MockDiv.displayName = 'MockDiv';
  return { motion: { div: MockDiv } };
});

vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon">check</span>,
  ChevronDown: () => <span>down</span>,
  ChevronUp: () => <span>up</span>,
  Flame: () => <span>flame</span>,
  Repeat: () => <span data-testid="routine-fallback-icon">repeat</span>,
  RotateCcw: () => <span>retry</span>,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({
    children,
    content,
    delay,
  }: {
    children: React.ReactNode;
    content: React.ReactNode;
    delay?: number;
  }) => <span data-tooltip={String(content)} data-delay={delay}>{children}</span>,
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/motion', () => ({ fadeSlideUp: {}, staggerContainer: {} }));
vi.mock('@/lib/utils/client-date', () => ({ getLocalToday: () => '2026-07-29' }));

const originalFetch = global.fetch;

function routine(index: number, overrides: Partial<TodayRoutine> = {}): TodayRoutine {
  return {
    id: `routine-${index}`,
    name: `Routine ${index}`,
    icon: index === 1 ? null : `icon-${index}`,
    iconColor: null,
    cadenceType: 'daily',
    cadenceConfig: {},
    sortOrder: index,
    streak: 0,
    weekCompletions: [],
    intervalStatus: null,
    weeklyProgress: null,
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(routines: TodayRoutine[], loadStatus = 200) {
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/routines?') && method === 'GET') {
      return response({ routines }, loadStatus);
    }
    if (url === '/api/routines/completions' && method === 'POST') return response({});
    if (url.startsWith('/api/routines/completions?') && method === 'DELETE') return response({});
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 900 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

describe('TodayRoutinesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('shows six promoted routines initially and reveals all remaining routines', async () => {
    mockFetch(Array.from({ length: 9 }, (_, index) => routine(index + 1)));
    render(<TodayRoutinesSection />);

    expect(await screen.findByText('Routine 1')).toBeInTheDocument();
    expect(screen.getByText('Routine 6')).toBeInTheDocument();
    expect(screen.queryByText('Routine 7')).not.toBeInTheDocument();
    expect(screen.getByText('3 more routines')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /3 more routines/i }));

    expect(screen.getByText('Routine 9')).toBeInTheDocument();
    expect(screen.getByText('All 9 routines shown')).toBeInTheDocument();
    expect(screen.getByText('Show fewer')).toBeInTheDocument();
  });

  it('uses the routine navigation icon when a routine has no custom icon', async () => {
    mockFetch([routine(1)]);
    render(<TodayRoutinesSection />);

    await screen.findByText('Routine 1');

    expect(screen.getByTestId('routine-fallback-icon')).toBeInTheDocument();
    const tooltip = screen.getByRole('button', { name: 'Mark Routine 1 complete' }).parentElement;
    expect(tooltip).toHaveAttribute('data-delay', '80');
  });

  it('renders routine cards with compact typography and spacing', async () => {
    mockFetch([routine(2)]);
    render(<TodayRoutinesSection />);

    const title = await screen.findByText('Routine 2');
    const toggle = screen.getByRole('button', { name: 'Mark Routine 2 complete' });

    expect(title).toHaveClass('text-xs', 'leading-4');
    expect(toggle).toHaveClass('size-8');
    expect(title.parentElement?.parentElement).toHaveClass('min-h-[43px]', 'gap-[9px]', 'px-[11px]', 'py-2');
  });

  it('balances four routines into a two-column grid', async () => {
    mockFetch(Array.from({ length: 4 }, (_, index) => routine(index + 1)));
    render(<TodayRoutinesSection />);

    const title = await screen.findByText('Routine 1');
    const grid = title.parentElement?.parentElement?.parentElement;

    expect(grid).toHaveClass('sm:grid-cols-2');
    expect(grid).not.toHaveClass('xl:grid-cols-3');
  });

  it('keeps on-track flexible routines under Other routines', async () => {
    mockFetch([
      routine(1),
      routine(2, {
        name: 'Clean coffee maker',
        cadenceType: 'every_n_days',
        intervalStatus: { status: 'on_track', daysSinceLast: 1, progressPercent: 25 },
      }),
    ]);
    render(<TodayRoutinesSection />);

    expect(await screen.findByText('Other routines (1)')).toBeInTheDocument();
    expect(screen.queryByText('Clean coffee maker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Other routines/ }));

    expect(screen.getByText('Clean coffee maker')).toBeInTheDocument();
    expect(screen.getByText('Every 1-7 days · logged yesterday')).toBeInTheDocument();
  });

  it('collapses from the summary header and expands all routines from the +N action', async () => {
    mockFetch(Array.from({ length: 9 }, (_, index) => routine(index + 1)));
    render(<TodayRoutinesSection />);

    const summary = await screen.findByRole('button', { name: /9 routines left today/ });
    fireEvent.click(summary);

    expect(screen.queryByText('Routine 9')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Show 3 more routines' }));

    expect(screen.getByText('Routine 9')).toBeInTheDocument();
    expect(screen.getByText('All 9 routines shown')).toBeInTheDocument();
  });

  it('marks a routine complete and automatically collapses the completed section', async () => {
    mockFetch([routine(1)]);
    render(<TodayRoutinesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Routine 1 complete' }));

    await waitFor(() => {
      expect(screen.getByText('All routines complete')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Expand routines' })).toHaveAttribute('aria-expanded', 'false');
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/routines/completions', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('shows an actionable error state when routines fail to load', async () => {
    mockFetch([], 500);
    render(<TodayRoutinesSection />);

    expect(await screen.findByText('Routines could not load.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry loading routines' })).toBeInTheDocument();
  });
});
