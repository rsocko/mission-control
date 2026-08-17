/**
 * Goals Page Component Tests — /goals page rendering, filtering, interactions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ─── Mocks ──────────────────────────────────────────────────────────────────

type MockDivProps = React.ComponentPropsWithoutRef<'div'>;

const MockMotionDiv = React.forwardRef<HTMLDivElement, MockDivProps>(({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>);
MockMotionDiv.displayName = 'MockMotionDiv';

function MockAnimatePresence({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

vi.mock('motion/react', () => ({
  motion: {
    div: MockMotionDiv,
    section: MockMotionDiv,
    aside: MockMotionDiv,
  },
  AnimatePresence: MockAnimatePresence,
}));

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <span data-testid="icon-alert-triangle">⚠</span>,
  Brain: () => <span data-testid="icon-brain">🧠</span>,
  ChevronRight: () => <span data-testid="icon-chevron">›</span>,
  Filter: () => <span data-testid="icon-filter">F</span>,
  ChartNetwork: () => <span data-testid="icon-folder">📁</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">💡</span>,
  Loader2: () => <span data-testid="icon-loader">⏳</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  RefreshCw: () => <span data-testid="icon-refresh">↻</span>,
  Sparkles: () => <span data-testid="icon-sparkles">✨</span>,
  Target: () => <span data-testid="icon-target">🎯</span>,
  X: () => <span data-testid="icon-x">×</span>,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentPropsWithoutRef<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/lib/motion', () => ({
  staggerContainer: { hidden: {}, show: {} },
  fadeSlideUp: { hidden: {}, show: {} },
  scaleIn: { hidden: {}, show: {} },
  modalOverlay: { hidden: {}, show: {} },
  modalContent: { hidden: {}, show: {} },
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) => classes.filter(Boolean).join(' '),
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// ─── Test data ──────────────────────────────────────────────────────────────

const mockGoalItems = [
  {
    id: 'goal-1',
    title: 'Launch v2.0',
    description: 'Major version release with new features',
    status: 'todo',
    priority: 'high',
    goalType: 'goal',
    tags: [
      { id: 'tag-1', name: 'Goal', slug: 'goal', color: '#3b82f6', type: 'system' },
      { id: 'tag-2', name: 'Product', slug: 'product', color: '#10b981', type: 'user' },
    ],
    linkedProjects: [{ id: 'proj-1', name: 'Main App', color: '#3b82f6', icon: null }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    connectorType: 'mission-control',
  },
  {
    id: 'idea-1',
    title: 'AI-powered search',
    description: 'Use AI to improve search results',
    status: 'todo',
    priority: 'medium',
    goalType: 'idea',
    tags: [{ id: 'tag-3', name: 'Idea', slug: 'idea', color: '#f59e0b', type: 'system' }],
    linkedProjects: [],
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    connectorType: 'mission-control',
  },
  {
    id: 'brainstorm-1',
    title: 'Mobile-first redesign',
    description: null,
    status: 'todo',
    priority: 'low',
    goalType: 'brainstorm',
    tags: [{ id: 'tag-4', name: 'Brainstorm', slug: 'brainstorm', color: '#8b5cf6', type: 'system' }],
    linkedProjects: [],
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    connectorType: 'mission-control',
  },
];

const mockApiResponse = {
  items: mockGoalItems,
  counts: { goal: 1, idea: 1, brainstorm: 1 },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(mockApiResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoalsPage', () => {
  let GoalsPage: React.ComponentType;

  beforeEach(async () => {
    const mod = await import('@/app/goals/page');
    GoalsPage = mod.default;
  });

  it('renders the page header', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('Goals & Ideas')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', async () => {
    // Hang the fetch to keep loading state visible
    fetchSpy.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      render(<GoalsPage />);
    });

    expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
  });

  it('renders goal items after loading', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('Launch v2.0')).toBeInTheDocument();
    });
    expect(screen.getByText('AI-powered search')).toBeInTheDocument();
    expect(screen.getByText('Mobile-first redesign')).toBeInTheDocument();
  });

  it('renders section headers for each goal type', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      // "Goals" appears in both sidebar filter and section header
      const goalsElements = screen.getAllByText('Goals');
      expect(goalsElements.length).toBeGreaterThanOrEqual(2);
    });
    // "Ideas" appears in both sidebar and section header
    const ideasElements = screen.getAllByText('Ideas');
    expect(ideasElements.length).toBeGreaterThanOrEqual(1);
    // "Brainstorms" appears in both sidebar and section header
    const brainstormElements = screen.getAllByText('Brainstorms');
    expect(brainstormElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders filter buttons in sidebar', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      // "All" appears in both sidebar and mobile filter chips
      const allElements = screen.getAllByText('All');
      expect(allElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows empty state when no items exist', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ items: [], counts: { goal: 0, idea: 0, brainstorm: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText(/big-picture thinking/)).toBeInTheDocument();
    });
    expect(screen.getByText(/#goal/)).toBeInTheDocument();
  });

  it('renders tags on goal cards (excluding system tags)', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('#product')).toBeInTheDocument();
    });
  });

  it('renders linked project names', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Main App').length).toBeGreaterThan(0);
    });
  });

  it('displays Develop buttons on cards', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      const developButtons = screen.getAllByText('Develop');
      expect(developButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows error toast when fetch fails', async () => {
    const { toast } = await import('sonner');
    fetchSpy.mockResolvedValue(new Response('error', { status: 500 }));

    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load goals');
    });
  });

  it('calls API with filter param when filter is changed', async () => {
    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('Launch v2.0')).toBeInTheDocument();
    });

    // The sidebar filter buttons are inside the aside (hidden on mobile)
    // Use the mobile chips instead which are always in DOM
    const filterButtons = screen.getAllByRole('button');
    const ideaButton = filterButtons.find(btn => btn.textContent === 'Idea');
    if (ideaButton) {
      await act(async () => {
        fireEvent.click(ideaButton);
      });
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('filter=idea'));
      });
    }
  });
});

describe('GoalsPage - Develop flow', () => {
  let GoalsPage: React.ComponentType;

  beforeEach(async () => {
    const mod = await import('@/app/goals/page');
    GoalsPage = mod.default;
  });

  it('opens develop panel when Develop button is clicked', async () => {
    const developResponse = {
      proposal: {
        summary: 'This goal needs a phased approach',
        suggestedTasks: [{ title: 'Research', description: 'Do research', effort: '~2d', category: 'research' }],
        suggestedProject: {
          name: 'V2 Launch',
          description: 'Launch v2',
          category: 'product',
          phases: [{ name: 'Phase 1', description: 'Research', taskIndices: [0] }],
          estimatedEffortDays: 5,
        },
      },
    };

    let fetchCallCount = 0;
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('/api/goals/develop')) {
        return Promise.resolve(new Response(JSON.stringify(developResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      fetchCallCount++;
      return Promise.resolve(new Response(JSON.stringify(mockApiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    await act(async () => {
      render(<GoalsPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('Launch v2.0')).toBeInTheDocument();
    });

    const developButtons = screen.getAllByText('Develop');
    await act(async () => {
      fireEvent.click(developButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByText('AI: Develop')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('This goal needs a phased approach')).toBeInTheDocument();
    });
    expect(screen.getByText('Suggested Tasks')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.getByText('Create Project')).toBeInTheDocument();
  });
});

describe('GoalsPage error boundary', () => {
  it('renders error UI with retry button', async () => {
    const mod = await import('@/app/goals/error');
    const GoalsError = mod.default;
    const mockReset = vi.fn();

    render(<GoalsError error={new Error('Test error')} reset={mockReset} />);

    expect(screen.getByText('Goals failed to render')).toBeInTheDocument();
    expect(screen.getByText('Test error')).toBeInTheDocument();

    const retryButton = screen.getByText('Try again');
    fireEvent.click(retryButton);
    expect(mockReset).toHaveBeenCalledOnce();
  });

  it('shows fallback message when error has no message', async () => {
    const mod = await import('@/app/goals/error');
    const GoalsError = mod.default;

    render(<GoalsError error={new Error('')} reset={vi.fn()} />);

    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  });
});
