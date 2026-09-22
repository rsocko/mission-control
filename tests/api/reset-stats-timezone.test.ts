import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aggregateStats: vi.fn(async () => ({
    completedTasks: [],
    createdTaskCount: 0,
    carriedForwardCount: 0,
    activeRoutines: [],
    periodCompletions: [],
    focusItems: [],
    staleTasks: [],
    energyData: [],
    focusTaskStatuses: [],
  })),
  getLocalDateBoundsISO: vi.fn((date: string) => ({
    dayStart: `${date}T04:00:00.000Z`,
    nextDayStart: `${date}-nextT04:00:00.000Z`,
  })),
}));

vi.mock('@/lib/ai/workflow-persistence', () => ({
  getAIWorkflowPersistence: async () => ({
    resets: { aggregateStats: mocks.aggregateStats },
  }),
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
    mocks.aggregateStats.mockResolvedValue({
      completedTasks: [],
      createdTaskCount: 0,
      carriedForwardCount: 0,
      activeRoutines: [],
      periodCompletions: [],
      focusItems: [],
      staleTasks: [],
      energyData: [],
      focusTaskStatuses: [],
    });
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
