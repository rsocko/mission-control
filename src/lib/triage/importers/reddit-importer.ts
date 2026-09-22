/**
 * Reddit Saved importer for triage queue.
 */
import type { TriageSourcePlatform } from '@/types';
import { ingestTriageImports, type TriageImportInput } from '../import-capture';
import {
  completeFullSyncResult,
  createFullSyncResult,
  fetchWithRateLimit,
  IMPORT_USER_AGENT,
  MAX_PAGES,
  remoteResponseError,
  safeRemoteError,
} from './base-importer';
import { getSyncState, recordSyncRun } from '../sync-state';
import type { TriageImportSummary, FullSyncResult } from './base-importer';

async function getRedditAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const basicAuth = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
  const tokenResponse = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': IMPORT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
  });

  if (!tokenResponse.ok) {
    throw remoteResponseError('Reddit token exchange', tokenResponse);
  }

  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    throw new Error('Reddit token exchange returned malformed data');
  }
  return token.access_token;
}

async function resolveRedditUsername(accessToken: string) {
  const response = await fetchWithRateLimit('https://oauth.reddit.com/api/v1/me', {
    headers: {
      Authorization: `${'Bearer'} ${accessToken}`,
      'User-Agent': IMPORT_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw remoteResponseError('Reddit profile request', response);
  }
  const me = await response.json() as { name?: string };
  if (!me.name) throw new Error('Reddit profile response returned malformed data');
  return me.name;
}

type RedditListingChild = {
  kind: string;
  data: Record<string, unknown>;
};

function toIsoFromUnix(value: unknown): string | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function toAbsoluteRedditUrl(pathOrUrl: unknown): string | null {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `https://www.reddit.com${pathOrUrl}`;
  return null;
}

function decodeRedditUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('http')) return null;
  return url.replace(/&amp;/g, '&');
}

function extractRedditThumbnail(data: Record<string, unknown>): string | null {
  const preview = data.preview as {
    images?: Array<{
      source?: { url?: string };
      resolutions?: Array<{ url?: string }>;
      variants?: {
        gif?: { source?: { url?: string }; resolutions?: Array<{ url?: string }> };
        mp4?: { source?: { url?: string } };
      };
    }>;
  } | undefined;

  // 1. Animated GIF variant (full quality animated image — renders in <img> tag)
  const gifVariant = decodeRedditUrl(preview?.images?.[0]?.variants?.gif?.source?.url);
  if (gifVariant) return gifVariant;

  // 2. Direct i.redd.it URL — full quality original (GIF, PNG, JPG)
  const overriddenUrl = data.url_overridden_by_dest;
  if (typeof overriddenUrl === 'string' && overriddenUrl.includes('i.redd.it') && overriddenUrl.startsWith('http')) {
    return overriddenUrl;
  }

  // 3. High-res preview source image (static JPEG)
  const previewSource = decodeRedditUrl(preview?.images?.[0]?.source?.url);
  if (previewSource) return previewSource;

  // 4. First preview resolution (smaller but still decent)
  const previewRes = decodeRedditUrl(preview?.images?.[0]?.resolutions?.[0]?.url);
  if (previewRes) return previewRes;

  // 5. Gallery posts: media_metadata first key source URL
  const mediaMeta = data.media_metadata as Record<string, { s?: { u?: string; gif?: string }; p?: Array<{ u?: string }> }> | undefined;
  if (mediaMeta && typeof mediaMeta === 'object') {
    const firstKey = Object.keys(mediaMeta)[0];
    if (firstKey) {
      // Prefer GIF URL from gallery metadata
      const galleryGif = decodeRedditUrl(mediaMeta[firstKey]?.s?.gif);
      if (galleryGif) return galleryGif;

      const gallerySource = decodeRedditUrl(mediaMeta[firstKey]?.s?.u);
      if (gallerySource) return gallerySource;

      const galleryThumb = decodeRedditUrl(mediaMeta[firstKey]?.p?.[0]?.u);
      if (galleryThumb) return galleryThumb;
    }
  }

  // 6. Skip v.redd.it URLs — they are video URLs, not images.
  //    Only use other redd.it image hosts (e.g. i.redd.it already handled above).

  // 7. Fall back to thumbnail field (lower res but widely available)
  const thumb = data.thumbnail as string | undefined;
  if (typeof thumb === 'string' && thumb.startsWith('http')) {
    return thumb;
  }

  return null;
}

/**
 * Extract video/mp4 URL from Reddit post data for inline playback.
 * Reddit hosts videos at v.redd.it and provides mp4 variants in preview data.
 */
function extractRedditVideoUrl(data: Record<string, unknown>): string | null {
  const preview = data.preview as {
    images?: Array<{
      variants?: {
        mp4?: { source?: { url?: string } };
      };
    }>;
    reddit_video_preview?: { fallback_url?: string };
  } | undefined;

  // 1. MP4 variant from preview (GIF posts converted to mp4 — best for inline playback)
  const mp4Variant = decodeRedditUrl(preview?.images?.[0]?.variants?.mp4?.source?.url);
  if (mp4Variant) return mp4Variant;

  // 2. Reddit-hosted video (data.media.reddit_video or data.secure_media.reddit_video)
  const media = data.media as { reddit_video?: { fallback_url?: string } } | undefined;
  const secureMedia = data.secure_media as { reddit_video?: { fallback_url?: string } } | undefined;
  const redditVideo = media?.reddit_video?.fallback_url || secureMedia?.reddit_video?.fallback_url;
  if (redditVideo) return redditVideo;

  // 3. Cross-posted video preview
  const videoPreview = preview?.reddit_video_preview?.fallback_url;
  if (videoPreview) return videoPreview;

  // 4. v.redd.it URL from url_overridden_by_dest (video link posts)
  const overriddenUrl = data.url_overridden_by_dest;
  if (typeof overriddenUrl === 'string' && overriddenUrl.includes('v.redd.it') && overriddenUrl.startsWith('http')) {
    return overriddenUrl;
  }

  return null;
}

/**
 * Extract all gallery image URLs from a Reddit gallery post, ordered by gallery_data.
 * Returns null if the post is not a gallery.
 */
function extractRedditGalleryUrls(data: Record<string, unknown>): string[] | null {
  const mediaMeta = data.media_metadata as Record<string, { s?: { u?: string; gif?: string }; e?: string; m?: string }> | undefined;
  if (!mediaMeta || typeof mediaMeta !== 'object') return null;

  const galleryData = data.gallery_data as { items?: Array<{ media_id: string }> } | undefined;
  const orderedKeys = galleryData?.items?.map((item) => item.media_id) || Object.keys(mediaMeta);

  if (orderedKeys.length <= 1) return null;

  const urls: string[] = [];
  for (const key of orderedKeys) {
    const entry = mediaMeta[key];
    if (!entry) continue;
    // Prefer animated GIF URL, then full-size source
    const url = decodeRedditUrl(entry.s?.gif) || decodeRedditUrl(entry.s?.u);
    if (url) urls.push(url);
  }

  return urls.length > 1 ? urls : null;
}

function mapRedditChildToImport(
  child: RedditListingChild,
): {
  sourcePlatform: TriageSourcePlatform;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  capturedAt?: string;
  rawMetadata?: Record<string, unknown>;
} | null {
  const data = child.data;
  const sourceId = typeof data.name === 'string' ? `reddit:${data.name}` : null;
  if (!sourceId) return null;

  if (child.kind === 't3') {
    const permalink = toAbsoluteRedditUrl(data.permalink);
    const sourceUrl = toAbsoluteRedditUrl(data.url_overridden_by_dest) || permalink;
    if (!sourceUrl) return null;

    const galleryUrls = extractRedditGalleryUrls(data);
    const videoUrl = extractRedditVideoUrl(data);

    return {
      sourcePlatform: 'reddit',
      sourceId,
      sourceUrl,
      canonicalUrl: toAbsoluteRedditUrl(data.url_overridden_by_dest) || sourceUrl,
      title: typeof data.title === 'string' ? data.title : 'Reddit saved post',
      description: typeof data.selftext === 'string' && data.selftext.trim()
        ? data.selftext
        : typeof data.subreddit_name_prefixed === 'string'
          ? data.subreddit_name_prefixed
          : undefined,
      thumbnailUrl: extractRedditThumbnail(data) || undefined,
      capturedAt: toIsoFromUnix(data.created_utc),
      rawMetadata: {
        subreddit: data.subreddit,
        subredditNamePrefixed: data.subreddit_name_prefixed,
        author: data.author,
        score: data.score,
        comments: data.num_comments,
        permalink,
        kind: child.kind,
        ...(galleryUrls ? { galleryUrls } : {}),
        ...(videoUrl ? { redditVideoUrl: videoUrl } : {}),
      },
    };
  }

  if (child.kind === 't1') {
    const sourceUrl = toAbsoluteRedditUrl(data.link_permalink) || toAbsoluteRedditUrl(data.permalink);
    if (!sourceUrl) return null;
    const subreddit = typeof data.subreddit_name_prefixed === 'string' ? data.subreddit_name_prefixed : 'Reddit';

    return {
      sourcePlatform: 'reddit',
      sourceId,
      sourceUrl,
      canonicalUrl: sourceUrl,
      title: `Comment in ${subreddit}`,
      description: typeof data.body === 'string' ? data.body : undefined,
      capturedAt: toIsoFromUnix(data.created_utc),
      rawMetadata: {
        subreddit: data.subreddit,
        subredditNamePrefixed: data.subreddit_name_prefixed,
        author: data.author,
        score: data.score,
        linkTitle: data.link_title,
        permalink: toAbsoluteRedditUrl(data.permalink),
        kind: child.kind,
      },
    };
  }

  return null;
}

export async function importRedditSaved(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  username?: string;
  limit?: number;
  after?: string;
  startIndex?: number;
}): Promise<TriageImportSummary> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const accessToken = await getRedditAccessToken({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: input.refreshToken,
  });
  const username = input.username || await resolveRedditUsername(accessToken);
  const url = new URL(`https://oauth.reddit.com/user/${username}/saved`);
  url.searchParams.set('limit', String(limit));
  if (input.after) url.searchParams.set('after', input.after);

  const response = await fetchWithRateLimit(url, {
    headers: {
      Authorization: `${'Bearer'} ${accessToken}`,
      'User-Agent': IMPORT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw remoteResponseError('Reddit saved import', response);
  }

  const payload = await response.json() as {
    data?: {
      after?: string | null;
      children?: RedditListingChild[];
    };
  };

  const children = Array.isArray(payload.data?.children) ? payload.data.children : [];
  const summary: TriageImportSummary = {
    imported: 0,
    skipped: 0,
    errors: [],
    nextCursor: payload.data?.after ?? null,
  };

  const imports: TriageImportInput[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const mapped = mapRedditChildToImport(child);
    if (!mapped) {
      summary.skipped += 1;
      summary.errors.push(`Skipped unsupported Reddit saved item kind: ${child.kind}`);
      continue;
    }

    // sourceOrder: lower = more recently saved (API returns newest first)
    const sourceOrder = (input.startIndex ?? 0) + i;
    imports.push({ ...mapped, sourceOrder });
  }

  const outcomes = await ingestTriageImports(imports);
  for (const outcome of outcomes) {
    summary[outcome.status === 'imported' ? 'imported' : 'skipped'] += 1;
  }

  return summary;
}

export async function importAllRedditSaved(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  username?: string;
  incremental?: boolean;
}): Promise<FullSyncResult> {
  const startTime = Date.now();
  const state = await getSyncState('reddit-saved');
  const result = createFullSyncResult();

  let after: string | undefined;
  let pageCount = 0;
  let itemIndex = 0;

  const CONSECUTIVE_SKIP_THRESHOLD = 50;
  let consecutiveSkips = 0;

  while (pageCount < MAX_PAGES) {
    let summary: TriageImportSummary;
    try {
      summary = await importRedditSaved({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: input.refreshToken,
        username: input.username,
        limit: 100,
        after,
        startIndex: itemIndex,
      });
    } catch (error) {
      result.errors.push(safeRemoteError('Reddit saved import', error));
      break;
    }

    itemIndex += summary.imported + summary.skipped;

    pageCount += 1;
    result.pagesProcessed += 1;
    result.imported += summary.imported;
    result.skipped += summary.skipped;
    result.errors.push(...summary.errors);

    if (input.incremental && summary.imported === 0) {
      consecutiveSkips += summary.skipped;
      if (consecutiveSkips >= CONSECUTIVE_SKIP_THRESHOLD) break;
    } else {
      consecutiveSkips = 0;
    }

    if (!summary.nextCursor) break;
    after = summary.nextCursor;
    result.lastCursor = summary.nextCursor;
  }

  completeFullSyncResult(result, startTime);
  const persisted = await recordSyncRun('reddit-saved', state?.revision ?? 0, {
    lastCursor: result.lastCursor,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    durationMs: result.durationMs,
  });
  if (persisted.status === 'stale') result.outcome = 'stale';

  return result;
}
