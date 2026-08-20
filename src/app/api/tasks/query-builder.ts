import db from '@/db';
import { tasks, taskTags, tags, myDayItems, connectorConfigs, appSettings } from '@/db/schema';
import { eq, and, or, inArray, isNotNull, lt, lte, gte, notInArray, isNull, sql } from 'drizzle-orm';
import { getLocalToday, getLocalDaysFromNow } from '@/lib/utils/date';

export function getDateBounds() {
  const today = getLocalToday();
  const weekFromNow = getLocalDaysFromNow(7);
  return { today, weekFromNow };
}

export function getQuickFilterCondition(quickFilter: string | null, today: string, weekFromNow: string, myDayTaskIds?: string[]) {
  if (quickFilter === 'overdue') {
    return lt(tasks.dueDate, today);
  }

  if (quickFilter === 'today') {
    return eq(tasks.dueDate, today);
  }

  if (quickFilter === 'noDate') {
    return or(isNull(tasks.dueDate), eq(tasks.dueDate, ''));
  }

  if (quickFilter === 'high') {
    return inArray(tasks.priority, ['high', 'critical']);
  }

  if (quickFilter === 'week') {
    return and(gte(tasks.dueDate, today), lte(tasks.dueDate, weekFromNow));
  }

  if (quickFilter === 'myDay') {
    if (!myDayTaskIds || myDayTaskIds.length === 0) {
      return sql`1 = 0`;
    }
    return inArray(tasks.id, myDayTaskIds);
  }

  if (quickFilter === 'recentlyCreated') {
    const sevenDaysAgo = getLocalDaysFromNow(-7);
    return gte(tasks.createdAt, sevenDaysAgo);
  }

  if (quickFilter === 'recentlyClosed') {
    const sevenDaysAgo = getLocalDaysFromNow(-7);
    return and(
      inArray(tasks.status, ['done', 'cancelled']),
      gte(tasks.completedAt, sevenDaysAgo),
    );
  }

  if (quickFilter === 'waiting') {
    return inArray(tasks.microStatus, ['waiting_on_someone', 'blocked_external', 'on_hold']);
  }

  return undefined;
}

/**
 * Identity-aware "Assigned to Me" filter.
 */
export async function getAssignedFilterCondition() {
  const githubConfigs = await db
    .select({ id: connectorConfigs.id, settings: connectorConfigs.settings })
    .from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.type, 'github-issues'),
      eq(connectorConfigs.enabled, true),
      isNull(connectorConfigs.deletedAt),
    ));

  const githubUsernames: string[] = [];
  for (const cfg of githubConfigs) {
    const settings = (typeof cfg.settings === 'string' ? JSON.parse(cfg.settings) : cfg.settings) as Record<string, unknown>;
    if (settings.authenticatedUser && typeof settings.authenticatedUser === 'string') {
      githubUsernames.push(settings.authenticatedUser);
    }
  }

  const conditions = [
    eq(tasks.connectorType, 'microsoft-todo'),
    eq(tasks.connectorType, 'ms-todo'),
    eq(tasks.connectorType, 'local'),
  ];

  if (githubUsernames.length > 0) {
    conditions.push(
      and(
        eq(tasks.connectorType, 'github-issues'),
        inArray(tasks.assignee, githubUsernames),
      )!
    );
  }

  conditions.push(
    and(
      notInArray(tasks.connectorType, ['microsoft-todo', 'ms-todo', 'local', 'github-issues']),
      isNotNull(tasks.assignee),
    )!
  );

  return or(...conditions);
}

export function withCondition(baseWhere: ReturnType<typeof and> | undefined, condition: ReturnType<typeof eq> | ReturnType<typeof and> | ReturnType<typeof or> | ReturnType<typeof lt> | undefined) {
  if (!condition) {
    return baseWhere;
  }

  return baseWhere ? and(baseWhere, condition) : condition;
}

/**
 * "Inbox" quick filter — returns tasks that are considered untriaged.
 * Matches:
 *  1. connectorType = 'local' (quick captures)
 *  2. Tasks in user-configured "inbox lists" (e.g., MS To Do "Tasks" list)
 *  3. Tasks tagged 'needs-triage'
 */
export async function getInboxFilterCondition() {
  const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof and> | ReturnType<typeof inArray>> = [];

  // 1. All local tasks
  conditions.push(eq(tasks.connectorType, 'local'));

  // 2. User-configured inbox lists from appSettings
  const inboxSetting = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'inbox.lists'))
    .limit(1);

  if (inboxSetting.length > 0 && inboxSetting[0].value) {
    const inboxLists = inboxSetting[0].value as Array<{ connectorType: string; sourceListName?: string; sourceListId?: string }>;
    for (const entry of inboxLists) {
      if (entry.sourceListId) {
        conditions.push(
          and(eq(tasks.connectorType, entry.connectorType), eq(tasks.sourceListId, entry.sourceListId))!
        );
      } else if (entry.sourceListName) {
        conditions.push(
          and(eq(tasks.connectorType, entry.connectorType), eq(tasks.sourceListName, entry.sourceListName))!
        );
      }
    }
  }

  // 3. Tasks with 'needs-triage' tag (use subquery to avoid materializing IDs)
  const triageSubquery = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(eq(tags.slug, 'needs-triage'));

  conditions.push(inArray(tasks.id, triageSubquery));

  return or(...conditions);
}
