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
  };
});

vi.mock('@/db', () => ({
  default: { select: mocks.select },
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'taskId',
    status: 'status',
    priority: 'priority',
    assignee: 'assignee',
    dueDate: 'dueDate',
    completedAt: 'completedAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    connectorType: 'connectorType',
  },
  notifications: { id: 'notificationId' },
  myDayItems: { taskId: 'myDayTaskId', date: 'myDayDate' },
  focusItems: { id: 'focusId', taskId: 'focusTaskId', scope: 'focusScope', date: 'focusDate' },
  routines: { id: 'routineId', isActive: 'routineActive', isArchived: 'routineArchived' },
  routineCompletions: { routineId: 'completionRoutineId', date: 'completionDate' },
  triageItems: { status: 'triageStatus', createdAt: 'triageCreatedAt' },
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

vi.mock('@/lib/notifications/lifecycle-sql', () => ({
  notificationNeedsAttention: vi.fn(() => ({})),
}));

describe('stats configured-timezone bucketing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.terminals.length = 0;
  });

  it('uses configured local week boundaries for completed work', async () => {
    mocks.terminals.push([{ count: 3 }], [{ count: 2 }]);
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('this-week-progress', { today: '2026-08-16' });

    expect(result).toMatchObject({ value: 2, max: 3 });
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-10');
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-16');
  });

  it('groups completion timestamps into configured local streak days', async () => {
    mocks.terminals.push([
      { completedAt: '2026-08-17T01:00:00.0000000' },
      { completedAt: '2026-08-16T02:00:00.0000000' },
    ]);
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('streak', { today: '2026-08-16' });

    expect(result.value).toBe(2);
    expect(mocks.formatDateInLocalTimezone).toHaveBeenCalledTimes(2);
  });

  it('uses DST-aware local bounds for each daily average bucket', async () => {
    mocks.terminals.push(...Array.from({ length: 7 }, () => [{ count: 1 }]));
    const { computeKpi } = await import('@/lib/stats');

    const result = await computeKpi('daily-avg', { today: '2026-08-16' });

    expect(result.value).toBe(1);
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledTimes(7);
  });
});
