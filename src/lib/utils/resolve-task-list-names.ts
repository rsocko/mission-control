import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { resolveSourceListDisplayName } from './source-list-display-name';

/**
 * Build a lookup map from `${connectorInstanceId}:${sourceListId}` to the
 * authoritative display name (userDisplayName ?? name) for a set of tasks.
 *
 * This resolves at query time so the UI always shows the user's renamed
 * value, even if the denormalized `tasks.sourceListName` is stale due to a
 * sync race condition.
 *
 * Backend-neutral as of L04: the lookup goes through the portable task-core
 * `SourceListNameRepository`, which is why this is now asynchronous.
 */
export async function buildSourceListNameMap(
  tasks: Array<{ sourceListId: string | null; connectorInstanceId: string }>,
): Promise<Map<string, string>> {
  const sourceListIds = [...new Set(tasks.map((t) => t.sourceListId).filter(Boolean))] as string[];
  const map = new Map<string, string>();
  if (sourceListIds.length === 0) return map;

  const persistence = await getTaskCorePersistence();
  const rows = await persistence.sourceListNames.listSourceListDisplayNames(sourceListIds);

  for (const row of rows) {
    map.set(
      `${row.connectorInstanceId}:${row.sourceId}`,
      resolveSourceListDisplayName(row),
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
