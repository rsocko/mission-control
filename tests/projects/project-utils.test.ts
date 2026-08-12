/**
 * Tests for the extracted project page utility functions.
 * Imports directly from the modular utils.ts file to verify the split preserved behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  toRgba,
  parseLocalDate,
  formatRelativeTime,
  getPhaseColor,
  getPhaseStatusColor,
  getTaskStatusColor,
  getConnectorIcon,
  getPriorityDotColor,
  getProgressSummary,
  getProjectTabCount,
  filterProjectTasks,
  sortTasks,
  buildGanttRows,
} from '@/app/projects/[id]/utils';
import type { ProjectPhase, ProjectRecord, PhaseTaskEntry, ProjectTask, PhaseItem } from '@/app/projects/[id]/types';
import { EMPTY_TASK_FILTER_CONTEXT, type TaskFilterContext } from '@/lib/task-filter-context';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

function makeProjectPhase(color: string | null): ProjectPhase {
  return {
    id: 'phase-1',
    projectId: 'project-1',
    name: 'Phase 1',
    description: null,
    status: 'pending',
    color,
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder: 0,
    completedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

function makeProjectRecord(color: string): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Project 1',
    description: null,
    color,
    icon: null,
    iconColor: null,
    sourceBindings: [],
    autoIncludeRules: [],
    kanbanColumns: [],
    defaultView: 'board',
    status: 'active',
    statusOverride: null,
    category: null,
    targetDate: null,
    startedAt: null,
    completedAt: null,
    sortOrder: 0,
    metadata: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

// ─── toRgba ─────────────────────────────────────────────────────────
describe('toRgba', () => {
  it('returns default blue when color is null', () => {
    expect(toRgba(null, 0.5)).toBe('rgba(59, 130, 246, 0.5)');
  });

  it('returns default blue when color is undefined', () => {
    expect(toRgba(undefined, 0.3)).toBe('rgba(59, 130, 246, 0.3)');
  });

  it('converts 6-digit hex', () => {
    expect(toRgba('#ff0000', 1)).toBe('rgba(255, 0, 0, 1)');
  });

  it('converts 3-digit hex', () => {
    expect(toRgba('#f00', 0.8)).toBe('rgba(255, 0, 0, 0.8)');
  });

  it('converts rgb() string', () => {
    expect(toRgba('rgb(10, 20, 30)', 0.5)).toBe('rgba(10, 20, 30, 0.5)');
  });

  it('returns non-matching strings as-is', () => {
    expect(toRgba('var(--accent-500)', 1)).toBe('var(--accent-500)');
  });

  it('applies alpha to CSS variables via color-mix', () => {
    expect(toRgba('var(--success)', 0.22)).toBe('color-mix(in srgb, var(--success) 22%, transparent)');
  });

  it('applies alpha to CSS variables at higher opacity', () => {
    expect(toRgba('var(--accent-500)', 0.85)).toBe('color-mix(in srgb, var(--accent-500) 85%, transparent)');
  });
});

// ─── parseLocalDate ─────────────────────────────────────────────────
describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD correctly', () => {
    const date = parseLocalDate('2024-03-15');
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(2); // March = 2
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(12); // noon to avoid UTC issues
  });

  it('handles ISO datetime by stripping time', () => {
    const date = parseLocalDate('2024-06-01T14:30:00Z');
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(5); // June = 5
    expect(date.getDate()).toBe(1);
  });
});

// ─── getProgressSummary ─────────────────────────────────────────────
describe('getProgressSummary', () => {
  it('handles empty task list', () => {
    const result = getProgressSummary([]);
    expect(result).toEqual({
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      todoTasks: 0,
      cancelledTasks: 0,
      percentComplete: 0,
    });
  });

  it('calculates correct percentages', () => {
    const tasks = [
      makeTask({ id: '1', title: 'a', status: 'done' }),
      makeTask({ id: '2', title: 'b', status: 'done' }),
      makeTask({ id: '3', title: 'c', status: 'in_progress' }),
      makeTask({ id: '4', title: 'd', status: 'todo' }),
    ];
    const result = getProgressSummary(tasks);
    expect(result.totalTasks).toBe(4);
    expect(result.completedTasks).toBe(2);
    expect(result.inProgressTasks).toBe(1);
    expect(result.todoTasks).toBe(1);
    expect(result.cancelledTasks).toBe(0);
    expect(result.percentComplete).toBe(50);
  });

  it('keeps cancelled tasks separate from remaining work', () => {
    const tasks = [
      makeTask({ id: '1', title: 'done', status: 'done' }),
      makeTask({ id: '2', title: 'active', status: 'in_progress' }),
      makeTask({ id: '3', title: 'todo', status: 'todo' }),
      makeTask({ id: '4', title: 'cancelled', status: 'cancelled' }),
    ];

    const result = getProgressSummary(tasks);

    expect(result.todoTasks).toBe(1);
    expect(result.cancelledTasks).toBe(1);
  });

  it('returns 100% when all done', () => {
    const tasks = [
      makeTask({ id: '1', title: 'a', status: 'done' }),
      makeTask({ id: '2', title: 'b', status: 'done' }),
    ];
    expect(getProgressSummary(tasks).percentComplete).toBe(100);
  });
});

describe('getProjectTabCount', () => {
  it('uses stable phase and task totals rather than filtered task results', () => {
    expect(getProjectTabCount('phases', 10, 110)).toBe(10);
    expect(getProjectTabCount('tasks', 10, 110)).toBe(110);
    expect(getProjectTabCount('overview', 10, 110)).toBeNull();
  });
});

// ─── getPriorityDotColor ────────────────────────────────────────────
describe('getPriorityDotColor', () => {
  it('maps critical to danger', () => {
    expect(getPriorityDotColor('critical')).toBe('var(--danger)');
  });

  it('maps high to warning', () => {
    expect(getPriorityDotColor('high')).toBe('var(--warning)');
  });

  it('maps none to border-strong', () => {
    expect(getPriorityDotColor('none')).toBe('var(--border-strong)');
  });
});

// ─── sortTasks ──────────────────────────────────────────────────────
describe('sortTasks', () => {
  const tasks = [
    { id: '1', title: 'Zebra', priority: 'low' as const, dueDate: '2024-03-10', updatedAt: '2024-01-01T00:00:00Z' },
    { id: '2', title: 'Apple', priority: 'critical' as const, dueDate: null, updatedAt: '2024-06-01T00:00:00Z' },
    { id: '3', title: 'Mango', priority: 'high' as const, dueDate: '2024-01-01', updatedAt: '2024-03-01T00:00:00Z' },
  ];

  it('sorts by priority ascending (critical first)', () => {
    const sorted = sortTasks(tasks, 'priority', 'asc');
    expect(sorted.map((t) => t.id)).toEqual(['2', '3', '1']);
  });

  it('sorts by priority descending (low first)', () => {
    const sorted = sortTasks(tasks, 'priority', 'desc');
    expect(sorted.map((t) => t.id)).toEqual(['1', '3', '2']);
  });

  it('sorts by title ascending', () => {
    const sorted = sortTasks(tasks, 'title', 'asc');
    expect(sorted.map((t) => t.title)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('sorts by dueDate ascending (null last)', () => {
    const sorted = sortTasks(tasks, 'dueDate', 'asc');
    expect(sorted.map((t) => t.id)).toEqual(['3', '1', '2']);
  });

  it('sorts by updated descending (oldest first due to double-inversion)', () => {
    const sorted = sortTasks(tasks, 'updated', 'desc');
    expect(sorted.map((t) => t.id)).toEqual(['1', '3', '2']);
  });

  it('sorts by updated ascending (most recent first)', () => {
    const sorted = sortTasks(tasks, 'updated', 'asc');
    expect(sorted.map((t) => t.id)).toEqual(['2', '3', '1']);
  });
});

describe('filterProjectTasks', () => {
  const context = (
    overrides: Partial<Omit<TaskFilterContext, 'version'>> = {},
  ): TaskFilterContext => ({
    ...EMPTY_TASK_FILTER_CONTEXT,
    ...overrides,
  });
  const tasks = [
    makeTask({
      id: 'open',
      title: 'Open design task',
      priority: 'high',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-work',
      sourceListId: 'repo',
      sourceListName: 'Mission Control',
      tags: [{ id: 'tag-ux', name: 'UX', slug: 'ux', type: 'hub', color: null }],
      projectPhaseMemberships: [{
        projectId: 'project-1',
        projectName: 'Project 1',
        phaseId: 'phase-1',
        phaseName: 'Design',
      }],
    }),
    makeTask({
      id: 'done',
      title: 'Completed implementation',
      status: 'done',
      projectPhaseMemberships: [{
        projectId: 'project-1',
        projectName: 'Project 1',
        phaseId: null,
        phaseName: null,
      }],
    }),
    makeTask({
      id: 'other-phase',
      title: 'Unassigned here',
      status: 'in_progress',
      sourceListName: 'Personal Board',
      connectorInstanceId: 'todo-personal',
      projectPhaseMemberships: [{
        projectId: 'project-2',
        projectName: 'Project 2',
        phaseId: 'phase-elsewhere',
        phaseName: 'Elsewhere',
      }, {
        projectId: 'project-1',
        projectName: 'Project 1',
        phaseId: null,
        phaseName: null,
      }],
    }),
  ];

  it('hides inactive tasks by default and exposes them when completion is all', () => {
    expect(filterProjectTasks(tasks, context(), 'project-1').map((task) => task.id))
      .toEqual(['open', 'other-phase']);
    expect(filterProjectTasks(tasks, context({ completion: 'all' }), 'project-1'))
      .toHaveLength(3);
  });

  it('lets an explicit status query override the default open-only scope', () => {
    expect(filterProjectTasks(tasks, context({ query: 'status:done' }), 'project-1')
      .map((task) => task.id)).toEqual(['done']);
  });

  it('keeps inactive tasks hidden for negated status queries while Done is off', () => {
    expect(filterProjectTasks(tasks, context({ query: '-status:todo' }), 'project-1')
      .map((task) => task.id)).toEqual(['other-phase']);
  });

  it('evaluates unassigned phase filters within the current project only', () => {
    expect(filterProjectTasks(tasks, context({ query: 'phase:none', completion: 'all' }), 'project-1')
      .map((task) => task.id)).toEqual(['done', 'other-phase']);
  });

  it('combines shared context filters with keyword filtering', () => {
    expect(filterProjectTasks(tasks, context({
      query: 'design',
      sources: ['github-issues'],
      listIds: ['github-work:repo'],
      tagSlugs: ['ux'],
      priorities: ['high'],
    }), 'project-1').map((task) => task.id)).toEqual(['open']);
  });

  it('matches context list IDs built from a list-name fallback', () => {
    expect(filterProjectTasks(tasks, context({
      listIds: ['todo-personal:personal board'],
    }), 'project-1').map((task) => task.id)).toEqual(['other-phase']);
  });
});

// ─── getPhaseColor ──────────────────────────────────────────────────
describe('getPhaseColor', () => {
  it('uses phase color when available', () => {
    expect(getPhaseColor(makeProjectPhase('#ff0000'), makeProjectRecord('#00ff00'))).toBe('#ff0000');
  });

  it('falls back to project color', () => {
    expect(getPhaseColor(makeProjectPhase(null), makeProjectRecord('#00ff00'))).toBe('#00ff00');
  });

  it('falls back to default accent', () => {
    expect(getPhaseColor(makeProjectPhase(null), null)).toBe('var(--accent-500)');
  });
});

// ─── formatRelativeTime ─────────────────────────────────────────────
describe('formatRelativeTime', () => {
  it('returns dash for null', () => {
    expect(formatRelativeTime(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('—');
  });

  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });
});

// ─── getConnectorIcon ───────────────────────────────────────────────
describe('getConnectorIcon', () => {
  it('maps local to the Stored Signal icon', () => {
    const icon = getConnectorIcon('local');
    expect(icon.displayName || icon.name).toBe('LocalSourceIcon');
  });

  it('maps github-issues to FolderGit2', () => {
    const icon = getConnectorIcon('github-issues');
    expect(icon.displayName || icon.name).toContain('FolderGit2');
  });

  it('maps microsoft-todo to ListTodo', () => {
    const icon = getConnectorIcon('microsoft-todo');
    expect(icon.displayName || icon.name).toContain('ListTodo');
  });

  it('maps ms-todo to ListTodo', () => {
    const icon = getConnectorIcon('ms-todo');
    expect(icon.displayName || icon.name).toContain('ListTodo');
  });

  it('defaults to ListChecks for unknown', () => {
    const icon = getConnectorIcon('unknown');
    expect(icon.displayName || icon.name).toContain('ListChecks');
  });
});

// ─── getPhaseStatusColor ────────────────────────────────────────────
describe('getPhaseStatusColor', () => {
  it('returns success for completed', () => {
    expect(getPhaseStatusColor('completed')).toBe('var(--success)');
  });
  it('returns accent for in_progress', () => {
    expect(getPhaseStatusColor('in_progress')).toBe('var(--accent-500)');
  });
  it('returns muted for pending', () => {
    expect(getPhaseStatusColor('pending')).toBe('var(--text-muted)');
  });
});

// ─── getTaskStatusColor ─────────────────────────────────────────────
describe('getTaskStatusColor', () => {
  it('returns success for done', () => {
    expect(getTaskStatusColor('done')).toBe('var(--success)');
  });
  it('returns accent for in_progress', () => {
    expect(getTaskStatusColor('in_progress')).toBe('var(--accent-500)');
  });
  it('returns warning for cancelled', () => {
    expect(getTaskStatusColor('cancelled')).toBe('var(--warning)');
  });
  it('returns muted for todo', () => {
    expect(getTaskStatusColor('todo')).toBe('var(--text-muted)');
  });
});

// ─── buildGanttRows ─────────────────────────────────────────────────

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 't1',
    title: 'Task',
    status: 'todo',
    priority: 'none',
    updatedAt: '2024-01-01T00:00:00Z',
    connectorType: 'local',
    connectorInstanceId: 'local',
    localDisposition: 'active',
    taskSourceModel: 'mc-owned',
    editPolicy: editableTaskPolicy,
    ...overrides,
  };
}

function makePhaseItem(overrides: Partial<PhaseItem> = {}): PhaseItem {
  return {
    id: 'pi1',
    phaseId: 'phase-1',
    taskId: 't1',
    sortOrder: 0,
    estimatedEffortHours: null,
    isProposed: false,
    proposalType: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildGanttRows', () => {
  const project = makeProjectRecord('#3b82f6');

  it('uses explicit phase start/end when both are set', () => {
    const phase = { ...makeProjectPhase(null), targetStart: '2024-03-01', targetEnd: '2024-03-10' };
    const rows = buildGanttRows([phase], {}, project);
    expect(rows[0].start.getDate()).toBe(1);
    expect(rows[0].end.getDate()).toBe(10);
    expect(rows[0].durationDays).toBe(10);
  });

  it('lets tasks dictate phase span when no explicit dates exist', () => {
    const phase = { ...makeProjectPhase(null), estimatedDays: null };
    const task1 = makeTask({ id: 't1', dueDate: '2024-06-05', status: 'todo' });
    const task2 = makeTask({ id: 't2', dueDate: '2024-06-20', status: 'todo' });
    const entries: Record<string, PhaseTaskEntry[]> = {
      [phase.id]: [
        { item: makePhaseItem({ id: 'pi1', taskId: 't1' }), task: task1 },
        { item: makePhaseItem({ id: 'pi2', taskId: 't2' }), task: task2 },
      ],
    };
    const projectWithStart = { ...project, startedAt: '2024-06-01T00:00:00Z' };
    const rows = buildGanttRows([phase], entries, projectWithStart);
    // Phase end should stretch to the latest task date (June 20)
    expect(rows[0].end.getMonth()).toBe(5); // June
    expect(rows[0].end.getDate()).toBe(20);
  });

  it('uses completedAt over dueDate for done tasks', () => {
    const phase = { ...makeProjectPhase(null), estimatedDays: null };
    const task = makeTask({
      id: 't1',
      status: 'done',
      dueDate: '2024-06-10',
      completedAt: '2024-06-08T12:00:00Z',
    });
    const entries: Record<string, PhaseTaskEntry[]> = {
      [phase.id]: [{ item: makePhaseItem(), task }],
    };
    const projectWithStart = { ...project, startedAt: '2024-06-01T00:00:00Z' };
    const rows = buildGanttRows([phase], entries, projectWithStart);
    // Task bar end should be June 8 (completedAt), not June 10 (dueDate)
    expect(rows[0].tasks[0].end.getDate()).toBe(8);
  });

  it('clusters tasks under phase when no dates exist', () => {
    const phase = { ...makeProjectPhase(null), estimatedDays: 5 };
    const task = makeTask({ id: 't1', dueDate: null, completedAt: null });
    const entries: Record<string, PhaseTaskEntry[]> = {
      [phase.id]: [{ item: makePhaseItem(), task }],
    };
    const rows = buildGanttRows([phase], entries, project);
    // Task bar should fall within the phase span
    expect(rows[0].tasks[0].start.getTime()).toBeGreaterThanOrEqual(rows[0].start.getTime());
    expect(rows[0].tasks[0].end.getTime()).toBeLessThanOrEqual(rows[0].end.getTime());
  });

  it('stretches phase-with-start when tasks fall beyond estimated end', () => {
    const phase = { ...makeProjectPhase(null), targetStart: '2024-06-01', estimatedDays: 5 };
    const task = makeTask({ id: 't1', dueDate: '2024-06-15', status: 'todo' });
    const entries: Record<string, PhaseTaskEntry[]> = {
      [phase.id]: [{ item: makePhaseItem(), task }],
    };
    const rows = buildGanttRows([phase], entries, project);
    // Phase end should stretch to June 15 (task due date > estimated end of June 5)
    expect(rows[0].end.getDate()).toBe(15);
  });
});
