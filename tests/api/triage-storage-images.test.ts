import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';

function chainable<T>(terminal: T) {
  const chain = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  update: vi.fn(() => chainable({ changes: 2 })),
  select: vi.fn(() => chainable([])),
  delete: vi.fn(() => chainable({ changes: 0 })),
};

vi.mock('@/db', () => ({ default: mockDb }));
vi.mock('@/db/schema', () => ({
  triageItems: {
    id: 'id',
    status: 'status',
    sourcePlatform: 'sourcePlatform',
    sourceUrl: 'sourceUrl',
    thumbnailUrl: 'thumbnailUrl',
  },
}));
vi.mock('@/lib/triage/lifecycle', () => ({
  purgeDismissedItems: vi.fn(),
}));
vi.mock('@/lib/triage/capture-image-lifecycle', () => ({
  cleanupTriageItemStorage: vi.fn(),
}));
vi.mock('@/lib/triage/thumbnail-cache', () => ({
  deleteCachedThumbnail: vi.fn(),
  getThumbnailCacheStats: () => ({ fileCount: 0, totalBytes: 0 }),
  removeOrphanedThumbnails: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('POST /api/triage/storage image maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.update.mockReturnValue(chainable({ changes: 2 }));
  });

  it('excludes managed capture image URLs from clear_expired', async () => {
    const { POST } = await import('@/app/api/triage/storage/route');
    const response = await POST(new Request('http://localhost/api/triage/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear_expired' }),
    }));

    expect(response.status).toBe(200);
    expect(vi.mocked(and)).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything());
  });
});
