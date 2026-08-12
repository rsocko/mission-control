import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBurnReport } = vi.hoisted(() => ({
  getBurnReport: vi.fn(),
}));

vi.mock('@/lib/reports/burn', () => ({ getBurnReport }));

const BASE = 'http://localhost:3099';

describe('GET /api/projects/[id]/reports/burn', () => {
  beforeEach(() => {
    getBurnReport.mockReset();
  });

  it('validates mode and bounded calendar ranges', async () => {
    const { GET } = await import('@/app/api/projects/[id]/reports/burn/route');

    const invalidMode = await GET(
      new Request(`${BASE}/api/projects/project-1/reports/burn?mode=hours`),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    expect(invalidMode.status).toBe(400);

    const invalidRange = await GET(
      new Request(`${BASE}/api/projects/project-1/reports/burn?start=2026-07-10&end=2026-07-01`),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    expect(invalidRange.status).toBe(400);

    const oversizedRange = await GET(
      new Request(`${BASE}/api/projects/project-1/reports/burn?start=2021-01-01&end=2026-07-02`),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    expect(oversizedRange.status).toBe(400);
    expect(getBurnReport).not.toHaveBeenCalled();
  });

  it('requests a phase effort report with the validated range', async () => {
    getBurnReport.mockResolvedValue({
      projectId: 'project-1',
      scope: 'phase',
      scopeId: 'phase-1',
      points: [],
    });
    const { GET } = await import('@/app/api/projects/[id]/reports/burn/route');
    const response = await GET(
      new Request(
        `${BASE}/api/projects/project-1/reports/burn?phase_id=phase-1&mode=effort&start=2026-07-01&end=2026-07-31`,
      ),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(getBurnReport).toHaveBeenCalledWith({
      projectId: 'project-1',
      phaseId: 'phase-1',
      mode: 'effort',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('returns a scoped not-found response', async () => {
    getBurnReport.mockResolvedValue(null);
    const { GET } = await import('@/app/api/projects/[id]/reports/burn/route');
    const response = await GET(
      new Request(
        `${BASE}/api/projects/project-1/reports/burn?phase_id=missing&start=2026-07-01&end=2026-07-31`,
      ),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Project phase not found' });
  });
});
