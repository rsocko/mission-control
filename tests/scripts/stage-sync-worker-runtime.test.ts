import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stageSyncWorkerRuntime } from '../../scripts/lib/stage-sync-worker-runtime.mjs';

describe('stageSyncWorkerRuntime', () => {
  it('finishes the standalone copy before overlaying runtime-owned trees', async () => {
    const order: string[] = [];
    let releaseStandalone!: () => void;
    const standaloneCopy = new Promise<void>((resolve) => {
      releaseStandalone = resolve;
    });
    const copy = vi.fn(async (source: string, destination: string) => {
      order.push(`start:${source}->${destination}`);
      if (source === 'standalone') await standaloneCopy;
      order.push(`finish:${source}->${destination}`);
    });

    const staging = stageSyncWorkerRuntime({
      root: 'root',
      runtimeRoot: 'runtime',
      packagedRuntime: 'standalone',
      copy,
    });

    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
    releaseStandalone();
    await staging;

    expect(order).toEqual([
      'start:standalone->runtime',
      'finish:standalone->runtime',
      expect.stringMatching(/^start:.*dist->.*dist$/),
      expect.stringMatching(/^finish:.*dist->.*dist$/),
      expect.stringMatching(/^start:.*drizzle->.*drizzle$/),
      expect.stringMatching(/^finish:.*drizzle->.*drizzle$/),
    ]);
  });

  it('packages dependencies before overlaying runtime-owned trees', async () => {
    const order: string[] = [];
    const packageRuntime = vi.fn(async () => {
      order.push('package');
    });
    const copy = vi.fn(async (source: string) => {
      order.push(source);
    });

    await stageSyncWorkerRuntime({
      root: 'root',
      runtimeRoot: 'runtime',
      packagedRuntime: null,
      copy,
      packageRuntime,
    });

    expect(order[0]).toBe('package');
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it('deterministically overlays broad standalone trace directories', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mc-worker-stage-'));
    const root = path.join(temporaryRoot, 'root');
    const standalone = path.join(temporaryRoot, 'standalone');
    const runtime = path.join(temporaryRoot, 'runtime');

    try {
      await Promise.all([
        mkdir(path.join(root, 'dist'), { recursive: true }),
        mkdir(path.join(root, 'drizzle'), { recursive: true }),
        mkdir(path.join(standalone, 'dist'), { recursive: true }),
        mkdir(path.join(standalone, 'drizzle'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(root, 'dist', 'sync-worker.cjs'), 'current worker'),
        writeFile(path.join(root, 'drizzle', '0021.sql'), 'current migration'),
        writeFile(path.join(standalone, 'dist', 'sync-worker.cjs'), 'traced worker'),
        writeFile(path.join(standalone, 'drizzle', '0021.sql'), 'traced migration'),
      ]);

      await stageSyncWorkerRuntime({
        root,
        runtimeRoot: runtime,
        packagedRuntime: standalone,
      });

      await expect(readFile(path.join(runtime, 'dist', 'sync-worker.cjs'), 'utf8'))
        .resolves.toBe('current worker');
      await expect(readFile(path.join(runtime, 'drizzle', '0021.sql'), 'utf8'))
        .resolves.toBe('current migration');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
