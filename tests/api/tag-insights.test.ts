import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTagInsights = vi.fn();

vi.mock('@/lib/tag-insights/service', () => ({ getTagInsights }));

describe('GET /api/tag-insights', () => {
  beforeEach(() => getTagInsights.mockReset());

  it('passes bounded filters to the tag insights service', async () => {
    getTagInsights.mockResolvedValue({
      tags: [],
      pairs: [],
      tasks: {},
      meta: {},
    });
    const { GET } = await import('@/app/api/tag-insights/route');
    const response = await GET(new Request(
      'http://localhost/api/tag-insights?topN=500&minCooccurrence=0&taskLimit=99999',
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getTagInsights).toHaveBeenCalledWith({
      topN: 30,
      minCooccurrence: 1,
      taskLimit: 5000,
    });
  });

  it('uses defaults when query parameters are omitted', async () => {
    getTagInsights.mockResolvedValue({
      tags: [],
      pairs: [],
      tasks: {},
      meta: {},
    });
    const { GET } = await import('@/app/api/tag-insights/route');
    await GET(new Request('http://localhost/api/tag-insights'));

    expect(getTagInsights).toHaveBeenCalledWith({
      topN: 15,
      minCooccurrence: 2,
      taskLimit: 2000,
    });
  });
});
