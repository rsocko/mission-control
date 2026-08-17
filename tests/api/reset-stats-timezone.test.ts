import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  function chainable() {
    const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve([]);
        }
        return vi.fn(() => chain);
      },
    });
    return chain;
  }

  return {
    select: vi.fn(() => chainable()),
    getLocalDateBoundsISO: vi.fn((date: string) => ({
      dayStart: `${date}T04:00:00.000Z`,
      nextDayStart: `${date}-nextT04:00:00.000Z`,
    })),
  };
});

vi.mock('@/db', () => ({
  default: { select: mocks.select },
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'taskId',
    title: 'taskTitle',
    status: 'taskStatus',
    priority: 'taskPriority',
    sourceId: 'taskSourceId',
    connectorType: 'taskConnectorType',
    connectorInstanceId: 'taskConnectorInstanceId',
    completedAt: 'taskCompletedAt',
    createdAt: 'taskCreatedAt',
    updatedAt: 'taskUpdatedAt',
  },
  routines: {
    id: 'routineId',
    cadenceType: 'routineCadenceType',
    isActive: 'routineActive',
    isArchived: 'routineArchived',
  },
  routineCompletions: {
    routineId: 'completionRoutineId',
    date: 'completionDate',
  },
  focusItems: {
    taskId: 'focusTaskId',
    date: 'focusDate',
    slot: 'focusSlot',
    scope: 'focusScope',
  },
  energyCheckins: {
    date: 'energyDate',
    level: 'energyLevel',
  },
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: () => '2026-08-16',
  getLocalDateBoundsISO: mocks.getLocalDateBoundsISO,
  formatDateInLocalTimezone: vi.fn(() => '2026-08-01'),
  parseStoredTimestamp: vi.fn(() => Date.parse('2026-08-01T12:00:00.000Z')),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn() },
}));

vi.mock('@/lib/tasks/edit-policy', () => ({
  resolveTaskEditPolicies: vi.fn(async () => new Map()),
}));

describe('GET /api/resets/stats timezone boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts weekly and stale calendar cutoffs through configured local bounds', async () => {
    const { GET } = await import('@/app/api/resets/stats/route');
    const response = await GET(new Request('http://localhost/api/resets/stats?type=weekly'));

    expect(response.status).toBe(200);
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-10');
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-16');
    expect(mocks.getLocalDateBoundsISO).toHaveBeenCalledWith('2026-08-02');
  });
});
