import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseHealthProbeResult } from '@/lib/telemetry/database-health-probe';

const mockInspect = vi.fn<() => Promise<DatabaseHealthProbeResult>>(async () => ({
  connected: true,
  severity: 'healthy' as const,
  message: 'Connected',
  sizeBytes: 4096,
  backend: { kind: 'sqlite' },
}));
const mockHasSeedMarker = vi.fn(async () => true);
vi.mock('@/lib/telemetry/database-health-runtime', () => ({
  databaseHealthProbe: {
    inspect: mockInspect,
    hasSeedMarker: mockHasSeedMarker,
  },
}));
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => true,
}));
const lifecycle = {
  status: 'ready',
  reason: null,
  startedAt: '2026-08-02T00:00:00.000Z',
  drainingAt: null,
  release: 'revision-1',
  role: 'web',
  activeOperations: {},
  previousExit: null,
};
const mockIsRuntimeReady = vi.fn(() => true);
vi.mock('@/lib/runtime/lifecycle', () => ({
  getRuntimeLifecycleSnapshot: () => lifecycle,
  isRuntimeReady: mockIsRuntimeReady,
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MC_DEPLOYMENT_REVISION = 'revision-1';
});

describe('public demo health', () => {
  it('reports ready after the initialization marker is recorded', async () => {
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      mode: 'public-demo',
      revision: 'revision-1',
      lifecycle,
    });
    expect(mockInspect).toHaveBeenCalledOnce();
    expect(mockHasSeedMarker).toHaveBeenCalledOnce();
  });

  it('does not report ready before initialization completes', async () => {
    mockHasSeedMarker.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ ready: false }));
  });

  it('does not evaluate the seed marker when the database is disconnected', async () => {
    mockInspect.mockResolvedValueOnce({
      connected: false,
      severity: 'critical',
      message: 'PostgreSQL is unavailable',
      backend: { kind: 'postgres' },
    });
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ ready: false }));
    expect(mockHasSeedMarker).not.toHaveBeenCalled();
  });

  it('fails closed without exposing database errors', async () => {
    mockInspect.mockRejectedValueOnce(new Error('driver-internal-marker'));
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ready: false,
      mode: 'public-demo',
      revision: 'revision-1',
    });
    expect(JSON.stringify(body)).not.toContain('driver-internal-marker');
  });

  it('does not report ready while the runtime is draining', async () => {
    mockIsRuntimeReady.mockReturnValueOnce(false);
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ ready: false }));
  });

  it('falls back to immutable build metadata when deployment revision is absent', async () => {
    vi.resetModules();
    delete process.env.MC_DEPLOYMENT_REVISION;
    process.env.MC_BUILD_SHA = 'full-build-sha';

    const { GET } = await import('@/app/api/health/ready/route');
    const response = await GET();

    expect(await response.json()).toEqual(expect.objectContaining({
      revision: 'full-build-sha',
    }));
    delete process.env.MC_BUILD_SHA;
    vi.resetModules();
  });

  it('keeps liveness independent from mutable demo data', async () => {
    const { GET } = await import('@/app/api/health/live/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ live: true, revision: 'revision-1' });
  });
});
