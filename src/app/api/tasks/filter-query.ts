import type { SQL } from 'drizzle-orm';
import {
  compileFilterQueryConditions,
  getSourceListGroupCondition as compileSourceListGroupCondition,
  getSourceListIdsCondition as compileSourceListIdsCondition,
} from '@/db/persistence/sqlite-task-filter';

/**
 * Free-text filter-query compilation for the legacy SQLite task routes.
 *
 * Token parsing is pure and shared (`@/lib/utils/parseFilterQuery`); the
 * dialect-specific predicate construction now lives in the handle-free SQLite
 * compiler, so this module carries no database dependency. The signature stays
 * asynchronous for source compatibility with the existing route callers even
 * though the compilation itself is synchronous.
 */

export async function getFilterQueryConditions(
  filterQuery: string,
  today: string,
  weekFromNow: string,
): Promise<SQL[]> {
  return compileFilterQueryConditions(filterQuery, today, weekFromNow);
}

export function getSourceListIdsCondition(values: string[]): SQL {
  return compileSourceListIdsCondition(values);
}

export function getSourceListGroupCondition(groupId: string): SQL {
  return compileSourceListGroupCondition(groupId);
}
