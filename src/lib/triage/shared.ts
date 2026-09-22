/**
 * Internal helpers shared across the triage domain modules (capture, query,
 * actions, classification, lifecycle). Nothing here is part of the public
 * `@/lib/triage` API surface — it exists purely to avoid duplicating row
 * mapping / seed-guard logic across the split modules, and to avoid
 * import cycles between them.
 */
import type { TriageActionRecord, TriageContentType, TriageItem, TriageSourcePlatform, TriageStatus, TriageSuggestedAction } from '@/types';
import { SAMPLE_TRIAGE_ITEMS } from './seed-data';
import { isDemoMode } from '@/lib/mode';
import { getTriagePersistenceRepositories } from './persistence';

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

interface LegacyTriageItemRow {
  id: string;
  sourcePlatform: string;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  contentType: string;
  capturedAt: string;
  ingestedAt: string;
  status: string;
  snoozedUntil: string | null;
  aiSummary: string | null;
  aiCategories: unknown;
  aiSuggestedActions: unknown;
  aiRelevanceScore: number;
  aiUrgency: string;
  rawMetadata: unknown;
  actionsTaken: unknown;
  sourceOrder: number | null;
}

export function mapRow(row: LegacyTriageItemRow): TriageItem {
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
    await getTriagePersistenceRepositories().items.seedIfEmpty(
      isDemoMode() ? SAMPLE_TRIAGE_ITEMS : [],
    );
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
