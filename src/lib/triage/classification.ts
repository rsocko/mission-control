/**
 * Triage classification module — content-type detection and manual overrides
 * for one or many triage items.
 */
import type { TriageContentType, TriageItem } from '@/types';
import { detectContentType as detectContentTypeFromRegistry } from './content-type-registry';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication-service';
import { getTriagePersistenceRepositories } from './persistence';

/**
 * Re-run content type detection on a single triage item using the current registry rules.
 * Returns the updated item with its new content type.
 */
export async function reclassifyTriageItem(id: string): Promise<{ item: TriageItem; changed: boolean } | null> {
  const row = await getTriagePersistenceRepositories().items.get(id);
  if (!row) return null;

  const url = row.canonicalUrl || row.sourceUrl;
  const newType = await detectContentTypeFromRegistry(url, row.title, row.description || undefined) as TriageContentType;
  const changed = newType !== row.contentType;

  if (changed) {
    await getTriagePersistenceRepositories().items.setContentType(id, newType);
  }

  const updated = await getTriagePersistenceRepositories().items.get(id);
  if (!updated) return null;
  if (changed) await publishSemanticEntityUpsert('triage-item', id);
  return { item: updated, changed };
}

/**
 * Manually set the content type for a triage item (user override).
 */
export async function setTriageItemContentType(id: string, contentType: string): Promise<TriageItem | null> {
  const updated = await getTriagePersistenceRepositories().items.setContentType(
    id,
    contentType,
  );
  if (!updated) return null;
  await publishSemanticEntityUpsert('triage-item', id);
  return updated;
}

/**
 * Re-run content type detection on multiple triage items (batch).
 * Returns summary of how many were changed.
 */
export async function reclassifyTriageItems(ids?: string[]): Promise<{ total: number; changed: number; results: Array<{ id: string; oldType: string; newType: string }> }> {
  const rows = await getTriagePersistenceRepositories().items.listForReclassification(ids);

  const results: Array<{ id: string; oldType: string; newType: string }> = [];
  let changed = 0;

  for (const row of rows) {
    const url = row.canonicalUrl || row.sourceUrl;
    const newType = await detectContentTypeFromRegistry(url, row.title, row.description || undefined) as TriageContentType;
    if (newType !== row.contentType) {
      await getTriagePersistenceRepositories().items.setContentType(row.id, newType);
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
  const updated = await getTriagePersistenceRepositories().items.setContentTypes(
    ids,
    contentType,
  );
  await Promise.all(ids.map((id) => publishSemanticEntityUpsert('triage-item', id)));
  return updated;
}
