import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectOverviewKpis } from '@/app/projects/[id]/components';

describe('ProjectOverviewKpis', () => {
  it('presents progress, task flow, and Pulse evidence accessibly', () => {
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
        pulse={{
          state: 'on_track',
          legacyHealth: 'on_track',
          summary: 'Progress is tracking well against the current plan.',
          reasons: [],
          freshness: { state: 'fresh', label: 'Active today', daysSinceActivity: 0 },
          trend: { state: 'improving', label: '5 completed this week' },
          confidence: { level: 'high', label: 'Strong evidence' },
          suggestion: null,
        }}
      />,
    );

    expect(screen.getByRole('img', { name: '25% of project tasks complete' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '3 of 20 tasks in progress' })).toBeInTheDocument();
    expect(screen.getByText('Project pulse')).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('Fresh')).toBeInTheDocument();
    expect(screen.getByText('Improving')).toBeInTheDocument();
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
        pulse={{
          state: 'unknown',
          legacyHealth: 'on_track',
          summary: 'No tasks are assigned, so delivery cannot be assessed yet.',
          reasons: [{ code: 'no_tasks', detail: 'No tasks are assigned, so delivery cannot be assessed yet.' }],
          freshness: { state: 'unknown', label: 'No activity yet', daysSinceActivity: null },
          trend: { state: 'unknown', label: 'Not enough recent history' },
          confidence: { level: 'low', label: 'Limited evidence' },
          suggestion: 'Add the first task to make progress measurable.',
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
        pulse={{
          state: 'watch',
          legacyHealth: 'at_risk',
          summary: 'One milestone needs attention.',
          reasons: [{ code: 'phase_deadline', detail: 'One milestone needs attention.' }],
          freshness: { state: 'aging', label: 'Active 8 days ago', daysSinceActivity: 8 },
          trend: { state: 'stable', label: 'No completion trend yet' },
          confidence: { level: 'medium', label: 'Some schedule gaps' },
          suggestion: 'Confirm the next deliverable for the ending phase.',
        }}
      />,
    );

    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('One milestone needs attention.')).toBeInTheDocument();
    expect(screen.getByText(/Confirm the next deliverable/)).toBeInTheDocument();
  });
});
