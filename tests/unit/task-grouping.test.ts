import { describe, expect, it } from 'vitest';
import {
  countLoadedTasksForGroup,
  getTaskGroupLabels,
  resolveGroupLoadOffset,
  updateGroupCountsForTaskChange,
} from '@/lib/tasks/task-grouping';
import type { DashboardTaskViewModel as Task } from '@/types/dashboard';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    status: 'todo',
    priority: 'none',
    connectorType: 'local',
    ...overrides,
  } as Task;
}

describe('task grouping', () => {
  it('supports every selectable single-value grouping', () => {
    const value = task({
      connectorType: 'github-issues',
      sourceListName: 'Backlog',
      status: 'in_progress',
      priority: 'high',
      effort: 3,
      dueDate: '2026-08-18',
    });

    expect(getTaskGroupLabels(value, 'source', '')).toEqual(['github-issues']);
    expect(getTaskGroupLabels(value, 'list', '')).toEqual(['Backlog']);
    expect(getTaskGroupLabels(value, 'status', '')).toEqual(['In Progress']);
    expect(getTaskGroupLabels(value, 'priority', '')).toEqual(['high']);
    expect(getTaskGroupLabels(value, 'effort', '')).toEqual(['3']);
    expect(getTaskGroupLabels(value, 'dueDate', '2026-08-18')).toEqual(['Today']);
  });

  it('uses the same empty-value labels as grouped count queries', () => {
    const value = task({
      connectorType: '',
      sourceListName: '',
      effort: null,
      dueDate: null,
    });

    expect(getTaskGroupLabels(value, 'source', '')).toEqual(['local']);
    expect(getTaskGroupLabels(value, 'list', '')).toEqual(['No List']);
    expect(getTaskGroupLabels(value, 'effort', '')).toEqual(['No Effort']);
    expect(getTaskGroupLabels(value, 'dueDate', '2026-08-18')).toEqual(['No Due Date']);
  });

  it('deduplicates repeated many-to-many group labels for one task', () => {
    const value = task({
      tags: [
        { id: 'tag-1', name: 'Work', slug: 'work', type: 'hub', color: null },
        { id: 'tag-2', name: 'Work', slug: 'work-copy', type: 'hub', color: null },
      ],
      projectPhaseMemberships: [
        {
          projectId: 'project-1',
          projectName: 'Mission Control',
          phaseId: 'phase-1',
          phaseName: 'Build',
        },
        {
          projectId: 'project-1',
          projectName: 'Mission Control',
          phaseId: 'phase-1',
          phaseName: 'Build',
        },
      ],
    });

    expect(getTaskGroupLabels(value, 'tag', '')).toEqual(['Work']);
    expect(getTaskGroupLabels(value, 'project', '')).toEqual(['Mission Control › Build']);
  });

  it('does not treat tasks loaded through another group as an initial group prefix', () => {
    const sharedTask = task({
      id: 'shared',
      tags: [
        { id: 'tag-1', name: 'Work', slug: 'work', type: 'hub', color: null },
        { id: 'tag-2', name: 'Urgent', slug: 'urgent', type: 'hub', color: null },
      ],
    });

    expect(countLoadedTasksForGroup(
      [sharedTask],
      'tag',
      'Urgent',
      '',
      new Set(['shared']),
    )).toBe(0);
  });

  it('decrements a group total when a visible task is completed', () => {
    expect(updateGroupCountsForTaskChange(
      { 'To Do': 29, 'In Progress': 12 },
      'status',
      '',
      task({ status: 'todo' }),
      null,
    )).toEqual({
      'To Do': 28,
      'In Progress': 12,
    });
  });

  it('moves group totals when a grouped field changes', () => {
    expect(updateGroupCountsForTaskChange(
      { 'To Do': 29, Completed: 4 },
      'status',
      '',
      task({ status: 'todo' }),
      task({ status: 'done' }),
    )).toEqual({
      'To Do': 28,
      Completed: 5,
    });
  });

  it('resets a stale group offset when a refresh removes group-loaded tasks', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task({
      id: `initial-${index}`,
      status: 'in_progress',
    }));

    expect(resolveGroupLoadOffset({
      tasks,
      groupBy: 'status',
      groupLabel: 'In Progress',
      today: '',
      loadedTaskGroups: new Map([['previously-loaded', 'In Progress']]),
      savedOffset: 28,
    })).toEqual({
      offset: 6,
      staleTaskIds: ['previously-loaded'],
      staleGroupLabels: ['In Progress'],
    });
  });

  it('retains a valid group offset while group-loaded tasks remain visible', () => {
    const tasks = [
      task({ id: 'initial', status: 'in_progress' }),
      task({ id: 'group-loaded', status: 'in_progress' }),
    ];

    expect(resolveGroupLoadOffset({
      tasks,
      groupBy: 'status',
      groupLabel: 'In Progress',
      today: '',
      loadedTaskGroups: new Map([['group-loaded', 'In Progress']]),
      savedOffset: 12,
    })).toEqual({
      offset: 12,
      staleTaskIds: [],
      staleGroupLabels: [],
    });
  });

  it('keeps unaffected group offsets when another group loses a loaded task', () => {
    const tasks = [
      task({ id: 'urgent-loaded', tags: [
        { id: 'urgent', name: 'Urgent', slug: 'urgent', type: 'hub', color: null },
      ] }),
    ];

    expect(resolveGroupLoadOffset({
      tasks,
      groupBy: 'tag',
      groupLabel: 'Urgent',
      today: '',
      loadedTaskGroups: new Map([
        ['work-loaded', 'Work'],
        ['urgent-loaded', 'Urgent'],
      ]),
      savedOffset: 12,
    })).toEqual({
      offset: 12,
      staleTaskIds: ['work-loaded'],
      staleGroupLabels: ['Work'],
    });
  });

  it('resets the source group offset when a loaded task moves to another group', () => {
    expect(resolveGroupLoadOffset({
      tasks: [task({ id: 'moved-task', status: 'done' })],
      groupBy: 'status',
      groupLabel: 'In Progress',
      today: '',
      loadedTaskGroups: new Map([['moved-task', 'In Progress']]),
      savedOffset: 12,
    })).toEqual({
      offset: 0,
      staleTaskIds: ['moved-task'],
      staleGroupLabels: ['In Progress'],
    });
  });
});
