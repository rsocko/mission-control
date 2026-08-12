/**
 * MobileDashboard Tests — Phase 7.1 Hamburger Sub-Screens
 * Covers: F-83 Compact metrics grid, F-84 (removed — moved to Insights),
 *         F-85 Quick links / action queues / navigation grid
 *
 * Design philosophy: Dashboard = launchpad ("what should I go do?")
 * Analytics/trends live in /insights.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock motion/react
vi.mock('motion/react', () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>>(
    function MotionDiv({ children, ...props }, ref) {
      const { variants, initial, animate, exit, transition, style, ...rest } = props;
      return <div ref={ref} style={style as React.CSSProperties} {...rest}>{children as React.ReactNode}</div>;
    }
  );
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const MOCK_DASHBOARD_DATA = {
  today: {
    totalOpen: 12,
    completedToday: 6,
    inProgress: 2,
    overdue: 1,
    completionPct: 75,
  },
  weeklyTrend: {
    days: [],
    streak: 5,
  },
  priorityDistribution: { critical: 2, high: 4, medium: 5, low: 1, none: 0 },
  queues: { triage: 7, sort: 14, overdue: 2 },
  recentActivity: [
    { id: '1', title: 'Draft roadmap talking points', completedAt: '2026-07-29T14:00:00Z', type: 'completed' },
    { id: '2', title: 'Review sync edge cases', completedAt: '2026-07-29T11:00:00Z', type: 'completed' },
  ],
  computedAt: '2026-07-29T18:00:00Z',
};

import { MobileDashboard } from '@/components/dashboard/mobile/MobileDashboard';

describe('MobileDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_DASHBOARD_DATA),
    });
  });

  it('renders loading skeleton initially', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<MobileDashboard />);
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  describe('F-83: Status snapshot (today metrics)', () => {
    it('renders today summary metrics', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
      expect(screen.getByText('18')).toBeInTheDocument(); // totalOpen + completedToday
      expect(screen.getByText('6')).toBeInTheDocument();  // done
      expect(screen.getByText('In Progress')).toBeInTheDocument();
      expect(screen.getByText('75% complete')).toBeInTheDocument();
    });
  });

  describe('F-85: Action queues (needs attention)', () => {
    it('renders action items with counts when queues have items', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Needs Attention')).toBeInTheDocument();
      });
      expect(screen.getByText('Process Triage')).toBeInTheDocument();
      expect(screen.getByText('7 pending')).toBeInTheDocument();
      expect(screen.getByText('Quick Sort')).toBeInTheDocument();
      expect(screen.getByText('14 unsorted')).toBeInTheDocument();
      expect(screen.getByText('Fix Overdue')).toBeInTheDocument();
      expect(screen.getByText('2 overdue')).toBeInTheDocument();
    });

    it('renders action queue links to correct pages', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Process Triage')).toBeInTheDocument();
      });
      const triageLink = screen.getByText('Process Triage').closest('a');
      expect(triageLink).toHaveAttribute('href', '/triage');
      const sortLink = screen.getByText('Quick Sort').closest('a');
      expect(sortLink).toHaveAttribute('href', '/quick-sort');
      const overdueLink = screen.getByText('Fix Overdue').closest('a');
      expect(overdueLink).toHaveAttribute('href', '/today');
    });

    it('shows "all caught up" when all queues are empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          ...MOCK_DASHBOARD_DATA,
          queues: { triage: 0, sort: 0, overdue: 0 },
        }),
      });
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('All caught up!')).toBeInTheDocument();
      });
    });
  });

  describe('F-85: Go To navigation grid', () => {
    it('renders navigation destinations', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Go To')).toBeInTheDocument();
      });
      expect(screen.getByText('My Day')).toBeInTheDocument();
      expect(screen.getByText('Triage')).toBeInTheDocument();
      expect(screen.getByText('Sort')).toBeInTheDocument();
      expect(screen.getByText('Goals')).toBeInTheDocument();
      expect(screen.getByText('Routines')).toBeInTheDocument();
      expect(screen.getByText('Insights')).toBeInTheDocument();
      expect(screen.getByText('Matrix')).toBeInTheDocument();
    });

    it('links to the correct routes', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Goals')).toBeInTheDocument();
      });
      expect(screen.getByText('Goals').closest('a')).toHaveAttribute('href', '/goals');
      expect(screen.getByText('Insights').closest('a')).toHaveAttribute('href', '/insights');
      expect(screen.getByText('My Day').closest('a')).toHaveAttribute('href', '/today');
      expect(screen.getByText('Matrix').closest('a')).toHaveAttribute('href', '/matrix');
    });
  });

  describe('Recent wins (momentum, not analytics)', () => {
    it('renders recent completed tasks', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Recent Wins')).toBeInTheDocument();
      });
      expect(screen.getByText('Draft roadmap talking points')).toBeInTheDocument();
      expect(screen.getByText('Review sync edge cases')).toBeInTheDocument();
    });
  });

  describe('Error handling', () => {
    it('shows error state on fetch failure', async () => {
      mockFetch.mockResolvedValue({ ok: false });
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Unable to load dashboard')).toBeInTheDocument();
      });
    });
  });

  describe('No analytics overlap with /insights', () => {
    it('does NOT render weekly trend chart', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
      expect(screen.queryByText('This Week')).not.toBeInTheDocument();
      expect(screen.queryByText('Mon')).not.toBeInTheDocument();
    });

    it('does NOT render priority distribution chart', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
      expect(screen.queryByText('Priority Distribution')).not.toBeInTheDocument();
    });

    it('does NOT render streak counter', async () => {
      render(<MobileDashboard />);
      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
      expect(screen.queryByText(/streak/i)).not.toBeInTheDocument();
    });
  });
});
