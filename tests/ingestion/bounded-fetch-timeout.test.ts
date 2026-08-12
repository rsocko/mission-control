import { describe, expect, it, vi } from 'vitest';
import { IngestionTimeoutError } from '@/lib/ingestion/bounded-reader';

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup },
    lookup,
  };
});

describe('bounded fetch timeout', () => {
  it('times out while DNS resolution is stalled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { fetchBounded } = await import('@/lib/ingestion/bounded-fetch');

    await expect(fetchBounded('https://stalled.example/document', {
      limit: 100,
      timeoutMs: 5,
      source: 'remote-document',
    })).rejects.toBeInstanceOf(IngestionTimeoutError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
