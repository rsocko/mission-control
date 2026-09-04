import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightsAnalyticsRepository } from '@/db/persistence/analytics';

/**
 * The insights query layer reads through the composed `analytics.insights`
 * repository, so these cases stub that repository rather than a SQLite handle.
 * The timezone behaviour under test is unchanged: local period boundaries are
 * still resolved in this module and handed to persistence as instants.
 */

const mocks = vi.hoisted(() => ({
  countTasksCompletedIn: vi.fn(),
  countTopLevelTasksCreatedIn: vi.fn(),
  listCompletedTimestampsIn: vi.fn(),
  listCreatedTimestampsIn: vi.fn(),
  listCompletionSpansIn: vi.fn(),
  listCompletedTimestampsSince: vi.fn(),
  sourceBreakdownIn: vi.fn(),
  listOpenTaskCreatedTimestamps: vi.fn(),
  listPlanningFrictionEvents: vi.fn(),
  listTaskTagNames: vi.fn(),
}));

const insights = mocks as unknown as InsightsAnalyticsRepository;

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ analytics: { insights } }),
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

describe('insights configured-timezone bucketing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTasksCompletedIn.mockResolvedValue(0);
    mocks.countTopLevelTasksCreatedIn.mockResolvedValue(0);
    mocks.listCompletedTimestampsIn.mockResolvedValue([]);
    mocks.listCreatedTimestampsIn.mockResolvedValue([]);
    mocks.listCompletionSpansIn.mockResolvedValue([]);
    mocks.listCompletedTimestampsSince.mockResolvedValue([]);
    mocks.sourceBreakdownIn.mockResolvedValue([]);
    mocks.listOpenTaskCreatedTimestamps.mockResolvedValue([]);
    mocks.listPlanningFrictionEvents.mockResolvedValue([]);
    mocks.listTaskTagNames.mockResolvedValue([]);
  });

  it('uses configured today and buckets bare UTC timestamps into local dates', async () => {
    mocks.countTasksCompletedIn.mockResolvedValue(1);
    mocks.listCompletedTimestampsIn.mockResolvedValue(['2026-08-17T01:00:00.0000000']);
    mocks.listCompletedTimestampsSince.mockResolvedValue(['2026-08-17T01:00:00.0000000']);
    const { computeInsightsSection } = await import('@/lib/stats/insights');

    const result = await computeInsightsSection('summary', 7);

    expect(result.periodEnd).toBe('2026-08-16');
    expect(result.trends.find(point => point.date === '2026-08-16')).toMatchObject({
      completed: 1,
    });
    expect(result.kpis.streak.value).toBe(1);
    expect(mocks.listCompletedTimestampsIn).toHaveBeenCalledWith({
      startInclusive: '2026-08-10T04:00:00.000Z',
      endExclusive: '2026-08-16T-next04:00:00.000Z',
    });
  });

  it('summarizes later due-date moves into task, list, and tag patterns', async () => {
    mocks.listPlanningFrictionEvents.mockResolvedValue([
      {
        taskId: 'task-1',
        eventType: 'due_date_pushed',
        previousValue: '2026-08-10',
        newValue: '2026-08-14',
        title: 'Plan launch',
        dueDate: '2026-08-20',
        pushCount: 3,
        sourceListName: 'Work',
      },
      {
        taskId: 'task-1',
        eventType: 'due_date_pushed',
        previousValue: '2026-08-14',
        newValue: '2026-08-20',
        title: 'Plan launch',
        dueDate: '2026-08-20',
        pushCount: 3,
        sourceListName: 'Work',
      },
    ]);
    mocks.listTaskTagNames.mockResolvedValue([
      { taskId: 'task-1', name: 'planning' },
      { taskId: 'task-1', name: 'priority:high' },
    ]);
    const { computeInsightsSection } = await import('@/lib/stats/insights');

    const result = await computeInsightsSection('summary', 7);

    expect(result.planningFriction).toMatchObject({
      signalsInPeriod: 2,
      affectedTaskCount: 1,
      pushesInPeriod: 2,
      pushedTaskCount: 1,
      totalDaysDeferred: 10,
      averageDaysPerPush: 5,
      topTasks: [expect.objectContaining({
        id: 'task-1',
        signalsInPeriod: 2,
        pushesInPeriod: 2,
        daysDeferredInPeriod: 10,
      })],
      topLists: [{ label: 'Work', count: 2 }],
      topTags: [{ label: 'planning', count: 2 }],
    });
  });
});
