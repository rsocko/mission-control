import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    sql: vi.fn(() => ({ as: vi.fn(() => ({})) })),
  };
});

const mocks = vi.hoisted(() => {
  const terminals: unknown[] = [];

  function chainable(terminal: unknown) {
    const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve(terminal);
        }
        return vi.fn(() => chain);
      },
    });
    return chain;
  }

  return {
    terminals,
    select: vi.fn(() => chainable(terminals.shift() ?? [])),
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

vi.mock('@/db', () => ({
  default: { select: mocks.select },
}));

vi.mock('@/db/schema', () => ({
  quickSortLog: {
    mode: 'mode',
    action: 'action',
    triagedAt: 'triagedAt',
    reversedAt: 'reversedAt',
  },
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: () => '2026-08-16',
  getLocalDateBoundsISO: mocks.getLocalDateBoundsISO,
  formatDateInLocalTimezone: mocks.formatDateInLocalTimezone,
}));

describe('GET /api/tasks/quick-sort-stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.terminals.length = 0;
  });

  it('groups streak activity by configured local date after UTC midnight', async () => {
    mocks.terminals.push(
      [{ mode: 'no_priority', count: 2 }],
      [
        { triagedAt: '2026-08-17T01:00:00.000Z' },
        { triagedAt: '2026-08-16T02:00:00.000Z' },
      ],
    );

    const { GET } = await import('@/app/api/tasks/quick-sort-stats/route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thisWeek: { total: 2 },
      streak: 2,
    });
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-10');
    expect(mocks.formatDateInLocalTimezone).toHaveBeenCalledTimes(2);
  });
});
