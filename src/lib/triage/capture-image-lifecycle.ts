import 'server-only';

import logger from '@/lib/logger';
import { deleteCachedThumbnail } from './thumbnail-cache';

const CAPTURE_IMAGE_URL_PATTERN = /^\/api\/triage\/capture\/image\/([0-9a-f-]{36})$/i;

export async function cleanupTriageItemStorage(
  thumbnailUrl: string | null | undefined,
): Promise<void> {
  if (thumbnailUrl?.startsWith('/api/assets/thumbnails/')) {
    const filename = thumbnailUrl.split('/').pop();
    if (filename) deleteCachedThumbnail(filename);
    return;
  }

  const captureImageId = thumbnailUrl?.match(CAPTURE_IMAGE_URL_PATTERN)?.[1];
  if (!captureImageId) return;

  try {
    const { getCaptureImageStorage } = await import('./capture-image-storage');
    await getCaptureImageStorage().delete(captureImageId);
  } catch (error) {
    logger.error({ err: error, captureImageId }, 'Failed to delete stored capture image');
  }
}

