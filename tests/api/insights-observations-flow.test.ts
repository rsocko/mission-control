import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  computeInsights,
  getSourceBreakdown,
  detectObservations,
  generateLLMObservations,
} = vi.hoisted(() => ({
  computeInsights: vi.fn(),
  getSourceBreakdown: vi.fn(),
  detectObservations: vi.fn(),
  generateLLMObservations: vi.fn(),
}));

vi.mock('@/lib/stats/insights', () => ({ computeInsights, getSourceBreakdown }));
vi.mock('@/lib/stats/observations', () => ({
  detectObservations,
  generateLLMObservations,
}));

describe('GET /api/insights/observations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    computeInsights.mockResolvedValue({ period: 30 });
    getSourceBreakdown.mockResolvedValue([]);
    detectObservations.mockReturnValue([]);
    generateLLMObservations.mockResolvedValue([]);
  });

  it('skips flow reconstruction for observation-only snapshots', async () => {
    const { GET } = await import('@/app/api/insights/observations/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/insights/observations?period=30',
    ));

    expect(response.status).toBe(200);
    expect(computeInsights).toHaveBeenCalledWith(30, { includeFlow: false });
  });
});
