import { describe, expect, it, vi } from 'vitest';
import { QueryEmbeddingCache } from '@/lib/search/query-embedding-cache';

const vector = {
  embedding: [1, 2, 3],
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 3,
  fallbackOccurred: false,
  correlationId: 'test-correlation',
};

describe('QueryEmbeddingCache', () => {
  it('coalesces concurrent requests and reuses successful values', async () => {
    let resolve!: (value: typeof vector) => void;
    const load = vi.fn(() => new Promise<typeof vector>((done) => {
      resolve = done;
    }));
    const cache = new QueryEmbeddingCache(4, 1_000);

    const first = cache.getOrCreate('identity', load);
    const second = cache.getOrCreate('identity', load);
    resolve(vector);

    await expect(first).resolves.toEqual(vector);
    await expect(second).resolves.toEqual(vector);
    await expect(cache.getOrCreate('identity', load)).resolves.toEqual(vector);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getMetrics()).toMatchObject({
      hits: 1,
      misses: 1,
      coalesced: 1,
      stores: 1,
    });
  });

  it('expires least-recently-used values and never caches failures', async () => {
    let now = 0;
    const cache = new QueryEmbeddingCache(2, 10, () => now);
    const load = vi.fn(async () => vector);

    await cache.getOrCreate('a', load);
    await cache.getOrCreate('b', load);
    await cache.getOrCreate('a', load);
    await cache.getOrCreate('c', load);
    expect(cache.getMetrics().evictions).toBe(1);

    now = 11;
    await cache.getOrCreate('a', load);
    expect(cache.getMetrics().expirations).toBe(1);

    const failed = vi.fn(async () => null);
    await cache.getOrCreate('failed', failed);
    await cache.getOrCreate('failed', failed);
    expect(failed).toHaveBeenCalledTimes(2);
    expect(cache.getMetrics().failures).toBe(2);
  });
});
