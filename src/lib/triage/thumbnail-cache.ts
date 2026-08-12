import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { mkdir, opendir, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import logger from '@/lib/logger';
import { fetchBounded } from '@/lib/ingestion/bounded-fetch';
import { INGESTION_LIMITS } from '@/lib/ingestion/bounded-reader';

/**
 * Local filesystem thumbnail cache.
 *
 * Stores downloaded thumbnails in the data volume at /app/data/thumbnails/
 * using a flat naming scheme: {source}-{identifier}.{ext}
 *
 * This solves the problem of expiring CDN URLs (e.g. Instagram) by caching
 * the image bytes at import time when the URL is still valid.
 */

const DATA_DIR = process.env.MC_DATA_DIR || process.env.MC_DB_PATH?.replace(/\/[^/]+$/, '') || './data';
const THUMBNAILS_DIR = join(DATA_DIR, 'thumbnails');

// Ensure the thumbnails directory exists
function ensureDir() {
  if (!existsSync(THUMBNAILS_DIR)) {
    mkdirSync(THUMBNAILS_DIR, { recursive: true });
  }
}

/**
 * Build a cache filename from a source platform and identifier.
 * e.g. "instagram", "C8xY3kL" → "instagram-C8xY3kL.jpg"
 */
export function buildThumbnailFilename(source: string, identifier: string, ext = 'jpg'): string {
  // Sanitize identifier to be filesystem-safe
  const safe = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${source}-${safe}.${ext}`;
}

/**
 * Get the internal API URL for a cached thumbnail.
 * This is what gets stored in the DB as thumbnailUrl.
 */
export function getThumbnailServeUrl(filename: string): string {
  return `/api/assets/thumbnails/${filename}`;
}

/**
 * Download an image from a URL and cache it locally.
 * Returns the internal serve URL on success, or null on failure.
 *
 * Non-blocking — failures are logged but don't throw.
 */
export async function cacheThumbnail(
  remoteUrl: string,
  source: string,
  identifier: string,
): Promise<string | null> {
  try {
    ensureDir();

    // Detect extension from URL or default to jpg
    const ext = detectExtension(remoteUrl);
    const filename = buildThumbnailFilename(source, identifier, ext);
    const filepath = join(THUMBNAILS_DIR, filename);

    // Skip if already cached
    if (existsSync(filepath)) {
      return getThumbnailServeUrl(filename);
    }

    const { bytes, response } = await fetchBounded(remoteUrl, {
      limit: INGESTION_LIMITS.thumbnailBytes,
      timeoutMs: INGESTION_LIMITS.thumbnailTimeoutMs,
      acceptContentTypes: /^image\//i,
      label: 'Thumbnail',
      source: 'thumbnail',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MissionControl/1.0)',
      },
    });

    // Verify it's actually an image
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      logger.debug({ url: remoteUrl, contentType }, 'Thumbnail URL did not return an image');
      return null;
    }

    const buffer = Buffer.from(bytes);

    // Sanity check — don't cache empty or tiny responses
    if (buffer.length < 100) {
      logger.debug({ url: remoteUrl, size: buffer.length }, 'Thumbnail too small, skipping cache');
      return null;
    }

    await writeFile(filepath, buffer);
    logger.debug({ filename, size: buffer.length }, 'Cached thumbnail');

    return getThumbnailServeUrl(filename);
  } catch (err) {
    // AbortError, network errors, etc. — non-fatal
    logger.debug({ err, source, identifier }, 'Failed to cache thumbnail');
    return null;
  }
}

/**
 * Read a cached thumbnail from disk.
 * Returns { buffer, contentType } or null if not found.
 */
export function readCachedThumbnail(filename: string): { buffer: Buffer; contentType: string } | null {
  // Sanitize to prevent path traversal
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (sanitized !== filename) return null;

  const filepath = join(THUMBNAILS_DIR, sanitized);
  if (!existsSync(filepath)) return null;

  try {
    const buffer = readFileSync(filepath);
    const ext = sanitized.split('.').pop() || 'jpg';
    const contentType = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg';

    return { buffer, contentType };
  } catch {
    return null;
  }
}

/**
 * Check if a thumbnail is already cached.
 */
export function isThumbnailCached(source: string, identifier: string, ext = 'jpg'): boolean {
  const filename = buildThumbnailFilename(source, identifier, ext);
  return existsSync(join(THUMBNAILS_DIR, filename));
}

/**
 * Delete a cached thumbnail file.
 */
export function deleteCachedThumbnail(filename: string): boolean {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (sanitized !== filename) return false;

  const filepath = join(THUMBNAILS_DIR, sanitized);
  if (!existsSync(filepath)) return false;

  try {
    unlinkSync(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get cache statistics: file count, total size in bytes.
 */
export async function getThumbnailCacheStats(directory = THUMBNAILS_DIR): Promise<{ fileCount: number; totalBytes: number }> {
  await mkdir(directory, { recursive: true });
  try {
    let totalBytes = 0;
    let fileCount = 0;
    let processed = 0;
    const entries = await opendir(directory);

    for await (const entry of entries) {
      try {
        const metadata = await stat(join(directory, entry.name));
        if (metadata.isFile()) {
          totalBytes += metadata.size;
          fileCount++;
        }
      } catch { /* skip inaccessible entries */ }
      processed++;
      if (processed % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    return { fileCount, totalBytes };
  } catch {
    return { fileCount: 0, totalBytes: 0 };
  }
}

/**
 * Remove orphaned thumbnail files (files with no matching DB reference).
 * Takes a set of valid filenames that should be kept.
 * Returns the number of files removed.
 */
export async function removeOrphanedThumbnails(
  validFilenames: Set<string>,
  directory = THUMBNAILS_DIR,
): Promise<number> {
  await mkdir(directory, { recursive: true });
  try {
    let removed = 0;
    let processed = 0;
    const entries = await opendir(directory);

    for await (const entry of entries) {
      if (entry.isFile() && !validFilenames.has(entry.name)) {
        try {
          await unlink(join(directory, entry.name));
          removed++;
        } catch { /* skip inaccessible entries */ }
      }
      processed++;
      if (processed % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    return removed;
  } catch {
    return 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'png';
    if (pathname.endsWith('.webp')) return 'webp';
    if (pathname.endsWith('.gif')) return 'gif';
  } catch { /* ignore */ }
  return 'jpg';
}
