import { describe, expect, it } from 'vitest';
import {
  computeFlowReport,
  type FlowHistoryEventInput,
  type FlowTaskInput,
} from '@/lib/stats/flow';

const START = '2026-07-01T00:00:00.000Z';
const END = '2026-07-04T00:00:00.000Z';
const NOW = '2026-07-10T00:00:00.000Z';

function task(overrides: Partial<FlowTaskInput> = {}): FlowTaskInput {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'done',
    priority: 'high',
    source: 'github',
    projectIds: ['project-1'],
    ...overrides,
  };
}

function event(
  id: number,
  eventType: string,
  occurredAt: string,
  overrides: Partial<FlowHistoryEventInput> = {},
): FlowHistoryEventInput {
  return {
    id,
    taskId: 'task-1',
    eventType,
    previousValue: null,
    newValue: null,
    projectId: null,
    occurredAt,
    provenance: 'local',
    ...overrides,
  };
}

function baseline(
  id = 1,
  occurredAt = '2026-06-30T00:00:00.000Z',
  status = 'todo',
  projectIds = ['project-1'],
): FlowHistoryEventInput {
  return event(id, 'baseline', occurredAt, {
    newValue: JSON.stringify({ status, projectIds }),
  });
}

describe('computeFlowReport cycle time', () => {
  it('uses first active entry through final completion and exposes reopened rework', () => {
    const report = computeFlowReport({
      tasks: [task()],
      events: [
        baseline(),
        event(2, 'status_changed', '2026-07-01T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(3, 'status_changed', '2026-07-02T00:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
        event(4, 'reopened', '2026-07-02T12:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(5, 'status_changed', '2026-07-02T12:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(6, 'status_changed', '2026-07-03T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(7, 'status_changed', '2026-07-03T12:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cycleTime.items).toEqual([
      expect.objectContaining({
        startedAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-03T12:00:00.000Z',
        days: 2.5,
        reworkCount: 1,
      }),
    ]);
    expect(report.cycleTime.reworkedCount).toBe(1);
  });

  it('excludes completions without a recorded active transition', () => {
    const report = computeFlowReport({
      tasks: [task()],
      events: [
        baseline(1, '2026-07-01T00:00:00.000Z', 'in_progress'),
        event(2, 'status_changed', '2026-07-02T00:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cycleTime.count).toBe(0);
    expect(report.cycleTime.excludedWithoutStart).toBe(1);
  });

  it('uses an end-exclusive report boundary', () => {
    const report = computeFlowReport({
      tasks: [task()],
      events: [
        baseline(),
        event(2, 'status_changed', '2026-07-01T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(3, 'status_changed', END, {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cycleTime.count).toBe(0);
  });

  it('counts an explicit reopen before the recorded active entry as rework', () => {
    const report = computeFlowReport({
      tasks: [task()],
      events: [
        baseline(1, '2026-06-30T00:00:00.000Z', 'done'),
        event(2, 'reopened', '2026-07-01T00:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(3, 'status_changed', '2026-07-01T00:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(4, 'status_changed', '2026-07-02T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(5, 'status_changed', '2026-07-03T00:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cycleTime.items[0]).toEqual(expect.objectContaining({
      startedAt: '2026-07-02T00:00:00.000Z',
      reworkCount: 1,
    }));
    expect(report.cycleTime.reworkedCount).toBe(1);
  });

  it('places exact upper-day boundaries in their labeled buckets', () => {
    const durations = [3, 7, 30];
    const tasks = durations.map(days => task({
      id: `task-${days}`,
      title: `${days} day task`,
    }));
    const completion = '2026-07-02T00:00:00.000Z';
    const events = durations.flatMap((days, index) => {
      const taskId = `task-${days}`;
      const startedAt = new Date(Date.parse(completion) - days * 86_400_000).toISOString();
      return [
        { ...baseline(index * 3 + 1, '2026-05-01T00:00:00.000Z', 'todo'), taskId },
        event(index * 3 + 2, 'status_changed', startedAt, {
          taskId,
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(index * 3 + 3, 'status_changed', completion, {
          taskId,
          previousValue: 'in_progress',
          newValue: 'done',
        }),
      ];
    });
    const report = computeFlowReport({
      tasks,
      events,
      start: START,
      end: END,
      now: NOW,
    });

    expect(Object.fromEntries(
      report.cycleTime.distribution.map(bucket => [bucket.label, bucket.count]),
    )).toMatchObject({
      '1-3 days': 1,
      '4-7 days': 1,
      '15-30 days': 1,
      '> 30 days': 0,
    });
  });
});

describe('computeFlowReport cumulative flow', () => {
  it('replays same-timestamp events by ID and transitions status at day boundaries', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'in_progress' })],
      events: [
        event(3, 'status_changed', '2026-07-02T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(2, 'status_changed', '2026-07-01T12:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'todo',
        }),
        event(1, 'baseline', '2026-07-01T12:00:00.000Z', {
          newValue: JSON.stringify({ status: 'in_progress', projectIds: [] }),
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cumulativeFlow.points.map(point => ({
      date: point.date,
      todo: point.todo,
      inProgress: point.inProgress,
    }))).toEqual([
      { date: '2026-07-01', todo: 1, inProgress: 0 },
      { date: '2026-07-02', todo: 0, inProgress: 1 },
      { date: '2026-07-03', todo: 0, inProgress: 1 },
    ]);
  });

  it('applies project membership as of each daily snapshot', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'in_progress', projectIds: [] })],
      events: [
        baseline(1, '2026-06-30T00:00:00.000Z', 'in_progress', []),
        event(2, 'project_added', '2026-07-02T12:00:00.000Z', { projectId: 'project-1' }),
        event(3, 'project_removed', '2026-07-03T12:00:00.000Z', { projectId: 'project-1' }),
      ],
      start: START,
      end: END,
      now: NOW,
      filters: { projectId: 'project-1' },
    });

    expect(report.cumulativeFlow.points.map(point => point.knownTasks)).toEqual([0, 1, 0]);
  });

  it('respects same-timestamp project ordering at cycle completion', () => {
    const report = computeFlowReport({
      tasks: [task()],
      events: [
        baseline(1, '2026-06-30T00:00:00.000Z', 'todo', []),
        event(2, 'status_changed', '2026-07-01T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(3, 'status_changed', '2026-07-03T00:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
        event(4, 'project_added', '2026-07-03T00:00:00.000Z', { projectId: 'project-1' }),
      ],
      start: START,
      end: END,
      now: NOW,
      filters: { projectId: 'project-1' },
    });

    expect(report.cycleTime.count).toBe(0);
  });

  it('marks snapshots before migration history as unavailable without inferring state', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'todo' })],
      events: [
        event(1, 'baseline', '2026-07-02T12:00:00.000Z', {
          newValue: JSON.stringify({ status: 'todo', projectIds: [] }),
          provenance: 'migration_baseline',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.partialHistory).toBe(true);
    expect(report.cumulativeFlow.points.map(point => point.coverage))
      .toEqual(['unavailable', 'complete', 'complete']);
    expect(report.cumulativeFlow.points[0].knownTasks).toBe(0);
  });

  it('does not infer an end-of-day state for the current day', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'todo' })],
      events: [baseline()],
      start: START,
      end: '2026-07-11T00:00:00.000Z',
      now: '2026-07-10T12:00:00.000Z',
    });

    expect(report.cumulativeFlow.points.at(-1)?.date).toBe('2026-07-09');
  });
});

describe('computeFlowReport aging WIP', () => {
  it('ages from the latest entry into the current active status', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'in_progress' })],
      events: [
        baseline(),
        event(2, 'status_changed', '2026-07-01T00:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
        event(3, 'status_changed', '2026-07-04T00:00:00.000Z', {
          previousValue: 'in_progress',
          newValue: 'done',
        }),
        event(4, 'reopened', '2026-07-05T00:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(5, 'status_changed', '2026-07-05T00:00:00.000Z', {
          previousValue: 'done',
          newValue: 'todo',
        }),
        event(6, 'status_changed', '2026-07-07T12:00:00.000Z', {
          previousValue: 'todo',
          newValue: 'in_progress',
        }),
      ],
      start: START,
      end: END,
      now: NOW,
      staleThresholdDays: 2,
    });

    expect(report.agingWip.items[0]).toEqual(expect.objectContaining({
      enteredAt: '2026-07-07T12:00:00.000Z',
      ageDays: 2.5,
      stale: true,
    }));
  });

  it('excludes baseline-active tasks because entry time is unknown', () => {
    const report = computeFlowReport({
      tasks: [task({ status: 'in_progress' })],
      events: [baseline(1, '2026-07-01T00:00:00.000Z', 'in_progress')],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.agingWip.count).toBe(0);
    expect(report.agingWip.excludedWithoutEntry).toBe(1);
  });

  it('returns explicit empty reports', () => {
    const report = computeFlowReport({
      tasks: [],
      events: [],
      start: START,
      end: END,
      now: NOW,
    });

    expect(report.cycleTime.count).toBe(0);
    expect(report.cumulativeFlow.points).toHaveLength(3);
    expect(report.agingWip.items).toEqual([]);
    expect(report.agingWip.medianAgeDays).toBeNull();
  });
});
