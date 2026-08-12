import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PortfolioVisuals } from '@/components/projects/PortfolioVisuals';
import type { PortfolioVisualCategory } from '@/lib/projects-overview/visuals';

const categories: PortfolioVisualCategory[] = [
  {
    category: 'Design',
    projects: [
      {
        id: 'design-1',
        name: 'Design system',
        color: '#8b5cf6',
        status: 'active',
        targetDate: '2026-08-20',
        progress: {
          totalTasks: 10,
          completedTasks: 6,
          percentComplete: 60,
          health: 'on_track',
        },
      },
    ],
  },
  {
    category: 'Platform',
    projects: [
      {
        id: 'platform-1',
        name: 'API refresh',
        color: '#06b6d4',
        status: 'active',
        targetDate: null,
        progress: {
          totalTasks: 30,
          completedTasks: 9,
          percentComplete: 30,
          health: 'at_risk',
        },
      },
    ],
  },
];

describe('PortfolioVisuals', () => {
  it('offers completion, workload, and health chart concepts', () => {
    render(<PortfolioVisuals categories={categories} uncategorized={[]} />);

    expect(screen.getByRole('img', { name: 'Design: 60% of tasks complete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Workload' }));
    expect(screen.getByRole('img', { name: 'Task workload across 2 categories' })).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Health' }));
    expect(screen.getByRole('img', { name: 'Platform: 0 on track, 1 at risk, 0 behind' })).toBeInTheDocument();
    expect(screen.getAllByText('need attention')).toHaveLength(2);
  });
});
