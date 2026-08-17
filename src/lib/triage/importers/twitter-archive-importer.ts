/**
 * X/Twitter archive importer for triage queue.
 *
 * Unlike the other importers, X/Twitter no longer offers a usable public API
 * for reading a user's own likes/tweets, so this importer works off of the
 * personal data archive users can request from Settings → Your account →
 * Download an archive of your data. The archive is a ZIP file containing a
 * `data/` folder of `.js` files, each holding a JSON array wrapped in a
 * `window.YTD.<name>.partN = [...]` assignment.
 *
 * This module is intentionally decoupled from ZIP handling — callers (e.g.
 * the API route) are responsible for extracting the raw text of the relevant
 * `data/*.js` files and passing them in here.
 */
import { ingestTriageImport } from '../capture';
import { upsertSyncState } from '../sync-state';
import type { TriageImportSummary, FullSyncResult } from './base-importer';

/** Archive files this importer knows how to read. */
export type TwitterArchiveFileKind = 'tweet' | 'like' | 'account';

const ARCHIVE_FILE_PATTERNS: Array<{ kind: TwitterArchiveFileKind; pattern: RegExp }> = [
  { kind: 'account', pattern: /(^|\/)data\/account(-part\d+)?\.js$/i },
  { kind: 'like', pattern: /(^|\/)data\/like(-part\d+)?\.js$/i },
  { kind: 'tweet', pattern: /(^|\/)data\/tweet(s)?(-part\d+)?\.js$/i },
];

/** Identifies which known archive file a given zip entry path corresponds to, if any. */
export function identifyArchiveFile(entryPath: string): TwitterArchiveFileKind | null {
  const normalized = entryPath.replace(/\\/g, '/');
  for (const { kind, pattern } of ARCHIVE_FILE_PATTERNS) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
}

/**
 * Strips the `window.YTD.<name>.partN = ` (or similar) assignment prefix from
 * a raw archive `.js` file's contents and parses the remaining JSON array.
 */
export function parseArchiveJsFile(contents: string): unknown[] {
  const trimmed = contents.trim();
  const equalsIndex = trimmed.indexOf('=');
  const jsonText = equalsIndex >= 0 && /^window\.YTD\./.test(trimmed)
    ? trimmed.slice(equalsIndex + 1).trim().replace(/;\s*$/, '')
    : trimmed;

  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface RawTweetEntry {
  tweet?: RawTweet;
}

interface RawTweetMedia {
  media_url_https?: string;
  type?: string;
}

interface RawTweetEntities {
  urls?: Array<{ expanded_url?: string }>;
  media?: RawTweetMedia[];
  hashtags?: Array<{ text?: string }>;
}

interface RawTweet {
  id_str?: string;
  id?: string;
  full_text?: string;
  created_at?: string;
  in_reply_to_status_id_str?: string;
  retweeted?: boolean;
  favorite_count?: string | number;
  retweet_count?: string | number;
  entities?: RawTweetEntities;
  extended_entities?: RawTweetEntities;
}

interface RawLikeEntry {
  like?: {
    tweetId?: string;
    fullText?: string;
    expandedUrl?: string;
  };
}

interface RawAccountEntry {
  account?: {
    username?: string;
    accountId?: string;
  };
}

/** Parses a Twitter archive's `created_at` timestamp (RFC 2822-ish or ISO) into an ISO string. */
export function parseArchiveDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Extracts the account username from a parsed `data/account.js` array, if present. */
export function extractArchiveUsername(entries: unknown[]): string | undefined {
  for (const entry of entries) {
    const username = (entry as RawAccountEntry)?.account?.username;
    if (username) return username;
  }
  return undefined;
}

function extractMediaThumbnail(tweet: RawTweet): string | undefined {
  const media = tweet.extended_entities?.media || tweet.entities?.media;
  return media?.[0]?.media_url_https;
}

function tweetImportInput(tweet: RawTweet, username: string | undefined) {
  const id = tweet.id_str || tweet.id;
  if (!id) return null;

  const fullText = tweet.full_text?.trim();
  if (!fullText) return null;

  const author = username || 'i';
  const sourceUrl = `https://twitter.com/${author}/status/${id}`;

  return {
    sourcePlatform: 'twitter' as const,
    sourceId: `twitter:tweet:${id}`,
    sourceUrl,
    canonicalUrl: sourceUrl,
    title: fullText.length > 140 ? `${fullText.slice(0, 137)}...` : fullText,
    description: fullText,
    capturedAt: parseArchiveDate(tweet.created_at),
    rawMetadata: {
      kind: 'tweet' as const,
      isReply: !!tweet.in_reply_to_status_id_str,
      isRetweet: !!tweet.retweeted,
      favoriteCount: Number(tweet.favorite_count) || 0,
      retweetCount: Number(tweet.retweet_count) || 0,
      thumbnailUrl: extractMediaThumbnail(tweet),
      urls: tweet.entities?.urls?.map((u) => u.expanded_url).filter(Boolean) || [],
      hashtags: tweet.entities?.hashtags?.map((h) => h.text).filter(Boolean) || [],
    },
  };
}

function likeImportInput(like: NonNullable<RawLikeEntry['like']>) {
  const id = like.tweetId;
  if (!id) return null;

  const sourceUrl = like.expandedUrl || `https://twitter.com/i/web/status/${id}`;
  const title = like.fullText?.trim() || `Liked tweet ${id}`;

  return {
    sourcePlatform: 'twitter' as const,
    sourceId: `twitter:like:${id}`,
    sourceUrl,
    canonicalUrl: sourceUrl,
    title: title.length > 140 ? `${title.slice(0, 137)}...` : title,
    description: like.fullText,
    rawMetadata: {
      kind: 'like' as const,
      tweetId: id,
    },
  };
}

export interface TwitterArchiveFile {
  /** Path of the entry within the archive zip, e.g. `data/like.js`. */
  path: string;
  /** Raw text contents of the file. */
  contents: string;
}

/**
 * Parses the relevant files out of an extracted X/Twitter archive and ingests
 * the user's own tweets and likes into the triage queue.
 */
export async function importTwitterArchive(input: {
  files: TwitterArchiveFile[];
  signal?: AbortSignal;
}): Promise<TriageImportSummary> {
  const summary: TriageImportSummary = { imported: 0, skipped: 0, errors: [] };

  const filesByKind = new Map<TwitterArchiveFileKind, unknown[]>();
  for (const file of input.files) {
    input.signal?.throwIfAborted();
    const kind = identifyArchiveFile(file.path);
    if (!kind) continue;

    const entries = parseArchiveJsFile(file.contents);
    if (!entries.length && file.contents.trim()) {
      summary.errors.push(`Failed to parse archive file: ${file.path}`);
      continue;
    }

    filesByKind.set(kind, [...(filesByKind.get(kind) || []), ...entries]);
  }

  if (!filesByKind.has('tweet') && !filesByKind.has('like')) {
    summary.errors.push('No tweet.js or like.js entries found in archive');
    return summary;
  }

  const username = extractArchiveUsername(filesByKind.get('account') || []);

  const tweetEntries = (filesByKind.get('tweet') || []) as RawTweetEntry[];
  for (const entry of tweetEntries) {
    input.signal?.throwIfAborted();
    const mapped = entry.tweet && tweetImportInput(entry.tweet, username);
    if (!mapped) {
      summary.skipped += 1;
      continue;
    }
    const result = await ingestTriageImport(mapped);
    if (result.status === 'imported') summary.imported += 1;
    else summary.skipped += 1;
  }

  const likeEntries = (filesByKind.get('like') || []) as RawLikeEntry[];
  for (const entry of likeEntries) {
    input.signal?.throwIfAborted();
    const mapped = entry.like && likeImportInput(entry.like);
    if (!mapped) {
      summary.skipped += 1;
      continue;
    }
    const result = await ingestTriageImport(mapped);
    if (result.status === 'imported') summary.imported += 1;
    else summary.skipped += 1;
  }

  return summary;
}

/**
 * Runs `importTwitterArchive` and records the result in triage sync state
 * under the `twitter-archive` key, matching the other importers' behavior.
 */
export async function importAllTwitterArchive(input: {
  files: TwitterArchiveFile[];
  signal?: AbortSignal;
}): Promise<FullSyncResult> {
  const startTime = Date.now();
  const summary = await importTwitterArchive(input);

  const result: FullSyncResult = {
    imported: summary.imported,
    skipped: summary.skipped,
    errors: summary.errors,
    pagesProcessed: 1,
    durationMs: Date.now() - startTime,
    lastCursor: null,
  };

  await upsertSyncState('twitter-archive', {
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.slice(0, 20),
    durationMs: result.durationMs,
  });

  return result;
}
