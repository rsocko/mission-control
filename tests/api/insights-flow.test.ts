import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const computeInsights = vi.fn();
const computeInsightsSection = vi.fn();

vi.mock('@/lib/stats/insights', () => ({ computeInsights, computeInsightsSection }));

describe('GET /api/insights flow reporting', () => {
  beforeEach(() => {
    computeInsights.mockReset();
    computeInsightsSection.mockReset();
    computeInsights.mockResolvedValue({ flow: {} });
  });

  it('passes custom dates and bounded flow filters to the insights query', async () => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights?period=custom&start=2026-06-01&end=2026-07-31'
      + '&projectId=project-1&source=github&priority=high&status=in_progress&staleDays=999',
    ));

    expect(response.status).toBe(200);
    expect(computeInsights).toHaveBeenCalledWith(30, {
      startDate: '2026-06-01',
      endDate: '2026-07-31',
      staleThresholdDays: 365,
      interval: undefined,
      projectId: undefined,
      source: 'github',
      timeZone: undefined,
      flowFilters: {
        projectId: 'project-1',
        source: 'github',
        priority: 'high',
        status: 'in_progress',
      },
    });
  });

  it.each([
    'period=custom&start=2026-02-30&end=2026-03-01',
    'period=custom&start=2026-07-02&end=2026-07-01',
    'period=custom&start=2025-01-01&end=2026-07-01',
  ])('rejects invalid custom ranges: %s', async query => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(`http://localhost/api/insights?${query}`));

    expect(response.status).toBe(400);
    expect(computeInsights).not.toHaveBeenCalled();
  });

  it.each([
    'status=surprise',
    `projectId=${'x'.repeat(201)}`,
  ])('rejects malformed filters: %s', async query => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(`http://localhost/api/insights?${query}`));

    expect(response.status).toBe(400);
    expect(computeInsights).not.toHaveBeenCalled();
  });
});
