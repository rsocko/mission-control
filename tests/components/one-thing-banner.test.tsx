/**
 * Component Tests — OneThingBanner
 * Tests for issue #99
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Motion / icon mocks (inline to avoid hoisting issues) ──────────────────

const { reducedMotion } = vi.hoisted(() => ({
  reducedMotion: { current: false },
}));

vi.mock('motion/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  const Div = R.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    const { animate, children, ...rest } = props;
    return R.createElement('div', {
      ...rest,
      ref,
      'data-motion-animate': typeof animate === 'string' ? animate : undefined,
    }, children);
  });
  Div.displayName = 'MockDiv';
  const Span = R.forwardRef((props: Record<string, unknown>, ref: unknown) =>
    R.createElement('span', { ...props, ref }, props.children));
  Span.displayName = 'MockSpan';
  const Btn = R.forwardRef((props: Record<string, unknown>, ref: unknown) =>
    R.createElement('button', { ...props, ref }, props.children));
  Btn.displayName = 'MockBtn';
  return {
    motion: { div: Div, span: Span, button: Btn },
    AnimatePresence: ({ children }: { children?: unknown }) => R.createElement(R.Fragment, null, children),
  };
});

vi.mock('@/lib/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => reducedMotion.current,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  const Stub = (props: Record<string, unknown>) => R.createElement('span', props);
  return {
    Target: Stub,
    Sparkles: Stub,
    Loader2: Stub,
    X: Stub,
    ChevronDown: Stub,
    ChevronRight: Stub,
    CheckCircle2: Stub,
    ArrowRight: Stub,
    Shuffle: Stub,
    Trophy: Stub,
    Check: Stub,
    Clock: Stub,
    Star: Stub,
    AlertTriangle: Stub,
    Circle: Stub,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/motion', () => ({
  fadeSlideUp: { hidden: {}, show: {} },
  scaleIn: { hidden: {}, show: {}, exit: {} },
  oneThingCelebration: { idle: {}, celebrate: {} },
  oneThingConfetti: { hidden: {}, show: {} },
  oneThingGlow: { idle: {}, glow: {} },
}));

vi.mock('@/lib/client-logger', () => ({
  uiLogger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactElement; content: string }) =>
    React.cloneElement(children, { title: content }),
}));

// ─── Fetch mock ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Import component ────────────────────────────────────────────────────────

import { OneThingBanner } from '@/components/OneThingBanner';

// ─── Test data ───────────────────────────────────────────────────────────────

const activeOneThing = {
  oneThing: {
    id: 'ot-1',
    taskId: 'task-1',
    weekMonday: '2026-07-13',
    isManualOverride: false,
    completedAt: null,
    createdAt: '2026-07-13T08:00:00Z',
    title: 'Ship the dashboard',
    status: 'in_progress',
    priority: 'high',
    dueDate: '2026-07-17',
    connectorType: 'microsoft-todo',
    sourceListName: 'Work',
    justCompleted: false,
    subtaskTotal: 5,
    subtaskDone: 2,
  },
  weekMonday: '2026-07-13',
  source: 'auto',
};

const completedOneThing = {
  oneThing: {
    ...activeOneThing.oneThing,
    status: 'done',
    completedAt: '2026-07-16T14:00:00Z',
    justCompleted: false,
  },
  weekMonday: '2026-07-13',
  source: 'auto',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OneThingBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reducedMotion.current = false;
  });

  it('renders the active one-thing with title and label', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('This Week, One Thing')).toBeInTheDocument();
    expect(screen.getByText('AI picked')).toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('keeps the incomplete banner static when reduced motion is requested', async () => {
    reducedMotion.current = true;
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) });

    const { container } = render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });
    expect(container.querySelector('[data-motion-animate="idle"]')).toBeInTheDocument();
    expect(container.querySelector('[data-motion-animate="glow"]')).not.toBeInTheDocument();
  });

  it('renders nothing when source is none and no one-thing', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ oneThing: null, weekMonday: '2026-07-13', source: 'none' }),
    });

    const { container } = render(<OneThingBanner />);

    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });

  it('shows completed state with done label', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(completedOneThing) });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText(/One Thing — Done!/)).toBeInTheDocument();
    });
    expect(screen.getByText(/crushed your most important task/)).toBeInTheDocument();
  });

  it('shows "Your pick" label for manual overrides', async () => {
    const manual = {
      ...activeOneThing,
      source: 'manual',
      oneThing: { ...activeOneThing.oneThing, isManualOverride: true },
    };
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(manual) });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Your pick')).toBeInTheDocument();
    });
  });

  it('calls onTaskClick when task is clicked', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) });
    const onClick = vi.fn();

    render(<OneThingBanner onTaskClick={onClick} />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Ship the dashboard'));
    expect(onClick).toHaveBeenCalledWith('task-1');
  });

  it('dismisses banner when X is clicked', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) });

    const { container } = render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });

    const dismissBtn = screen.getByTitle('Dismiss banner');
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });

  it('opens swap picker when shuffle is clicked', async () => {
    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          tasks: [
            { id: 'task-2', title: 'Write tests', priority: 'medium', connectorType: 'github-issues', dueDate: null },
          ],
        }),
      });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });

    const swapBtn = screen.getByTitle('Swap your one thing');
    fireEvent.click(swapBtn);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tasks to swap in…')).toBeInTheDocument();
    });
  });

  it('performs swap when a task is selected', async () => {
    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) })
      // search tasks
      .mockResolvedValueOnce({
        json: () => Promise.resolve({
          tasks: [
            { id: 'task-2', title: 'Write tests', priority: 'medium', connectorType: 'github-issues', dueDate: null },
          ],
        }),
      })
      // POST swap
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'ot-2' }) })
      // re-fetch after swap
      .mockResolvedValueOnce({ json: () => Promise.resolve(activeOneThing) });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(screen.getByText('Ship the dashboard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Swap your one thing'));

    await waitFor(() => {
      expect(screen.getByText('Write tests')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Write tests'));

    await waitFor(() => {
      // POST call should have been made
      expect(mockFetch).toHaveBeenCalledWith('/api/one-thing', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('triggers celebration toast on justCompleted', async () => {
    const { toast } = await import('sonner');
    const justCompleted = {
      ...activeOneThing,
      oneThing: {
        ...activeOneThing.oneThing,
        status: 'done',
        completedAt: '2026-07-16T14:00:00Z',
        justCompleted: true,
      },
    };
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve(justCompleted) });

    render(<OneThingBanner />);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('You did it'),
        expect.any(Object),
      );
    });
  });
});
