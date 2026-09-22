/**
 * Triage capture module — ingest paths for the triage queue: single-URL
 * capture, image capture, text/share capture, and bulk/importer ingestion.
 * Also owns embed resolution, which runs as part of enriching newly
 * captured items.
 */
import { randomUUID } from 'crypto';
import type { TriageContentType, TriageItem, TriageSourcePlatform } from '@/types';
import { resolveEmbed } from './embed-resolver';
import type { EmbedMetadata } from './embed-resolver';
import logger from '@/lib/logger';
import { parseDateFromText } from '@/lib/parse-task-input';
import { evaluateRules } from './suggestion-engine';
import { parseDescriptionLinks } from './importers/youtube-importer';
import { detectContentType as detectContentTypeFromRegistry } from './content-type-registry';
import { ensureSeedData, safeJsonObject } from './shared';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';
import { getTriagePersistenceRepositories } from './persistence';
export {
  ingestTriageImport,
  ingestTriageImports,
  type TriageImportInput,
  type TriageImportResult,
} from './import-capture';

export interface TriageCaptureInput {
  url: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  sourcePlatform?: TriageSourcePlatform;
  sharedText?: string;
  sourceId?: string;
  capturedAt?: string;
  /** Platform-specific metadata extracted by the browser extension (e.g. subreddit, channel name) */
  platformMeta?: Record<string, unknown>;
}

export interface TriageTextCaptureInput {
  requestId: string;
  text: string;
  title?: string;
  capturedAt?: string;
}

export interface TriageImageCaptureInput {
  storageId: string;
  imageUrl: string;
  mime: string;
  size: number;
  title?: string;
  description?: string;
  client?: string;
  originalName?: string;
  requestId?: string;
}

/**
 * Resolve embed metadata for a triage item asynchronously (fire-and-forget).
 * Updates the item's rawMetadata.embed and thumbnailUrl without blocking ingest.
 */
function resolveEmbedAsync(itemId: string, url: string) {
  resolveEmbed(url)
    .then(async (result) => {
      if (!result.success || !result.embed) return;

      await getTriagePersistenceRepositories().items.mergeMetadata(
        itemId,
        { embed: result.embed },
        { fillThumbnailUrl: result.embed.thumbnail_url },
      );
    })
    .catch((err) => {
      logger.error({ err, itemId }, 'Failed to resolve triage embed');
    });
}

/**
 * Resolve embed metadata synchronously (for backfill). Returns the embed data.
 */
export async function resolveAndStoreEmbed(
  itemId: string,
  url: string,
  options?: { fillOnly?: boolean },
): Promise<EmbedMetadata | null> {
  const fillOnly = options?.fillOnly ?? false;

  const result = await resolveEmbed(url);
  if (!result.success || !result.embed) return null;

  const existing = await getTriagePersistenceRepositories().items.get(itemId);
  if (!existing) return null;

  // Fill-only: skip if embed data already exists (don't overwrite good data)
  if (fillOnly && existing.rawMetadata.embed) return result.embed;

  await getTriagePersistenceRepositories().items.mergeMetadata(
    itemId,
    { embed: result.embed },
    {
      fillThumbnailUrl: result.embed.thumbnail_url,
      ...(fillOnly ? { skipWhenKeyPresent: 'embed' } : {}),
    },
  );
  return result.embed;
}

export function detectSourcePlatform(url: string): TriageSourcePlatform {
  if (url.includes('reddit.com')) return 'reddit';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('github.com')) return 'github';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  return 'web';
}

/** Extracts the YouTube video ID from a `watch?v=` or `youtu.be/` URL, if present. */
function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('youtu.be')) {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }
    if (parsed.hostname.includes('youtube.com')) {
      const id = parsed.searchParams.get('v');
      if (id) return id;
      // /shorts/{id} and /embed/{id} forms
      const match = parsed.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/);
      if (match) return match[1];
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Fire-and-forget enrichment for single-page YouTube captures made via the
 * browser extension. Uses YouTube's public oEmbed endpoint (no OAuth/API key
 * required) to backfill the channel name when the extension didn't supply
 * one. Never throws — logs and gives up on failure.
 */
function enrichYouTubeCaptureAsync(itemId: string, url: string) {
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  fetch(oEmbedUrl)
    .then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { author_name?: string; author_url?: string; title?: string };
      if (!data.author_name) return;

      const existing = await getTriagePersistenceRepositories().items.get(itemId);
      if (!existing) return;

      if (existing.rawMetadata.channelName) return;
      await getTriagePersistenceRepositories().items.mergeMetadata(
        itemId,
        { channelName: data.author_name, channelUrl: data.author_url },
        { skipWhenKeyPresent: 'channelName' },
      );
    })
    .catch((err) => {
      logger.error({ err, url }, 'YouTube oEmbed enrichment failed — continuing without channel metadata');
    });
}

function buildSuggestedActions(input: {
  sourcePlatform: TriageSourcePlatform;
  contentType: TriageContentType;
  title: string;
  description?: string;
  url: string;
  rawMetadata?: Record<string, unknown>;
}): { summary: string; categories: string[]; score: number; urgency: TriageItem['aiUrgency']; actions: TriageItem['aiSuggestedActions'] } {
  return evaluateRules(input);
}

export async function createTriageCapture(input: TriageCaptureInput) {
  await ensureSeedData();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    throw new Error('Invalid URL provided for capture');
  }

  const title = input.title?.trim() || parsedUrl.hostname.replace('www.', '');
  const sourcePlatform = input.sourcePlatform || detectSourcePlatform(input.url);
  const contentType = await detectContentTypeFromRegistry(input.url, title, input.description || input.sharedText) as TriageContentType;
  const normalizedPlatformMeta = input.platformMeta && typeof input.platformMeta === 'object'
    ? safeJsonObject(input.platformMeta)
    : {};
  const captureRawMetadata = {
    ...normalizedPlatformMeta,
    sharedText: input.sharedText,
    captureSource: input.sourcePlatform || 'web',
  };
  const ai = buildSuggestedActions({
    sourcePlatform,
    contentType,
    title,
    description: input.description || input.sharedText,
    url: input.url,
    rawMetadata: captureRawMetadata,
  });
  const now = new Date().toISOString();
  const id = randomUUID();

  // Parse NLP dates from the captured text
  const captureText = [title, input.description, input.sharedText].filter(Boolean).join(' ');
  const parsedDate = parseDateFromText(captureText);

  // For YouTube captures (single-page or bulk), derive the canonical
  // youtube:video:{id} sourceId and extract description links, matching the
  // shape produced by the YouTube Data API importer.
  const youtubeVideoId = sourcePlatform === 'youtube' ? extractYouTubeVideoId(input.url) : null;
  const extractedLinks = sourcePlatform === 'youtube'
    ? parseDescriptionLinks(input.description || input.sharedText)
    : undefined;

  const created = await getTriagePersistenceRepositories().items.create({
    id,
    sourcePlatform,
    sourceId: input.sourceId || (youtubeVideoId ? `youtube:video:${youtubeVideoId}` : `${sourcePlatform}:${id}`),
    sourceUrl: input.url,
    canonicalUrl: input.url,
    title,
    description: input.description || input.sharedText,
    thumbnailUrl: input.thumbnailUrl,
    contentType,
    capturedAt: input.capturedAt || now,
    ingestedAt: now,
    status: 'pending',
    aiSummary: ai.summary,
    aiCategories: ai.categories,
    aiSuggestedActions: ai.actions,
    aiRelevanceScore: ai.score,
    aiUrgency: ai.urgency,
    rawMetadata: {
      ...captureRawMetadata,
      ...(parsedDate && {
        parsedDueDate: parsedDate.dueDate,
        parsedDueDateLabel: parsedDate.dueDateLabel,
      }),
      ...(extractedLinks?.length && { extractedLinks }),
      ...(Object.keys(normalizedPlatformMeta).length > 0 && { platformMeta: normalizedPlatformMeta }),
    },
    actionsTaken: [],
  });
  await publishSemanticEntityUpsert('triage-item', id);

  // Fire-and-forget embed resolution (design: don't block capture)
  resolveEmbedAsync(id, input.url);

  // Fire-and-forget YouTube channel-name enrichment via oEmbed (no API creds needed)
  if (youtubeVideoId) {
    enrichYouTubeCaptureAsync(id, input.url);
  }

  return created;
}

export async function createTriageImageCapture(input: TriageImageCaptureInput) {
  await ensureSeedData();

  const now = new Date().toISOString();
  const id = randomUUID();
  const title = input.title?.trim() || 'Image capture';
  const sourcePlatform: TriageSourcePlatform = input.client === 'ios'
    ? 'ios_share'
    : input.client === 'android'
      ? 'android_share'
      : 'web';
  const rawMetadata = {
    captureSource: input.client || 'web',
    ...(input.requestId ? { requestId: input.requestId } : {}),
    image: {
      storageId: input.storageId,
      mime: input.mime,
      size: input.size,
      ...(input.originalName ? { originalName: input.originalName } : {}),
    },
  };
  const ai = buildSuggestedActions({
    sourcePlatform,
    contentType: 'image',
    title,
    description: input.description,
    url: input.imageUrl,
    rawMetadata,
  });

  const created = await getTriagePersistenceRepositories().items.create({
    id,
    sourcePlatform,
    sourceId: input.requestId ? `image-request:${input.requestId}` : `image:${input.storageId}`,
    sourceUrl: input.imageUrl,
    canonicalUrl: input.imageUrl,
    title,
    description: input.description?.trim() || undefined,
    thumbnailUrl: input.imageUrl,
    contentType: 'image',
    capturedAt: now,
    ingestedAt: now,
    status: 'pending',
    aiSummary: ai.summary,
    aiCategories: ai.categories,
    aiSuggestedActions: ai.actions,
    aiRelevanceScore: ai.score,
    aiUrgency: ai.urgency,
    rawMetadata,
    actionsTaken: [],
  });
  await publishSemanticEntityUpsert('triage-item', id);
  return created;
}

export async function findTriageImageCaptureByRequestId(requestId: string) {
  return getTriagePersistenceRepositories().items.findBySourceId(
    `image-request:${requestId}`,
  );
}

export async function findTriageImageCaptureByImageUrl(imageUrl: string) {
  return getTriagePersistenceRepositories().items.findBySourceUrl(imageUrl);
}

export async function createTriageTextCapture(input: TriageTextCaptureInput) {
  await ensureSeedData();

  const text = input.text.trim();
  if (!text) {
    throw new Error('Text is required for capture');
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const title = input.title?.trim()
    || text.split(/\r?\n/, 1)[0].slice(0, 500);
  const sourceUrl = `mc://share/${input.requestId}`;
  const parsedDate = parseDateFromText([title, text].join(' '));
  const rawMetadata = {
    captureSource: 'ios_share',
    ...(parsedDate && {
      parsedDueDate: parsedDate.dueDate,
      parsedDueDateLabel: parsedDate.dueDateLabel,
    }),
  };
  const ai = buildSuggestedActions({
    sourcePlatform: 'ios_share',
    contentType: 'text_post',
    title,
    description: text,
    url: sourceUrl,
    rawMetadata,
  });

  const created = await getTriagePersistenceRepositories().items.create({
    id,
    sourcePlatform: 'ios_share',
    sourceId: `ios_share:${input.requestId}`,
    sourceUrl,
    canonicalUrl: sourceUrl,
    title,
    description: text,
    contentType: 'text_post',
    capturedAt: input.capturedAt || now,
    ingestedAt: now,
    status: 'pending',
    aiSummary: ai.summary,
    aiCategories: ai.categories,
    aiSuggestedActions: ai.actions,
    aiRelevanceScore: ai.score,
    aiUrgency: ai.urgency,
    rawMetadata,
    actionsTaken: [],
  });
  await publishSemanticEntityUpsert('triage-item', id);
  return created;
}
