/**
 * Triage query module — read-side access to triage items (listing, single-item
 * lookup, and status/source validation). Deliberately free of any action
 * provider wiring so query-only consumers (AI tools, list routes, hooks) don't
 * pull in MS Todo / Karakeep / Model Catalog / Knowledge Base / GitHub clients.
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm';
import type { TriageItem, TriageSourcePlatform, TriageStatus } from '@/types';
import { ensureSeedData, mapRow, toNumber } from './shared';

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

const ALLOWED_STATUSES = new Set<TriageStatus | 'all'>(['all', 'pending', 'snoozed', 'actioned', 'dismissed']);
const ALLOWED_SOURCES = new Set<TriageSourcePlatform | 'all'>(['all', 'reddit', 'youtube', 'instagram', 'facebook', 'github', 'twitter', 'tiktok', 'pinterest', 'document-intelligence', 'scout', 'ios_share', 'android_share', 'browser_extension', 'browser_tabs', 'web']);

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

export async function getTriageItemById(id: string): Promise<TriageItem | null> {
  await ensureSeedData();
  const [row] = await db.select().from(triageItems).where(eq(triageItems.id, id));
  return row ? mapRow(row) : null;
}

export function isValidTriageStatus(value: string | null): value is TriageStatus | 'all' {
  return !!value && ALLOWED_STATUSES.has(value as TriageStatus | 'all');
}

export function isValidTriageSource(value: string | null): value is TriageSourcePlatform | 'all' {
  return !!value && ALLOWED_SOURCES.has(value as TriageSourcePlatform | 'all');
}
