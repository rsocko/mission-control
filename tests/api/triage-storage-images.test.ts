import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearExternalThumbnails = vi.fn();

vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => ({
    maintenance: {
      clearExternalThumbnails,
    },
  }),
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
    clearExternalThumbnails.mockResolvedValue(2);
  });

  it('returns the adapter-owned clear_expired outcome', async () => {
    const { POST } = await import('@/app/api/triage/storage/route');
    const response = await POST(new Request('http://localhost/api/triage/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear_expired' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: 'clear_expired', cleared: 2 });
    expect(clearExternalThumbnails).toHaveBeenCalledOnce();
  });
});
