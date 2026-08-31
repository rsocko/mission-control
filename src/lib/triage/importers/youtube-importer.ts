/**
 * YouTube Data API v3 importer for triage queue (#351).
 *
 * Imports videos from YouTube playlists (Watch Later, Liked Videos, custom
 * playlists) into the triage queue, extracting embedded links from video
 * descriptions along the way.
 */
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

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PLAYLIST_ITEMS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';

/** Well-known "special" playlist IDs YouTube exposes per-user. */
export const YOUTUBE_WATCH_LATER_PLAYLIST_ID = 'WL';
export const YOUTUBE_LIKED_VIDEOS_PLAYLIST_ID = 'LL';

export type ExtractedLinkCategory = '3d_model' | 'github_repo' | 'product' | 'link';

export interface ExtractedLink {
  url: string;
  label?: string;
  category: ExtractedLinkCategory;
  position: number;
}

/**
 * Extracts URLs embedded in a YouTube video description and classifies them
 * by domain heuristics (3D model sites, GitHub repos, shopping links, etc).
 */
export function parseDescriptionLinks(description?: string | null): ExtractedLink[] {
  if (!description || typeof description !== 'string') return [];

  const urlPattern = /https?:\/\/[^\s<>()[\]"']+/g;
  const matches = description.match(urlPattern);
  if (!matches) return [];

  return matches.map((raw, index) => {
    // Trim common trailing punctuation that gets swept up by the regex.
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    return {
      url,
      category: classifyLinkDomain(url),
      position: index,
    };
  });
}

function classifyLinkDomain(url: string): ExtractedLinkCategory {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'link';
  }

  if (/(thingiverse\.com|printables\.com|makerworld\.com)$/.test(hostname) || hostname.endsWith('.thingiverse.com')) {
    return '3d_model';
  }
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    return 'github_repo';
  }
  if (/(amazon\.[a-z.]+|aliexpress\.[a-z.]+)$/.test(hostname)) {
    return 'product';
  }
  return 'link';
}

/**
 * Exchanges a Google OAuth refresh token for a short-lived access token.
 */
export async function getYouTubeAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': IMPORT_USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResponse.ok) {
    throw remoteResponseError('YouTube token exchange', tokenResponse);
  }

  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    throw new Error('YouTube token exchange did not return access_token');
  }
  return token.access_token;
}

interface YouTubeThumbnail {
  url?: string;
}

interface YouTubePlaylistItem {
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    videoOwnerChannelTitle?: string;
    videoOwnerChannelId?: string;
    thumbnails?: {
      default?: YouTubeThumbnail;
      medium?: YouTubeThumbnail;
      high?: YouTubeThumbnail;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
}

interface YouTubePlaylistItemsResponse {
  nextPageToken?: string;
  items?: YouTubePlaylistItem[];
}

function mapPlaylistItemToImport(item: YouTubePlaylistItem, playlistId: string) {
  const videoId = item.contentDetails?.videoId;
  if (!videoId) return null;

  const snippet = item.snippet;
  const title = snippet?.title?.trim();
  if (!title || title === 'Deleted video' || title === 'Private video') return null;

  const description = typeof snippet?.description === 'string' ? snippet.description : undefined;
  const thumbnailUrl = snippet?.thumbnails?.high?.url || snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url;

  return {
    sourcePlatform: 'youtube' as const,
    sourceId: `youtube:video:${videoId}`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    description: description?.slice(0, 500),
    capturedAt: snippet?.publishedAt || item.contentDetails?.videoPublishedAt,
    rawMetadata: {
      channelName: snippet?.videoOwnerChannelTitle,
      channelId: snippet?.videoOwnerChannelId,
      playlistSource: playlistId,
      thumbnailUrl,
      videoPublishedAt: item.contentDetails?.videoPublishedAt,
      savedToPlaylistAt: snippet?.publishedAt,
      extractedLinks: parseDescriptionLinks(description),
    },
  };
}

/**
 * Fetches a single page of playlist items and ingests each into the triage queue.
 */
export async function importYouTubePlaylist(input: {
  accessToken: string;
  playlistId: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<TriageImportSummary> {
  const maxResults = Math.min(Math.max(input.maxResults ?? 50, 1), 50);
  const url = new URL(PLAYLIST_ITEMS_ENDPOINT);
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('playlistId', input.playlistId);
  url.searchParams.set('maxResults', String(maxResults));
  if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);

  const response = await fetchWithRateLimit(url, {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'User-Agent': IMPORT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw remoteResponseError('YouTube playlist import', response, input.playlistId);
  }

  const payload = await response.json() as YouTubePlaylistItemsResponse;
  const items = Array.isArray(payload.items) ? payload.items : [];

  const summary: TriageImportSummary = {
    imported: 0,
    skipped: 0,
    errors: [],
    nextCursor: payload.nextPageToken ?? null,
  };

  const imports: TriageImportInput[] = [];
  for (const item of items) {
    const mapped = mapPlaylistItemToImport(item, input.playlistId);
    if (!mapped) {
      summary.skipped += 1;
      summary.errors.push('Skipped unavailable/deleted YouTube playlist item');
      continue;
    }

    imports.push(mapped);
  }

  const outcomes = await ingestTriageImports(imports);
  for (const outcome of outcomes) {
    summary[outcome.status === 'imported' ? 'imported' : 'skipped'] += 1;
  }

  return summary;
}

/**
 * Paginates through an entire playlist, ingesting all videos, and records sync state
 * under the key `youtube-{playlistId}`.
 */
export async function importAllYouTubePlaylist(input: {
  accessToken: string;
  playlistId: string;
  incremental?: boolean;
}): Promise<FullSyncResult> {
  const startTime = Date.now();
  const sourceId = `youtube-${input.playlistId}`;
  const state = await getSyncState(sourceId);
  const result = createFullSyncResult();

  let pageToken: string | undefined;
  let pageCount = 0;

  const CONSECUTIVE_SKIP_THRESHOLD = 50;
  let consecutiveSkips = 0;

  while (pageCount < MAX_PAGES) {
    let summary: TriageImportSummary;
    try {
      summary = await importYouTubePlaylist({
        accessToken: input.accessToken,
        playlistId: input.playlistId,
        maxResults: 50,
        pageToken,
      });
    } catch (error) {
      result.errors.push(safeRemoteError('YouTube playlist import', error));
      break;
    }

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
    pageToken = summary.nextCursor;
    result.lastCursor = summary.nextCursor;
  }

  completeFullSyncResult(result, startTime);
  const persisted = await recordSyncRun(sourceId, state?.revision ?? 0, {
    lastCursor: result.lastCursor,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    durationMs: result.durationMs,
  });
  if (persisted.status === 'stale') result.outcome = 'stale';

  return result;
}

/**
 * Imports all configured YouTube playlists (Watch Later, Liked Videos, and any
 * user-configured playlist IDs) in a single call, exchanging the OAuth refresh
 * token once and reusing the access token across playlists.
 */
export async function importAllYouTubePlaylists(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  playlistIds: string[];
  incremental?: boolean;
}): Promise<FullSyncResult> {
  const startTime = Date.now();
  const aggregateState = await getSyncState('youtube');
  const aggregate = createFullSyncResult();
  const playlistIds = input.playlistIds.length ? input.playlistIds : [YOUTUBE_WATCH_LATER_PLAYLIST_ID, YOUTUBE_LIKED_VIDEOS_PLAYLIST_ID];
  let accessToken: string;
  try {
    accessToken = await getYouTubeAccessToken({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken,
    });
  } catch (error) {
    aggregate.errors.push(safeRemoteError('YouTube token exchange', error));
    completeFullSyncResult(aggregate, startTime);
    const persisted = await recordSyncRun('youtube', aggregateState?.revision ?? 0, {
      lastCursor: null,
      imported: 0,
      skipped: 0,
      errors: aggregate.errors,
      durationMs: aggregate.durationMs,
    });
    if (persisted.status === 'stale') aggregate.outcome = 'stale';
    return aggregate;
  }

  for (const playlistId of playlistIds) {
    const result = await importAllYouTubePlaylist({
      accessToken,
      playlistId,
      incremental: input.incremental,
    });
    aggregate.imported += result.imported;
    aggregate.skipped += result.skipped;
    aggregate.pagesProcessed += result.pagesProcessed;
    aggregate.errors.push(...result.errors.map((error) => `Playlist ${playlistId}: ${error}`));
  }

  completeFullSyncResult(aggregate, startTime);
  const persisted = await recordSyncRun('youtube', aggregateState?.revision ?? 0, {
    lastCursor: null,
    imported: aggregate.imported,
    skipped: aggregate.skipped,
    errors: aggregate.errors.slice(0, 20),
    durationMs: aggregate.durationMs,
  });
  if (persisted.status === 'stale') aggregate.outcome = 'stale';
  return aggregate;
}
