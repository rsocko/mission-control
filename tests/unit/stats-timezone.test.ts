import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KpiAnalyticsRepository } from '@/db/persistence/analytics';

/**
 * The stats engine reads through the composed `analytics.kpis` repository, so
 * these cases stub that repository rather than a SQLite handle. The timezone
 * behaviour under test is unchanged: local day/week boundaries are still
 * resolved in this module and handed to persistence as instants.
 */

const mocks = vi.hoisted(() => ({
  countNonCancelledTasksDueBetween: vi.fn(),
  countTasksCompletedIn: vi.fn(),
  listCompletedTimestampsSince: vi.fn(),
  getLocalDateBoundsISO: vi.fn((date: string) => ({
    dayStart: `${date}T04:00:00.000Z`,
    nextDayStart: `${date}-nextT04:00:00.000Z`,
  })),
  formatDateInLocalTimezone: vi.fn((date: Date) => {
    const iso = date.toISOString();
    if (iso === '2026-08-17T01:00:00.000Z') return '2026-08-16';
    if (iso === '2026-08-16T02:00:00.000Z') return '2026-08-15';
    return iso.slice(0, 10);
  }),
}));

const kpis = {
  countNonCancelledTasksDueBetween: mocks.countNonCancelledTasksDueBetween,
  countTasksCompletedIn: mocks.countTasksCompletedIn,
  listCompletedTimestampsSince: mocks.listCompletedTimestampsSince,
} as unknown as KpiAnalyticsRepository;

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ analytics: { kpis } }),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: () => '2026-08-16',
  getLocalDaysFromNow: () => '2026-08-23',
  getLocalDayBoundsISO: () => ({
    todayStart: '2026-08-16T04:00:00.000Z',
    tomorrowStart: '2026-08-17T04:00:00.000Z',
  }),
  getLocalDateBoundsISO: mocks.getLocalDateBoundsISO,
  formatDateInLocalTimezone: mocks.formatDateInLocalTimezone,
  parseStoredTimestamp: (timestamp: string) => Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`,
  ),
}));

describe('stats configured-timezone bucketing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses configured local week boundaries for completed work', async () => {
    mocks.countNonCancelledTasksDueBetween.mockResolvedValue(3);
    mocks.countTasksCompletedIn.mockResolvedValue(2);
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('this-week-progress', { today: '2026-08-16' });

    expect(result).toMatchObject({ value: 2, max: 3 });
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-10');
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-16');
    expect(mocks.countTasksCompletedIn).toHaveBeenCalledWith({
      startInclusive: '2026-08-10T04:00:00.000Z',
      endExclusive: '2026-08-16-nextT04:00:00.000Z',
    });
  });

  it('groups completion timestamps into configured local streak days', async () => {
    mocks.listCompletedTimestampsSince.mockResolvedValue([
      '2026-08-17T01:00:00.0000000',
      '2026-08-16T02:00:00.0000000',
    ]);
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('streak', { today: '2026-08-16' });

    expect(result.value).toBe(2);
    expect(mocks.formatDateInLocalTimezone).toHaveBeenCalledTimes(2);
  });

  it('uses DST-aware local bounds for each daily average bucket', async () => {
    mocks.countTasksCompletedIn.mockResolvedValue(1);
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('daily-avg', { today: '2026-08-16' });

    expect(result.value).toBe(1);
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledTimes(7);
    expect(mocks.countTasksCompletedIn).toHaveBeenCalledTimes(7);
  });
});
