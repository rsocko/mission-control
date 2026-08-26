import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeTelemetry = vi.fn(() => []);

vi.mock('@/lib/telemetry/runtime', () => ({ getRuntimeTelemetry }));

describe('GET /api/metrics', () => {
  beforeEach(() => {
    getRuntimeTelemetry.mockClear();
  });

  it('returns uncached Prometheus text exposition', async () => {
    const { GET } = await import('@/app/api/metrics/route');
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type'))
      .toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain(
      '# TYPE mission_control_sqlite_operation_latency_milliseconds gauge',
    );
    expect(getRuntimeTelemetry).toHaveBeenCalledOnce();
  });
});
