import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('web runtime lifecycle', () => {
  let directory: string;

  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as typeof globalThis & {
      __mc_runtime_lifecycle__?: unknown;
    }).__mc_runtime_lifecycle__;
    directory = mkdtempSync(join(tmpdir(), 'mc-runtime-lifecycle-'));
    process.env.MC_RUNTIME_DIAGNOSTICS_PATH = join(directory, 'runtime-exit.json');
    process.env.MC_DEPLOYMENT_REVISION = 'sha-test';
    process.env.MC_CONTAINER_RESTART_COUNT = '2';
  });

  afterEach(() => {
    delete process.env.MC_RUNTIME_DIAGNOSTICS_PATH;
    delete process.env.MC_DEPLOYMENT_REVISION;
    delete process.env.MC_CONTAINER_RESTART_COUNT;
    rmSync(directory, { recursive: true, force: true });
  });

  it('aborts cancellable work and persists restart context before shutdown', async () => {
    const {
      beginRuntimeDrain,
      getRuntimeLifecycleSnapshot,
      markRuntimeReady,
      recordRuntimeMemoryDiagnostics,
      startRuntimeOperation,
    } = await import('@/lib/runtime/lifecycle');
    markRuntimeReady();
    const operation = startRuntimeOperation('export');
    recordRuntimeMemoryDiagnostics({
      sampledAt: '2026-08-06T00:00:00.000Z',
      rssBytes: 900,
      rssHighWaterBytes: 950,
      rssP95Bytes: 925,
      externalBytes: 100,
      arrayBuffersBytes: 50,
      containerCurrentBytes: 900,
      containerLimitBytes: 1000,
      containerOomEvents: 0,
      containerOomKillEvents: 0,
      pressure: 'critical',
    });

    beginRuntimeDrain('memory-critical');

    expect(operation.signal.aborted).toBe(true);
    expect(getRuntimeLifecycleSnapshot()).toMatchObject({
      status: 'draining',
      reason: 'memory-critical',
      release: 'sha-test',
      activeOperations: { export: 1 },
    });
    expect(JSON.parse(readFileSync(
      process.env.MC_RUNTIME_DIAGNOSTICS_PATH!,
      'utf8',
    ))).toMatchObject({
      role: 'web',
      release: 'sha-test',
      reason: 'memory-critical',
      restartCount: 2,
      activeOperations: { export: 1 },
      memory: {
        rssHighWaterBytes: 950,
        pressure: 'critical',
      },
    });
    operation.finish();
  });

  it('holds readiness after a critical-memory restart until stabilization', async () => {
    vi.useFakeTimers();
    const diagnostics = {
      recordedAt: '2026-08-06T00:00:00.000Z',
      role: 'web',
      release: 'sha-old',
      reason: 'memory-critical',
      restartCount: null,
      activeOperations: { 'archive-import': 1 },
      memory: {
        sampledAt: '2026-08-06T00:00:00.000Z',
        rssBytes: 900,
        rssHighWaterBytes: 950,
        rssP95Bytes: 925,
        externalBytes: 100,
        arrayBuffersBytes: 50,
        containerCurrentBytes: 900,
        containerLimitBytes: 1000,
        containerOomEvents: 1,
        containerOomKillEvents: 1,
        pressure: 'critical',
      },
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.MC_RUNTIME_DIAGNOSTICS_PATH!,
      JSON.stringify(diagnostics),
    );
    process.env.MC_RESTART_STABILIZATION_MS = '5000';
    const {
      configureRuntimeLifecycle,
      isRuntimeReady,
      markRuntimeReady,
    } = await import('@/lib/runtime/lifecycle');

    configureRuntimeLifecycle('web');
    markRuntimeReady();
    expect(isRuntimeReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(isRuntimeReady()).toBe(true);
    vi.useRealTimers();
    delete process.env.MC_RESTART_STABILIZATION_MS;
  });
});
