/**
 * View Modes — Unit Tests
 * Tests for #123 (Calm Mode) and #124 (Zen Mode)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('motion/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react') as typeof import('react');
  const Div = ReactLib.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
    ({ children, ...props }: React.PropsWithChildren<React.ComponentPropsWithoutRef<'div'>>, ref: React.Ref<HTMLDivElement>) => ReactLib.createElement('div', { ...props, ref }, children)
  );
  Div.displayName = 'MockMotionDiv';
  return {
    motion: { div: Div },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => ReactLib.createElement(ReactLib.Fragment, null, children),
  };
});

vi.mock('lucide-react', () => ({
  X: () => <span data-testid="icon-x">×</span>,
  Moon: () => <span data-testid="icon-moon">🌙</span>,
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
  Check: () => <span data-testid="icon-check">✓</span>,
  SkipForward: () => <span data-testid="icon-skip">⏭</span>,
  Bold: () => <span data-testid="icon-bold">B</span>,
  Code: () => <span data-testid="icon-code">C</span>,
  Italic: () => <span data-testid="icon-italic">I</span>,
  Link2: () => <span data-testid="icon-link">L</span>,
  List: () => <span data-testid="icon-list">•</span>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/ui/CompletionBurst', () => ({
  CompletionBurst: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/smart-score/SmartScoreBadge', () => ({
  SmartScoreBadge: ({ score }: { score: number }) => (
    <span data-testid="smart-score-badge">{score}</span>
  ),
}));

vi.mock('@/components/task-list/MicroStatusIcon', () => ({
  MicroStatusIcon: () => <span data-testid="micro-status-icon" />,
}));

// ─── useViewMode Hook Tests ─────────────────────────────────────────────────

import { renderHook, act } from '@testing-library/react';
import { ViewModeProvider, useViewMode, type ViewMode } from '@/lib/hooks/useViewMode';

function wrapper({ children }: { children: React.ReactNode }) {
  return <ViewModeProvider>{children}</ViewModeProvider>;
}

describe('useViewMode', () => {
  it('initializes with normal mode', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    expect(result.current.viewMode).toBe('normal');
  });

  it('setViewMode changes the mode', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    act(() => result.current.setViewMode('zen'));
    expect(result.current.viewMode).toBe('zen');
  });

  it('toggleZen switches between zen and normal', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    act(() => result.current.toggleZen());
    expect(result.current.viewMode).toBe('zen');
    act(() => result.current.toggleZen());
    expect(result.current.viewMode).toBe('normal');
  });

  it('toggleCalm switches between calm and normal', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    act(() => result.current.toggleCalm());
    expect(result.current.viewMode).toBe('calm');
    act(() => result.current.toggleCalm());
    expect(result.current.viewMode).toBe('normal');
  });

  it('toggling zen while in calm switches to zen', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    act(() => result.current.setViewMode('calm'));
    act(() => result.current.toggleZen());
    expect(result.current.viewMode).toBe('zen');
  });

  it('toggling calm while in zen switches to calm', () => {
    const { result } = renderHook(() => useViewMode(), { wrapper });
    act(() => result.current.setViewMode('zen'));
    act(() => result.current.toggleCalm());
    expect(result.current.viewMode).toBe('calm');
  });
});

// ─── CalmMode Component Tests ───────────────────────────────────────────────

import { CalmMode } from '@/components/CalmMode';

const MOCK_CALM_TASKS = [
  { taskId: 't1', score: { total: 80 }, task: { title: 'Write report', priority: 'high', dueDate: '2026-07-20' } },
  { taskId: 't2', score: { total: 60 }, task: { title: 'Review PR', priority: 'medium', dueDate: null } },
  { taskId: 't3', score: { total: 40 }, task: { title: 'Update docs', priority: 'low', dueDate: '2026-07-25' } },
];

function renderCalmMode(initialMode: ViewMode = 'calm') {
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return <ViewModeProvider>{children}</ViewModeProvider>;
  }
  function Inner() {
    const { setViewMode } = useViewMode();
    React.useEffect(() => { setViewMode(initialMode); }, [setViewMode]);
    return <CalmMode />;
  }
  return render(<Inner />, { wrapper: TestWrapper });
}

describe('CalmMode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when viewMode is normal', () => {
    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    render(<CalmMode />, { wrapper: TestWrapper });
    expect(screen.queryByText('What matters now')).not.toBeInTheDocument();
  });

  it('renders heading when viewMode is calm', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_CALM_TASKS }),
    }) as unknown as typeof fetch;

    renderCalmMode('calm');
    await waitFor(() => {
      expect(screen.getByText('What matters now')).toBeInTheDocument();
    });
  });

  it('fetches and renders tasks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_CALM_TASKS }),
    }) as unknown as typeof fetch;

    renderCalmMode('calm');
    await waitFor(() => {
      expect(screen.getByText('Write report')).toBeInTheDocument();
      expect(screen.getByText('Review PR')).toBeInTheDocument();
      expect(screen.getByText('Update docs')).toBeInTheDocument();
    });
  });

  it('shows empty state when no tasks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: [] }),
    }) as unknown as typeof fetch;

    renderCalmMode('calm');
    await waitFor(() => {
      expect(screen.getByText('Nothing pressing right now')).toBeInTheDocument();
    });
  });

  it('shows empty state on fetch error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

    renderCalmMode('calm');
    await waitFor(() => {
      expect(screen.getByText('Nothing pressing right now')).toBeInTheDocument();
    });
  });

  it('displays formatted due dates', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_CALM_TASKS }),
    }) as unknown as typeof fetch;

    renderCalmMode('calm');
    // The date '2026-07-20' is formatted via toLocaleDateString — the exact
    // rendered text depends on the timezone, so just verify the calendar icon
    // is present alongside a date string for the task that has a dueDate.
    await waitFor(() => {
      const calendarIcons = screen.getAllByTestId('icon-calendar');
      expect(calendarIcons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('exit button exits calm mode', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_CALM_TASKS }),
    }) as unknown as typeof fetch;

    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    function Inner() {
      const { viewMode, setViewMode } = useViewMode();
      React.useEffect(() => { setViewMode('calm'); }, [setViewMode]);
      return (
        <>
          <span data-testid="current-mode">{viewMode}</span>
          <CalmMode />
        </>
      );
    }
    render(<Inner />, { wrapper: TestWrapper });

    await waitFor(() => {
      expect(screen.getByText('What matters now')).toBeInTheDocument();
    });

    // Click the Exit button
    fireEvent.click(screen.getByText('Exit'));
    expect(screen.getByTestId('current-mode').textContent).toBe('normal');
  });

  it('Escape key exits calm mode', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_CALM_TASKS }),
    }) as unknown as typeof fetch;

    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    function Inner() {
      const { viewMode, setViewMode } = useViewMode();
      React.useEffect(() => { setViewMode('calm'); }, [setViewMode]);
      return (
        <>
          <span data-testid="current-mode">{viewMode}</span>
          <CalmMode />
        </>
      );
    }
    render(<Inner />, { wrapper: TestWrapper });

    await waitFor(() => {
      expect(screen.getByText('What matters now')).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('current-mode').textContent).toBe('normal');
  });

  it('limits to 5 tasks maximum', async () => {
    const manyTasks = Array.from({ length: 10 }, (_, i) => ({
      taskId: `t${i}`,
      score: { total: 100 - i * 10 },
      task: { title: `Task ${i}`, priority: 'medium', dueDate: null },
    }));
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: manyTasks }),
    }) as unknown as typeof fetch;

    renderCalmMode('calm');
    await waitFor(() => {
      expect(screen.getByText('Task 0')).toBeInTheDocument();
      expect(screen.getByText('Task 4')).toBeInTheDocument();
      expect(screen.queryByText('Task 5')).not.toBeInTheDocument();
    });
  });
});

// ─── ZenMode Component Tests ────────────────────────────────────────────────

import { ZenMode } from '@/components/ZenMode';

const MOCK_ZEN_TASKS = [
  { taskId: 'z1', score: { total: 95 }, task: { title: 'Deploy release', priority: 'critical', dueDate: '2026-07-19' } },
  { taskId: 'z2', score: { total: 72 }, task: { title: 'Fix login bug', priority: 'high', dueDate: null } },
  { taskId: 'z3', score: { total: 50 }, task: { title: 'Add tests', priority: 'medium', dueDate: '2026-07-22' } },
  { taskId: 'z4', score: { total: 30 }, task: { title: 'Clean up CSS', priority: 'low', dueDate: null } },
];

function renderZenMode(initialMode: ViewMode = 'zen') {
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return <ViewModeProvider>{children}</ViewModeProvider>;
  }
  function Inner() {
    const { setViewMode } = useViewMode();
    React.useEffect(() => { setViewMode(initialMode); }, [setViewMode]);
    return <ZenMode />;
  }
  return render(<Inner />, { wrapper: TestWrapper });
}

describe('ZenMode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when viewMode is normal', () => {
    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    render(<ZenMode />, { wrapper: TestWrapper });
    expect(screen.queryByText('Zen Mode')).not.toBeInTheDocument();
  });

  it('renders header when viewMode is zen', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    });
  });

  it('fetches and renders score-sorted tasks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('Deploy release')).toBeInTheDocument();
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
      expect(screen.getByText('Add tests')).toBeInTheDocument();
      expect(screen.getByText('Clean up CSS')).toBeInTheDocument();
    });
  });

  it('renders SmartScoreBadge for each task', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      const badges = screen.getAllByTestId('smart-score-badge');
      expect(badges).toHaveLength(4);
      expect(badges[0].textContent).toBe('95');
    });
  });

  it('renders numbered rank for each task', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
    });
  });

  it('renders priority labels', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('critical')).toBeInTheDocument();
      expect(screen.getByText('high')).toBeInTheDocument();
      expect(screen.getByText('medium')).toBeInTheDocument();
      expect(screen.getByText('low')).toBeInTheDocument();
    });
  });

  it('shows task count in header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText(/4 remaining/)).toBeInTheDocument();
    });
  });

  it('shows empty state when no tasks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: [] }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('No scored tasks found')).toBeInTheDocument();
    });
  });

  it('shows empty state on fetch error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(screen.getByText('No scored tasks found')).toBeInTheDocument();
    });
  });

  it('exit button exits zen mode', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    function Inner() {
      const { viewMode, setViewMode } = useViewMode();
      React.useEffect(() => { setViewMode('zen'); }, [setViewMode]);
      return (
        <>
          <span data-testid="current-mode">{viewMode}</span>
          <ZenMode />
        </>
      );
    }
    render(<Inner />, { wrapper: TestWrapper });

    await waitFor(() => {
      expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Exit'));
    expect(screen.getByTestId('current-mode').textContent).toBe('normal');
  });

  it('Escape key exits zen mode', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: MOCK_ZEN_TASKS }),
    }) as unknown as typeof fetch;

    function TestWrapper({ children }: { children: React.ReactNode }) {
      return <ViewModeProvider>{children}</ViewModeProvider>;
    }
    function Inner() {
      const { viewMode, setViewMode } = useViewMode();
      React.useEffect(() => { setViewMode('zen'); }, [setViewMode]);
      return (
        <>
          <span data-testid="current-mode">{viewMode}</span>
          <ZenMode />
        </>
      );
    }
    render(<Inner />, { wrapper: TestWrapper });

    await waitFor(() => {
      expect(screen.getByText('Zen Mode')).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('current-mode').textContent).toBe('normal');
  });

  it('calls API with limit=50 and status=open', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ scores: [] }),
    }) as unknown as typeof fetch;

    renderZenMode('zen');
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/smart-score?limit=50&status=open');
    });
  });
});
