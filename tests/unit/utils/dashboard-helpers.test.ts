import { describe, expect, it } from 'vitest';
import {
  removeTaskFromResponse,
  replaceTaskInKeywordFilteredResponse,
  restoreTaskToResponse,
} from '@/lib/utils/dashboard-helpers';
import type { Task, TaskResponse } from '@/types/dashboard';
import { editableTaskPolicy } from '../../fixtures/task-edit-policy';

const task = (id: string): Task => ({
  id,
  title: id,
  status: 'todo',
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  microStatus: null,
  priority: 'high',
  dueDate: null,
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListName: 'Inbox',
  assignee: null,
  tags: [],
  metadata: null,
  sourceId: null,
  hasDescription: false,
  editPolicy: editableTaskPolicy,
});

const response = (tasks: Task[]): TaskResponse => ({
  tasks,
  total: tasks.length,
  hasMore: false,
  sourceCounts: { local: tasks.length },
  availableTags: [],
  stats: {
    totalOpen: tasks.length,
    overdue: 0,
    dueThisWeek: 0,
    highPriority: tasks.length,
    assignedToMe: tasks.length,
    myDay: 0,
    recentlyCreated: 0,
    recentlyClosed: 0,
    waiting: 0,
    inbox: tasks.length,
  },
});

describe('restoreTaskToResponse', () => {
  it('does not change scoped totals when the task is no longer visible', () => {
    const current = response([task('visible')]);
    const absent = task('absent');

    expect(removeTaskFromResponse(current, absent.id, absent)).toBe(current);
  });

  it('restores only the failed task when multiple completions overlap', () => {
    const first = task('first');
    const second = task('second');
    const afterFirstRemoval = removeTaskFromResponse(response([first, second]), first.id, first);
    const afterBothRemovals = removeTaskFromResponse(afterFirstRemoval, second.id, second);

    const restored = restoreTaskToResponse(afterBothRemovals, first, 0);

    expect(restored.tasks.map((candidate) => candidate.id)).toEqual(['first']);
    expect(restored.total).toBe(1);
    expect(restored.sourceCounts.local).toBe(1);
    expect(restored.stats.totalOpen).toBe(1);
  });
});

describe('replaceTaskInKeywordFilteredResponse', () => {
  it.each([
    {
      type: 'assignee',
      matching: { assignee: null },
      selected: { assignee: 'alice' },
    },
    {
      type: 'due',
      matching: { dueDate: null },
      selected: { dueDate: '2026-08-07' },
    },
    {
      type: 'list',
      matching: { sourceListId: null, sourceListName: null },
      selected: { sourceListId: 'backlog', sourceListName: 'Backlog' },
    },
    {
      type: 'phase',
      matching: {
        projectPhaseMemberships: [{
          projectId: 'project-1',
          projectName: 'Project 1',
          phaseId: null,
          phaseName: null,
        }],
      },
      selected: {
        projectPhaseMemberships: [{
          projectId: 'project-1',
          projectName: 'Project 1',
          phaseId: 'phase-1',
          phaseName: 'Delivery',
        }],
      },
    },
    {
      type: 'priority',
      matching: { priority: 'none' },
      selected: { priority: 'high' },
    },
    {
      type: 'project',
      matching: { hubProjectIds: [], projectPhaseMemberships: [] },
      selected: {
        hubProjectIds: ['project-1'],
        projectPhaseMemberships: [{
          projectId: 'project-1',
          projectName: 'Project 1',
          phaseId: null,
          phaseName: null,
        }],
      },
    },
    {
      type: 'tag',
      matching: { tags: [] },
      selected: {
        tags: [{
          id: 'tag-1',
          name: 'Feature',
          slug: 'feature',
          type: 'label',
          color: null,
        }],
      },
    },
  ] satisfies Array<{
    type: string;
    matching: Partial<Task>;
    selected: Partial<Task>;
  }>)('removes a task that no longer matches $type:none', ({ type, matching, selected }) => {
    const unset = { ...task('unset'), ...matching };
    const current = response([unset, task('other')]);
    const updatedTask = { ...unset, ...selected };

    const updated = replaceTaskInKeywordFilteredResponse(current, updatedTask, `${type}:none`);

    expect(updated.tasks.map((candidate) => candidate.id)).toEqual(['other']);
    expect(updated.total).toBe(1);
    expect(updated.sourceCounts.local).toBe(1);
  });

  it('keeps and replaces a task that still matches the active filter', () => {
    const unassigned = task('unassigned');
    const current = response([unassigned]);
    const updatedTask = { ...unassigned, title: 'Updated title' };

    const updated = replaceTaskInKeywordFilteredResponse(current, updatedTask, 'project:none');

    expect(updated.tasks).toEqual([updatedTask]);
    expect(updated.total).toBe(1);
  });

  it('reconciles negated none filters', () => {
    const assigned = {
      ...task('assigned'),
      hubProjectIds: ['project-1'],
      projectPhaseMemberships: [{
        projectId: 'project-1',
        projectName: 'Project 1',
        phaseId: null,
        phaseName: null,
      }],
    };
    const current = response([assigned]);
    const unassigned = {
      ...assigned,
      hubProjectIds: [],
      projectPhaseMemberships: [],
    };

    const updated = replaceTaskInKeywordFilteredResponse(current, unassigned, '-project:none');

    expect(updated.tasks).toEqual([]);
    expect(updated.total).toBe(0);
  });
});
