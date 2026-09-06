import { describe, expect, it, vi } from 'vitest';

const { markSeeded, ensureReady, resetDemoDatabase, updateSettings } = vi.hoisted(() => ({
  ensureReady: vi.fn(async () => {}),
  markSeeded: vi.fn<(seededAt: string) => Promise<void>>(async () => {}),
  resetDemoDatabase: vi.fn(async () => {}),
  updateSettings: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/seed-api', () => ({ resetDemoDatabase }));
vi.mock('@/lib/mode', () => ({ updateSettings }));
vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    operationalUtility: { publicDemo: { ensureReady, markSeeded } },
  }),
}));

describe('public demo runtime', () => {
  it('resets demo data before marking the runtime as seeded', async () => {
    const { initializePublicDemoData } = await import('@/lib/public-demo-runtime');
    const calls: string[] = [];
    const mark = vi.fn(() => { calls.push('mark'); });

    await initializePublicDemoData({
      initializeDatabase: () => { calls.push('initialize'); },
      resetDemoDatabase: async () => { calls.push('reset'); },
      markSeeded: mark,
    });

    expect(calls).toEqual(['initialize', 'reset', 'mark']);
    expect(mark).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it('drives the operational utility public-demo subport by default', async () => {
    const { initializePublicDemoData } = await import('@/lib/public-demo-runtime');

    await initializePublicDemoData();

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(resetDemoDatabase).toHaveBeenCalledTimes(1);
    expect(markSeeded).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(updateSettings).toHaveBeenCalledWith({
      mode: 'demo',
      demoSeededAt: markSeeded.mock.calls[0][0],
    });
    expect(ensureReady.mock.invocationCallOrder[0])
      .toBeLessThan(resetDemoDatabase.mock.invocationCallOrder[0]);
    expect(resetDemoDatabase.mock.invocationCallOrder[0])
      .toBeLessThan(markSeeded.mock.invocationCallOrder[0]);
  });

  it('fails when the backend does not provide operational utility persistence', async () => {
    vi.resetModules();
    vi.doMock('@/lib/persistence/worker-runtime', () => ({
      getWorkerPersistenceRepositories: async () => ({}),
    }));
    const { initializePublicDemoData } = await import('@/lib/public-demo-runtime');

    await expect(initializePublicDemoData()).rejects.toThrow(
      'Operational utility persistence is not available in the selected backend',
    );
    vi.doUnmock('@/lib/persistence/worker-runtime');
    vi.resetModules();
  });
});
