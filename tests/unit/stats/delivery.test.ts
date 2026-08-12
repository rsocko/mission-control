import { describe, expect, it } from 'vitest';
import {
  buildDeliveryMetrics,
  getInclusivePeriodBoundaries,
  percentile,
  type DeliveryTaskRecord,
} from '@/lib/stats/delivery';

function record(overrides: Partial<DeliveryTaskRecord> = {}): DeliveryTaskRecord {
  return {
    id: 'task-1',
    title: 'Ship report',
    createdAt: '2026-06-30T12:00:00.000Z',
    completedAt: '2026-07-01T12:00:00.000Z',
    source: 'github',
    statusReason: 'completed',
    ...overrides,
  };
}

describe('buildDeliveryMetrics', () => {
  it('builds adjacent inclusive periods with exactly the requested number of days', () => {
    expect(getInclusivePeriodBoundaries('2026-07-31', 7)).toEqual({
      periodStart: '2026-07-25',
      previousPeriodStart: '2026-07-18',
      previousPeriodEnd: '2026-07-24',
    });
  });

  it('returns stable zero-valued weekly intervals for empty data', () => {
    const metrics = buildDeliveryMetrics([], {
      startDate: '2026-07-01',
      endDate: '2026-07-14',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.total).toBe(0);
    expect(metrics.throughput.points.map(point => ({
      start: point.start,
      end: point.end,
      count: point.count,
      partial: point.isPartial,
    }))).toEqual([
      { start: '2026-06-29', end: '2026-07-05', count: 0, partial: true },
      { start: '2026-07-06', end: '2026-07-12', count: 0, partial: false },
      { start: '2026-07-13', end: '2026-07-19', count: 0, partial: true },
    ]);
    expect(metrics.leadTime.summary.medianDays).toBeNull();
  });

  it('uses Monday boundaries and the requested local timezone', () => {
    const metrics = buildDeliveryMetrics([
      record({ id: 'sunday-local', completedAt: '2026-07-06T00:30:00.000Z' }),
      record({ id: 'monday-local', completedAt: '2026-07-06T05:00:00.000Z' }),
      record({ id: 'next-monday', completedAt: '2026-07-13T12:00:00.000Z' }),
    ], {
      startDate: '2026-07-05',
      endDate: '2026-07-13',
      interval: 'week',
      timeZone: 'America/New_York',
    });

    expect(metrics.throughput.points.map(point => point.count)).toEqual([1, 1, 1]);
    expect(metrics.throughput.points.map(point => point.start)).toEqual([
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
    ]);
  });

  it('normalizes partial buckets before calculating velocity', () => {
    const records = Array.from({ length: 7 }, (_, index) => record({
      id: `task-${index}`,
      completedAt: `2026-07-${String(index + 8).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const metrics = buildDeliveryMetrics(records, {
      startDate: '2026-07-08',
      endDate: '2026-07-14',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.points.map(point => point.count)).toEqual([5, 2]);
    expect(metrics.throughput.points.map(point => point.normalizedCount)).toEqual([7, 7]);
    expect(metrics.throughput.averagePerInterval).toBe(7);
    expect(metrics.velocity.points.at(-1)?.rollingAverage).toBe(7);
  });

  it('uses daily lead-time trend points for a seven-day view', () => {
    const records = Array.from({ length: 7 }, (_, index) => record({
      id: `task-${index}`,
      createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
      completedAt: `2026-07-${String(index + 8).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const metrics = buildDeliveryMetrics(records, {
      startDate: '2026-07-08',
      endDate: '2026-07-14',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.points).toHaveLength(2);
    expect(metrics.leadTime.trend.map(point => ({
      start: point.start,
      end: point.end,
      medianDays: point.medianDays,
    }))).toEqual([
      { start: '2026-07-08', end: '2026-07-08', medianDays: 7 },
      { start: '2026-07-09', end: '2026-07-09', medianDays: 7 },
      { start: '2026-07-10', end: '2026-07-10', medianDays: 7 },
      { start: '2026-07-11', end: '2026-07-11', medianDays: 7 },
      { start: '2026-07-12', end: '2026-07-12', medianDays: 7 },
      { start: '2026-07-13', end: '2026-07-13', medianDays: 7 },
      { start: '2026-07-14', end: '2026-07-14', medianDays: 7 },
    ]);
  });

  it('uses calendar month boundaries rather than fixed day windows', () => {
    const metrics = buildDeliveryMetrics([
      record({ id: 'june', completedAt: '2026-06-30T20:00:00.000Z' }),
      record({ id: 'july', completedAt: '2026-07-31T20:00:00.000Z' }),
      record({ id: 'august', completedAt: '2026-08-01T20:00:00.000Z' }),
    ], {
      startDate: '2026-06-15',
      endDate: '2026-08-10',
      interval: 'month',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.points.map(point => [point.start, point.end, point.count])).toEqual([
      ['2026-06-01', '2026-06-30', 1],
      ['2026-07-01', '2026-07-31', 1],
      ['2026-08-01', '2026-08-31', 1],
    ]);
  });

  it('counts only the current final completion and excludes cancellation closures', () => {
    const metrics = buildDeliveryMetrics([
      record({
        id: 'reopened-then-finished',
        completedAt: '2026-07-10T12:00:00.000Z',
      }),
      record({
        id: 'not-planned',
        completedAt: '2026-07-11T12:00:00.000Z',
        statusReason: 'not_planned',
      }),
      record({
        id: 'duplicate',
        completedAt: '2026-07-12T12:00:00.000Z',
        statusReason: 'duplicate',
      }),
    ], {
      startDate: '2026-07-01',
      endDate: '2026-07-14',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.total).toBe(1);
    expect(metrics.excluded.nonCompletionClosures).toBe(2);
    expect(metrics.leadTime.summary.count).toBe(1);
  });

  it('calculates interpolated percentiles and lead-time summaries', () => {
    expect(percentile([0, 10, 20, 30], 0.5)).toBe(15);
    expect(percentile([0, 10, 20, 30], 0.85)).toBe(25.5);
    expect(percentile([], 0.95)).toBeNull();

    const metrics = buildDeliveryMetrics([
      record({ id: 'one', createdAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-01T12:00:00.000Z' }),
      record({ id: 'two', createdAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-11T00:00:00.000Z' }),
    ], {
      startDate: '2026-07-01',
      endDate: '2026-07-14',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.leadTime.summary.averageDays).toBe(5.3);
    expect(metrics.leadTime.summary.medianDays).toBe(5.3);
    expect(metrics.leadTime.outliers[0]).toMatchObject({ taskId: 'two', leadTimeDays: 10 });
  });

  it('keeps valid throughput when creation time cannot produce lead time', () => {
    const metrics = buildDeliveryMetrics([
      record({ createdAt: 'invalid', completedAt: '2026-07-10T12:00:00.000Z' }),
    ], {
      startDate: '2026-07-10',
      endDate: '2026-07-10',
      interval: 'week',
      timeZone: 'UTC',
    });

    expect(metrics.throughput.total).toBe(1);
    expect(metrics.leadTime.summary.count).toBe(0);
    expect(metrics.excluded.invalidTimestamps).toBe(1);
  });

  it('interprets offsetless source timestamps in the reporting timezone', () => {
    const metrics = buildDeliveryMetrics([
      record({
        createdAt: '2026-06-30T00:30:00.0000000',
        completedAt: '2026-07-01T00:30:00.0000000',
      }),
    ], {
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      interval: 'week',
      timeZone: 'America/Los_Angeles',
    });

    expect(metrics.throughput.total).toBe(1);
    expect(metrics.leadTime.summary.medianDays).toBe(1);
  });
});
