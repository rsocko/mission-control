import { describe, expect, it } from 'vitest';
import { EmbeddingCache, type EmbeddingCacheEntry } from '@/lib/search/embedding-cache';

function entry(id: string, dimensions = 16): EmbeddingCacheEntry {
  const embedding = new Float32Array(dimensions).fill(0.25);
  return {
    id: `task:${id}`,
    entityType: 'task',
    entityId: id,
    embedding,
    norm: Math.sqrt(dimensions * 0.25 * 0.25),
    updatedAt: '2030-01-01T00:00:00.000Z',
    provider: 'ollama',
    model: 'nomic-embed-text',
  };
}

describe('EmbeddingCache', () => {
  it('enforces entry and byte budgets with LRU eviction', () => {
    const cache = new EmbeddingCache(2, 10_000);
    cache.set(entry('one'));
    cache.set(entry('two'));
    expect(cache.get(
      'task:one',
      '2030-01-01T00:00:00.000Z',
      'ollama',
      'nomic-embed-text',
    )?.entityId).toBe('one');

    cache.set(entry('three'));

    expect(cache.getMetrics()).toMatchObject({ entries: 2, evictions: 1 });
    expect(cache.get(
      'task:two',
      '2030-01-01T00:00:00.000Z',
      'ollama',
      'nomic-embed-text',
    )).toBeUndefined();
  });

  it('rejects a vector larger than the total byte budget', () => {
    const cache = new EmbeddingCache(10, 256);

    expect(cache.set(entry('large', 1_536))).toBe(false);
    expect(cache.getMetrics()).toMatchObject({
      entries: 0,
      estimatedBytes: 0,
      rejectedOversize: 1,
    });
  });

  it('keeps retained bytes bounded for a large fixture', () => {
    const maxBytes = 256 * 1024;
    const cache = new EmbeddingCache(10_000, maxBytes);

    for (let index = 0; index < 5_000; index++) {
      cache.set(entry(String(index), 384));
    }

    const metrics = cache.getMetrics();
    expect(metrics.estimatedBytes).toBeLessThanOrEqual(maxBytes);
    expect(metrics.entries).toBeLessThan(5_000);
    expect(metrics.evictions).toBeGreaterThan(0);
  });

  it('invalidates entries when provider, model, or update version changes', () => {
    const cache = new EmbeddingCache(10, 10_000);
    cache.set(entry('one'));

    expect(cache.get(
      'task:one',
      '2030-01-01T00:00:00.000Z',
      'ollama',
      'different-model',
    )).toBeUndefined();
    expect(cache.getMetrics()).toMatchObject({ entries: 0, misses: 1 });
  });
});
