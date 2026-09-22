import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    countActivityByModeSince: vi.fn(async () => [{ mode: 'no_priority', count: 2 }]),
    listActivityTimestampsSince: vi.fn(async () => [
      '2026-08-17T01:00:00.000Z',
      '2026-08-16T02:00:00.000Z',
    ]),
    recordActivity: vi.fn(async () => undefined),
    getLocalDateBoundsISO: vi.fn((date: string) => ({
      dayStart: `${date}T04:00:00.000Z`,
      nextDayStart: `${date}T04:00:00.000Z`,
    })),
    formatDateInLocalTimezone: vi.fn((date: Date) => {
      const iso = date.toISOString();
      if (iso === '2026-08-17T01:00:00.000Z') return '2026-08-16';
      if (iso === '2026-08-16T02:00:00.000Z') return '2026-08-15';
      return iso.slice(0, 10);
    }),
  };
});

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    quickSort: {
      countActivityByModeSince: mocks.countActivityByModeSince,
      listActivityTimestampsSince: mocks.listActivityTimestampsSince,
      recordActivity: mocks.recordActivity,
    },
  }),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: () => '2026-08-16',
  getLocalDateBoundsISO: mocks.getLocalDateBoundsISO,
  formatDateInLocalTimezone: mocks.formatDateInLocalTimezone,
}));

describe('GET /api/tasks/quick-sort-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('groups streak activity by configured local date after UTC midnight', async () => {
    const { GET } = await import('@/app/api/tasks/quick-sort-stats/route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thisWeek: {
        total: 2,
        byMode: { no_priority: 2, quadrant: 0 },
      },
      streak: 2,
    });
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-10');
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-05-18');
    expect(mocks.formatDateInLocalTimezone).toHaveBeenCalledTimes(2);
  });
});
