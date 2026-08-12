import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { computeInsights, getSourceBreakdown } = vi.hoisted(() => ({
  computeInsights: vi.fn(),
  getSourceBreakdown: vi.fn(),
}));

vi.mock('@/lib/stats/insights', () => ({
  computeInsights,
  getSourceBreakdown,
}));

vi.mock('@/lib/stats/observations', () => ({
  detectObservations: vi.fn(() => []),
  generateLLMObservations: vi.fn(async () => []),
}));

describe('GET /api/insights/observations period comparison', () => {
  beforeEach(() => {
    computeInsights.mockReset();
    getSourceBreakdown.mockReset();
    computeInsights.mockResolvedValue({ periodEnd: '2026-07-31' });
    getSourceBreakdown.mockResolvedValue([]);
  });

  it('uses the adjacent previous inclusive period', async () => {
    const { GET } = await import('@/app/api/insights/observations/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights/observations?period=7',
    ));

    expect(response.status).toBe(200);
    expect(getSourceBreakdown).toHaveBeenCalledWith('2026-07-18', '2026-07-24');
  });
});
