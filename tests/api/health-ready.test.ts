import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockPrepare = vi.fn(() => ({ get: mockGet }));

vi.mock('@/db', () => ({
  sqlite: { prepare: mockPrepare },
  withoutDatabaseObservation: <T>(callback: () => T) => callback(),
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
    mockGet
      .mockReturnValueOnce({ 1: 1 })
      .mockReturnValueOnce({ seeded_at: '2026-08-02T00:00:00.000Z' });
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      mode: 'public-demo',
      revision: 'revision-1',
      lifecycle,
    });
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'));
  });

  it('does not report ready before initialization completes', async () => {
    mockGet
      .mockReturnValueOnce({ 1: 1 })
      .mockReturnValueOnce(undefined);
    const { GET } = await import('@/app/api/health/ready/route');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ ready: false }));
  });

  it('does not report ready while the runtime is draining', async () => {
    mockGet
      .mockReturnValueOnce({ 1: 1 })
      .mockReturnValueOnce({ seeded_at: '2026-08-02T00:00:00.000Z' });
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
    mockGet
      .mockReturnValueOnce({ 1: 1 })
      .mockReturnValueOnce({ seeded_at: '2026-08-02T00:00:00.000Z' });

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
