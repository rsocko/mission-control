import { randomUUID } from 'crypto';
import db, { runTransaction } from '@/db';
import { triageActionClaims, triageItems } from '@/db/schema';
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { TriageActionRecord, TriageActionType, TriageContentType, TriageItem, TriageSourcePlatform, TriageStatus, TriageSuggestedAction } from '@/types';
import { SAMPLE_TRIAGE_ITEMS } from './seed-data';
import { isDemoMode } from '@/lib/mode';
import { resolveEmbed } from './embed-resolver';
import type { EmbedMetadata } from './embed-resolver';
import logger from '@/lib/logger';
import { parseDateFromText } from '@/lib/parse-task-input';
import { saveToKarakeep } from './actions/karakeep';
import {
  createTodoTaskFromTriageItem,
  findTodoTaskFromTriageItem,
  TodoTaskCreationError,
} from './actions/ms-todo';
import type { CreateTodoTaskOptions } from './actions/ms-todo';
import { saveToModelCatalog } from './actions/model-catalog';
import type { ModelCatalogOptions } from './actions/model-catalog';
import { saveToKnowledgeBase, buildKnowledgeBaseActionRecord } from './actions/knowledge-base';
import type { KnowledgeBaseOptions } from './actions/knowledge-base';
import {
  completeDocumentAction,
  deferDocumentAction,
  reopenDocumentAction,
} from './actions/document-intelligence';
import { evaluateRules } from './suggestion-engine';
import { parseDescriptionLinks } from './importers/youtube-importer';
import { detectContentType as detectContentTypeFromRegistry } from './content-type-registry';
import { cleanupTriageItemStorage } from './capture-image-lifecycle';

export type TriageSortBy = 'relevance' | 'newest' | 'oldest' | 'score';

export interface TriageFilters {
  status?: TriageStatus | 'all';
  source?: TriageSourcePlatform | 'all';
  q?: string;
  categories?: string[];
  sortBy?: TriageSortBy;
  limit?: number;
  offset?: number;
}

const DEFAULT_PAGE_LIMIT = 200;

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


let seedEnsured = false;
let seedPromise: Promise<void> | null = null;

const ALLOWED_STATUSES = new Set<TriageStatus | 'all'>(['all', 'pending', 'snoozed', 'actioned', 'dismissed']);
const ALLOWED_SOURCES = new Set<TriageSourcePlatform | 'all'>(['all', 'reddit', 'youtube', 'instagram', 'facebook', 'github', 'twitter', 'tiktok', 'pinterest', 'document-intelligence', 'scout', 'ios_share', 'android_share', 'browser_extension', 'browser_tabs', 'web']);
const SNOOZE_DURATION_MS = 1000 * 60 * 60 * 24;
const IDEMPOTENT_ACTIONS = new Set<TriageActionType>(['create_task_todo']);
const CLAIM_SETTLE_ATTEMPTS = 40;
const CLAIM_SETTLE_DELAY_MS = 25;
const CLAIM_RECONCILIATION_GRACE_MS = 5 * 60 * 1000;

export class TriageActionInProgressError extends Error {
  constructor(readonly triageItemId: string) {
    super('Task creation for this triage item is still in progress');
    this.name = 'TriageActionInProgressError';
  }
}

export type TriageTaskClaim =
  | { kind: 'claimed'; claimId: string; item: TriageItem }
  | { kind: 'completed'; item: TriageItem; record?: TriageActionRecord }
  | {
      kind: 'pending';
      claimId: string;
      claimedAt: string;
      context?: { listId?: string; listName?: string };
      item: TriageItem;
    };

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

function safeJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mapRow(row: typeof triageItems.$inferSelect): TriageItem {
  return {
    id: row.id,
    sourcePlatform: row.sourcePlatform as TriageSourcePlatform,
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    canonicalUrl: row.canonicalUrl || undefined,
    title: row.title,
    description: row.description || undefined,
    thumbnailUrl: row.thumbnailUrl || undefined,
    contentType: row.contentType as TriageContentType,
    capturedAt: row.capturedAt,
    ingestedAt: row.ingestedAt,
    status: row.status as TriageStatus,
    snoozedUntil: row.snoozedUntil || undefined,
    aiSummary: row.aiSummary || undefined,
    aiCategories: safeJsonArray<string>(row.aiCategories),
    aiSuggestedActions: safeJsonArray<TriageSuggestedAction>(row.aiSuggestedActions),
    aiRelevanceScore: row.aiRelevanceScore,
    aiUrgency: (row.aiUrgency as TriageItem['aiUrgency']) || 'evergreen',
    rawMetadata: safeJsonObject(row.rawMetadata),
    actionsTaken: safeJsonArray<TriageActionRecord>(row.actionsTaken),
    sourceOrder: row.sourceOrder ?? undefined,
  };
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

/** @deprecated Use detectContentTypeFromRegistry (async) instead. Kept as sync fallback. */
function detectContentTypeLegacy(url: string, title: string, description?: string): TriageContentType {
  const combined = `${title} ${description || ''} ${url}`.toLowerCase();
  if (url.includes('github.com/')) return 'repo';
  if (url.includes('instagram.com/')) {
    if (/\/reel(s)?\//.test(url)) return 'video';
    return 'image';
  }
  if (url.includes('i.redd.it/')) return 'image';
  if (/(makerworld|printables|thingiverse|3d print|3d-print|functionalprint)/i.test(combined)) return 'model_3d';
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('/reel/')) return 'video';
  if ((url.includes('twitter.com') || url.includes('x.com')) && /\/status\//.test(url)) return 'text_post';
  if (combined.includes('article') || combined.includes('blog')) return 'article';
  return 'link';
}

function buildSuggestedActions(input: {
  sourcePlatform: TriageSourcePlatform;
  contentType: TriageContentType;
  title: string;
  description?: string;
  url: string;
  rawMetadata?: Record<string, unknown>;
}): { summary: string; categories: string[]; score: number; urgency: TriageItem['aiUrgency']; actions: TriageSuggestedAction[] } {
  return evaluateRules(input);
}

async function ensureSeedData() {
  if (seedEnsured) return;
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    const rows = await db.select({ count: sql<number>`count(*)` }).from(triageItems);
    const count = toNumber(rows[0]?.count);
    if (count > 0) {
      seedEnsured = true;
      return;
    }

    // Only insert sample data in demo mode, matching the rest of the app
    if (!isDemoMode()) {
      seedEnsured = true;
      return;
    }

    await db.insert(triageItems).values(SAMPLE_TRIAGE_ITEMS.map((item) => ({
      id: item.id,
      sourcePlatform: item.sourcePlatform,
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      description: item.description,
      thumbnailUrl: item.thumbnailUrl,
      contentType: item.contentType,
      capturedAt: item.capturedAt,
      ingestedAt: item.ingestedAt,
      status: item.status,
      snoozedUntil: item.snoozedUntil,
      aiSummary: item.aiSummary,
      aiCategories: item.aiCategories,
      aiSuggestedActions: item.aiSuggestedActions,
      aiRelevanceScore: item.aiRelevanceScore,
      aiUrgency: item.aiUrgency,
      rawMetadata: item.rawMetadata,
      actionsTaken: item.actionsTaken,
    })));
    seedEnsured = true;
  })().finally(() => {
    seedPromise = null;
  });

  return seedPromise;
}

export async function listTriageItems(filters: TriageFilters = {}) {
  await ensureSeedData();

  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const offset = filters.offset ?? 0;

  const conditions = [];
  if (filters.status && filters.status !== 'all') conditions.push(eq(triageItems.status, filters.status));
  if (filters.source && filters.source !== 'all') conditions.push(eq(triageItems.sourcePlatform, filters.source));
  if (filters.q) {
    const query = `%${filters.q.trim()}%`;
    conditions.push(or(like(triageItems.title, query), like(triageItems.description, query), like(triageItems.sourceUrl, query)));
  }
  const normalizedCategories = [...new Set(
    (filters.categories || []).map(category => category.trim().toLowerCase()).filter(Boolean),
  )];
  const categoryWhere = normalizedCategories.length
    ? or(...normalizedCategories.map(category => sql`EXISTS (
        SELECT 1
        FROM json_each(${triageItems.aiCategories}) AS triage_category
        WHERE instr(lower(triage_category.value), ${category}) > 0
      )`))
    : undefined;
  if (categoryWhere) conditions.push(categoryWhere);

  const where = conditions.length ? and(...conditions) : undefined;

  // Build orderBy based on sortBy filter.
  // For relevance/score sorts, deprioritize already-handled items:
  // pending (0) → snoozed (1) → actioned (2) → dismissed (3)
  const statusPriority = asc(sql`CASE ${triageItems.status}
    WHEN 'pending' THEN 0
    WHEN 'snoozed' THEN 1
    WHEN 'actioned' THEN 2
    WHEN 'dismissed' THEN 3
    ELSE 4
  END`);

  const sortBy = filters.sortBy || 'relevance';
  const orderBy = sortBy === 'newest'
    ? [desc(triageItems.capturedAt)]
    : sortBy === 'oldest'
      ? [asc(triageItems.capturedAt)]
      : sortBy === 'score'
        ? [statusPriority, desc(triageItems.aiRelevanceScore)]
        : [statusPriority, desc(triageItems.aiRelevanceScore), desc(triageItems.capturedAt), triageItems.sourceOrder];

  const rows = await db.select().from(triageItems).where(where).orderBy(...orderBy).limit(limit).offset(offset);
  const items = rows.map(mapRow);

  // Build cross-filter conditions so each facet's counts reflect the OTHER active filters.
  // Status counts are filtered by source + query (not status), and vice versa.
  const statusFacetConditions = [];
  if (filters.source && filters.source !== 'all') statusFacetConditions.push(eq(triageItems.sourcePlatform, filters.source));
  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    statusFacetConditions.push(or(like(triageItems.title, q), like(triageItems.description, q), like(triageItems.sourceUrl, q)));
  }
  if (categoryWhere) statusFacetConditions.push(categoryWhere);
  const statusFacetWhere = statusFacetConditions.length ? and(...statusFacetConditions) : undefined;

  const sourceFacetConditions = [];
  if (filters.status && filters.status !== 'all') sourceFacetConditions.push(eq(triageItems.status, filters.status));
  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    sourceFacetConditions.push(or(like(triageItems.title, q), like(triageItems.description, q), like(triageItems.sourceUrl, q)));
  }
  if (categoryWhere) sourceFacetConditions.push(categoryWhere);
  const sourceFacetWhere = sourceFacetConditions.length ? and(...sourceFacetConditions) : undefined;

  const [totals] = await db.select({
    total: sql<number>`count(*)`,
    pending: sql<number>`sum(case when ${triageItems.status} = 'pending' then 1 else 0 end)`,
    snoozed: sql<number>`sum(case when ${triageItems.status} = 'snoozed' then 1 else 0 end)`,
    actioned: sql<number>`sum(case when ${triageItems.status} = 'actioned' then 1 else 0 end)`,
    dismissed: sql<number>`sum(case when ${triageItems.status} = 'dismissed' then 1 else 0 end)`,
  }).from(triageItems).where(statusFacetWhere);
  const sourceRows = await db.select({
    sourcePlatform: triageItems.sourcePlatform,
    count: sql<number>`count(*)`,
  }).from(triageItems).where(sourceFacetWhere).groupBy(triageItems.sourcePlatform);

  // Count total matching rows for the current filter to support "load more"
  const [filteredCount] = await db.select({ count: sql<number>`count(*)` }).from(triageItems).where(where);
  const totalFiltered = toNumber(filteredCount?.count);

  return {
    items,
    totalFiltered,
    hasMore: offset + items.length < totalFiltered,
    stats: {
      total: toNumber(totals?.total),
      pending: toNumber(totals?.pending),
      snoozed: toNumber(totals?.snoozed),
      actioned: toNumber(totals?.actioned),
      dismissed: toNumber(totals?.dismissed),
      sourceCounts: Object.fromEntries(sourceRows.map((row) => [row.sourcePlatform, toNumber(row.count)])),
    },
  };
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

export async function getTriageItemById(id: string): Promise<TriageItem | null> {
  await ensureSeedData();
  const [row] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  return row ? mapRow(row) : null;
}

async function readTaskClaim(id: string) {
  const [claim] = await db.select().from(triageActionClaims).where(and(
    eq(triageActionClaims.triageItemId, id),
    eq(triageActionClaims.actionType, 'create_task_todo'),
  ));
  return claim;
}

export async function reserveTriageTaskCreation(id: string): Promise<TriageTaskClaim | null> {
  await ensureSeedData();
  const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  if (!existing) return null;

  const item = mapRow(existing);
  const recorded = item.actionsTaken.find((action) => action.actionType === 'create_task_todo');
  if (recorded) {
    return { kind: 'completed', item, record: recorded };
  }

  const claimId = randomUUID();
  const claimed = await db.insert(triageActionClaims).values({
    id: claimId,
    triageItemId: id,
    actionType: 'create_task_todo',
    state: 'pending',
    claimedAt: new Date().toISOString(),
  }).onConflictDoNothing({
    target: [triageActionClaims.triageItemId, triageActionClaims.actionType],
  }).returning({ id: triageActionClaims.id }).get();

  if (claimed) {
    return { kind: 'claimed', claimId, item };
  }

  for (let attempt = 0; attempt < CLAIM_SETTLE_ATTEMPTS; attempt++) {
    const claim = await readTaskClaim(id);
    if (claim?.state === 'completed') {
      const current = await getTriageItemById(id);
      if (!current) return null;
      return {
        kind: 'completed',
        item: current,
        record: claim.result as TriageActionRecord | undefined,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_DELAY_MS));
  }

  const claim = await readTaskClaim(id);
  return claim
    ? {
        kind: 'pending',
        claimId: claim.id,
        claimedAt: claim.claimedAt,
        context: safeJsonObject(claim.result),
        item,
      }
    : reserveTriageTaskCreation(id);
}

export async function completeTriageTaskCreation(
  id: string,
  claimId: string,
  record: TriageActionRecord,
): Promise<TriageItem> {
  const completedAt = new Date().toISOString();
  runTransaction((tx) => {
    const completed = tx.update(triageActionClaims).set({
      state: 'completed',
      completedAt,
      result: record,
    }).where(and(
      eq(triageActionClaims.id, claimId),
      eq(triageActionClaims.state, 'pending'),
    )).run();
    if (completed.changes === 0) return;
    tx.update(triageItems).set({
      status: 'actioned',
      snoozedUntil: null,
      actionsTaken: sql`json_insert(${triageItems.actionsTaken}, '$[#]', json(${JSON.stringify(record)}))`,
    }).where(eq(triageItems.id, id)).run();
  });

  const updated = await getTriageItemById(id);
  if (!updated) throw new Error('Triage item disappeared while completing task creation');
  return updated;
}

async function heartbeatTriageTaskCreation(claimId: string): Promise<boolean> {
  const heartbeat = await db.update(triageActionClaims).set({
    claimedAt: new Date().toISOString(),
  }).where(and(
    eq(triageActionClaims.id, claimId),
    eq(triageActionClaims.state, 'pending'),
  )).returning({ id: triageActionClaims.id }).get();
  return Boolean(heartbeat);
}

async function recordTriageTaskTarget(
  claimId: string,
  target: { listId: string; listName: string },
): Promise<boolean> {
  const recorded = await db.update(triageActionClaims).set({
    claimedAt: new Date().toISOString(),
    result: target,
  }).where(and(
    eq(triageActionClaims.id, claimId),
    eq(triageActionClaims.state, 'pending'),
  )).returning({ id: triageActionClaims.id }).get();
  return Boolean(recorded);
}

export async function releaseTriageTaskCreation(
  claimId: string,
  expectedClaimedAt?: string,
): Promise<boolean> {
  const released = await db.delete(triageActionClaims).where(and(
    eq(triageActionClaims.id, claimId),
    eq(triageActionClaims.state, 'pending'),
    ...(expectedClaimedAt ? [eq(triageActionClaims.claimedAt, expectedClaimedAt)] : []),
  )).returning({ id: triageActionClaims.id }).get();
  return Boolean(released);
}

export async function applyTriageAction(
  id: string,
  actionType: TriageActionType,
  note?: string,
  overrides?: { tags?: string[]; list?: string },
  todoOptions?: CreateTodoTaskOptions,
  modelCatalogOptions?: ModelCatalogOptions,
  knowledgeBaseOptions?: KnowledgeBaseOptions,
  options?: { skipExternalAction?: boolean },
  concurrencyAttempt = 0,
) {
  await ensureSeedData();

  const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  if (!existing) return null;

  const item = mapRow(existing);
  if (item.actionsTaken.at(-1)?.metadata?.undoInProgress === true) {
    throw new TriageActionInProgressError(id);
  }

  const skip = options?.skipExternalAction === true;
  let actionClaimId: string | null = null;

  if (IDEMPOTENT_ACTIONS.has(actionType)) {
    const reservation = await reserveTriageTaskCreation(id);
    if (!reservation) return null;
    if (reservation.kind === 'completed') return reservation.item;
    if (reservation.kind === 'pending') {
      if (!skip) {
        const reconciled = await findTodoTaskFromTriageItem(item, {
          ...todoOptions,
          listId: reservation.context?.listId || todoOptions?.listId,
          listName: reservation.context?.listName || todoOptions?.listName,
        });
        if (reconciled) {
          return completeTriageTaskCreation(id, reservation.claimId, {
            actionType,
            appliedAt: new Date().toISOString(),
            note: `Recovered task in "${reconciled.listName}" list`,
            metadata: {
              todoTaskId: reconciled.taskId,
              todoTaskTitle: reconciled.taskTitle,
              todoListId: reconciled.listId,
              todoListName: reconciled.listName,
              todoWebUrl: reconciled.webUrl,
            },
          });
        }
        if (Date.now() - new Date(reservation.claimedAt).getTime() >= CLAIM_RECONCILIATION_GRACE_MS) {
          const released = await releaseTriageTaskCreation(
            reservation.claimId,
            reservation.claimedAt,
          );
          if (released) {
            return applyTriageAction(
              id,
              actionType,
              note,
              overrides,
              todoOptions,
              modelCatalogOptions,
              knowledgeBaseOptions,
              options,
            );
          }
        }
      }
      throw new TriageActionInProgressError(id);
    }
    actionClaimId = reservation.claimId;
  }

  // Execute the Karakeep write-back if this is a save_karakeep action
  let karakeepNote = note;
  if (actionType === 'save_karakeep' && !skip) {
    const result = await saveToKarakeep(item, overrides);
    if (!result.success) {
      throw new Error(result.error || 'Karakeep save failed');
    }
    karakeepNote = karakeepNote
      ? `${karakeepNote} (Karakeep bookmark: ${result.bookmarkId})`
      : `Saved to Karakeep (bookmark: ${result.bookmarkId})`;
  }

  const record: TriageActionRecord = {
    id: randomUUID(),
    actionType,
    appliedAt: new Date().toISOString(),
    note: karakeepNote,
  };
  if (isUndoableTriageAction(actionType)) {
    record.metadata = {
      undoPreviousStatus: item.status,
      undoPreviousSnoozedUntil: item.snoozedUntil ?? null,
    };
  }

  // Execute MS Todo task creation when action is create_task_todo
  // Skip when the task was already created externally (e.g. via AddTaskModal)
  if (actionType === 'create_task_todo' && !skip) {
    try {
      if (actionClaimId && !(await heartbeatTriageTaskCreation(actionClaimId))) {
        throw new TriageActionInProgressError(id);
      }
      const result = await createTodoTaskFromTriageItem(item, {
        ...todoOptions,
        onTargetResolved: async (target) => {
          if (!actionClaimId || !(await recordTriageTaskTarget(actionClaimId, target))) {
            throw new TriageActionInProgressError(id);
          }
        },
      });
      record.metadata = {
        todoTaskId: result.taskId,
        todoTaskTitle: result.taskTitle,
        todoListId: result.listId,
        todoListName: result.listName,
        todoWebUrl: result.webUrl,
      };
      record.note = record.note || `Created in "${result.listName}" list`;
    } catch (err) {
      if (actionClaimId && (!(err instanceof TodoTaskCreationError) || !err.outcomeUnknown)) {
        await releaseTriageTaskCreation(actionClaimId);
      }
      logger.error({ err, triageItemId: id }, 'Failed to create MS Todo task from triage action');
      throw err;
    }
  }

  // Execute Model Catalog save when action is save_model_catalog
  if (actionType === 'save_model_catalog' && !skip) {
    const result = await saveToModelCatalog(item, modelCatalogOptions);
    if (!result.success) {
      throw new Error(result.error || 'Model Catalog save failed');
    }
    record.metadata = { modelCatalogEntryId: result.entryId };
    record.note = record.note
      ? `${record.note} (Model Catalog entry: ${result.entryId})`
      : `Saved to Model Catalog (entry: ${result.entryId})`;
  }

  // Execute Knowledge Base save when action is save_knowledge_base
  if (actionType === 'save_knowledge_base' && !skip) {
    const result = await saveToKnowledgeBase(item, knowledgeBaseOptions);
    if (!result.success) {
      throw new Error(result.error || 'Knowledge Base save failed');
    }
    const kbRecord = buildKnowledgeBaseActionRecord(result);
    record.metadata = kbRecord.metadata;
    record.note = kbRecord.note;
  }

  if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence') {
    record.note = record.note || 'Completed in OWL';
  }

  if (actionType === 'defer_action' && !skip) {
    if (item.sourcePlatform === 'document-intelligence') {
      await deferDocumentAction(item);
    }
    record.note = record.note || 'Deferred';
  }

  const nextStatus: TriageStatus =
    actionType === 'dismiss'
      ? 'dismissed'
      : actionType === 'snooze' || actionType === 'defer_action'
        ? 'snoozed'
        : 'actioned';

  const snoozedUntil =
    actionType === 'snooze' || actionType === 'defer_action'
      ? new Date(Date.now() + SNOOZE_DURATION_MS).toISOString()
      : null;

  const itemUpdate = {
    status: nextStatus,
    snoozedUntil,
    actionsTaken: sql`json_insert(${triageItems.actionsTaken}, '$[#]', json(${JSON.stringify(record)}))`,
  };

  if (actionClaimId) {
    return completeTriageTaskCreation(id, actionClaimId, record);
  } else {
    const actionVersionCondition = isUndoableTriageAction(actionType)
      ? sql`${triageItems.actionsTaken} = ${JSON.stringify(existing.actionsTaken)}
          AND ${triageItems.status} = ${existing.status}
          AND ${triageItems.snoozedUntil} IS ${existing.snoozedUntil}`
      : undefined;
    const updated = await db.update(triageItems)
      .set(itemUpdate)
      .where(and(eq(triageItems.id, id), actionVersionCondition))
      .returning()
      .get();
    if (!updated && actionVersionCondition) {
      if (concurrencyAttempt >= 3) {
        throw new TriageActionInProgressError(id);
      }
      return applyTriageAction(
        id,
        actionType,
        note,
        overrides,
        todoOptions,
        modelCatalogOptions,
        knowledgeBaseOptions,
        options,
        concurrencyAttempt + 1,
      );
    }
    if (!updated) return null;

    if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence' && !skip) {
      const result = await completeDocumentAction(item);
      if (!result.success) {
        logger.warn({ triageItemId: id, err: result.error }, 'DI complete_action write-back failed (action recorded locally)');
      }
    }
    return mapRow(updated);
  }
}

export async function undoTriageAction(
  id: string,
  actionType: TriageActionType,
  actionId: string,
) {
  if (!isUndoableTriageAction(actionType)) return null;
  await ensureSeedData();

  const [existing] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  if (!existing) return null;

  const item = mapRow(existing);
  const latestAction = item.actionsTaken.at(-1);
  if (
    latestAction?.id !== actionId
    || latestAction.actionType !== actionType
  ) {
    return null;
  }
  const previousStatus = latestAction.metadata?.undoPreviousStatus;
  const previousSnoozedUntil = latestAction.metadata?.undoPreviousSnoozedUntil;
  if (
    typeof previousStatus !== 'string'
    || !isRestorableTriageStatus(previousStatus)
    || (previousSnoozedUntil !== null && typeof previousSnoozedUntil !== 'string')
  ) {
    return null;
  }
  const undoInProgress = latestAction.metadata?.undoInProgress === true;
  const undoClaimedAt = latestAction.metadata?.undoClaimedAt;
  const claimIsStale = typeof undoClaimedAt !== 'string'
    || Date.now() - new Date(undoClaimedAt).getTime() >= 30_000;
  if (undoInProgress && !claimIsStale) return null;
  const originalMetadata = { ...latestAction.metadata };
  delete originalMetadata.undoInProgress;
  delete originalMetadata.undoClaimId;
  delete originalMetadata.undoClaimedAt;
  const originalAction: TriageActionRecord = {
    ...latestAction,
    metadata: originalMetadata,
  };
  const originalActions = [...item.actionsTaken.slice(0, -1), originalAction];
  let expectedActions = item.actionsTaken;
  if (actionType === 'complete_action' && item.sourcePlatform === 'document-intelligence') {
    const claimedAction: TriageActionRecord = {
      ...originalAction,
      metadata: {
        ...originalMetadata,
        undoInProgress: true,
        undoClaimId: randomUUID(),
        undoClaimedAt: new Date().toISOString(),
      },
    };
    const claimedActions = [...originalActions.slice(0, -1), claimedAction];
    const claim = await db.update(triageItems)
      .set({ actionsTaken: claimedActions })
      .where(and(
        eq(triageItems.id, id),
        sql`${triageItems.actionsTaken} = ${JSON.stringify(expectedActions)}`,
      ))
      .returning({ id: triageItems.id })
      .get();
    if (!claim) return null;
    expectedActions = claimedActions;

    try {
      await reopenDocumentAction(item);
    } catch (error) {
      await db.update(triageItems)
        .set({ actionsTaken: originalActions })
        .where(and(
          eq(triageItems.id, id),
          sql`${triageItems.actionsTaken} = ${JSON.stringify(expectedActions)}`,
        ));
      throw error;
    }
  }

  const updated = await db.update(triageItems)
    .set({
      status: previousStatus,
      snoozedUntil: previousSnoozedUntil,
      actionsTaken: item.actionsTaken.slice(0, -1),
    })
    .where(and(
      eq(triageItems.id, id),
      sql`${triageItems.actionsTaken} = ${JSON.stringify(expectedActions)}`,
    ))
    .returning()
    .get();

  return updated ? mapRow(updated) : null;
}

export function isUndoableTriageAction(actionType: string): actionType is TriageActionType {
  return actionType === 'complete_action' || actionType === 'dismiss' || actionType === 'snooze';
}

function isRestorableTriageStatus(status: string): status is TriageStatus {
  return status === 'pending'
    || status === 'snoozed'
    || status === 'actioned'
    || status === 'dismissed';
}

export async function clearTriageSampleData(): Promise<number> {
  const sampleIds = SAMPLE_TRIAGE_ITEMS.map((item) => item.id);
  const result = await db.delete(triageItems).where(
    or(...sampleIds.map((id) => eq(triageItems.id, id)))
  );
  // Reset seed guard so demo mode can re-seed if toggled back
  seedEnsured = false;
  return result.changes;
}

export function isValidTriageStatus(value: string | null): value is TriageStatus | 'all' {
  return !!value && ALLOWED_STATUSES.has(value as TriageStatus | 'all');
}

export function isValidTriageSource(value: string | null): value is TriageSourcePlatform | 'all' {
  return !!value && ALLOWED_SOURCES.has(value as TriageSourcePlatform | 'all');
}

/**
 * Update just the thumbnailUrl for an existing triage item.
 * Used by refresh-thumbnail flows to replace expired CDN URLs with cached versions.
 */
export async function updateTriageItemThumbnail(id: string, thumbnailUrl: string): Promise<void> {
  await db.update(triageItems).set({ thumbnailUrl }).where(eq(triageItems.id, id));
}

// ─── Hard Delete & Purge ─────────────────────────────────────────────────────

/**
 * Permanently delete a triage item and its cached thumbnail.
 */
export async function hardDeleteTriageItem(id: string): Promise<boolean> {
  const [item] = await db.select({
    id: triageItems.id,
    thumbnailUrl: triageItems.thumbnailUrl,
    sourceUrl: triageItems.sourceUrl,
  }).from(triageItems).where(eq(triageItems.id, id));

  if (!item) return false;

  await db.delete(triageItems).where(eq(triageItems.id, id));
  await cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl);
  return true;
}

/**
 * Permanently delete multiple triage items and their cached thumbnails.
 */
export async function hardDeleteTriageItems(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const items = await db.select({
    id: triageItems.id,
    thumbnailUrl: triageItems.thumbnailUrl,
    sourceUrl: triageItems.sourceUrl,
  }).from(triageItems).where(inArray(triageItems.id, ids));

  const result = await db.delete(triageItems).where(inArray(triageItems.id, ids));
  await Promise.all(items.map((item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl)));
  return result.changes;
}

/**
 * Purge dismissed items older than the specified retention period.
 * Only removes items with status 'dismissed'. Actioned items are preserved.
 * Returns the number of items purged.
 */
// ─── RECLASSIFY ─────────────────────────────────────────────────────────────

/**
 * Re-run content type detection on a single triage item using the current registry rules.
 * Returns the updated item with its new content type.
 */
export async function reclassifyTriageItem(id: string): Promise<{ item: TriageItem; changed: boolean } | null> {
  const [row] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  if (!row) return null;

  const url = row.canonicalUrl || row.sourceUrl;
  const newType = await detectContentTypeFromRegistry(url, row.title, row.description || undefined) as TriageContentType;
  const changed = newType !== row.contentType;

  if (changed) {
    await db.update(triageItems).set({ contentType: newType }).where(eq(triageItems.id, id));
  }

  const [updated] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  return { item: mapRow(updated), changed };
}

/**
 * Manually set the content type for a triage item (user override).
 */
export async function setTriageItemContentType(id: string, contentType: string): Promise<TriageItem | null> {
  const [row] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  if (!row) return null;

  await db.update(triageItems).set({ contentType }).where(eq(triageItems.id, id));
  const [updated] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  return mapRow(updated);
}

/**
 * Re-run content type detection on multiple triage items (batch).
 * Returns summary of how many were changed.
 */
export async function reclassifyTriageItems(ids?: string[]): Promise<{ total: number; changed: number; results: Array<{ id: string; oldType: string; newType: string }> }> {
  const rows = ids && ids.length > 0
    ? await db.select().from(triageItems).where(inArray(triageItems.id, ids))
    : await db.select().from(triageItems);

  const results: Array<{ id: string; oldType: string; newType: string }> = [];
  let changed = 0;

  for (const row of rows) {
    const url = row.canonicalUrl || row.sourceUrl;
    const newType = await detectContentTypeFromRegistry(url, row.title, row.description || undefined) as TriageContentType;
    if (newType !== row.contentType) {
      await db.update(triageItems).set({ contentType: newType }).where(eq(triageItems.id, row.id));
      results.push({ id: row.id, oldType: row.contentType, newType });
      changed++;
    }
  }

  return { total: rows.length, changed, results };
}

/**
 * Manually set content type for multiple items (bulk override).
 */
export async function setTriageItemsContentType(ids: string[], contentType: string): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.update(triageItems).set({ contentType }).where(inArray(triageItems.id, ids));
  return result.changes;
}

export async function purgeDismissedItems(retentionDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Find dismissed items older than the cutoff
  const staleItems = await db.select({
    id: triageItems.id,
    thumbnailUrl: triageItems.thumbnailUrl,
    sourceUrl: triageItems.sourceUrl,
  }).from(triageItems).where(
    and(
      eq(triageItems.status, 'dismissed'),
      sql`${triageItems.ingestedAt} < ${cutoffDate}`,
    ),
  );

  if (staleItems.length === 0) return 0;

  const ids = staleItems.map((i) => i.id);
  const result = await db.delete(triageItems).where(inArray(triageItems.id, ids));
  await Promise.all(staleItems.map((item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl)));
  logger.info({ purged: result.changes, retentionDays }, 'Purged dismissed triage items');
  return result.changes;
}
