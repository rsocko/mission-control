import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listTriageItems } = vi.hoisted(() => ({
  listTriageItems: vi.fn(),
}));

vi.mock('@/lib/triage', () => ({
  createTriageCapture: vi.fn(),
  isValidTriageSource: (value: string | null) => value === 'github',
  isValidTriageStatus: (value: string | null) => value === 'pending',
  listTriageItems,
}));

import { GET } from '@/app/api/triage/route';

describe('GET /api/triage category filters', () => {
  beforeEach(() => {
    listTriageItems.mockReset();
    listTriageItems.mockResolvedValue({
      items: [],
      totalFiltered: 0,
      hasMore: false,
      stats: {
        total: 0,
        pending: 0,
        snoozed: 0,
        actioned: 0,
        dismissed: 0,
        sourceCounts: {},
      },
    });
  });

  it('passes repeated categories and bounded pagination to the query layer', async () => {
    const response = await GET(new Request(
      'https://mc.example/api/triage?category=software-development&category=ux&limit=25&offset=50',
    ));

    expect(response.status).toBe(200);
    expect(listTriageItems).toHaveBeenCalledWith(expect.objectContaining({
      categories: ['software-development', 'ux'],
      limit: 25,
      offset: 50,
    }));
  });
});
