import { describe, expect, it } from 'vitest';
import { buildPlanAlignment } from '@/lib/stats/insights';
import type {
  AnalyticsMyDayPlanningEvent,
  AnalyticsTaskCompletion,
} from '@/db/persistence/analytics';

function completion(id: string, completedAt: string): AnalyticsTaskCompletion {
  return { id, completedAt };
}

function event(
  id: number,
  taskId: string,
  eventType: AnalyticsMyDayPlanningEvent['eventType'],
  occurredAt: string,
): AnalyticsMyDayPlanningEvent {
  return { id, taskId, eventType, date: '2026-08-10', occurredAt };
}

describe('buildPlanAlignment', () => {
  it('separates planned and unplanned completions using commitment state at completion', () => {
    const completions = [
      completion('planned', '2026-08-10T10:00:00.000Z'),
      completion('unplanned', '2026-08-10T11:00:00.000Z'),
      completion('withdrawn', '2026-08-10T12:00:00.000Z'),
      completion('readded', '2026-08-10T13:00:00.000Z'),
    ];
    const events = [
      event(1, 'planned', 'my_day_committed', '2026-08-10T08:00:00.000Z'),
      event(2, 'withdrawn', 'my_day_committed', '2026-08-10T08:00:00.000Z'),
      event(3, 'withdrawn', 'my_day_withdrawn', '2026-08-10T09:00:00.000Z'),
      event(4, 'readded', 'my_day_committed', '2026-08-10T08:00:00.000Z'),
      event(5, 'readded', 'my_day_withdrawn', '2026-08-10T09:00:00.000Z'),
      event(6, 'readded', 'my_day_committed', '2026-08-10T09:30:00.000Z'),
      event(7, 'carryover', 'my_day_committed', '2026-08-10T08:00:00.000Z'),
      event(8, 'carryover', 'my_day_missed', '2026-08-11T04:00:00.000Z'),
    ];

    const result = buildPlanAlignment(completions, events, '2026-08-10', '2026-08-10');

    expect(result.points).toEqual([{
      date: '2026-08-10',
      committed: 3,
      plannedCompleted: 2,
      unplannedCompleted: 2,
      carryover: 1,
    }]);
    expect(result.totals).toEqual({
      committed: 3,
      plannedCompleted: 2,
      unplannedCompleted: 2,
      carryover: 1,
    });
    expect(result.planCoverage).toBe(50);
    expect(result.commitmentRate).toBe(67);
  });

  it('returns a complete zero-filled daily series and safe percentages', () => {
    const result = buildPlanAlignment([], [], '2026-08-10', '2026-08-12');

    expect(result.points).toHaveLength(3);
    expect(result.points.every(point => (
      point.committed === 0
      && point.plannedCompleted === 0
      && point.unplannedCompleted === 0
      && point.carryover === 0
    ))).toBe(true);
    expect(result.planCoverage).toBe(0);
    expect(result.commitmentRate).toBe(0);
  });
});
