import { describe, expect, it } from 'vitest';
import {
  effortPosition,
  getMatrixPaginationDecision,
  markerDensityScale,
  markerDiameter,
  priorityPosition,
  urgencyScore,
} from '@/lib/matrix/scales';
import { createMatrixMarks, projectTasks } from '@/lib/matrix/projection';
import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const TODAY = '2026-07-31';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Matrix task',
    status: 'todo',
    microStatus: null,
    priority: 'high',
    dueDate: TODAY,
    connectorType: 'local',
    connectorInstanceId: 'local',
    sourceListName: null,
    assignee: null,
    tags: [],
    metadata: null,
    sourceId: null,
    effort: 3,
    smartScore: 64,
    hasDescription: false,
    editPolicy: editableTaskPolicy,
    ...overrides,
    localDisposition: overrides.localDisposition ?? 'active',
    taskSourceModel: overrides.taskSourceModel ?? 'mc-owned',
    hasDescription: overrides.hasDescription ?? false,
  };
}

describe('matrix scales', () => {
  it('maps explicit priorities and effort values to stable bands', () => {
    expect(priorityPosition('critical')).toBe(100);
    expect(priorityPosition('high')).toBe(75);
    expect(priorityPosition('medium')).toBe(50);
    expect(priorityPosition('low')).toBe(25);
    expect(priorityPosition('none')).toBeNull();
    expect([1, 2, 3, 4, 5].map(effortPosition)).toEqual([0, 25, 50, 75, 100]);
  });

  it('calculates urgency from local calendar dates and interpolates anchors', () => {
    expect(urgencyScore('2026-07-30', TODAY)).toMatchObject({ value: 100, state: 'overdue' });
    expect(urgencyScore(TODAY, TODAY)).toMatchObject({ value: 95, state: 'today' });
    expect(urgencyScore('2026-08-01', TODAY).value).toBe(85);
    expect(urgencyScore('2026-08-05', TODAY).value).toBe(55);
    expect(urgencyScore(null, TODAY)).toMatchObject({ value: 0, state: 'none' });
    expect(urgencyScore('not-a-date', TODAY)).toMatchObject({ value: null, state: 'invalid' });
  });

  it('uses planning horizons only when no due date is present', () => {
    expect(urgencyScore(null, TODAY, 'now')).toMatchObject({
      value: 85,
      state: 'horizon',
      source: 'planning-horizon',
    });
    expect(urgencyScore(null, TODAY, 'next').value).toBe(55);
    expect(urgencyScore(null, TODAY, 'later').value).toBe(25);
    expect(urgencyScore(null, TODAY, 'someday').value).toBe(5);
    expect(urgencyScore(TODAY, TODAY, 'someday')).toMatchObject({
      value: 95,
      state: 'today',
      source: 'due-date',
    });
    expect(urgencyScore('not-a-date', TODAY, 'now')).toMatchObject({
      value: null,
      state: 'invalid',
      source: 'due-date',
    });
  });

  it('maps marker area from the selected metric and exposes missing values', () => {
    expect(markerDiameter(task(), 50, 'uniform')).toEqual({ diameter: 12, missing: false });
    expect(markerDiameter(task({ effort: 1 }), 50, 'effort')).toEqual({ diameter: 8, missing: false });
    expect(markerDiameter(task({ effort: null }), 50, 'effort')).toEqual({ diameter: 8, missing: true });
    expect(markerDiameter(task({ smartScore: 100 }), 50, 'smart-score').diameter).toBe(18);
    expect(markerDiameter(task(), null, 'urgency')).toEqual({ diameter: 8, missing: true });
  });

  it('expands markers when a filter leaves only a few visible tasks', () => {
    expect(markerDensityScale(10, 900, 560)).toBeGreaterThan(1.5);
    expect(markerDensityScale(300, 900, 560)).toBe(1);
    expect(markerDensityScale(0, 900, 560)).toBe(1);
  });
});

describe('matrix projection', () => {
  it('reports every missing field without treating no due date as invalid', () => {
    const tasks = [
      task({ id: 'valid' }),
      task({ id: 'priority', priority: 'none', effort: null, dueDate: null }),
      task({ id: 'effort', effort: null }),
      task({ id: 'date', dueDate: 'invalid' }),
      task({ id: 'no-date', dueDate: null }),
      task({ id: 'horizon', dueDate: null, planningHorizon: 'now' }),
    ];
    const urgency = projectTasks(tasks, 'priority-urgency', TODAY);
    expect(urgency.tasks.map((item) => item.task.id)).toContain('no-date');
    expect(urgency.needsData.missingPriority).toHaveLength(1);
    expect(urgency.needsData.missingEffort).toHaveLength(2);
    expect(urgency.needsData.missingPlanningSignal).toHaveLength(2);
    expect(urgency.needsData.invalidDueDate).toHaveLength(1);
    expect(urgency.horizonFallback.map((item) => item.id)).toEqual(['horizon']);
    expect(urgency.tasks.find((item) => item.task.id === 'horizon')).toMatchObject({
      x: 85,
      urgency: 85,
      urgencyState: 'horizon',
    });

    const effort = projectTasks(tasks, 'priority-effort', TODAY);
    expect(effort.needsData.missingEffort).toHaveLength(2);
    expect(effort.tasks.map((item) => item.task.id)).toContain('date');
    expect(effort.tasks.find((item) => item.task.id === 'date')).toMatchObject({
      urgency: null,
      urgencyState: 'invalid',
    });
  });

  describe('matrix pagination', () => {
    it('waits for replacement results after a filter change, then loads each page once', () => {
      const reset = getMatrixPaginationDecision(
        { signature: 'priority:high', count: 50 },
        'priority:low',
        50,
        false,
        true,
      );
      expect(reset).toEqual({
        cursor: { signature: 'priority:low', count: -1 },
        shouldLoad: false,
      });

      const load = getMatrixPaginationDecision(reset.cursor, 'priority:low', 50, false, true);
      expect(load.shouldLoad).toBe(true);
      expect(getMatrixPaginationDecision(load.cursor, 'priority:low', 50, false, true).shouldLoad).toBe(false);
    });
  });

  it('clusters dense tasks and reveals individuals at high zoom', () => {
    const projected = projectTasks(
      Array.from({ length: 180 }, (_, index) => task({ id: `task-${index}` })),
      'priority-urgency',
      TODAY,
    ).tasks;
    expect(createMatrixMarks(projected, 800, 600, 1).some((mark) => mark.kind === 'cluster')).toBe(true);
    expect(createMatrixMarks(projected, 800, 600, 4)).toHaveLength(180);
  });

  it('keeps very large datasets aggregated at maximum zoom', () => {
    const projected = projectTasks(
      Array.from({ length: 5_000 }, (_, index) => task({ id: `large-${index}` })),
      'priority-urgency',
      TODAY,
    ).tasks;
    expect(createMatrixMarks(projected, 800, 600, 4).length).toBeLessThan(1_000);
  });

  it('keeps collision placement stable when task input order changes', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => task({ id }));
    const forward = createMatrixMarks(projectTasks(tasks, 'priority-urgency', TODAY).tasks, 800, 600, 4);
    const reversed = createMatrixMarks(projectTasks([...tasks].reverse(), 'priority-urgency', TODAY).tasks, 800, 600, 4);
    const positions = (marks: typeof forward) => Object.fromEntries(marks.map((mark) => [
      mark.kind === 'task' ? mark.item.task.id : mark.id,
      [mark.x, mark.y],
    ]));
    expect(positions(reversed)).toEqual(positions(forward));
  });

  it('spreads nearby low-density tasks while keeping their semantic quadrant', () => {
    const projected = projectTasks(
      ['a', 'b', 'c', 'd'].map((id) => task({ id })),
      'priority-urgency',
      TODAY,
    ).tasks;
    const marks = createMatrixMarks(projected, 800, 600, 1);
    const positions = marks.map((mark) => [mark.x, mark.y]);

    expect(new Set(positions.map(([x, y]) => `${x}:${y}`))).toHaveLength(4);
    expect(positions.every(([x, y]) => x >= 50 && y >= 62.5)).toBe(true);
  });
});
