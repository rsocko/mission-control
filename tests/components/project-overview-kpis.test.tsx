import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectOverviewKpis } from '@/app/projects/[id]/components';

describe('ProjectOverviewKpis', () => {
  it('presents progress, task flow, and health as accessible visuals', () => {
    render(
      <ProjectOverviewKpis
        progress={{
          totalTasks: 20,
          completedTasks: 5,
          inProgressTasks: 3,
          todoTasks: 12,
          cancelledTasks: 0,
          percentComplete: 25,
        }}
        health={{
          health: 'on_track',
          message: 'Progress is tracking well against the current plan.',
        }}
      />,
    );

    expect(screen.getByRole('img', { name: '25% of project tasks complete' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '3 of 20 tasks in progress' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Project health: On track' })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('15% of tasks')).toBeInTheDocument();
  });

  it('handles a project without tasks', () => {
    render(
      <ProjectOverviewKpis
        progress={{
          totalTasks: 0,
          completedTasks: 0,
          inProgressTasks: 0,
          todoTasks: 0,
          cancelledTasks: 0,
          percentComplete: 0,
        }}
        health={{
          health: 'on_track',
          message: 'No schedule risks detected.',
        }}
      />,
    );

    expect(screen.getByText('No tasks assigned yet')).toBeInTheDocument();
    expect(screen.getByText('No active tasks right now.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '0 of 0 tasks in progress' })).toBeInTheDocument();
  });

  it('separates cancelled tasks from work left to do', () => {
    render(
      <ProjectOverviewKpis
        progress={{
          totalTasks: 4,
          completedTasks: 1,
          inProgressTasks: 1,
          todoTasks: 1,
          cancelledTasks: 1,
          percentComplete: 25,
        }}
        health={{
          health: 'at_risk',
          message: 'One milestone needs attention.',
        }}
      />,
    );

    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
});
