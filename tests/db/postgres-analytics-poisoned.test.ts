import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsPersistence } from '@/db/persistence/analytics';

/**
 * Poisoned-SQLite proof for the L17 owned surface: with a PostgreSQL-shaped
 * worker composition and a throwing `@/db`, every handler on the six owned
 * analytics routes and all five migrated services must import and run. Any
 * static SQLite reach fails the whole file at import time.
 *
 * `/api/insights/observations` is included deliberately. It is the layer's one
 * Tier B reclassification: its residual reach is a *deferred* `import()` of the
 * AI provider config resolver inside `@/lib/stats/observations`, which belongs
 * to the held AI provider scope. That module is stubbed here so the AI path is
 * provably untaken, which is exactly why the route is Tier B rather than clean.
 */

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const observations = vi.hoisted(() => ({
  detectObservations: vi.fn(() => [
    { type: 'velocity', title: 'a', detail: 'a' },
    { type: 'friction', title: 'b', detail: 'b' },
    { type: 'aging', title: 'c', detail: 'c' },
  ]),
  generateLLMObservations: vi.fn(async () => []),
}));

vi.mock('@/lib/stats/observations', () => observations);

const calls = vi.hoisted(() => ({
  countOpenTasks: vi.fn(async () => 4),
  listDeliveryRecords: vi.fn(async () => []),
  listFlowTasks: vi.fn(async () => []),
  listSyntheticTagCandidates: vi.fn(async () => []),
  listTasksWithLiveConnector: vi.fn(async () => []),
}));

const zero = async () => 0;
const empty = async () => [];

const repository: AnalyticsPersistence = {
  kpis: {
    countOpenTasks: calls.countOpenTasks,
    countOpenTasksDueBefore: zero,
    countOpenTasksDueBetween: zero,
    countOpenTasksInIds: zero,
    countOpenTasksWithPriorities: zero,
    countOpenTasksWithAssignee: zero,
    countOpenTasksByConnectorType: zero,
    countNotificationsNeedingAttention: zero,
    countNotificationsNeedingAttentionInCategory: zero,
    listMyDayTaskIds: empty,
    countTasksCompletedIn: zero,
    countNonCancelledTasksDueBetween: zero,
    listActiveRoutines: empty,
    listRoutineCompletionsBetween: empty,
    listCompletedTimestampsSince: empty,
    listFocusItemStatuses: empty,
    countTriageItemsWithStatus: zero,
    countTriageItemsWithStatusCapturedBefore: zero,
  },
  insights: {
    countTasksCompletedIn: zero,
    countTopLevelTasksCreatedIn: zero,
    listCompletedTimestampsIn: empty,
    listCreatedTimestampsIn: empty,
    listCompletionSpansIn: empty,
    listCompletedTimestampsSince: empty,
    sourceBreakdownIn: empty,
    listOpenTaskCreatedTimestamps: empty,
    listPlanningFrictionEvents: empty,
    listTaskTagNames: empty,
    listActiveProjects: empty,
    countProjectTasksCompletedIn: zero,
    countProjectOpenTasks: zero,
    countProjectTopLevelTasksCreatedIn: zero,
    listActiveRoutines: empty,
    listRoutineCompletionsBetween: empty,
    listRoutineCompletionsInHalfOpenRange: empty,
    countRoutineCompletionsByDate: empty,
    deliveryFilterOptions: async () => ({ projects: [], sources: [] }),
    listDeliveryRecords: calls.listDeliveryRecords,
  },
  flow: {
    listFlowTasks: calls.listFlowTasks,
    listTaskProjectMemberships: empty,
    listVisibleProjects: empty,
    listTaskTransitions: empty,
  },
  tagInsights: {
    listSyntheticTagCandidates: calls.listSyntheticTagCandidates,
    listBoundedTaggedTasks: empty,
    listTopTags: empty,
    listTaskTagLinks: empty,
  },
  wordInsights: {
    listTasksWithLiveConnector: calls.listTasksWithLiveConnector,
    listRankedTaskTags: empty,
    listRankedTaskProjects: empty,
    listRankedTaskPhases: empty,
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ analytics: repository }),
}));

const BASE = 'http://localhost:3099';

function request(url: string) {
  return new Request(`${BASE}${url}`, {
    headers: { host: 'localhost:3099', origin: BASE, 'sec-fetch-site': 'same-origin' },
  });
}

describe('poisoned-SQLite analytics web surface', () => {
  it('serves the stats and dashboard KPI routes from the composed repository', async () => {
    const stats = await import('@/app/api/stats/route');
    const response = await stats.GET(request('/api/stats?slugs=total-open'));
    expect(response.status).toBe(200);
    expect((await response.json()).kpis['total-open']).toMatchObject({ value: 4 });

    const kpis = await import('@/app/api/dashboard/kpis/route');
    const cards = await kpis.GET(request('/api/dashboard/kpis?slugs=total-open'));
    expect(cards.status).toBe(200);
    expect((await cards.json()).cards).toEqual([expect.objectContaining({
      slug: 'total-open',
      value: 4,
    })]);
    expect(calls.countOpenTasks).toHaveBeenCalled();
  });

  it('serves every insights section from the composed repository', async () => {
    const route = await import('@/app/api/insights/route');
    const { NextRequest } = await import('next/server');

    for (const section of ['summary', 'delivery', 'flow', 'activity']) {
      const response = await route.GET(
        new NextRequest(`${BASE}/api/insights?period=7&section=${section}`),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).section).toBe(section);
    }

    const full = await route.GET(new NextRequest(`${BASE}/api/insights?period=30`));
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({ period: 30 });
    expect(calls.listDeliveryRecords).toHaveBeenCalled();
    expect(calls.listFlowTasks).toHaveBeenCalled();
  });

  it('serves the observations route without taking the deferred AI path', async () => {
    const route = await import('@/app/api/insights/observations/route');
    const { NextRequest } = await import('next/server');

    const response = await route.GET(new NextRequest(`${BASE}/api/insights/observations?period=30`));
    expect(response.status).toBe(200);
    expect((await response.json()).observations).toHaveLength(3);
    expect(observations.detectObservations).toHaveBeenCalled();
    expect(observations.generateLLMObservations).not.toHaveBeenCalled();
  });

  it('serves the tag and word insight routes from the composed repository', async () => {
    const tags = await import('@/app/api/tag-insights/route');
    const tagResponse = await tags.GET(request('/api/tag-insights?topN=10'));
    expect(tagResponse.status).toBe(200);
    expect(calls.listSyntheticTagCandidates).toHaveBeenCalled();

    const words = await import('@/app/api/word-insights/route');
    const wordResponse = await words.GET(request('/api/word-insights?taskLimit=5'));
    expect(wordResponse.status).toBe(200);
    expect(calls.listTasksWithLiveConnector).toHaveBeenCalledWith(6);
  });

  it('exposes the shared source breakdown helper without a SQLite handle', async () => {
    const { getSourceBreakdown } = await import('@/lib/stats/insights');
    expect(await getSourceBreakdown('2026-03-01', '2026-03-10')).toEqual([]);
  });
});
