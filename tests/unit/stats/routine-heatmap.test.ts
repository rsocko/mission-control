import { describe, expect, it } from 'vitest';
import {
  buildRoutineHeatmapDays,
  getRoutineWeekContext,
} from '@/lib/stats/routine-heatmap';

const WEEK_MONDAY = '2026-07-27';

describe('buildRoutineHeatmapDays', () => {
  it('keeps future daily routine days neutral', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-07-31',
      cadenceType: 'daily',
      config: {},
      completionDates: ['2026-07-28'],
    })).toEqual([false, true, false, false, false, null, null]);
  });

  it('only marks past configured weekdays as missed', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-07-31',
      cadenceType: 'specific_days',
      config: { days: [1, 3, 6] },
      completionDates: [],
    })).toEqual([false, null, false, null, null, null, null]);
  });

  it('uses the prior completion when evaluating every-N-days routines', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-07-31',
      cadenceType: 'every_n_days',
      config: { minDays: 1, maxDays: 2 },
      completionDates: ['2026-07-31'],
      priorCompletionDate: '2026-07-26',
    })).toEqual([null, null, false, false, true, null, null]);
  });

  it('only marks an unmet X-per-week target missed at the end of the week', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-08-02',
      cadenceType: 'x_per_week',
      config: { target: 3 },
      completionDates: ['2026-07-27', '2026-07-28'],
    })).toEqual([true, true, null, null, null, null, false]);
  });

  it('keeps the rest of the week neutral once an X-per-week target is met', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-08-02',
      cadenceType: 'x_per_week',
      config: { target: 2 },
      completionDates: ['2026-07-27', '2026-07-28'],
    })).toEqual([true, true, null, null, null, null, null]);
  });

  it('only marks an incomplete weekly routine missed on Sunday', () => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-08-02',
      cadenceType: 'weekly',
      config: {},
      completionDates: [],
    })).toEqual([null, null, null, null, null, null, false]);
  });

  it.each(['monthly', 'quarterly'])('keeps %s routine gaps neutral', cadenceType => {
    expect(buildRoutineHeatmapDays({
      weekMonday: WEEK_MONDAY,
      today: '2026-08-02',
      cadenceType,
      config: {},
      completionDates: [],
    })).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('getRoutineWeekContext', () => {
  it('keeps Sunday evening in the current local week after UTC rolls to Monday', () => {
    expect(getRoutineWeekContext(
      new Date('2026-08-17T01:00:00.000Z'),
      'America/New_York',
    )).toEqual({
      today: '2026-08-16',
      weekMonday: '2026-08-10',
    });
  });
});
