import db from '@/db';
import { tasks, taskTags, taskProjects, tags } from '@/db/schema';
import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';

type EmptyResponse = {
  tasks: never[];
  total: number;
  stats: {
    totalOpen: number;
    overdue: number;
    dueThisWeek: number;
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
  dueThisWeek: 0,
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
  const matchingTasks = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(eq(tags.slug, tagSlug));
  return inArray(tasks.id, matchingTasks);
}

/** Match every requested slug while treating duplicate tag rows as one logical slug. */
export function getMultiTagFilterCondition(tagSlugs: string[]): SQL {
  const matchingTasks = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(inArray(tags.slug, tagSlugs))
    .groupBy(taskTags.taskId)
    .having(sql`COUNT(DISTINCT ${tags.slug}) = ${tagSlugs.length}`);
  return inArray(tasks.id, matchingTasks);
}

/** Match any requested tag slug or name. */
export function getAnyTagSlugFilterCondition(tagSlugs: string[]): SQL {
  const matchingTasks = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(or(inArray(tags.slug, tagSlugs), inArray(tags.name, tagSlugs)));
  return inArray(tasks.id, matchingTasks);
}

/** Match any requested tag ID. */
export function getTagIdsFilterCondition(tagIds: string[]): SQL {
  const matchingTasks = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .where(inArray(taskTags.tagId, tagIds));
  return inArray(tasks.id, matchingTasks);
}

/** Match tasks in the requested project. */
export function getProjectFilterCondition(projectId: string): SQL {
  const matchingTasks = db
    .select({ taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(eq(taskProjects.projectId, projectId));
  return inArray(tasks.id, matchingTasks);
}
