import db from '@/db';
import { tasks, taskTags, tags, myDayItems } from '@/db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { getQuickFilterCondition, getAssignedFilterCondition, getInboxFilterCondition, withCondition } from './query-builder';

type TaskStats = {
  totalOpen: number;
  overdue: number;
  dueThisWeek: number;
  highPriority: number;
  assignedToMe: number;
  myDay: number;
  recentlyCreated: number;
  waiting: number;
  inbox: number;
};

type SourceCounts = Record<string, number>;

type AvailableTag = {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  color: string | null;
  confirmed: boolean;
  count: number;
};

import { notInArray } from 'drizzle-orm';

export async function countTasks(whereClause: ReturnType<typeof and> | ReturnType<typeof eq> | ReturnType<typeof sql> | undefined) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(whereClause);

  return Number(row?.count ?? 0);
}

export async function getStats(baseWhere: ReturnType<typeof and> | undefined, openOnly: boolean, today: string, weekFromNow: string, myDayTaskIds: string[]): Promise<TaskStats> {
  const openCondition = notInArray(tasks.status, ['done', 'cancelled']);
  const openWhere = openOnly ? baseWhere : withCondition(baseWhere, openCondition);

  const assignedCondition = await getAssignedFilterCondition();
  const inboxCondition = await getInboxFilterCondition();

  const [totalOpen, overdue, dueThisWeek, highPriority, assignedToMe, myDay, recentlyCreated, waiting, inbox] = await Promise.all([
    countTasks(openWhere),
    countTasks(withCondition(openWhere, getQuickFilterCondition('overdue', today, weekFromNow))),
    countTasks(withCondition(openWhere, getQuickFilterCondition('week', today, weekFromNow))),
    countTasks(withCondition(openWhere, getQuickFilterCondition('high', today, weekFromNow))),
    countTasks(withCondition(openWhere, assignedCondition)),
    countTasks(withCondition(openWhere, getQuickFilterCondition('myDay', today, weekFromNow, myDayTaskIds))),
    countTasks(withCondition(openWhere, getQuickFilterCondition('recentlyCreated', today, weekFromNow))),
    countTasks(withCondition(openWhere, getQuickFilterCondition('waiting', today, weekFromNow))),
    countTasks(withCondition(openWhere, inboxCondition)),
  ]);

  return {
    totalOpen,
    overdue,
    dueThisWeek,
    highPriority,
    assignedToMe,
    myDay,
    recentlyCreated,
    waiting,
    inbox,
  };
}

export async function getSourceCounts(baseWhere: ReturnType<typeof and> | undefined): Promise<SourceCounts> {
  const rows = await db
    .select({
      connectorType: tasks.connectorType,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(baseWhere)
    .groupBy(tasks.connectorType);

  return rows.reduce<SourceCounts>((acc, row) => {
    acc[row.connectorType] = Number(row.count ?? 0);
    return acc;
  }, {});
}

export async function getAvailableTags(baseWhere: ReturnType<typeof and> | undefined): Promise<AvailableTag[]> {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      count: sql<number>`count(*)`,
    })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
    .where(baseWhere)
    .groupBy(tags.id, tags.name, tags.slug, tags.type, tags.source, tags.color, tags.confirmed)
    .orderBy(asc(tags.name));

  return rows.map((row) => ({
    ...row,
    count: Number(row.count ?? 0),
  }));
}
