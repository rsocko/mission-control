import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ProjectsPortfolioDashboard,
  type PortfolioProject,
  type PortfolioSummary,
} from '@/components/projects/ProjectsPortfolioDashboard';

function makeProject(
  id: string,
  overrides: Partial<PortfolioProject> = {},
): PortfolioProject {
  return {
    id,
    name: `Project ${id}`,
    color: '#3b82f6',
    icon: null,
    category: null,
    status: 'active',
    targetDate: '2026-09-15',
    phases: [{
      id: `${id}-phase`,
      name: `Phase ${id}`,
      status: 'in_progress',
      color: '#3b82f6',
      totalTasks: 4,
      completedTasks: 2,
      inProgressTasks: 1,
      percentComplete: 50,
    }],
    progress: {
      totalTasks: 4,
      completedTasks: 2,
      inProgressTasks: 1,
      percentComplete: 50,
      health: 'on_track',
      lastActivity: '2026-08-12T12:00:00.000Z',
    },
    ...overrides,
  };
}

const summary: PortfolioSummary = {
  totalProjects: 9,
  activeProjects: 9,
  completedProjects: 0,
  atRiskProjects: 1,
  totalTasks: 36,
  completedTasks: 18,
  inProgressTasks: 9,
  portfolioPercent: 50,
  completedThisWeek: 3,
};

function renderDashboard() {
  const categories = Array.from({ length: 9 }, (_, index) => {
    const project = makeProject(`${index + 1}`, index === 0
      ? {
          name: 'Launch control',
          targetDate: '2026-08-20',
          progress: {
            totalTasks: 4,
            completedTasks: 1,
            inProgressTasks: 1,
            percentComplete: 25,
            health: 'at_risk',
            lastActivity: '2026-08-13T12:00:00.000Z',
          },
        }
      : {});
    return { category: `Category ${index + 1}`, projects: [project] };
  });

  return render(
    <ProjectsPortfolioDashboard
      categories={categories}
      uncategorized={[]}
      summary={summary}
    />,
  );
}

describe('ProjectsPortfolioDashboard', () => {
  it('supports category expansion, drill-down, and direct phase navigation', () => {
    renderDashboard();

    expect(screen.getAllByRole('img', { name: /tasks complete/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getAllByRole('img', { name: /tasks complete/ })).toHaveLength(9);

    fireEvent.click(screen.getByRole('button', { name: /Category 1: 25% of tasks complete/ }));
    expect(screen.getByText('Category 1 projects')).toBeInTheDocument();
    expect(screen.queryByText('Project 2')).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Open Phase 1 phase in Launch control' }))
      .toHaveAttribute('href', '/projects/1?tab=phases&phase=1-phase');
    fireEvent.click(screen.getByRole('button', { name: 'All categories' }));
    expect(screen.getByText('Project 2')).toBeInTheDocument();
  });

  it('changes view content and searches project phases', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('tab', { name: 'Project health' }));
    expect(screen.getAllByText('Needs attention')).toHaveLength(2);
    expect(screen.getAllByText('Launch control')).toHaveLength(2);
    expect(screen.queryByText('Project 2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Target timeline' }));
    expect(screen.getByText('Target runway')).toBeInTheDocument();
    expect(screen.queryByText('Portfolio by category')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.change(screen.getByPlaceholderText('Find a project or phase…'), {
      target: { value: 'Phase 2' },
    });
    expect(screen.getByText('Project 2')).toBeInTheDocument();
    expect(screen.queryByText('Launch control')).not.toBeInTheDocument();
  });
});
