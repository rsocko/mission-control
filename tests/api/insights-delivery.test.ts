import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const computeInsights = vi.fn();
const computeInsightsSection = vi.fn();

vi.mock('@/lib/stats/insights', () => ({
  computeInsights,
  computeInsightsSection,
}));

describe('GET /api/insights delivery filters', () => {
  beforeEach(() => {
    computeInsights.mockReset();
    computeInsightsSection.mockReset();
    computeInsights.mockResolvedValue({ ok: true });
    computeInsightsSection.mockResolvedValue({ section: 'delivery' });
  });

  it('computes only the requested insights section', async () => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights?period=7&section=delivery',
    ));

    expect(response.status).toBe(200);
    expect(computeInsights).not.toHaveBeenCalled();
    expect(computeInsightsSection).toHaveBeenCalledWith('delivery', 7, expect.objectContaining({
      interval: undefined,
      staleThresholdDays: 14,
    }));
  });

  it('rejects unsupported insights sections', async () => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights?section=everything',
    ));

    expect(response.status).toBe(400);
    expect(computeInsights).not.toHaveBeenCalled();
    expect(computeInsightsSection).not.toHaveBeenCalled();
  });

  it('forwards composed period, interval, project, source, and timezone filters', async () => {
    const { GET } = await import('@/app/api/insights/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights?period=30&interval=month&project=project-1&source=github&timezone=America%2FNew_York',
    ));

    expect(response.status).toBe(200);
    expect(computeInsights).toHaveBeenCalledWith(30, {
      startDate: undefined,
      endDate: undefined,
      staleThresholdDays: 14,
      flowFilters: {
        projectId: 'project-1',
        source: 'github',
        priority: undefined,
        status: undefined,
      },
      interval: 'month',
      projectId: 'project-1',
      source: 'github',
      timeZone: 'America/New_York',
    });
  });

  it('rejects oversized filters before querying', async () => {
    const { GET } = await import('@/app/api/insights/route');
    const oversized = 'x'.repeat(201);
    const response = await GET(new NextRequest(
      `http://localhost/api/insights?period=999&interval=day&project=${oversized}`,
    ));

    expect(response.status).toBe(400);
    expect(computeInsights).not.toHaveBeenCalled();
  });
});
