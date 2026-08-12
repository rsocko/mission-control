import { describe, expect, it } from 'vitest';
import {
  buildCategoryPortfolioRows,
  buildDeadlineRunway,
  type PortfolioVisualProject,
} from '@/lib/projects-overview/visuals';

function makeProject(overrides: Partial<PortfolioVisualProject>): PortfolioVisualProject {
  return {
    id: 'project-1',
    name: 'Project one',
    color: '#3b82f6',
    status: 'active',
    targetDate: null,
    progress: {
      totalTasks: 4,
      completedTasks: 2,
      percentComplete: 50,
      health: 'on_track',
    },
    ...overrides,
  };
}

describe('project portfolio visuals', () => {
  it('builds task-weighted category progress and health counts', () => {
    const rows = buildCategoryPortfolioRows(
      [
        {
          category: 'Home',
          projects: [
            makeProject({
              id: 'small',
              progress: { totalTasks: 2, completedTasks: 2, percentComplete: 100, health: 'on_track' },
            }),
            makeProject({
              id: 'large',
              progress: { totalTasks: 8, completedTasks: 2, percentComplete: 25, health: 'behind' },
            }),
          ],
        },
        {
          category: 'Learning',
          projects: [makeProject({ id: 'learning', progress: { totalTasks: 0, completedTasks: 0, percentComplete: 0, health: 'at_risk' } })],
        },
      ],
      [makeProject({ id: 'uncategorized' })],
    );

    expect(rows.map(row => row.category)).toEqual(['Home', 'Learning', 'Uncategorized']);
    expect(rows[0]).toMatchObject({
      projectCount: 2,
      totalTasks: 10,
      percentComplete: 40,
      health: { on_track: 1, at_risk: 0, behind: 1 },
    });
    expect(rows[1].percentComplete).toBe(0);
  });

  it('orders active project targets by calendar day and excludes finished projects', () => {
    const projects = [
      makeProject({ id: 'later', name: 'Later', targetDate: '2026-08-20' }),
      makeProject({ id: 'overdue', name: 'Overdue', targetDate: '2026-08-03' }),
      makeProject({ id: 'today', name: 'Today', targetDate: '2026-08-05' }),
      makeProject({ id: 'completed', status: 'completed', targetDate: '2026-08-01' }),
      makeProject({ id: 'invalid', targetDate: 'not-a-date' }),
      makeProject({ id: 'invalid-calendar-day', targetDate: '2026-02-31' }),
    ];

    const runway = buildDeadlineRunway(
      [{ category: 'Work', projects }],
      [],
      new Date(2026, 7, 5, 18, 30),
    );

    expect(runway.map(project => project.id)).toEqual(['overdue', 'today', 'later']);
    expect(runway.map(project => project.daysRemaining)).toEqual([-2, 0, 15]);
  });

  it('honors the runway item limit', () => {
    const projects = Array.from({ length: 7 }, (_, index) => makeProject({
      id: `project-${index}`,
      targetDate: `2026-08-${String(index + 10).padStart(2, '0')}`,
    }));

    expect(buildDeadlineRunway(
      [{ category: 'Work', projects }],
      [],
      new Date(2026, 7, 5),
      3,
    )).toHaveLength(3);
  });
});
