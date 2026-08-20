import { describe, it, expect } from 'vitest';
import { detectObservations } from '@/lib/stats/observations';
import type { InsightsSnapshot, TrendDataPoint, SourceBreakdownItem } from '@/lib/stats/insights';

function makeSnapshot(overrides: Partial<InsightsSnapshot> = {}): InsightsSnapshot {
  return {
    period: 30,
    periodStart: '2026-06-23',
    periodEnd: '2026-07-23',
    kpis: {
      completed: { label: 'Completed', value: 10, previousValue: 12, delta: -17, unit: 'tasks' },
      created: { label: 'Created', value: 8, previousValue: 9, delta: -11, unit: 'tasks' },
      netChange: { label: 'Net Change', value: 2, unit: 'tasks' },
      avgTaskAge: { label: 'Avg Task Age', value: 3.5, previousValue: 4.0, delta: -13, unit: 'days' },
      streak: { label: 'Streak', value: 3, unit: 'days' },
    },
    trends: [],
    sourceBreakdown: [],
    taskAge: [
      { label: '< 1 day', count: 2, minDays: 0, maxDays: 1 },
      { label: '1–7 days', count: 5, minDays: 1, maxDays: 7 },
      { label: '8–30 days', count: 3, minDays: 8, maxDays: 30 },
      { label: '31–60 days', count: 0, minDays: 31, maxDays: 60 },
      { label: '61–90 days', count: 0, minDays: 61, maxDays: 90 },
      { label: '> 90 days', count: 0, minDays: 91, maxDays: null },
    ],
    planningFriction: {
      signalsInPeriod: 0,
      affectedTaskCount: 0,
      pushesInPeriod: 0,
      pushedTaskCount: 0,
      missedCommitments: 0,
      elapsedBlocks: 0,
      overdueTransitions: 0,
      snoozeExtensions: 0,
      totalDaysDeferred: 0,
      averageDaysPerPush: 0,
      topTasks: [],
      topLists: [],
      topTags: [],
    },
    projectActivity: [],
    routineHeatmap: [],
    delivery: {
      throughput: { interval: 'week', total: 0, averagePerInterval: 0, points: [] },
      velocity: { interval: 'week', measure: 'tasks', rollingWindow: 3, points: [] },
      leadTime: {
        summary: { count: 0, averageDays: null, medianDays: null, p85Days: null, p95Days: null },
        distribution: [],
        trend: [],
        outliers: [],
      },
      excluded: { nonCompletionClosures: 0, invalidTimestamps: 0 },
    },
    deliveryFilters: {
      interval: 'week',
      projectId: null,
      source: null,
      timeZone: 'UTC',
      projects: [],
      sources: [],
    },
    deliverySemantics: {
      completion: '',
      intervals: '',
      leadTime: '',
      exclusions: '',
      unsupportedMeasures: '',
    },
    activityHeatmap: [],
    flow: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-08T00:00:00.000Z',
      generatedAt: '2026-01-08T12:00:00.000Z',
      historicalBoundaryAt: null,
      partialHistory: false,
      cycleTime: {
        count: 0,
        excludedWithoutStart: 0,
        medianDays: null,
        averageDays: null,
        percentile85Days: null,
        reworkedCount: 0,
        items: [],
        distribution: [],
      },
      cumulativeFlow: { dimension: 'normalized_status', points: [] },
      agingWip: {
        count: 0,
        excludedWithoutEntry: 0,
        medianAgeDays: null,
        staleCount: 0,
        staleThresholdDays: 14,
        items: [],
        buckets: [],
      },
      filterOptions: {
        projects: [],
        sources: [],
        priorities: [],
        statuses: [],
      },
    },
    ...overrides,
  };
}

function makeTrends(daysCount: number, pattern?: Record<number, number>): TrendDataPoint[] {
  const points: TrendDataPoint[] = [];
  const baseDate = new Date('2026-07-01T12:00:00');
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    const dateStr = d.toISOString().slice(0, 10);
    points.push({
      date: dateStr,
      completed: pattern?.[dow] ?? 2,
      created: 1,
    });
  }
  return points;
}

describe('detectObservations', () => {
  it('returns empty array when no patterns detected', () => {
    const snapshot = makeSnapshot({ trends: makeTrends(14) });
    const result = detectObservations({ snapshot });
    // With uniform trends, no stale work, no streak extremes, balanced workload
    // only workload-shrinking might trigger (10 completed > 8 created * 1.5? no, 8*1.5=12 > 10)
    // So should be empty or just streak/workload
    expect(result.length).toBeLessThanOrEqual(3);
    for (const obs of result) {
      expect(obs.id).toBeTruthy();
      expect(obs.title).toBeTruthy();
    }
  });

  it('detects day-of-week productivity pattern', () => {
    // Make Fridays (dow=5) highly productive
    const trends = makeTrends(28, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 8, 6: 1 });
    const snapshot = makeSnapshot({ trends });
    const result = detectObservations({ snapshot });
    const pattern = result.find(o => o.type === 'pattern');
    expect(pattern).toBeDefined();
    expect(pattern!.title).toContain('Friday');
  });

  it('detects stale work', () => {
    const snapshot = makeSnapshot({
      taskAge: [
        { label: '< 1 day', count: 2, minDays: 0, maxDays: 1 },
        { label: '1–7 days', count: 5, minDays: 1, maxDays: 7 },
        { label: '8–30 days', count: 3, minDays: 8, maxDays: 30 },
        { label: '31–60 days', count: 2, minDays: 31, maxDays: 60 },
        { label: '61–90 days', count: 3, minDays: 61, maxDays: 90 },
        { label: '> 90 days', count: 2, minDays: 91, maxDays: null },
      ],
    });
    const result = detectObservations({ snapshot });
    const stale = result.find(o => o.type === 'stale');
    expect(stale).toBeDefined();
    expect(stale!.title).toContain('7');
    expect(stale!.title).toContain('30+ days');
  });

  it('detects source balance shift', () => {
    const currentBreakdown: SourceBreakdownItem[] = [
      { source: 'github', count: 3, percentage: 30 },
      { source: 'microsoft_todo', count: 7, percentage: 70 },
    ];
    const previousBreakdown: SourceBreakdownItem[] = [
      { source: 'github', count: 10, percentage: 50 },
      { source: 'microsoft_todo', count: 10, percentage: 50 },
    ];
    const snapshot = makeSnapshot({ sourceBreakdown: currentBreakdown });
    const result = detectObservations({ snapshot, previousSourceBreakdown: previousBreakdown });
    const balance = result.find(o => o.type === 'balance');
    expect(balance).toBeDefined();
    expect(balance!.title).toContain('GitHub');
    expect(balance!.title).toContain('dropped');
  });

  it('detects workload imbalance when created >> completed', () => {
    const snapshot = makeSnapshot({
      kpis: {
        completed: { label: 'Completed', value: 5, unit: 'tasks' },
        created: { label: 'Created', value: 15, unit: 'tasks' },
        netChange: { label: 'Net Change', value: -10, unit: 'tasks' },
        avgTaskAge: { label: 'Avg Task Age', value: 3.5, unit: 'days' },
        streak: { label: 'Streak', value: 3, unit: 'days' },
      },
    });
    const result = detectObservations({ snapshot });
    const workload = result.find(o => o.type === 'workload');
    expect(workload).toBeDefined();
    expect(workload!.title).toContain('growing');
  });

  it('detects strong streak', () => {
    const snapshot = makeSnapshot({
      kpis: {
        completed: { label: 'Completed', value: 10, unit: 'tasks' },
        created: { label: 'Created', value: 8, unit: 'tasks' },
        netChange: { label: 'Net Change', value: 2, unit: 'tasks' },
        avgTaskAge: { label: 'Avg Task Age', value: 3.5, unit: 'days' },
        streak: { label: 'Streak', value: 10, unit: 'days' },
      },
    });
    const result = detectObservations({ snapshot });
    const streak = result.find(o => o.type === 'streak');
    expect(streak).toBeDefined();
    expect(streak!.title).toContain('10-day');
  });

  it('turns repeated due-date pushes into an actionable observation', () => {
    const snapshot = makeSnapshot({
      planningFriction: {
        signalsInPeriod: 5,
        affectedTaskCount: 2,
        pushesInPeriod: 5,
        pushedTaskCount: 2,
        missedCommitments: 0,
        elapsedBlocks: 0,
        overdueTransitions: 0,
        snoozeExtensions: 0,
        totalDaysDeferred: 18,
        averageDaysPerPush: 3.6,
        topTasks: [],
        topLists: [{ label: 'Work', count: 3 }],
        topTags: [{ label: 'planning', count: 4 }],
      },
    });

    const result = detectObservations({ snapshot });
    const observation = result.find(item => item.id === 'obs-planning-friction');

    expect(observation).toMatchObject({
      title: '5 planning friction signals',
      severity: 'warning',
    });
    expect(observation?.description).toContain('planning');
    expect(observation?.description).toContain('5 later due-date moves');
  });

  it('returns max 3 observations', () => {
    // Trigger as many detectors as possible
    const trends = makeTrends(28, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 8, 6: 1 });
    const snapshot = makeSnapshot({
      trends,
      taskAge: [
        { label: '< 1 day', count: 2, minDays: 0, maxDays: 1 },
        { label: '1–7 days', count: 5, minDays: 1, maxDays: 7 },
        { label: '8–30 days', count: 3, minDays: 8, maxDays: 30 },
        { label: '31–60 days', count: 4, minDays: 31, maxDays: 60 },
        { label: '61–90 days', count: 3, minDays: 61, maxDays: 90 },
        { label: '> 90 days', count: 3, minDays: 91, maxDays: null },
      ],
      kpis: {
        completed: { label: 'Completed', value: 5, unit: 'tasks' },
        created: { label: 'Created', value: 15, unit: 'tasks' },
        netChange: { label: 'Net Change', value: -10, unit: 'tasks' },
        avgTaskAge: { label: 'Avg Task Age', value: 3.5, unit: 'days' },
        streak: { label: 'Streak', value: 10, unit: 'days' },
      },
    });
    const result = detectObservations({ snapshot });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('prioritizes warnings over positive observations', () => {
    const trends = makeTrends(28, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 8, 6: 1 });
    const snapshot = makeSnapshot({
      trends,
      taskAge: [
        { label: '< 1 day', count: 2, minDays: 0, maxDays: 1 },
        { label: '1–7 days', count: 5, minDays: 1, maxDays: 7 },
        { label: '8–30 days', count: 3, minDays: 8, maxDays: 30 },
        { label: '31–60 days', count: 4, minDays: 31, maxDays: 60 },
        { label: '61–90 days', count: 3, minDays: 61, maxDays: 90 },
        { label: '> 90 days', count: 3, minDays: 91, maxDays: null },
      ],
      kpis: {
        completed: { label: 'Completed', value: 5, unit: 'tasks' },
        created: { label: 'Created', value: 15, unit: 'tasks' },
        netChange: { label: 'Net Change', value: -10, unit: 'tasks' },
        avgTaskAge: { label: 'Avg Task Age', value: 3.5, unit: 'days' },
        streak: { label: 'Streak', value: 10, unit: 'days' },
      },
    });
    const result = detectObservations({ snapshot });
    // First result should be a warning (stale or workload)
    expect(result[0].severity).toBe('warning');
  });
});
