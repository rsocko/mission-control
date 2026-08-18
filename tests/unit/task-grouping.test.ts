import { describe, expect, it } from 'vitest';
import { countLoadedTasksForGroup, getTaskGroupLabels } from '@/lib/tasks/task-grouping';
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
});
