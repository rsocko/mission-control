import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('@/db', () => ({
  default: { select: mocks.select },
}));

vi.mock('@/db/schema', () => ({
  tasks: new Proxy({}, { get: (_, property) => String(property) }),
  routines: new Proxy({}, { get: (_, property) => String(property) }),
  routineCompletions: new Proxy({}, { get: (_, property) => String(property) }),
  taskProjects: new Proxy({}, { get: (_, property) => String(property) }),
  hubProjects: new Proxy({}, { get: (_, property) => String(property) }),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: () => '2026-08-16',
  getLocalDateBoundsISO: (date: string) => ({
    dayStart: `${date}T04:00:00.000Z`,
    nextDayStart: `${date}T-next04:00:00.000Z`,
  }),
  parseStoredTimestamp: (timestamp: string) => Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`,
  ),
  formatDateInLocalTimezone: (date: Date) => (
    date.toISOString() === '2026-08-17T01:00:00.000Z'
      ? '2026-08-16'
      : date.toISOString().slice(0, 10)
  ),
}));

vi.mock('@/lib/utils/sqlite-date', () => ({
  timestampGte: vi.fn(() => ({})),
  timestampLt: vi.fn(() => ({})),
}));

describe('insights configured-timezone bucketing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.terminals.length = 0;
  });

  it('uses configured today and buckets bare UTC timestamps into local dates', async () => {
    mocks.terminals.push(
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [],
      [],
      [{ completedAt: '2026-08-17T01:00:00.0000000' }],
      [{ timestamp: '2026-08-17T01:00:00.0000000' }],
      [],
      [],
      [],
    );
    const { computeInsightsSection } = await import('@/lib/stats/insights');

    const result = await computeInsightsSection('summary', 7);

    expect(result.periodEnd).toBe('2026-08-16');
    expect(result.trends.find(point => point.date === '2026-08-16')).toMatchObject({
      completed: 1,
    });
    expect(result.kpis.streak.value).toBe(1);
  });
});
