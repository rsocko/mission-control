import 'server-only';

import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { ScoutHardDeleteOutcome } from '@/lib/tasks/core/contracts';

export type ScoutHardDeleteResult = ScoutHardDeleteOutcome;

/**
 * Hard-deletes a Scout task graph together with its ingest-suppression
 * tombstones.
 *
 * Backend-neutral as of L04. The tombstone write and the graph deletion are
 * one adapter-owned transaction on purpose: a partially-applied hard delete
 * would either resurrect the task on the next Scout sync (tombstones lost) or
 * permanently suppress a task that still exists (deletion lost).
 */
export async function hardDeleteScoutTask(
  taskId: string,
): Promise<ScoutHardDeleteResult> {
  const persistence = await getTaskCorePersistence();
  return persistence.scoutDeletion.hardDeleteScoutTask(taskId);
}
