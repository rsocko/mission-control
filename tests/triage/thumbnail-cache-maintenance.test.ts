import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getThumbnailCacheStats,
  removeOrphanedThumbnails,
} from '@/lib/triage/thumbnail-cache';

describe('thumbnail cache maintenance', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(
      directory => rm(directory, { recursive: true, force: true }),
    ));
  });

  it('scans and cleans a large directory in complete async batches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mc-thumbnail-cache-'));
    temporaryDirectories.push(directory);
    const fileCount = 250;
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(directory, `thumbnail-${index}.jpg`), Buffer.alloc(index % 7 + 1)),
    ));
    await mkdir(join(directory, 'nested'));
    const immediate = vi.spyOn(globalThis, 'setImmediate');

    const stats = await getThumbnailCacheStats(directory);
    expect(stats.fileCount).toBe(fileCount);
    expect(stats.totalBytes).toBe(
      Array.from({ length: fileCount }, (_, index) => index % 7 + 1)
        .reduce((total, size) => total + size, 0),
    );

    const retained = new Set(['thumbnail-0.jpg', 'thumbnail-249.jpg']);
    await expect(removeOrphanedThumbnails(retained, directory)).resolves.toBe(fileCount - retained.size);
    expect(immediate.mock.calls.length).toBeGreaterThanOrEqual(4);
    await expect(readdir(directory)).resolves.toEqual(expect.arrayContaining([
      'nested',
      'thumbnail-0.jpg',
      'thumbnail-249.jpg',
    ]));
  });
});
