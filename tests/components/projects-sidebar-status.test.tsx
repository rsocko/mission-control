import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsSidebar } from '@/components/projects/ProjectsSidebar';

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const progress = {
  totalTasks: 4,
  completedTasks: 4,
  inProgressTasks: 0,
  percentComplete: 100,
  health: 'on_track',
  lastActivity: null,
};

describe('ProjectsSidebar project status indicators', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects-overview') {
        return {
          ok: true,
          json: async () => ({
            categories: [],
            uncategorized: [
              {
                id: 'active-project',
                name: 'Healthy Project',
                color: '#22c55e',
                icon: null,
                category: null,
                status: 'active',
                progress: { ...progress, percentComplete: 50 },
                metadata: {},
              },
              {
                id: 'completed-project',
                name: 'Completed Project',
                color: '#22c55e',
                icon: null,
                category: null,
                status: 'completed',
                progress,
                metadata: {},
              },
            ],
            summary: {
              totalProjects: 2,
              activeProjects: 1,
              completedProjects: 1,
              atRiskProjects: 0,
            },
          }),
        } as Response;
      }
      if (url === '/api/project-phases') {
        return { ok: true, json: async () => ({ phases: [] }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('renders completed projects with a larger, distinct status treatment', async () => {
    render(<ProjectsSidebar collapsed={false} onCollapsedChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Completed Project')).toBeInTheDocument());

    const completedIndicator = screen.getByLabelText('Completed');
    const healthyIndicator = screen.getByLabelText('On Track');
    const completedLink = screen.getByRole('link', { name: /Completed Project/ });

    expect(completedIndicator).toHaveClass('h-5', 'w-5', 'bg-sky-500/15', 'text-sky-400');
    expect(healthyIndicator).toHaveClass('h-1.5', 'w-1.5');
    expect(completedLink).toHaveClass('bg-sky-500/[0.04]');
  });

  it('places Cancelled immediately before Done in the status filters', async () => {
    render(<ProjectsSidebar collapsed={false} onCollapsedChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Completed Project')).toBeInTheDocument());

    const statusFilters = screen.getAllByRole('button')
      .filter((button) => ['Active', 'On Hold', 'Not Started', 'Cancelled', 'Done'].includes(button.getAttribute('aria-label') ?? ''));

    expect(statusFilters.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Active',
      'On Hold',
      'Not Started',
      'Cancelled',
      'Done',
    ]);
  });
});
