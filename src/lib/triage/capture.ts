/**
 * Triage capture module — ingest paths for the triage queue: single-URL
 * capture, image capture, text/share capture, and bulk/importer ingestion.
 * Also owns embed resolution, which runs as part of enriching newly
 * captured items.
 */
import { randomUUID } from 'crypto';
import db, { runTransaction } from '@/db';
import { triageItems } from '@/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { TriageContentType, TriageItem, TriageSourcePlatform } from '@/types';
import { resolveEmbed } from './embed-resolver';
import type { EmbedMetadata } from './embed-resolver';
import logger from '@/lib/logger';
import { parseDateFromText } from '@/lib/parse-task-input';
import { evaluateRules } from './suggestion-engine';
import { parseDescriptionLinks } from './importers/youtube-importer';
import { detectContentType as detectContentTypeFromRegistry } from './content-type-registry';
import { ensureSeedData, mapRow, safeJsonObject } from './shared';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication';

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

export interface TriageImportInput {
  sourcePlatform: TriageSourcePlatform;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  capturedAt?: string;
  sourceOrder?: number;
  rawMetadata?: Record<string, unknown>;
}

export type TriageImportResult =
  | { status: 'imported'; item: TriageItem }
  | { status: 'skipped'; reason: string; item?: TriageItem };

/**
 * Resolve embed metadata for a triage item asynchronously (fire-and-forget).
 * Updates the item's rawMetadata.embed and thumbnailUrl without blocking ingest.
 */
function resolveEmbedAsync(itemId: string, url: string) {
  resolveEmbed(url)
    .then(async (result) => {
      if (!result.success || !result.embed) return;

      const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, itemId));
      if (!existing) return;

      const currentMeta = safeJsonObject(existing.rawMetadata);
      const updatedMeta = { ...currentMeta, embed: result.embed };

      const updates: Record<string, unknown> = { rawMetadata: updatedMeta };

      // Set thumbnailUrl if not already set and embed has one
      if (!existing.thumbnailUrl && result.embed.thumbnail_url) {
        updates.thumbnailUrl = result.embed.thumbnail_url;
      }

      await db.update(triageItems).set(updates).where(eq(triageItems.id, itemId));
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

  const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, itemId));
  if (!existing) return null;

  const currentMeta = safeJsonObject(existing.rawMetadata);

  // Fill-only: skip if embed data already exists (don't overwrite good data)
  if (fillOnly && currentMeta.embed) return result.embed;

  const updatedMeta = { ...currentMeta, embed: result.embed };

  const updates: Record<string, unknown> = { rawMetadata: updatedMeta };
  // Only fill thumbnailUrl when it's currently empty (COALESCE semantics)
  if (!existing.thumbnailUrl && result.embed.thumbnail_url) {
    updates.thumbnailUrl = result.embed.thumbnail_url;
  }

  await db.update(triageItems).set(updates).where(eq(triageItems.id, itemId));
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

      const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, itemId));
      if (!existing) return;

      const currentMeta = safeJsonObject(existing.rawMetadata);
      if (currentMeta.channelName) return; // don't clobber metadata the extension/importer already supplied

      await db.update(triageItems).set({
        rawMetadata: { ...currentMeta, channelName: data.author_name, channelUrl: data.author_url },
      }).where(eq(triageItems.id, itemId));
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

  await db.insert(triageItems).values({
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

  const [created] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  await publishSemanticEntityUpsert('triage-item', id);

  // Fire-and-forget embed resolution (design: don't block capture)
  resolveEmbedAsync(id, input.url);

  // Fire-and-forget YouTube channel-name enrichment via oEmbed (no API creds needed)
  if (youtubeVideoId) {
    enrichYouTubeCaptureAsync(id, input.url);
  }

  return mapRow(created);
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

  await db.insert(triageItems).values({
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

  const [created] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  await publishSemanticEntityUpsert('triage-item', id);
  return mapRow(created);
}

export async function findTriageImageCaptureByRequestId(requestId: string) {
  const [existing] = await db.select()
    .from(triageItems)
    .where(eq(triageItems.sourceId, `image-request:${requestId}`));
  return existing ? mapRow(existing) : null;
}

export async function findTriageImageCaptureByImageUrl(imageUrl: string) {
  const [existing] = await db.select()
    .from(triageItems)
    .where(eq(triageItems.sourceUrl, imageUrl));
  return existing ? mapRow(existing) : null;
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

  await db.insert(triageItems).values({
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

  const [created] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  await publishSemanticEntityUpsert('triage-item', id);
  return mapRow(created);
}

function triageImportSourceKey(input: { sourcePlatform: string; sourceId: string }) {
  return JSON.stringify([input.sourcePlatform, input.sourceId]);
}

export async function ingestTriageImports(
  inputs: readonly TriageImportInput[],
): Promise<TriageImportResult[]> {
  await ensureSeedData();

  if (inputs.length === 0) return [];

  const results: Array<TriageImportResult | undefined> = new Array(inputs.length);
  const prepared = inputs.flatMap((input, index) => {
    if (!input.sourceId?.trim()) {
      results[index] = { status: 'skipped', reason: 'Missing source ID' };
      return [];
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.sourceUrl);
    } catch {
      results[index] = { status: 'skipped', reason: 'Invalid source URL' };
      return [];
    }

    return [{
      index,
      input,
      parsedUrl,
      canonicalUrl: input.canonicalUrl || input.sourceUrl,
    }];
  });

  if (prepared.length === 0) {
    return results.map((result) => result!);
  }

  const sourceConditions = prepared.map(({ input }) => and(
    eq(triageItems.sourcePlatform, input.sourcePlatform),
    eq(triageItems.sourceId, input.sourceId),
  ));
  const canonicalUrls = [...new Set(prepared.map(({ canonicalUrl }) => canonicalUrl))];
  const [existingSourceRows, existingCanonicalRows] = await Promise.all([
    db.select().from(triageItems).where(or(...sourceConditions)),
    db.select().from(triageItems).where(inArray(triageItems.canonicalUrl, canonicalUrls)),
  ]);
  const existingBySource = new Map(
    existingSourceRows.map((row) => [triageImportSourceKey(row), row]),
  );
  const existingByCanonical = new Map(
    existingCanonicalRows.map((row) => [row.canonicalUrl, row]),
  );

  const seenSources = new Map<string, number>();
  const seenCanonicalUrls = new Map<string, number>();
  const duplicatesWithinBatch = new Map<number, {
    originalIndex: number;
    reason: string;
  }>();
  const candidates = prepared.filter(({ index, input, canonicalUrl }) => {
    const sourceKey = triageImportSourceKey(input);
    const existingSource = existingBySource.get(sourceKey);
    if (existingSource) {
      results[index] = {
        status: 'skipped',
        reason: 'Already ingested for this source item',
        item: mapRow(existingSource),
      };
      return false;
    }

    const existingCanonical = existingByCanonical.get(canonicalUrl);
    if (existingCanonical) {
      results[index] = {
        status: 'skipped',
        reason: 'Already ingested for canonical URL',
        item: mapRow(existingCanonical),
      };
      return false;
    }

    const sourceDuplicate = seenSources.get(sourceKey);
    if (sourceDuplicate !== undefined) {
      duplicatesWithinBatch.set(index, {
        originalIndex: sourceDuplicate,
        reason: 'Already ingested for this source item',
      });
      return false;
    }

    const canonicalDuplicate = seenCanonicalUrls.get(canonicalUrl);
    if (canonicalDuplicate !== undefined) {
      duplicatesWithinBatch.set(index, {
        originalIndex: canonicalDuplicate,
        reason: 'Already ingested for canonical URL',
      });
      return false;
    }

    seenSources.set(sourceKey, index);
    seenCanonicalUrls.set(canonicalUrl, index);
    return true;
  });

  const buildInsert = async (candidate: typeof candidates[number]) => {
    const { input, parsedUrl, canonicalUrl } = candidate;
    const title = input.title?.trim() || parsedUrl.hostname.replace('www.', '');
    const contentType = await detectContentTypeFromRegistry(
      canonicalUrl,
      title,
      input.description,
    ) as TriageContentType;
    const ai = buildSuggestedActions({
      sourcePlatform: input.sourcePlatform,
      contentType,
      title,
      description: input.description,
      url: canonicalUrl,
      rawMetadata: input.rawMetadata,
    });
    const now = new Date().toISOString();

    return {
      candidate,
      row: {
        id: randomUUID(),
        sourcePlatform: input.sourcePlatform,
        sourceId: input.sourceId,
        sourceUrl: input.sourceUrl,
        canonicalUrl,
        title,
        description: input.description,
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
        rawMetadata: input.rawMetadata || {},
        sourceOrder: input.sourceOrder ?? null,
        actionsTaken: [],
      } satisfies typeof triageItems.$inferInsert,
    };
  };

  const inserts: Awaited<ReturnType<typeof buildInsert>>[] = [];
  if (candidates.length > 0) {
    inserts.push(await buildInsert(candidates[0]));
    inserts.push(...await Promise.all(candidates.slice(1).map(buildInsert)));
  }

  if (inserts.length > 0) {
    const { createdRows, conflictRows } = runTransaction((tx) => {
      const inserted = tx
        .insert(triageItems)
        .values(inserts.map(({ row }) => row))
        .onConflictDoNothing()
        .returning()
        .all();
      const insertedIds = new Set(inserted.map((row) => row.id));
      const conflicted = inserts.filter(({ row }) => !insertedIds.has(row.id));
      const conflicts = conflicted.length > 0
        ? tx.select().from(triageItems).where(or(...conflicted.map(({ candidate }) => and(
          eq(triageItems.sourcePlatform, candidate.input.sourcePlatform),
          eq(triageItems.sourceId, candidate.input.sourceId),
        )))).all()
        : [];
      const conflictSourceKeys = new Set(
        conflicts.map((row) => triageImportSourceKey(row)),
      );
      const unresolved = conflicted.find(
        ({ candidate }) => !conflictSourceKeys.has(triageImportSourceKey(candidate.input)),
      );
      if (unresolved) {
        throw new Error(`Triage import conflict could not be resolved for ${unresolved.candidate.input.sourceId}`);
      }
      return { createdRows: inserted, conflictRows: conflicts };
    });
    const createdById = new Map(createdRows.map((row) => [row.id, row]));
    const conflictsBySource = new Map(
      conflictRows.map((row) => [triageImportSourceKey(row), row]),
    );

    for (const { candidate, row } of inserts) {
      const created = createdById.get(row.id);
      if (created) {
        const item = mapRow(created);
        results[candidate.index] = { status: 'imported', item };
        resolveEmbedAsync(created.id, candidate.canonicalUrl);
        continue;
      }

      const conflict = conflictsBySource.get(triageImportSourceKey(candidate.input));
      results[candidate.index] = {
        status: 'skipped',
        reason: 'Already ingested for this source item',
        ...(conflict ? { item: mapRow(conflict) } : {}),
      };
    }
    await Promise.all(
      createdRows.map((row) => publishSemanticEntityUpsert('triage-item', row.id)),
    );
  }

  for (const [index, duplicate] of duplicatesWithinBatch) {
    const original = results[duplicate.originalIndex];
    results[index] = {
      status: 'skipped',
      reason: duplicate.reason,
      ...(original?.item ? { item: original.item } : {}),
    };
  }

  return results.map((result, index) => {
    if (!result) throw new Error(`Missing triage import result at index ${index}`);
    return result;
  });
}

export async function ingestTriageImport(
  input: TriageImportInput,
): Promise<TriageImportResult> {
  const [result] = await ingestTriageImports([input]);
  return result;
}
