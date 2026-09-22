import type { SQL } from 'drizzle-orm';
import {
  getAnyTagSlugFilterCondition as compileAnyTagSlugCondition,
  getMultiTagFilterCondition as compileMultiTagCondition,
  getProjectFilterCondition as compileProjectCondition,
  getTagIdsFilterCondition as compileTagIdsCondition,
  getTagSlugFilterCondition as compileTagSlugCondition,
} from '@/db/persistence/sqlite-task-filter';

/**
 * Relation-membership filter factories for the legacy SQLite task routes.
 *
 * The predicates themselves now live in the SQLite dialect compiler
 * (`@/db/persistence/sqlite-task-filter`), which is handle-free, so this
 * module no longer needs a database connection to build a subquery. The
 * portable equivalents live behind `TaskQueryRepository`.
 */

type EmptyResponse = {
  tasks: never[];
  total: number;
  stats: {
    totalOpen: number;
    overdue: number;
    dueToday: number;
    dueThisWeek: number;
    noDate: number;
    highPriority: number;
    assignedToMe: number;
    myDay: number;
    recentlyCreated: number;
    recentlyClosed: number;
    waiting: number;
    inbox: number;
  };
  hasMore: boolean;
  sourceCounts: Record<string, number>;
  availableTags: never[];
};

const EMPTY_STATS = {
  totalOpen: 0,
  overdue: 0,
  dueToday: 0,
  dueThisWeek: 0,
  noDate: 0,
  highPriority: 0,
  assignedToMe: 0,
  myDay: 0,
  recentlyCreated: 0,
  recentlyClosed: 0,
  waiting: 0,
  inbox: 0,
};

export function createEmptyResponse(): EmptyResponse {
  return {
    tasks: [],
    total: 0,
    stats: EMPTY_STATS,
    hasMore: false,
    sourceCounts: {},
    availableTags: [],
  };
}

/** Match tasks with a tag slug without hydrating the task-tag junction. */
export function getTagSlugFilterCondition(tagSlug: string): SQL {
  return compileTagSlugCondition(tagSlug);
}

/** Match every requested slug while treating duplicate tag rows as one logical slug. */
export function getMultiTagFilterCondition(tagSlugs: string[]): SQL {
  return compileMultiTagCondition(tagSlugs);
}

/** Match any requested tag slug or name. */
export function getAnyTagSlugFilterCondition(tagSlugs: string[]): SQL {
  return compileAnyTagSlugCondition(tagSlugs);
}

/** Match any requested tag ID. */
export function getTagIdsFilterCondition(tagIds: string[]): SQL {
  return compileTagIdsCondition(tagIds);
}

/** Match tasks in the requested project. */
export function getProjectFilterCondition(projectId: string): SQL {
  return compileProjectCondition(projectId);
}
