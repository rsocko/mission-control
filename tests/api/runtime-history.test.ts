import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeTelemetryHistory = vi.fn(() => []);

vi.mock('@/lib/telemetry/runtime', () => ({
  getRuntimeTelemetryHistory,
}));

describe('runtime telemetry history API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries bounded history with validated filters', async () => {
    const { GET } = await import('@/app/api/health/runtime/route');
    const response = await GET(new Request(
      'http://localhost/api/health/runtime?role=web&since=2026-08-01T00:00:00-04:00&limit=50',
    ));

    expect(response.status).toBe(200);
    expect(getRuntimeTelemetryHistory).toHaveBeenCalledWith({
      role: 'web',
      since: '2026-08-01T04:00:00.000Z',
      limit: 50,
    });
    expect(await response.json()).toEqual({
      samples: [],
      retention: {
        hours: 72,
        rawHours: 6,
        downsampleSeconds: 300,
      },
    });
  });

  it.each([
    ['role=api', 'role must be web or worker'],
    ['since=not-a-date', 'since must be an ISO-8601 timestamp'],
    ['limit=10001', 'limit must be an integer from 1 to 10000'],
  ])('rejects invalid query %s', async (query, error) => {
    const { GET } = await import('@/app/api/health/runtime/route');
    const response = await GET(new Request(`http://localhost/api/health/runtime?${query}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(getRuntimeTelemetryHistory).not.toHaveBeenCalled();
  });
});
