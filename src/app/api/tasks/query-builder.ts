import type { SQL } from 'drizzle-orm';
import {
  getAssignedFilterCondition as compileAssignedCondition,
  getInboxFilterCondition as compileInboxCondition,
  getQuickFilterCondition as compileQuickFilterCondition,
  withCondition as composeCondition,
} from '@/db/persistence/sqlite-task-filter';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';
import { getLocalDaysFromNow, getLocalToday } from '@/lib/utils/date';

/**
 * Quick-filter predicate builders for the legacy SQLite task routes.
 *
 * The predicates come from the handle-free SQLite compiler; the two
 * identity-aware filters ("assigned to me" and "inbox") read their stored
 * evidence through the portable task-core `TaskFilterInputRepository`, which
 * is why they remain asynchronous.
 */

export function getDateBounds() {
  const today = getLocalToday();
  const weekFromNow = getLocalDaysFromNow(NEXT_7_DAYS);
  return { today, weekFromNow };
}

export function getQuickFilterCondition(
  quickFilter: string | null,
  today: string,
  weekFromNow: string,
  myDayTaskIds?: string[],
): SQL | undefined {
  return compileQuickFilterCondition(quickFilter, today, weekFromNow, myDayTaskIds);
}

/**
 * Identity-aware "Assigned to Me" filter.
 */
export async function getAssignedFilterCondition(): Promise<SQL | undefined> {
  const { filterInputs } = await getTaskCorePersistence();
  return compileAssignedCondition(await filterInputs.listAssignedGitHubUsernames());
}

export function withCondition(
  baseWhere: SQL | undefined,
  condition: SQL | undefined,
): SQL | undefined {
  return composeCondition(baseWhere, condition);
}

/**
 * "Inbox" quick filter — returns tasks that are considered untriaged.
 * Matches:
 *  1. connectorType = 'local' (quick captures)
 *  2. Tasks in user-configured "inbox lists" (e.g., MS To Do "Tasks" list)
 *  3. Tasks tagged 'needs-triage'
 */
export async function getInboxFilterCondition(): Promise<SQL | undefined> {
  const { filterInputs } = await getTaskCorePersistence();
  return compileInboxCondition(await filterInputs.listInboxListEntries());
}
