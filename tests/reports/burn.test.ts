import { describe, expect, it } from 'vitest';
import type { TaskHistoryEvent } from '@/db/task-history';
import { buildBurnReport, EFFORT_COVERAGE_THRESHOLD } from '@/lib/reports/burn';

let nextId = 1;

function event(
  overrides: Partial<TaskHistoryEvent> & Pick<TaskHistoryEvent, 'taskId' | 'eventType' | 'occurredAt'>,
): TaskHistoryEvent {
  return {
    id: nextId++,
    fieldName: null,
    previousValue: null,
    newValue: null,
    projectId: null,
    phaseId: null,
    recordedAt: overrides.occurredAt,
    provenance: 'local',
    provenanceRef: null,
    metadata: null,
    ...overrides,
  };
}

function baseline(
  taskId: string,
  occurredAt: string,
  state: {
    status?: string;
    effort?: number | null;
    projectIds?: string[];
    phaseIds?: string[];
  } = {},
  provenance = 'local',
): TaskHistoryEvent {
  return event({
    taskId,
    eventType: 'baseline',
    occurredAt,
    provenance,
    newValue: JSON.stringify({
      status: state.status ?? 'todo',
      effort: state.effort ?? null,
      projectIds: state.projectIds ?? [],
      phaseIds: state.phaseIds ?? [],
    }),
  });
}

function report(
  overrides: Partial<Parameters<typeof buildBurnReport>[0]> = {},
) {
  return buildBurnReport({
    projectId: 'project-1',
    scope: 'project',
    scopeId: 'project-1',
    scopeName: 'Reporting',
    mode: 'count',
    startDate: '2026-07-01',
    endDate: '2026-07-05',
    scheduleStart: '2026-07-01',
    scheduleEnd: '2026-07-05',
    events: [],
    tasks: [],
    today: '2026-07-05',
    ...overrides,
  });
}

describe('burn report reconstruction', () => {
  it('marks values before a migration baseline as partial instead of inventing history', () => {
    const result = report({
      events: [
        baseline(
          'task-1',
          '2026-07-02T12:00:00.000Z',
          { projectIds: ['project-1'] },
          'migration_baseline',
        ),
      ],
    });

    expect(result.partialHistory).toBe(true);
    expect(result.completeFromDate).toBe('2026-07-02');
    expect(result.points[0].total).toBeNull();
    expect(result.points[1]).toMatchObject({
      date: '2026-07-02',
      total: 1,
      remaining: 1,
      partial: true,
    });
  });

  it('reconstructs migrated scope and completion from task lifecycle dates', () => {
    const result = report({
      startDate: '2026-07-09',
      endDate: '2026-08-07',
      today: '2026-08-07',
      events: [
        baseline(
          'task-1',
          '2026-08-07T12:00:00.000Z',
          { status: 'done', projectIds: ['project-1'] },
          'migration_baseline',
        ),
        baseline(
          'task-2',
          '2026-08-07T12:00:00.000Z',
          { projectIds: ['project-1'] },
          'migration_baseline',
        ),
      ],
      tasks: [
        {
          id: 'task-1',
          title: 'Completed task',
          createdAt: '2026-07-10T15:00:00.000Z',
          completedAt: '2026-07-20T18:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'Open task',
          createdAt: '2026-07-15T15:00:00.000Z',
          completedAt: null,
        },
      ],
    });

    expect(result.partialHistory).toBe(false);
    expect(result.completeFromDate).toBeNull();
    expect(result.points.find((point) => point.date === '2026-07-09')).toMatchObject({
      total: 0,
      completed: 0,
    });
    expect(result.points.find((point) => point.date === '2026-07-10')).toMatchObject({
      total: 1,
      completed: 0,
    });
    expect(result.points.find((point) => point.date === '2026-07-15')).toMatchObject({
      total: 2,
      completed: 0,
    });
    expect(result.points.find((point) => point.date === '2026-07-20')).toMatchObject({
      total: 2,
      completed: 1,
    });
  });

  it.each(['done', 'cancelled'])(
    'keeps pre-migration history partial for a migrated %s task without a closure date',
    (status) => {
      const result = report({
        startDate: '2026-07-09',
        endDate: '2026-08-07',
        today: '2026-08-07',
        events: [
          baseline(
            'task-1',
            '2026-08-07T12:00:00.000Z',
            { status, projectIds: ['project-1'] },
            'migration_baseline',
          ),
        ],
        tasks: [{
          id: 'task-1',
          title: 'Terminal task',
          createdAt: '2026-07-10T15:00:00.000Z',
          completedAt: null,
        }],
      });

      expect(result.partialHistory).toBe(true);
      expect(result.completeFromDate).toBe('2026-08-07');
      expect(result.points.find((point) => point.date === '2026-07-10')?.total).toBeNull();
    },
  );

  it('reconstructs project scope additions and removals on the day they occur', () => {
    const result = report({
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z'),
        event({
          taskId: 'task-1',
          eventType: 'project_added',
          projectId: 'project-1',
          occurredAt: '2026-07-02T10:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'project_removed',
          projectId: 'project-1',
          occurredAt: '2026-07-04T10:00:00.000Z',
        }),
      ],
    });

    expect(result.points.map((point) => point.total)).toEqual([0, 1, 1, 0, 0]);
  });

  it('treats recently organized project tasks as scoped from their creation dates', () => {
    const result = report({
      startDate: '2025-03-24',
      endDate: '2025-04-02',
      today: '2026-08-08',
      events: [
        baseline('task-1', '2026-08-07T08:00:00.000Z'),
        event({
          taskId: 'task-1',
          eventType: 'project_added',
          projectId: 'project-1',
          occurredAt: '2026-08-07T10:00:00.000Z',
        }),
      ],
      tasks: [{
        id: 'task-1',
        title: 'Older open task',
        createdAt: '2025-03-25T15:00:00.000Z',
        completedAt: null,
      }],
    });

    expect(result.points.find((point) => point.date === '2025-03-24')).toMatchObject({
      total: 0,
      completed: 0,
    });
    expect(result.points.find((point) => point.date === '2025-03-25')).toMatchObject({
      total: 1,
      completed: 0,
    });
  });

  it('uses a known closure date for a completed task organized into a project later', () => {
    const result = report({
      startDate: '2025-03-24',
      endDate: '2025-04-02',
      today: '2026-08-08',
      events: [
        baseline('task-1', '2026-08-07T08:00:00.000Z', { status: 'done' }),
        event({
          taskId: 'task-1',
          eventType: 'project_added',
          projectId: 'project-1',
          occurredAt: '2026-08-07T10:00:00.000Z',
        }),
      ],
      tasks: [{
        id: 'task-1',
        title: 'Older completed task',
        createdAt: '2025-03-25T15:00:00.000Z',
        completedAt: '2025-03-30T12:00:00.000Z',
      }],
    });

    expect(result.points.find((point) => point.date === '2025-03-25')).toMatchObject({
      total: 1,
      completed: 0,
    });
    expect(result.points.find((point) => point.date === '2025-03-30')).toMatchObject({
      total: 1,
      completed: 1,
    });
  });

  it('moves completed work back to remaining when reopened and forward when recompleted', () => {
    const result = report({
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z', {
          status: 'done',
          projectIds: ['project-1'],
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'done',
          newValue: 'todo',
          occurredAt: '2026-07-02T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'reopened',
          previousValue: 'done',
          newValue: 'todo',
          occurredAt: '2026-07-02T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'todo',
          newValue: 'done',
          occurredAt: '2026-07-03T09:00:00.000Z',
        }),
      ],
    });

    expect(result.points.slice(0, 3).map(({ completed, remaining }) => (
      [completed, remaining]
    ))).toEqual([[1, 0], [0, 1], [1, 0]]);
  });

  it('removes cancelled work from scope and restores it when reopened', () => {
    const result = report({
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z', {
          projectIds: ['project-1'],
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'todo',
          newValue: 'cancelled',
          occurredAt: '2026-07-02T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'cancelled',
          newValue: 'todo',
          occurredAt: '2026-07-03T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'reopened',
          previousValue: 'cancelled',
          newValue: 'todo',
          occurredAt: '2026-07-03T09:00:00.000Z',
        }),
      ],
    });

    expect(result.points.slice(0, 3).map(({ total, remaining }) => (
      [total, remaining]
    ))).toEqual([[1, 1], [0, 0], [1, 1]]);
    expect(result.points.slice(0, 3).map(({ cancelled }) => cancelled)).toEqual([0, 1, 0]);
  });

  it('reconstructs each workflow status for cumulative flow reporting', () => {
    const result = report({
      events: [
        baseline('todo', '2026-07-01T08:00:00.000Z', {
          projectIds: ['project-1'],
        }),
        baseline('active', '2026-07-01T08:00:00.000Z', {
          status: 'in_progress',
          projectIds: ['project-1'],
        }),
        baseline('done', '2026-07-01T08:00:00.000Z', {
          status: 'done',
          projectIds: ['project-1'],
        }),
        baseline('cancelled', '2026-07-01T08:00:00.000Z', {
          status: 'cancelled',
          projectIds: ['project-1'],
        }),
      ],
      tasks: [
        { id: 'todo', title: 'Todo' },
        { id: 'active', title: 'Active' },
        { id: 'done', title: 'Done' },
        { id: 'cancelled', title: 'Cancelled' },
      ],
    });

    expect(result.points.at(-1)).toMatchObject({
      todo: 1,
      inProgress: 1,
      completed: 1,
      cancelled: 1,
      statusTaskIds: {
        todo: ['todo'],
        inProgress: ['active'],
        done: ['done'],
        cancelled: ['cancelled'],
      },
    });
    expect(result.tasks).toHaveLength(4);
  });

  it('moves work through every cumulative-flow status on the observed day', () => {
    const result = report({
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z', {
          projectIds: ['project-1'],
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'todo',
          newValue: 'in_progress',
          occurredAt: '2026-07-02T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'in_progress',
          newValue: 'done',
          occurredAt: '2026-07-03T09:00:00.000Z',
        }),
        event({
          taskId: 'task-1',
          eventType: 'status_changed',
          previousValue: 'done',
          newValue: 'cancelled',
          occurredAt: '2026-07-04T09:00:00.000Z',
        }),
      ],
    });

    expect(result.points.slice(0, 4).map((point) => [
      point.todo,
      point.inProgress,
      point.completed,
      point.cancelled,
    ])).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it('applies effort changes and enables effort reporting once coverage is sufficient', () => {
    const result = report({
      mode: 'effort',
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z', {
          effort: 3,
          projectIds: ['project-1'],
        }),
        baseline('task-2', '2026-07-01T08:00:00.000Z', {
          status: 'done',
          projectIds: ['project-1'],
        }),
        event({
          taskId: 'task-2',
          eventType: 'effort_changed',
          previousValue: null,
          newValue: '2',
          occurredAt: '2026-07-02T09:00:00.000Z',
        }),
      ],
    });

    expect(result.points[0]).toMatchObject({
      total: 3,
      completed: 0,
      effortCoverage: 0.5,
      estimateIncomplete: true,
    });
    expect(result.points[1]).toMatchObject({
      total: 5,
      completed: 2,
      effortCoverage: 1,
      estimateIncomplete: false,
    });
    expect(result.effort.available).toBe(true);
  });

  it('explains when too few tasks have effort estimates', () => {
    const events = Array.from({ length: 5 }, (_, index) => baseline(
      `task-${index + 1}`,
      '2026-07-01T08:00:00.000Z',
      {
        effort: index < 3 ? index + 1 : null,
        projectIds: ['project-1'],
      },
    ));
    const result = report({ mode: 'effort', events });

    expect(result.effort).toMatchObject({
      available: false,
      coverage: 0.6,
      estimatedTasks: 3,
      totalTasks: 5,
      threshold: EFFORT_COVERAGE_THRESHOLD,
    });
    expect(result.effort.message).toContain('3 of 5');
  });

  it('keeps effort estimates usable but labeled incomplete at the coverage threshold', () => {
    const events = Array.from({ length: 5 }, (_, index) => baseline(
      `task-${index + 1}`,
      '2026-07-01T08:00:00.000Z',
      {
        effort: index < 4 ? index + 1 : null,
        projectIds: ['project-1'],
      },
    ));
    const result = report({ mode: 'effort', events });

    expect(result.effort.available).toBe(true);
    expect(result.effort.coverage).toBe(0.8);
    expect(result.effort.message).toContain('4 of 5');
  });

  it('omits an ideal trajectory when dates are not defensible', () => {
    const result = report({
      scheduleEnd: null,
      events: [
        baseline('task-1', '2026-07-01T08:00:00.000Z', {
          projectIds: ['project-1'],
        }),
      ],
    });

    expect(result.ideal.available).toBe(false);
    expect(result.ideal.message).toContain('both a start and target date');
    expect(result.points.every((point) => point.idealRemaining === null)).toBe(true);
  });

  it('returns an honest empty phase report', () => {
    const result = report({
      scope: 'phase',
      scopeId: 'phase-1',
      scopeName: 'Design',
      scheduleStart: null,
      scheduleEnd: null,
    });

    expect(result.points.every((point) => (
      point.total === 0 && point.completed === 0 && point.remaining === 0
    ))).toBe(true);
    expect(result.tasks).toEqual([]);
    expect(result.effort.available).toBe(true);
  });
});
