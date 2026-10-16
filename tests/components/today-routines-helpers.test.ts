import { describe, expect, it } from 'vitest';
import {
  getQuickActionLimit,
  getRoutineDetail,
  groupTodayRoutines,
  type TodayRoutine,
} from '@/components/routines/today-routines';

const TODAY = '2026-07-29';

function routine(overrides: Partial<TodayRoutine> & Pick<TodayRoutine, 'id' | 'name'>): TodayRoutine {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    icon: null,
    cadenceType: 'daily',
    cadenceConfig: {},
    sortOrder: 0,
    streak: 0,
    weekCompletions: [],
    intervalStatus: null,
    weeklyProgress: null,
    ...rest,
  };
}

describe('today routine grouping', () => {
  it('promotes due routines and keeps on-track flexible routines available separately', () => {
    const result = groupTodayRoutines([
      routine({
        id: 'on-track',
        name: 'Clean coffee maker',
        cadenceType: 'every_n_days',
        intervalStatus: { status: 'on_track', daysSinceLast: 1, progressPercent: 25 },
      }),
      routine({
        id: 'due',
        name: 'Water plants',
        cadenceType: 'every_n_days',
        intervalStatus: { status: 'due_soon', daysSinceLast: 3, progressPercent: 80 },
      }),
      routine({
        id: 'scheduled',
        name: 'Read',
        cadenceType: 'specific_days',
        cadenceConfig: { days: [3] },
      }),
      routine({
        id: 'not-scheduled',
        name: 'Run',
        cadenceType: 'specific_days',
        cadenceConfig: { days: [4] },
      }),
    ], TODAY);

    expect(result.promoted.map(({ id }) => id)).toEqual(['due', 'scheduled']);
    expect(result.other.map(({ id }) => id)).toEqual(['on-track', 'not-scheduled']);
  });

  it('promotes weekly targets only when every remaining day is needed', () => {
    const result = groupTodayRoutines([
      routine({
        id: 'weekly-urgent',
        name: 'Exercise',
        cadenceType: 'x_per_week',
        cadenceConfig: { target: 5 },
        weeklyProgress: { done: 0, target: 5, isOver: false, bonus: 0 },
      }),
      routine({
        id: 'weekly-on-track',
        name: 'Journal',
        cadenceType: 'x_per_week',
        cadenceConfig: { target: 3 },
        weeklyProgress: { done: 1, target: 3, isOver: false, bonus: 0 },
      }),
    ], TODAY);

    expect(result.promoted.map(({ id }) => id)).toEqual(['weekly-urgent']);
    expect(result.other.map(({ id }) => id)).toEqual(['weekly-on-track']);
  });

  it('sorts incomplete promoted routines before completed routines', () => {
    const result = groupTodayRoutines([
      routine({
        id: 'complete',
        name: 'Completed first by sort order',
        sortOrder: 0,
        weekCompletions: [{ date: TODAY, id: 'completion-1' }],
      }),
      routine({
        id: 'incomplete',
        name: 'Incomplete',
        sortOrder: 1,
      }),
    ], TODAY);

    expect(result.promoted.map(({ id }) => id)).toEqual(['incomplete', 'complete']);
  });

  it('selects compact quick-action counts by available width', () => {
    expect(getQuickActionLimit(420)).toBe(2);
    expect(getQuickActionLimit(560)).toBe(3);
    expect(getQuickActionLimit(700)).toBe(4);
    expect(getQuickActionLimit(900)).toBe(6);
  });

  it('explains cadence and due timing instead of using a generic due-soon label', () => {
    expect(getRoutineDetail(routine({
      id: 'weekly',
      name: 'Weekly review',
      cadenceType: 'weekly',
      intervalStatus: { status: 'due_soon', daysSinceLast: 7, progressPercent: 100 },
    }))).toBe('Weekly · due today');

    expect(getRoutineDetail(routine({
      id: 'interval',
      name: 'Water plants',
      cadenceType: 'every_n_days',
      cadenceConfig: { minDays: 3, maxDays: 4 },
      intervalStatus: { status: 'overdue_soft', daysSinceLast: 6, progressPercent: 100 },
    }))).toBe('Every 3-4 days · overdue by 2 days');

    expect(getRoutineDetail(routine({
      id: 'target',
      name: 'Exercise',
      cadenceType: 'x_per_week',
      cadenceConfig: { target: 4 },
      weeklyProgress: { done: 3, target: 4, isOver: false, bonus: 0 },
    }))).toBe('4x/week · 3 of 4 complete');
  });

  it('keeps cadence visible after completion', () => {
    expect(getRoutineDetail(routine({
      id: 'weekdays',
      name: 'Read',
      cadenceType: 'specific_days',
      cadenceConfig: { days: [1, 2, 3, 4, 5] },
    }), true)).toBe('Weekdays · completed today');
  });
});
