/**
 * Triage lifecycle module — item deletion, thumbnail updates, retention
 * purges, and demo sample-data administration.
 *
 * Persistence is owned by the composed triage repositories. Storage cleanup
 * and semantic publication intentionally remain outside repository transactions.
 */
import { SAMPLE_TRIAGE_ITEMS } from './seed-data';
import { cleanupTriageItemStorage } from './capture-image-lifecycle';
import logger from '@/lib/logger';
import { resetSeedGuard } from './shared';
import { publishSemanticEntityDelete } from '@/lib/semantic-index/publication-service';
import { getTriagePersistenceRepositories } from './persistence';

/**
 * Update just the thumbnailUrl for an existing triage item.
 * Used by refresh-thumbnail flows to replace expired CDN URLs with cached versions.
 */
export async function updateTriageItemThumbnail(id: string, thumbnailUrl: string): Promise<void> {
  await getTriagePersistenceRepositories().items.setThumbnail(id, thumbnailUrl);
}

// ─── Hard Delete & Purge ─────────────────────────────────────────────────────

/**
 * Permanently delete a triage item and its cached thumbnail.
 */
export async function hardDeleteTriageItem(id: string): Promise<boolean> {
  const [item] = await getTriagePersistenceRepositories().maintenance.deleteByIds([id]);
  if (!item) return false;

  await cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl);
  await publishSemanticEntityDelete('triage-item', id);
  return true;
}

/**
 * Permanently delete multiple triage items and their cached thumbnails.
 */
export async function hardDeleteTriageItems(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const items = await getTriagePersistenceRepositories().maintenance.deleteByIds(ids);
  await Promise.all(items.map((item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl)));
  await Promise.all(items.map((item) => publishSemanticEntityDelete('triage-item', item.id)));
  return items.length;
}

/**
 * Deletes the canonical demo/sample triage items. Reachable only from
 * `/api/settings/mode`'s `clear-triage-samples` demo action — see the
 * module doc comment for why this is the one SQLite-only exception here.
 */
export async function clearTriageSampleData(): Promise<number> {
  const sampleIds = SAMPLE_TRIAGE_ITEMS.map((item) => item.id);
  const deleted = await getTriagePersistenceRepositories().maintenance.deleteByIds(sampleIds);
  await Promise.all(sampleIds.map(
    (id) => publishSemanticEntityDelete('triage-item', id),
  ));
  // Reset seed guard so demo mode can re-seed if toggled back
  resetSeedGuard();
  return deleted.length;
}

/**
 * Purge dismissed items older than the specified retention period.
 * Only removes items with status 'dismissed'. Actioned items are preserved.
 * Returns the number of items purged.
 */
export async function purgeDismissedItems(retentionDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const staleItems = await getTriagePersistenceRepositories()
    .maintenance
    .purgeDismissedBefore(cutoffDate);

  if (staleItems.length === 0) return 0;

  await Promise.all(staleItems.map((item) => cleanupTriageItemStorage(item.thumbnailUrl || item.sourceUrl)));
  await Promise.all(staleItems.map(
    (item) => publishSemanticEntityDelete('triage-item', item.id),
  ));
  logger.info({ purged: staleItems.length, retentionDays }, 'Purged dismissed triage items');
  return staleItems.length;
}
