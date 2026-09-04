import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  focusItems,
  hubProjects,
  myDayItems,
  notifications,
  projectPhaseItems,
  projectPhases,
  routineCompletions,
  routines,
  tags,
  taskHistoryEvents,
  taskProjects,
  tasks,
  taskTags,
  triageItems,
} from '@/db/schema';
import { getTaskTransitionsInRange, type TaskHistoryEventType } from '@/db/task-history';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';
import { timestampGte, timestampLt } from '@/lib/utils/sqlite-date';
import type {
  AnalyticsInstantRange,
  AnalyticsLocalDateRange,
  AnalyticsPersistence,
  FlowAnalyticsRepository,
  InsightsAnalyticsRepository,
  KpiAnalyticsRepository,
  TagInsightsAnalyticsRepository,
  WordInsightsAnalyticsRepository,
} from './analytics';

/**
 * SQLite adapter for the L17 derived-analytics read boundary.
 *
 * Every query body here was moved verbatim out of `src/lib/stats/**`,
 * `src/lib/tag-insights/service.ts`, and `src/lib/word-insights/service.ts`, so
 * the emitted SQLite SQL is unchanged apart from the explicit tiebreakers noted
 * inline, which define an order SQLite previously left unspecified so both
 * backends agree. Nothing here opens a transaction: the surface is read-only
 * and its multi-query composites were, and stay, deliberately non-atomic.
 */

type AnalyticsDatabase = BetterSQLite3Database<typeof schema>;

const OPEN_TASK_CONDITION = notInArray(tasks.status, ['done', 'cancelled']);

function count(row: { count: unknown } | undefined): number {
  return Number(row?.count ?? 0);
}

function createKpiRepository(db: AnalyticsDatabase): KpiAnalyticsRepository {
  async function countOpen(extra?: SQL): Promise<number> {
    const where = extra ? and(OPEN_TASK_CONDITION, extra) : OPEN_TASK_CONDITION;
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(where);
    return count(row);
  }

  return {
    countOpenTasks: () => countOpen(),
    countOpenTasksDueBefore: (date) => countOpen(lt(tasks.dueDate, date)),
    countOpenTasksDueBetween: ({ from, to }) => countOpen(
      and(gte(tasks.dueDate, from), lte(tasks.dueDate, to)),
    ),
    countOpenTasksInIds: (taskIds) => countOpen(inArray(tasks.id, [...taskIds])),
    countOpenTasksWithPriorities: (priorities) => countOpen(
      inArray(tasks.priority, [...priorities]),
    ),
    countOpenTasksWithAssignee: () => countOpen(isNotNull(tasks.assignee)),
    countOpenTasksByConnectorType: (connectorType) => countOpen(
      eq(tasks.connectorType, connectorType),
    ),

    async countNotificationsNeedingAttention() {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(notificationNeedsAttention());
      return count(row);
    },

    async countNotificationsNeedingAttentionInCategory(connectorType, category) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(and(
          eq(notifications.connectorType, connectorType),
          notificationNeedsAttention(),
          eq(notifications.category, category),
        ));
      return count(row);
    },

    async listMyDayTaskIds(date) {
      const rows = await db.select({ taskId: myDayItems.taskId })
        .from(myDayItems)
        .where(eq(myDayItems.date, date));
      return rows.map((row) => row.taskId);
    },

    async countTasksCompletedIn({ startInclusive, endExclusive }) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          eq(tasks.status, 'done'),
          timestampGte(tasks.completedAt, startInclusive),
          timestampLt(tasks.completedAt, endExclusive),
        ));
      return count(row);
    },

    async countNonCancelledTasksDueBetween({ from, to }) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          sql`${tasks.status} != 'cancelled'`,
          gte(tasks.dueDate, from),
          lte(tasks.dueDate, to),
        ));
      return count(row);
    },

    listActiveRoutines: () => listActiveRoutines(db),
    listRoutineCompletionsBetween: (range) => listRoutineCompletionsBetween(db, range),

    async listCompletedTimestampsSince(startInclusive) {
      const rows = await db.select({ completedAt: tasks.completedAt })
        .from(tasks)
        .where(and(
          eq(tasks.status, 'done'),
          timestampGte(tasks.completedAt, startInclusive),
        ));
      return rows.map((row) => row.completedAt);
    },

    async listFocusItemStatuses(scope, date) {
      return db.select({ id: focusItems.id, status: tasks.status })
        .from(focusItems)
        .innerJoin(tasks, eq(focusItems.taskId, tasks.id))
        .where(and(eq(focusItems.scope, scope), eq(focusItems.date, date)));
    },

    async countTriageItemsWithStatus(status) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(triageItems)
        .where(eq(triageItems.status, status));
      return count(row);
    },

    async countTriageItemsWithStatusCapturedBefore(status, capturedBefore) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(triageItems)
        .where(and(eq(triageItems.status, status), lt(triageItems.capturedAt, capturedBefore)));
      return count(row);
    },
  };
}

/** Shared by the KPI and insights repositories; `id` is the added tiebreaker. */
function listActiveRoutines(db: AnalyticsDatabase) {
  return db.select({
    id: routines.id,
    name: routines.name,
    icon: routines.icon,
    cadenceType: routines.cadenceType,
    cadenceConfig: routines.cadenceConfig,
  })
    .from(routines)
    .where(and(eq(routines.isActive, true), eq(routines.isArchived, false)))
    .orderBy(asc(routines.id));
}

function listRoutineCompletionsBetween(
  db: AnalyticsDatabase,
  { from, to }: AnalyticsLocalDateRange,
) {
  return db.select({ routineId: routineCompletions.routineId, date: routineCompletions.date })
    .from(routineCompletions)
    .where(and(gte(routineCompletions.date, from), lte(routineCompletions.date, to)))
    .orderBy(asc(routineCompletions.routineId), asc(routineCompletions.date));
}

function createInsightsRepository(db: AnalyticsDatabase): InsightsAnalyticsRepository {
  const completedIn = ({ startInclusive, endExclusive }: AnalyticsInstantRange) => and(
    eq(tasks.status, 'done'),
    timestampGte(tasks.completedAt, startInclusive),
    timestampLt(tasks.completedAt, endExclusive),
  );
  const createdTopLevelIn = ({ startInclusive, endExclusive }: AnalyticsInstantRange) => and(
    eq(tasks.depth, 0),
    eq(tasks.isChecklistItem, false),
    timestampGte(tasks.createdAt, startInclusive),
    timestampLt(tasks.createdAt, endExclusive),
  );

  return {
    async countTasksCompletedIn(range) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(completedIn(range));
      return count(row);
    },

    async countTopLevelTasksCreatedIn(range) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(createdTopLevelIn(range));
      return count(row);
    },

    async listCompletedTimestampsIn(range) {
      const rows = await db.select({ timestamp: tasks.completedAt })
        .from(tasks)
        .where(completedIn(range));
      return rows.map((row) => row.timestamp);
    },

    async listCreatedTimestampsIn(range) {
      const rows = await db.select({ timestamp: tasks.createdAt })
        .from(tasks)
        .where(createdTopLevelIn(range));
      return rows.map((row) => row.timestamp);
    },

    async listCompletionSpansIn(range) {
      return db.select({ createdAt: tasks.createdAt, completedAt: tasks.completedAt })
        .from(tasks)
        .where(completedIn(range));
    },

    async listCompletedTimestampsSince(startInclusive) {
      const rows = await db.select({ completedAt: tasks.completedAt })
        .from(tasks)
        .where(and(
          eq(tasks.status, 'done'),
          timestampGte(tasks.completedAt, startInclusive),
        ));
      return rows.map((row) => row.completedAt);
    },

    async sourceBreakdownIn(range) {
      // `connector_type` is the added tiebreaker for equal counts.
      const rows = await db.select({
        source: tasks.connectorType,
        count: sql<number>`count(*)`,
      })
        .from(tasks)
        .where(completedIn(range))
        .groupBy(tasks.connectorType)
        .orderBy(sql`count(*) DESC`, asc(tasks.connectorType));
      return rows.map((row) => ({ source: row.source, count: Number(row.count) }));
    },

    async listOpenTaskCreatedTimestamps() {
      const rows = await db.select({ createdAt: tasks.createdAt })
        .from(tasks)
        .where(OPEN_TASK_CONDITION);
      return rows.map((row) => row.createdAt);
    },

    async listPlanningFrictionEvents(eventTypes, { startInclusive, endExclusive }) {
      return db.select({
        taskId: taskHistoryEvents.taskId,
        eventType: taskHistoryEvents.eventType,
        previousValue: taskHistoryEvents.previousValue,
        newValue: taskHistoryEvents.newValue,
        title: tasks.title,
        dueDate: tasks.dueDate,
        pushCount: tasks.pushCount,
        sourceListName: tasks.sourceListName,
      })
        .from(taskHistoryEvents)
        .innerJoin(tasks, eq(taskHistoryEvents.taskId, tasks.id))
        .where(and(
          inArray(taskHistoryEvents.eventType, [...eventTypes]),
          timestampGte(taskHistoryEvents.occurredAt, startInclusive),
          timestampLt(taskHistoryEvents.occurredAt, endExclusive),
          eq(tasks.depth, 0),
          eq(tasks.isChecklistItem, false),
        ));
    },

    async listTaskTagNames(taskIds) {
      return db.select({ taskId: taskTags.taskId, name: tags.name })
        .from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, [...taskIds]));
    },

    async listActiveProjects() {
      // `name, id` is the added tiebreaker; the caller's later sort is stable.
      return db.select({ id: hubProjects.id, name: hubProjects.name, color: hubProjects.color })
        .from(hubProjects)
        .where(eq(hubProjects.status, 'active'))
        .orderBy(asc(hubProjects.name), asc(hubProjects.id));
    },

    async countProjectTasksCompletedIn(projectId, range) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(taskProjects)
        .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
        .where(and(eq(taskProjects.projectId, projectId), completedIn(range)));
      return count(row);
    },

    async countProjectOpenTasks(projectId) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(taskProjects)
        .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
        .where(and(eq(taskProjects.projectId, projectId), OPEN_TASK_CONDITION));
      return count(row);
    },

    async countProjectTopLevelTasksCreatedIn(projectId, range) {
      const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(taskProjects)
        .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
        .where(and(eq(taskProjects.projectId, projectId), createdTopLevelIn(range)));
      return count(row);
    },

    listActiveRoutines: () => listActiveRoutines(db),
    listRoutineCompletionsBetween: (range) => listRoutineCompletionsBetween(db, range),

    async listRoutineCompletionsInHalfOpenRange(fromInclusive, toExclusive) {
      return db.select({
        routineId: routineCompletions.routineId,
        date: routineCompletions.date,
      })
        .from(routineCompletions)
        .where(and(
          gte(routineCompletions.date, fromInclusive),
          lt(routineCompletions.date, toExclusive),
        ))
        .orderBy(asc(routineCompletions.routineId), asc(routineCompletions.date));
    },

    async countRoutineCompletionsByDate({ from, to }) {
      const rows = await db.select({
        date: routineCompletions.date,
        count: sql<number>`count(*)`,
      })
        .from(routineCompletions)
        .where(and(gte(routineCompletions.date, from), lte(routineCompletions.date, to)))
        .groupBy(routineCompletions.date);
      return rows.map((row) => ({ date: row.date, count: Number(row.count) }));
    },

    async deliveryFilterOptions() {
      const [projectRows, sourceRows] = await Promise.all([
        // `id` is the added tiebreaker for equal project names.
        db.select({ value: hubProjects.id, label: hubProjects.name })
          .from(hubProjects)
          .where(eq(hubProjects.hidden, false))
          .orderBy(asc(hubProjects.name), asc(hubProjects.id)),
        db.selectDistinct({ value: tasks.connectorType })
          .from(tasks)
          .orderBy(tasks.connectorType),
      ]);
      return {
        projects: projectRows,
        sources: sourceRows.map((row) => row.value),
      };
    },

    async listDeliveryRecords({ startInclusive, endExclusive }, filters) {
      const conditions = [
        eq(tasks.status, 'done'),
        isNotNull(tasks.completedAt),
        timestampGte(tasks.completedAt, startInclusive),
        timestampLt(tasks.completedAt, endExclusive),
      ];
      if (filters.source) conditions.push(eq(tasks.connectorType, filters.source));

      const selection = {
        id: tasks.id,
        title: tasks.title,
        createdAt: tasks.createdAt,
        completedAt: tasks.completedAt,
        source: tasks.connectorType,
        statusReason: tasks.statusReason,
      };

      // `completed_at, id` is the added tiebreaker.
      return filters.projectId
        ? db.selectDistinct(selection)
          .from(tasks)
          .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
          .where(and(...conditions, eq(taskProjects.projectId, filters.projectId)))
          .orderBy(asc(tasks.completedAt), asc(tasks.id))
        : db.select(selection)
          .from(tasks)
          .where(and(...conditions))
          .orderBy(asc(tasks.completedAt), asc(tasks.id));
    },
  };
}

function createFlowRepository(db: AnalyticsDatabase): FlowAnalyticsRepository {
  return {
    async listFlowTasks() {
      return db.select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        source: tasks.connectorType,
      }).from(tasks).where(eq(tasks.isChecklistItem, false));
    },

    async listTaskProjectMemberships() {
      return db.select({ taskId: taskProjects.taskId, projectId: taskProjects.projectId })
        .from(taskProjects);
    },

    async listVisibleProjects() {
      return db.select({
        id: hubProjects.id,
        name: hubProjects.name,
        color: hubProjects.color,
      }).from(hubProjects).where(eq(hubProjects.hidden, false)).orderBy(asc(hubProjects.name));
    },

    listTaskTransitions({ startInclusive, endExclusive }, eventTypes) {
      return getTaskTransitionsInRange({
        start: startInclusive,
        end: endExclusive,
        eventTypes: [...eventTypes] as TaskHistoryEventType[],
      }, db);
    },
  };
}

function createTagInsightsRepository(db: AnalyticsDatabase): TagInsightsAnalyticsRepository {
  const normalizedTagName = sql`lower(trim(${tags.name}))`;

  function excludeTags(excludedTagIds: readonly string[]) {
    return excludedTagIds.length > 0
      ? notInArray(taskTags.tagId, [...excludedTagIds])
      : undefined;
  }

  return {
    async listSyntheticTagCandidates() {
      return db.select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(sql`
      ${normalizedTagName} LIKE 'priority%'
      OR ${normalizedTagName} IN ('p0', 'p1', 'p2', 'p3')
      OR ${normalizedTagName} LIKE 'effort%'
      OR ${normalizedTagName} LIKE 'size%'
      OR ${normalizedTagName} LIKE 'estimate%'
      OR ${normalizedTagName} LIKE 't-shirt%'
      OR ${normalizedTagName} LIKE 'mc:%'
    `);
    },

    async listBoundedTaggedTasks(excludedTagIds, limit) {
      return db.select({ id: tasks.id, title: tasks.title, status: tasks.status })
        .from(tasks)
        .innerJoin(taskTags, eq(taskTags.taskId, tasks.id))
        .where(excludeTags(excludedTagIds))
        .groupBy(tasks.id, tasks.title, tasks.status)
        .orderBy(asc(tasks.id))
        .limit(limit);
    },

    async listTopTags(taskIds, excludedTagIds, topN) {
      const usageCount = countDistinct(taskTags.taskId);
      const rows = await db.select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        usageCount,
      })
        .from(tags)
        .innerJoin(taskTags, eq(taskTags.tagId, tags.id))
        .where(and(
          inArray(taskTags.taskId, [...taskIds]),
          excludeTags(excludedTagIds),
        ))
        .groupBy(tags.id, tags.name, tags.color)
        .orderBy(desc(usageCount), asc(tags.name), asc(tags.id))
        .limit(topN);
      return rows.map((row) => ({ ...row, usageCount: Number(row.usageCount) }));
    },

    async listTaskTagLinks(taskIds, tagIds) {
      return db.select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
        .from(taskTags)
        .where(and(
          inArray(taskTags.taskId, [...taskIds]),
          inArray(taskTags.tagId, [...tagIds]),
        ))
        .orderBy(asc(taskTags.taskId), asc(taskTags.tagId));
    },
  };
}

function createWordInsightsRepository(db: AnalyticsDatabase): WordInsightsAnalyticsRepository {
  return {
    async listTasksWithLiveConnector(limit) {
      return db.select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        sourceListId: tasks.sourceListId,
        sourceListName: tasks.sourceListName,
      }).from(tasks)
        .leftJoin(connectorConfigs, eq(tasks.connectorInstanceId, connectorConfigs.id))
        .where(isNull(connectorConfigs.deletedAt))
        .orderBy(asc(tasks.id))
        .limit(limit);
    },

    async listRankedTaskTags(taskIds, perTaskLimit, limit) {
      const ranked = db.select({
        taskId: taskTags.taskId,
        id: tags.id,
        name: tags.name,
        rank: sql<number>`row_number() over (
        partition by ${taskTags.taskId}
        order by ${tags.name}, ${tags.id}
      )`.as('source_rank'),
      }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, [...taskIds]))
        .as('ranked_word_insight_tags');
      return db.select({ taskId: ranked.taskId, id: ranked.id, name: ranked.name })
        .from(ranked)
        .where(lte(ranked.rank, perTaskLimit))
        .orderBy(asc(ranked.taskId), asc(ranked.name), asc(ranked.id))
        .limit(limit);
    },

    async listRankedTaskProjects(taskIds, perTaskLimit, limit) {
      const ranked = db.select({
        taskId: taskProjects.taskId,
        id: hubProjects.id,
        name: hubProjects.name,
        rank: sql<number>`row_number() over (
        partition by ${taskProjects.taskId}
        order by ${hubProjects.name}, ${hubProjects.id}
      )`.as('source_rank'),
      }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(inArray(taskProjects.taskId, [...taskIds]))
        .as('ranked_word_insight_projects');
      return db.select({ taskId: ranked.taskId, id: ranked.id, name: ranked.name })
        .from(ranked)
        .where(lte(ranked.rank, perTaskLimit))
        .orderBy(asc(ranked.taskId), asc(ranked.name), asc(ranked.id))
        .limit(limit);
    },

    async listRankedTaskPhases(taskIds, perTaskLimit, limit) {
      const ranked = db.select({
        taskId: projectPhaseItems.taskId,
        id: projectPhases.id,
        name: projectPhases.name,
        rank: sql<number>`row_number() over (
        partition by ${projectPhaseItems.taskId}
        order by ${projectPhases.name}, ${projectPhases.id}
      )`.as('source_rank'),
      }).from(projectPhaseItems)
        .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
        .where(inArray(projectPhaseItems.taskId, [...taskIds]))
        .as('ranked_word_insight_phases');
      return db.select({ taskId: ranked.taskId, id: ranked.id, name: ranked.name })
        .from(ranked)
        .where(lte(ranked.rank, perTaskLimit))
        .orderBy(asc(ranked.taskId), asc(ranked.name), asc(ranked.id))
        .limit(limit);
    },
  };
}

export function createSqliteAnalyticsPersistence(db: AnalyticsDatabase): AnalyticsPersistence {
  return {
    kpis: createKpiRepository(db),
    insights: createInsightsRepository(db),
    flow: createFlowRepository(db),
    tagInsights: createTagInsightsRepository(db),
    wordInsights: createWordInsightsRepository(db),
  };
}
