/**
 * Triage lifecycle module — item deletion, thumbnail updates, retention
 * purges, and demo sample-data administration.
 *
 * Backend-specific exception (see `docs/architecture/persistence-boundaries.md`,
 * "Web/API PostgreSQL parity: Layer L02"): only `clearTriageSampleData` is a
 * SQLite-only seed/demo exception — it is reachable exclusively from
 * `/api/settings/mode`'s demo-only `clear-triage-samples` action, so it
 * fails closed under `MC_DATABASE_BACKEND=postgres` with an explicit,
 * specific message before its `db`/`triageItems` access. Every other export
 * here (`updateTriageItemThumbnail`, `hardDeleteTriageItem`,
 * `hardDeleteTriageItems`, `purgeDismissedItems`) is reachable from normal
 * (non-demo) triage routes — `/api/triage/[id]`, `/api/triage/maintenance`,
 * `/api/triage/storage`, `/api/triage/import/bulk` — and is intentionally
 * left untouched (still statically importing `@/db`/`@/db/schema`), i.e.
 * still owned by whichever later layer migrates triage persistence to
 * PostgreSQL. They already throw under PostgreSQL today via `@/db`'s own
 * `initDatabase()` guard; this file does not change that behavior, and does
 * not move their taint from Tier A to Tier B.
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { SAMPLE_TRIAGE_ITEMS } from './seed-data';
import { cleanupTriageItemStorage } from './capture-image-lifecycle';
import logger from '@/lib/logger';
import { resetSeedGuard } from './shared';
import { publishSemanticEntityDelete } from '@/lib/semantic-index/publication';
import { resolveDatabaseBackend } from '@/db/runtime-backend';

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
  await publishSemanticEntityDelete('triage-item', id);
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
  await Promise.all(items.map((item) => publishSemanticEntityDelete('triage-item', item.id)));
  return result.changes;
}

/**
 * Deletes the canonical demo/sample triage items. Reachable only from
 * `/api/settings/mode`'s `clear-triage-samples` demo action — see the
 * module doc comment for why this is the one SQLite-only exception here.
 */
export async function clearTriageSampleData(): Promise<number> {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'Clearing triage demo/sample data is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
    );
  }
  const sampleIds = SAMPLE_TRIAGE_ITEMS.map((item) => item.id);
  const result = await db.delete(triageItems).where(
    or(...sampleIds.map((id) => eq(triageItems.id, id)))
  );
  await Promise.all(sampleIds.map(
    (id) => publishSemanticEntityDelete('triage-item', id),
  ));
  // Reset seed guard so demo mode can re-seed if toggled back
  resetSeedGuard();
  return result.changes;
}

/**
 * Purge dismissed items older than the specified retention period.
 * Only removes items with status 'dismissed'. Actioned items are preserved.
 * Returns the number of items purged.
 */
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
  await Promise.all(staleItems.map(
    (item) => publishSemanticEntityDelete('triage-item', item.id),
  ));
  logger.info({ purged: result.changes, retentionDays }, 'Purged dismissed triage items');
  return result.changes;
}
