import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  AvailableTaskTag,
  TaskFilterSpec,
  TaskQueryScope,
  TaskSourceCounts,
  TaskStatsResult,
} from '@/lib/tasks/core/contracts';

/**
 * Task list statistics.
 *
 * Fully portable as of L04: every entry point takes the backend-neutral
 * `TaskFilterSpec` and runs through the task-core `TaskQueryRepository`, so
 * this module names no database handle, no Drizzle table, and no dialect.
 * Both adapters are proven to agree on these counters by the shared contract
 * suite in `tests/contracts/task-core.contract.ts`.
 *
 * The legacy Drizzle-clause statistics used by `src/app/api/tasks/route.ts`
 * deliberately do *not* live here any more. That route composes route-local
 * predicates (effort, free-text search, tag ids, no-project, group scoping)
 * into the canonical condition array, and modelling those as spec fields is
 * the L05 read-route migration. Rather than smuggling Drizzle predicates
 * across a task-core contract behind an opaque port — or keeping this shared
 * helper tainted for one caller's benefit — those clause-shaped counters now
 * live inside the single SQLite route that still needs them.
 */

export type TaskStats = TaskStatsResult;
export type SourceCounts = TaskSourceCounts;
export type AvailableTag = AvailableTaskTag;

export async function countTasksForSpec(
  spec: TaskFilterSpec,
  options: TaskQueryScope = {},
): Promise<number> {
  const { queries } = await getTaskCorePersistence();
  return queries.countTasks(spec, options);
}

export async function getStatsForSpec(spec: TaskFilterSpec): Promise<TaskStats> {
  const { queries } = await getTaskCorePersistence();
  return queries.getStats(spec);
}

export async function getSourceCountsForSpec(spec: TaskFilterSpec): Promise<SourceCounts> {
  const { queries } = await getTaskCorePersistence();
  return queries.getSourceCounts(spec);
}

export async function getAvailableTagsForSpec(spec: TaskFilterSpec): Promise<AvailableTag[]> {
  const { queries } = await getTaskCorePersistence();
  return [...await queries.getAvailableTags(spec)];
}
