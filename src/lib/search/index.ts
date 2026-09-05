import {
  indexAlert,
  indexTask,
  rebuildSearchIndex,
  removeAlertFromIndex,
  removeTaskFromIndex,
  warmUpFTS,
  type SearchableNotificationRecord,
  type SearchableTaskRecord,
} from './fts';
import {
  getSearchStatus,
  rebuildEmbeddingIndex,
  search,
  searchWithBranches,
  type SearchBranchTiming,
  type SearchExecution,
} from './semantic';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';

export interface SearchFilters {
  source?: string;
  status?: string;
  excludeDone?: boolean;
  universeEligible?: boolean;
  excludeConnectorInstanceIds?: string[];
}

export { getSearchStatus, search, searchWithBranches };
export type { SearchBranchTiming, SearchExecution };

/**
 * Publishes a semantic intent for an entity whose authoritative write already
 * committed.
 *
 * Publication never throws and never blocks on a provider: `publishSemantic*`
 * records a durable intent (or logs a skip) and returns. A dropped intent is
 * repaired by reconciliation rather than failing the caller.
 */
async function publishSemantic(
  kind: 'upsert' | 'delete',
  entityType: 'task' | 'alert',
  entityId: string,
): Promise<void> {
  if (kind === 'upsert') await publishSemanticEntityUpsert(entityType, entityId);
  else await publishSemanticEntityDelete(entityType, entityId);
}

/**
 * Keyword indexing stays inline and immediate — it is a local FTS write. The
 * semantic side is only *published*: no embedding provider is ever called on a
 * domain write path.
 */
export async function indexTaskSearch(task: SearchableTaskRecord) {
  await indexTask(task);
  await publishSemantic('upsert', 'task', task.id);
}

export async function indexNotificationSearch(notification: SearchableNotificationRecord) {
  await indexAlert(notification);
  await publishSemantic('upsert', 'alert', notification.id);
}

/** @deprecated Use indexNotificationSearch */
export const indexAlertSearch = indexNotificationSearch;

/** Removes a deleted task from the keyword index and tombstones its document. */
export async function removeTaskSearch(taskId: string) {
  await removeTaskFromIndex(taskId);
  await publishSemantic('delete', 'task', taskId);
}

export async function removeNotificationSearch(notificationId: string) {
  await removeAlertFromIndex(notificationId);
  await publishSemantic('delete', 'alert', notificationId);
}

/**
 * Publishes a semantic re-index for an entity whose projected fields changed
 * without its searchable text changing (a status transition, for instance).
 * The keyword index does not need that update; the projection does.
 */
export async function publishTaskSemanticUpdate(taskId: string) {
  await publishSemantic('upsert', 'task', taskId);
}

export async function publishNotificationSemanticUpdate(notificationId: string) {
  await publishSemantic('upsert', 'alert', notificationId);
}

export { rebuildEmbeddingIndex, rebuildSearchIndex };

/**
 * Pre-warm the keyword index after sync. The semantic index is maintained by
 * the durable index worker, so nothing here embeds, backfills, or rebuilds.
 */
export async function warmUpSearch() {
  await warmUpFTS();
}

export type { SearchResult, SearchableTaskRecord, SearchableNotificationRecord } from './fts';
