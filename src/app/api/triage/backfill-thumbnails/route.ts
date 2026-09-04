import { NextResponse } from 'next/server';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import { cacheThumbnail } from '@/lib/triage/thumbnail-cache';
import logger from '@/lib/logger';
import { getTriagePersistenceRepositories } from '@/lib/triage/persistence';

/**
 * POST /api/triage/backfill-thumbnails
 *
 * Backfill thumbnailUrl for existing triage items that are missing it.
 * Uses platform-specific logic to derive thumbnails from existing rawMetadata:
 *
 * - GitHub: constructs avatar URL from ownerLogin in rawMetadata
 * - Reddit: checks rawMetadata for preview images (already handled at import now)
 * - Others: promotes embed.thumbnail_url to the top-level thumbnailUrl field
 *
 * Query params:
 *   source — filter to a specific source platform (e.g. "github", "reddit")
 *   limit — max items to process (default 100, max 500)
 *   dryRun — if "true", just return items that would be updated
 */
export async function POST(request: Request) {
  if (!hasValidTriageCaptureKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = parseInt(searchParams.get('limit') || '100', 10);
  const limit = Math.min(Math.max(1, limitParam), 500);
  const dryRun = searchParams.get('dryRun') === 'true';
  const sourceFilter = searchParams.get('source') || null;

  try {
    const candidates = await getTriagePersistenceRepositories()
      .items
      .listMissingThumbnailCandidates(
        sourceFilter ? { source: sourceFilter } : undefined,
      );

    const updates: Array<{ id: string; thumbnailUrl: string; source: string; sourceUrl: string }> = [];

    for (const item of candidates) {
      if (updates.length >= limit) break;

      const meta = parseMeta(item.rawMetadata);
      let thumbnailUrl: string | null = null;

      switch (item.sourcePlatform) {
        case 'github': {
          const ownerLogin = meta?.ownerLogin as string | undefined;
          const fullName = meta?.fullName as string | undefined;
          if (ownerLogin) {
            thumbnailUrl = `https://github.com/${ownerLogin}.png?size=128`;
          } else if (fullName) {
            thumbnailUrl = `https://opengraph.githubassets.com/1/${fullName}`;
          }
          break;
        }
        case 'instagram': {
          // Extension stores mediaUrls in rawMetadata; also check thumbnailUrl field
          const storedThumb = meta?.thumbnailUrl as string | undefined;
          if (storedThumb) {
            thumbnailUrl = storedThumb;
          } else {
            const mediaUrls = meta?.mediaUrls as string[] | undefined;
            if (Array.isArray(mediaUrls) && mediaUrls.length > 0 && typeof mediaUrls[0] === 'string') {
              thumbnailUrl = mediaUrls[0];
            }
          }
          // Fall back to embed thumbnail
          if (!thumbnailUrl) {
            const embed = meta?.embed as { thumbnail_url?: string } | undefined;
            if (embed?.thumbnail_url) thumbnailUrl = embed.thumbnail_url;
          }
          break;
        }
        case 'reddit': {
          // Check rawMetadata for thumbnailUrl stored by updated extension
          const storedThumb = meta?.thumbnailUrl as string | undefined;
          if (storedThumb) {
            thumbnailUrl = storedThumb;
          }

          // Check preview images from rawMetadata (server importer stores full post data)
          if (!thumbnailUrl) {
            const preview = meta?.preview as { images?: Array<{ source?: { url?: string }; resolutions?: Array<{ url?: string }> }> } | undefined;
            const previewSource = preview?.images?.[0]?.source?.url;
            if (typeof previewSource === 'string' && previewSource.startsWith('http')) {
              thumbnailUrl = previewSource.replace(/&amp;/g, '&');
            } else {
              const previewRes = preview?.images?.[0]?.resolutions?.[0]?.url;
              if (typeof previewRes === 'string' && previewRes.startsWith('http')) {
                thumbnailUrl = previewRes.replace(/&amp;/g, '&');
              }
            }
          }

          // Check media_metadata for gallery posts
          if (!thumbnailUrl) {
            const mediaMeta = meta?.media_metadata as Record<string, { s?: { u?: string }; p?: Array<{ u?: string }> }> | undefined;
            if (mediaMeta && typeof mediaMeta === 'object') {
              const firstKey = Object.keys(mediaMeta)[0];
              if (firstKey) {
                const galleryUrl = mediaMeta[firstKey]?.s?.u;
                if (typeof galleryUrl === 'string' && galleryUrl.startsWith('http')) {
                  thumbnailUrl = galleryUrl.replace(/&amp;/g, '&');
                } else {
                  const galleryThumb = mediaMeta[firstKey]?.p?.[0]?.u;
                  if (typeof galleryThumb === 'string' && galleryThumb.startsWith('http')) {
                    thumbnailUrl = galleryThumb.replace(/&amp;/g, '&');
                  }
                }
              }
            }
          }

          // Check embed for thumbnail that was resolved but not stored at top level
          if (!thumbnailUrl) {
            const embed = meta?.embed as { thumbnail_url?: string } | undefined;
            if (embed?.thumbnail_url) {
              thumbnailUrl = embed.thumbnail_url;
            }
          }
          break;
        }
        default: {
          // For other sources, check if embed has a thumbnail
          const embed = meta?.embed as { thumbnail_url?: string } | undefined;
          if (embed?.thumbnail_url) {
            thumbnailUrl = embed.thumbnail_url;
          }
          break;
        }
      }

      if (thumbnailUrl) {
        updates.push({ id: item.id, thumbnailUrl, source: item.sourcePlatform, sourceUrl: item.sourceUrl });
      }
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        totalMissingThumbnails: candidates.length,
        wouldUpdate: updates.length,
        items: updates.map((u) => ({ id: u.id, source: u.source, thumbnailUrl: u.thumbnailUrl })),
      });
    }

    // Apply updates using fill-only semantics: the isNull guard in the WHERE
    // clause ensures we never overwrite an existing thumbnailUrl. If another
    // process populated it between our SELECT and UPDATE, the row simply won't
    // match and no data is lost (inspired by COALESCE/NULLIF fill patterns).
    let updated = 0;
    for (const { id, thumbnailUrl, source, sourceUrl } of updates) {
      // For platforms with expiring CDN URLs, cache the image locally
      let finalUrl = thumbnailUrl;
      if (['instagram', 'tiktok'].includes(source)) {
        const identifier = extractShortIdentifier(source, sourceUrl);
        const cachedUrl = await cacheThumbnail(thumbnailUrl, source, identifier);
        if (cachedUrl) {
          finalUrl = cachedUrl;
        }
      }
      await getTriagePersistenceRepositories().items.fillThumbnailIfNull(id, finalUrl);
      updated++;
    }

    return NextResponse.json({
      totalMissingThumbnails: candidates.length,
      updated,
    });
  } catch (error) {
    logger.error({ err: error }, 'Backfill thumbnails failed');
    return NextResponse.json({ error: 'Backfill thumbnails failed' }, { status: 500 });
  }
}

function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function extractShortIdentifier(source: string, sourceUrl: string): string {
  if (source === 'instagram') {
    const match = sourceUrl.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  if (source === 'tiktok') {
    const match = sourceUrl.match(/\/video\/(\d+)/);
    if (match) return match[1];
  }
  // Fallback: hash the URL into a short identifier
  let hash = 0;
  for (let i = 0; i < sourceUrl.length; i++) {
    hash = ((hash << 5) - hash + sourceUrl.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
