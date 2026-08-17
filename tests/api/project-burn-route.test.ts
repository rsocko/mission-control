import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBurnReport: vi.fn(),
  getLocalToday: vi.fn(() => '2026-08-16'),
}));

vi.mock('@/lib/reports/burn', () => ({
  getBurnReport: mocks.getBurnReport,
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: mocks.getLocalToday,
}));

describe('GET /api/projects/[id]/reports/burn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBurnReport.mockResolvedValue({
      projectId: 'project-1',
      points: [],
    });
  });

  it('uses the configured local date for the default report range', async () => {
    const { GET } = await import('@/app/api/projects/[id]/reports/burn/route');
    const response = await GET(
      new Request('http://localhost/api/projects/project-1/reports/burn'),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getBurnReport).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-05-19',
      endDate: '2026-08-16',
      today: '2026-08-16',
    }));
  });
});
