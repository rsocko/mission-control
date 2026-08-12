import { describe, expect, it } from 'vitest';
import { buildTaskAgeDistribution } from '@/lib/stats/task-age';

describe('buildTaskAgeDistribution', () => {
  it('splits tasks older than 30 days into the restored age buckets', () => {
    expect(buildTaskAgeDistribution([0, 1, 7, 8, 30, 31, 60, 61, 90, 91])).toEqual([
      { label: '< 1 day', count: 1, minDays: 0, maxDays: 1 },
      { label: '1–7 days', count: 2, minDays: 1, maxDays: 7 },
      { label: '8–30 days', count: 2, minDays: 8, maxDays: 30 },
      { label: '31–60 days', count: 2, minDays: 31, maxDays: 60 },
      { label: '61–90 days', count: 2, minDays: 61, maxDays: 90 },
      { label: '> 90 days', count: 1, minDays: 91, maxDays: null },
    ]);
  });

  it('returns every bucket when there are no open tasks', () => {
    expect(buildTaskAgeDistribution([]).map(bucket => bucket.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
