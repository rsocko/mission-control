import db from '@/db';
import { sourceLists } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { resolveSourceListDisplayName } from './source-list-display-name';

/**
 * Build a lookup map from `${connectorInstanceId}:${sourceListId}` to the
 * authoritative display name (userDisplayName ?? name) for a set of tasks.
 *
 * This resolves at query time so the UI always shows the user's renamed
 * value, even if the denormalized `tasks.sourceListName` is stale due to a
 * sync race condition.
 */
export function buildSourceListNameMap(
  tasks: Array<{ sourceListId: string | null; connectorInstanceId: string }>,
): Map<string, string> {
  const sourceListIds = [...new Set(tasks.map((t) => t.sourceListId).filter(Boolean))] as string[];
  const map = new Map<string, string>();
  if (sourceListIds.length === 0) return map;

  const slRows = db
    .select({
      sourceId: sourceLists.sourceId,
      connectorInstanceId: sourceLists.connectorInstanceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
    })
    .from(sourceLists)
    .where(inArray(sourceLists.sourceId, sourceListIds))
    .all();

  for (const sl of slRows) {
    map.set(
      `${sl.connectorInstanceId}:${sl.sourceId}`,
      resolveSourceListDisplayName(sl),
    );
  }

  return map;
}

/**
 * Resolve the display name for a single task using the lookup map.
 */
export function resolveTaskListName(
  task: { sourceListId: string | null; connectorInstanceId: string; sourceListName: string | null },
  map: Map<string, string>,
): string | null {
  if (task.sourceListId) {
    const resolved = map.get(`${task.connectorInstanceId}:${task.sourceListId}`);
    if (resolved) return resolved;
  }
  return task.sourceListName;
}
