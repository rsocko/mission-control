/**
 * Mobile Goals Component Tests — MobileGoalCard and MobileGoalsPage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  useReducedMotion: () => false,
}));

vi.mock('lucide-react', () => ({
  Brain: () => <span data-testid="icon-brain">🧠</span>,
  CheckCircle: () => <span data-testid="icon-check-circle">✓</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">▼</span>,
  ChevronUp: () => <span data-testid="icon-chevron-up">▲</span>,
  Circle: () => <span data-testid="icon-circle">○</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">💡</span>,
  Loader2: () => <span data-testid="icon-loader">⏳</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  Rocket: () => <span data-testid="icon-rocket">🚀</span>,
  Server: () => <span data-testid="icon-server">🖥</span>,
  Target: () => <span data-testid="icon-target">🎯</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/motion', () => ({
  staggerContainer: { hidden: {}, show: {} },
  fadeSlideUp: { hidden: {}, show: {} },
}));

vi.mock('@/lib/utils/cn', () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) => classes.filter(Boolean).join(' '),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) => classes.filter(Boolean).join(' '),
}));

// ─── Test data ──────────────────────────────────────────────────────────────

const mockGoalWithMilestones = {
  id: 'goal-1',
  title: 'Ship iOS MVP',
  description: 'Build and ship the mobile app',
  status: 'todo',
  priority: 'high',
  goalType: 'goal' as const,
  tags: [{ id: 'tag-1', name: 'Goal', slug: 'goal', color: '#3b82f6', type: 'system' }],
  linkedProjects: [{
    id: 'proj-1',
    name: 'iOS App',
    color: '#10b981',
    icon: null,
    totalTasks: 10,
    doneTasks: 7,
    progress: 70,
    milestones: [
      { id: 'ms-1', name: 'Core navigation complete', targetDate: null, completed: true },
      { id: 'ms-2', name: 'Quick Sort functional', targetDate: null, completed: false },
      { id: 'ms-3', name: 'TestFlight beta', targetDate: '2026-08-31', completed: false },
    ],
  }],
  progress: 70,
  totalTasks: 10,
  doneTasks: 7,
  dueDate: '2026-08-31',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  connectorType: 'mission-control',
};

const mockGoalWithoutMilestones = {
  id: 'goal-2',
  title: 'Reduce task backlog by 50%',
  description: 'Clear out old tasks',
  status: 'todo',
  priority: 'medium',
  goalType: 'goal' as const,
  tags: [{ id: 'tag-2', name: 'Goal', slug: 'goal', color: '#3b82f6', type: 'system' }],
  linkedProjects: [{
    id: 'proj-2',
    name: 'Backlog',
    color: '#f59e0b',
    icon: null,
    totalTasks: 20,
    doneTasks: 9,
    progress: 45,
    milestones: [],
  }],
  progress: 45,
  totalTasks: 20,
  doneTasks: 9,
  dueDate: '2026-09-30',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  connectorType: 'mission-control',
};

const mockApiResponse = {
  items: [mockGoalWithMilestones, mockGoalWithoutMilestones],
  counts: { goal: 2, idea: 0, brainstorm: 0 },
};

// ─── MobileGoalCard Tests ──────────────────────────────────────────────────

describe('MobileGoalCard', () => {
  let MobileGoalCard: typeof import('@/components/goals/MobileGoalCard').MobileGoalCard;

  beforeEach(async () => {
    const mod = await import('@/components/goals/MobileGoalCard');
    MobileGoalCard = mod.MobileGoalCard;
  });

  it('renders goal title and progress percentage', () => {
    render(<MobileGoalCard item={mockGoalWithMilestones} />);
    expect(screen.getByText('Ship iOS MVP')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });

  it('shows key results count and due date', () => {
    render(<MobileGoalCard item={mockGoalWithMilestones} />);
    expect(screen.getByText(/3 key results/)).toBeInTheDocument();
    expect(screen.getByText(/Due Aug \d+/)).toBeInTheDocument();
  });

  it('shows milestone expand button with count', () => {
    render(<MobileGoalCard item={mockGoalWithMilestones} />);
    expect(screen.getByText('1/3 milestones')).toBeInTheDocument();
  });

  it('expands milestones on tap', () => {
    render(<MobileGoalCard item={mockGoalWithMilestones} />);
    const expandBtn = screen.getByRole('button', { name: /expand milestones/i });
    fireEvent.click(expandBtn);
    expect(screen.getByText('Core navigation complete')).toBeInTheDocument();
    expect(screen.getByText('Quick Sort functional')).toBeInTheDocument();
    expect(screen.getByText('TestFlight beta')).toBeInTheDocument();
  });

  it('shows project chips when no milestones', () => {
    render(<MobileGoalCard item={mockGoalWithoutMilestones} />);
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    // 45% appears both as the main progress badge and in the project chip
    const progressTexts = screen.getAllByText('45%');
    expect(progressTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onTap when card is clicked', () => {
    const onTap = vi.fn();
    render(<MobileGoalCard item={mockGoalWithMilestones} onTap={onTap} />);
    fireEvent.click(screen.getByText('Ship iOS MVP').closest('div[class*="rounded"]')!);
    expect(onTap).toHaveBeenCalledWith('goal-1');
  });

  it('renders progress bar with correct width', () => {
    const { container } = render(<MobileGoalCard item={mockGoalWithMilestones} />);
    const progressBar = container.querySelector('[style*="width: 70%"]');
    expect(progressBar).toBeInTheDocument();
  });
});

// ─── MobileGoalsPage Tests ──────────────────────────────────────────────────

describe('MobileGoalsPage', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let MobileGoalsPage: typeof import('@/components/goals/MobileGoalsPage').MobileGoalsPage;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockApiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const mod = await import('@/components/goals/MobileGoalsPage');
    MobileGoalsPage = mod.MobileGoalsPage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Objectives" label and "Goals" title', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      expect(screen.getByText('Objectives')).toBeInTheDocument();
      expect(screen.getByText('Goals')).toBeInTheDocument();
    });
  });

  it('renders period filter chips', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      expect(screen.getByText('Annual')).toBeInTheDocument();
      expect(screen.getByText('All')).toBeInTheDocument();
    });
    // Quarter label (e.g., "Q3 2026")
    const quarterBtn = screen.getByText(/Q\d \d{4}/);
    expect(quarterBtn).toBeInTheDocument();
  });

  it('fetches goals with filter=goal', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/goals?filter=goal');
    });
  });

  it('renders goal cards after loading', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      expect(screen.getByText('Ship iOS MVP')).toBeInTheDocument();
      expect(screen.getByText('Reduce task backlog by 50%')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    render(<MobileGoalsPage />);
    expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
  });

  it('period filter "All" is active by default', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      const allBtn = screen.getByText('All');
      expect(allBtn.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('switching period filter changes active chip', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => screen.getByText('Ship iOS MVP'));

    const annualBtn = screen.getByText('Annual');
    fireEvent.click(annualBtn);
    expect(annualBtn.getAttribute('aria-pressed')).toBe('true');

    const allBtn = screen.getByText('All');
    expect(allBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows empty state when no goals match period', async () => {
    // Mock goals with due date far in the past
    const oldGoal = {
      ...mockGoalWithMilestones,
      dueDate: '2020-01-01',
      createdAt: '2020-01-01T00:00:00Z',
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [oldGoal], counts: { goal: 1, idea: 0, brainstorm: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    render(<MobileGoalsPage />);
    await waitFor(() => screen.getByText('Ship iOS MVP'));

    // Switch to quarter filter — old goal shouldn't match
    const quarterBtn = screen.getByText(/Q\d \d{4}/);
    fireEvent.click(quarterBtn);
    expect(screen.getByText('No goals for this period')).toBeInTheDocument();
  });

  it('shows add button with aria label', async () => {
    render(<MobileGoalsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add new goal' })).toBeInTheDocument();
    });
  });
});
