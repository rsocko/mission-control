/**
 * Triage classification module — content-type detection and manual overrides
 * for one or many triage items.
 */
import db from '@/db';
import { triageItems } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { TriageContentType, TriageItem } from '@/types';
import { detectContentType as detectContentTypeFromRegistry } from './content-type-registry';
import { mapRow } from './shared';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication';

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
  if (changed) await publishSemanticEntityUpsert('triage-item', id);
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
  await publishSemanticEntityUpsert('triage-item', id);
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

  await Promise.all(results.map(
    (result) => publishSemanticEntityUpsert('triage-item', result.id),
  ));
  return { total: rows.length, changed, results };
}

/**
 * Manually set content type for multiple items (bulk override).
 */
export async function setTriageItemsContentType(ids: string[], contentType: string): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.update(triageItems).set({ contentType }).where(inArray(triageItems.id, ids));
  await Promise.all(ids.map((id) => publishSemanticEntityUpsert('triage-item', id)));
  return result.changes;
}
