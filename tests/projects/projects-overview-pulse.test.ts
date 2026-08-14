import { describe, expect, it } from 'vitest';
import {
  buildPortfolioPulse,
  sortProjectsAlphabetically,
  topLevelProjectTasks,
  type OverviewProject,
  type OverviewTask,
} from '@/lib/projects-overview';

function makeProject(overrides: Partial<OverviewProject>): OverviewProject {
  return {
    id: 'project-1',
    name: 'Project one',
    color: '#3b82f6',
    sourceBindings: [],
    autoIncludeRules: [],
    kanbanColumns: [],
    defaultView: 'list',
    status: 'active',
    sortOrder: 0,
    metadata: {},
    tags: [],
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-20T12:00:00.000Z',
    progress: {
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      percentComplete: 0,
      health: 'on_track',
    },
    ...overrides,
  };
}

function makeTask(overrides: Partial<OverviewTask>): OverviewTask {
  return {
    id: 'task-1',
    title: 'Task one',
    status: 'todo',
    parentId: null,
    dueDate: null,
    updatedAt: '2026-07-20T12:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('sortProjectsAlphabetically', () => {
  it('sorts projects alphabetically without using persisted manual order', () => {
    const projects = [
      makeProject({ id: 'ux', name: 'UX Polish', sortOrder: -10 }),
      makeProject({ id: 'ios', name: 'iOS Mobile UX', sortOrder: 100 }),
      makeProject({ id: 'insights', name: 'Insights', sortOrder: 0 }),
      makeProject({ id: 'project-10', name: 'Project 10', sortOrder: 1 }),
      makeProject({ id: 'project-2', name: 'Project 2', sortOrder: 2 }),
    ];

    expect(sortProjectsAlphabetically(projects).map(project => project.id)).toEqual([
      'insights',
      'ios',
      'project-2',
      'project-10',
      'ux',
    ]);
  });
});

describe('buildPortfolioPulse', () => {
  it('keeps project totals scoped to top-level tasks', () => {
    expect(topLevelProjectTasks([
      makeTask({ id: 'parent' }),
      makeTask({ id: 'child', parentId: 'parent' }),
    ]).map(task => task.id)).toEqual(['parent']);
  });

  it('computes unique task totals and current-week completions', () => {
    const projects = [
      makeProject({ id: 'project-1' }),
      makeProject({ id: 'project-2', name: 'Project two' }),
    ];
    const projectTaskIds = new Map([
      ['project-1', ['done-this-week', 'shared']],
      ['project-2', ['shared', 'done-last-week']],
    ]);
    const taskMap = new Map<string, OverviewTask>([
      ['done-this-week', makeTask({
        id: 'done-this-week',
        status: 'done',
        completedAt: '2026-07-28T12:00:00.000Z',
      })],
      ['shared', makeTask({ id: 'shared', status: 'in_progress' })],
      ['done-last-week', makeTask({
        id: 'done-last-week',
        status: 'done',
        completedAt: '2026-07-26T12:00:00.000Z',
      })],
      ['cancelled', makeTask({ id: 'cancelled', status: 'cancelled' })],
    ]);
    projectTaskIds.get('project-2')?.push('cancelled');

    const result = buildPortfolioPulse(
      projects,
      projectTaskIds,
      taskMap,
      new Date('2026-07-29T18:00:00.000Z'),
    );

    expect(result.taskSummary).toEqual({
      totalTasks: 3,
      completedTasks: 2,
      inProgressTasks: 1,
      portfolioPercent: 67,
      completedThisWeek: 1,
    });
  });

  it('orders active projects by activity and selects the latest open task', () => {
    const projects = [
      makeProject({
        id: 'older',
        name: 'Older project',
        progress: {
          totalTasks: 1,
          completedTasks: 0,
          inProgressTasks: 0,
          percentComplete: 0,
          health: 'on_track',
          lastActivity: '2026-07-20T12:00:00.000Z',
        },
      }),
      makeProject({
        id: 'newer',
        name: 'Newer project',
        progress: {
          totalTasks: 2,
          completedTasks: 0,
          inProgressTasks: 1,
          percentComplete: 0,
          health: 'on_track',
          lastActivity: '2026-07-29T12:00:00.000Z',
        },
      }),
      makeProject({ id: 'completed', status: 'completed' }),
    ];
    const projectTaskIds = new Map([
      ['older', ['older-task']],
      ['newer', ['newer-task', 'newest-task']],
      ['completed', []],
    ]);
    const taskMap = new Map<string, OverviewTask>([
      ['older-task', makeTask({ id: 'older-task' })],
      ['newer-task', makeTask({ id: 'newer-task', title: 'Earlier next step', updatedAt: '2026-07-28T12:00:00.000Z' })],
      ['newest-task', makeTask({ id: 'newest-task', title: 'Latest next step', updatedAt: '2026-07-29T12:00:00.000Z' })],
    ]);

    const result = buildPortfolioPulse(projects, projectTaskIds, taskMap);

    expect(result.recentProjects.map(project => project.id)).toEqual(['newer', 'older']);
    expect(result.recentProjects[0].nextTask).toEqual({
      id: 'newest-task',
      title: 'Latest next step',
    });
  });

  it('returns recent completed items with project context', () => {
    const projects = [makeProject({ id: 'project-1', name: 'Launch' })];
    const projectTaskIds = new Map([['project-1', ['older', 'newer']]]);
    const taskMap = new Map<string, OverviewTask>([
      ['older', makeTask({
        id: 'older',
        title: 'Write plan',
        status: 'done',
        completedAt: '2026-07-27T12:00:00.000Z',
      })],
      ['newer', makeTask({
        id: 'newer',
        title: 'Ship launch',
        status: 'done',
        completedAt: '2026-07-29T12:00:00.000Z',
      })],
    ]);

    const result = buildPortfolioPulse(projects, projectTaskIds, taskMap);

    expect(result.recentCompletedItems.map(item => item.title)).toEqual(['Ship launch', 'Write plan']);
    expect(result.recentCompletedItems[0]).toMatchObject({
      projectId: 'project-1',
      projectName: 'Launch',
      projectColor: '#3b82f6',
    });
  });

  it('shows a completed task linked to multiple projects only once', () => {
    const projects = [
      makeProject({ id: 'project-1', name: 'Launch' }),
      makeProject({ id: 'project-2', name: 'Marketing' }),
    ];
    const projectTaskIds = new Map([
      ['project-1', ['shared-win']],
      ['project-2', ['shared-win']],
    ]);
    const taskMap = new Map<string, OverviewTask>([
      ['shared-win', makeTask({
        id: 'shared-win',
        title: 'Ship announcement',
        status: 'done',
        completedAt: '2026-07-29T12:00:00.000Z',
      })],
    ]);

    const result = buildPortfolioPulse(projects, projectTaskIds, taskMap);

    expect(result.recentCompletedItems).toHaveLength(1);
    expect(result.recentCompletedItems[0].taskId).toBe('shared-win');
  });
});
