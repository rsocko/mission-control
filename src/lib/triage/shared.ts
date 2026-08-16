/**
 * Internal helpers shared across the triage domain modules (capture, query,
 * actions, classification, lifecycle). Nothing here is part of the public
 * `@/lib/triage` API surface — it exists purely to avoid duplicating row
 * mapping / seed-guard logic across the split modules, and to avoid
 * import cycles between them.
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { sql } from 'drizzle-orm';
import type { TriageActionRecord, TriageContentType, TriageItem, TriageSourcePlatform, TriageStatus, TriageSuggestedAction } from '@/types';
import { SAMPLE_TRIAGE_ITEMS } from './seed-data';
import { isDemoMode } from '@/lib/mode';

export function safeJsonArray<T>(value: unknown): T[] {
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

export function safeJsonObject(value: unknown): Record<string, unknown> {
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

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function mapRow(row: typeof triageItems.$inferSelect): TriageItem {
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

let seedEnsured = false;
let seedPromise: Promise<void> | null = null;

/**
 * Ensures the triage table has sample data in demo mode (idempotent, memoized).
 * Called from capture/query/actions entry points before they touch triageItems.
 */
export async function ensureSeedData(): Promise<void> {
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

/** Resets the seed-ensured guard so demo mode can re-seed after data is cleared. */
export function resetSeedGuard(): void {
  seedEnsured = false;
}
