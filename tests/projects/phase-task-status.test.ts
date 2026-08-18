import { describe, expect, it } from 'vitest';
import {
  filterCompletedTasks,
  getPhaseTaskStatusSummary,
  shouldCompactCompletedPhase,
} from '@/lib/projects/phase-task-status';

describe('phase task status', () => {
  it('identifies phase statuses that do not match their tasks', () => {
    expect(getPhaseTaskStatusSummary('in_progress', ['todo', 'todo']).mismatchMessage)
      .toBe('No tasks are currently in progress');
    expect(getPhaseTaskStatusSummary('in_progress', []).mismatchMessage)
      .toBe('Phase is in progress but has no tasks');
    expect(getPhaseTaskStatusSummary('in_progress', ['done', 'done']).mismatchMessage)
      .toBe('All tasks are complete but the phase is still in progress');
    expect(getPhaseTaskStatusSummary('pending', ['done']).mismatchMessage)
      .toBe('All tasks are complete but the phase is still pending');
    expect(getPhaseTaskStatusSummary('completed', ['done', 'todo']).mismatchMessage)
      .toBe('1 task is not complete');
  });

  it('does not flag phase and task statuses that agree', () => {
    expect(getPhaseTaskStatusSummary('pending', ['todo']).mismatchMessage).toBeNull();
    expect(getPhaseTaskStatusSummary('in_progress', ['todo', 'in_progress']).mismatchMessage).toBeNull();
    expect(getPhaseTaskStatusSummary('completed', ['done', 'done']).mismatchMessage).toBeNull();
    expect(getPhaseTaskStatusSummary('completed', []).mismatchMessage).toBeNull();
  });

  it('filters only completed tasks and compacts only fully hidden completed phases', () => {
    const tasks = [
      { id: 'todo', status: 'todo' as const },
      { id: 'done', status: 'done' as const },
      { id: 'cancelled', status: 'cancelled' as const },
    ];

    expect(filterCompletedTasks(tasks, false, (task) => task.status).map((task) => task.id))
      .toEqual(['todo', 'cancelled']);
    expect(filterCompletedTasks(tasks, true, (task) => task.status)).toEqual(tasks);
    expect(shouldCompactCompletedPhase('completed', 0, false)).toBe(true);
    expect(shouldCompactCompletedPhase('completed', 1, false)).toBe(false);
    expect(shouldCompactCompletedPhase('in_progress', 0, false)).toBe(false);
  });
});
