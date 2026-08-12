import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTriageItemStorage } from '@/lib/triage/capture-image-lifecycle';
import { deleteCachedThumbnail } from '@/lib/triage/thumbnail-cache';

const storage = { delete: vi.fn() };

vi.mock('@/lib/triage/capture-image-storage', () => ({
  getCaptureImageStorage: () => storage,
}));
vi.mock('@/lib/triage/thumbnail-cache', () => ({
  deleteCachedThumbnail: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('cleanupTriageItemStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.delete.mockResolvedValue(undefined);
  });

  it('deletes capture images by their validated storage ID', async () => {
    await cleanupTriageItemStorage(
      '/api/triage/capture/image/2f1dfac6-69dc-4ca0-8514-7f441dc253cb',
    );

    expect(storage.delete).toHaveBeenCalledWith('2f1dfac6-69dc-4ca0-8514-7f441dc253cb');
  });

  it('preserves existing cached-thumbnail cleanup behavior', async () => {
    await cleanupTriageItemStorage('/api/assets/thumbnails/example.webp');

    expect(deleteCachedThumbnail).toHaveBeenCalledWith('example.webp');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
