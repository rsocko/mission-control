import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/telemetry/runtime', () => ({
  recordLivenessProbe: vi.fn(),
}));

describe('web liveness process isolation', () => {
  it('serves liveness while a separate worker process is CPU-bound', async () => {
    const worker = spawn(
      process.execPath,
      ['-e', 'const end=Date.now()+1000; while(Date.now()<end) Math.sqrt(Math.random())'],
      { stdio: 'ignore' },
    );
    const { GET } = await import('@/app/api/health/live/route');
    const startedAt = performance.now();

    const response = await GET();
    const durationMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ live: true });
    expect(durationMs).toBeLessThan(500);
    await once(worker, 'exit');
  });
});
