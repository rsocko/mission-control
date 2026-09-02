import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { isDatabaseContentionError } from '@/db/contention';
import {
  myDayItems,
  myDayExclusions,
  projectPhaseItems,
  projectPhases,
  tasks,
  taskTags,
  tags,
  sourceLists,
  taskProjects,
  taskSchedules,
  taskHistoryEvents,
} from '@/db/schema';
import { eq, and, lt, lte, gt, gte, sql, ne, inArray, isNull } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import type { MicrosoftTodoConnector } from '@/lib/connectors/microsoft-todo';
import { getLocalDateBoundsISO, getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';
import { resolveTaskListName } from '@/lib/utils/resolve-task-list-names';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { ApiErrors } from '@/lib/api-error';
import { isPublicDemoMode } from '@/lib/public-demo';
import { getTaskSourceVisibilityConditions } from '@/app/api/tasks/canonical-filter';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';
import {
  getPlanningSignalRepository,
  finalizePlanningSignalsIfDue,
  planningFrictionEventTypes,
} from '@/lib/planning-signals';

const SUGGESTION_LIMIT = 200;

class StaleMyDayOrderError extends Error {}

function isValidDateParameter(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

type MyDayDatabase = Parameters<Parameters<typeof runTransaction>[0]>[0];

/**
 * Read the completed tasks for a date that are not yet represented in My Day.
 * Runs without the writer lock so callers can skip the write entirely when
 * there is nothing to auto-include.
 */
function findCompletedTasksToAutoInclude(
  reader: MyDayDatabase,
  date: string,
  taskVisibilityConditions: ReturnType<typeof getTaskSourceVisibilityConditions>,
): Array<{ id: string; completedAt: string }> {
  const { dayStart, nextDayStart } = getLocalDateBoundsISO(date);

  const completedTasks = reader.select({
    id: tasks.id,
    completedAt: tasks.completedAt,
  })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'done'),
      gte(
        sql<number>`julianday(${tasks.completedAt})`,
        sql<number>`julianday(${dayStart})`,
      ),
      lt(
        sql<number>`julianday(${tasks.completedAt})`,
        sql<number>`julianday(${nextDayStart})`,
      ),
      eq(tasks.depth, 0),
      isNull(tasks.parentId),
      ...taskVisibilityConditions,
    ))
    .all();

  if (completedTasks.length === 0) return [];

  const existingTaskIds = new Set(
    reader.select({ taskId: myDayItems.taskId })
      .from(myDayItems)
      .where(eq(myDayItems.date, date))
      .all()
      .map((item) => item.taskId),
  );
  const excludedTaskIds = new Set(
    reader.select({ taskId: myDayExclusions.taskId })
      .from(myDayExclusions)
      .where(eq(myDayExclusions.date, date))
      .all()
      .map((item) => item.taskId),
  );

  return completedTasks.flatMap((task) => (
    task.completedAt
      && !existingTaskIds.has(task.id)
      && !excludedTaskIds.has(task.id)
      ? [{ id: task.id, completedAt: task.completedAt }]
      : []
  ));
}

function includeCompletedTasksForDate(
  date: string,
  taskVisibilityConditions: ReturnType<typeof getTaskSourceVisibilityConditions>,
): void {
  // Avoid contending for the writer lock when the read-only view already shows
  // that there is nothing to auto-include.
  if (findCompletedTasksToAutoInclude(db, date, taskVisibilityConditions).length === 0) return;

  try {
    runTransaction((tx) => {
      const pendingTasks = findCompletedTasksToAutoInclude(
        tx,
        date,
        taskVisibilityConditions,
      );
      if (pendingTasks.length === 0) return;

      const [maxOrder] = tx.select({ max: sql<number>`MAX("order")` })
        .from(myDayItems)
        .where(eq(myDayItems.date, date))
        .all();
      let order = (maxOrder?.max || 0) + 1;

      for (const task of pendingTasks) {
        tx.insert(myDayItems).values({
          id: `md-completed-${crypto.randomUUID().slice(0, 8)}`,
          taskId: task.id,
          date,
          addedAt: task.completedAt,
          isAutoIncluded: true,
          order,
        }).run();
        order++;
      }
    });
  } catch (error) {
    // Auto-inclusion is best-effort maintenance: a reader must not fail because
    // background sync or maintenance currently owns the writer lock.
    if (!isDatabaseContentionError(error)) throw error;
    logger.warn(
      { err: error, date },
      'Skipped My Day completed-task auto-include because SQLite is write-contended',
    );
  }
}

/**
 * Compute yesterday's date string from a given YYYY-MM-DD date.
 */
function getYesterday(date: string): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Compute a date N days from now.
 */
function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * GET /api/my-day — Get today's items with full task details + tags
 * Also returns grouped suggestions (yesterday, overdue, dueToday, dueThisWeek,
 * highPriority, aiRecommended, recentlyAdded, carriedForward)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();
  if (!isValidDateParameter(date)) {
    return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');
  }

  try {
    try {
      await finalizePlanningSignalsIfDue();
    } catch (error) {
      logger.warn({ err: error }, 'Planning signal finalization will retry later');
    }
    const taskVisibilityConditions = [
      ...getTaskSourceVisibilityConditions(),
      eq(tasks.localDisposition, 'active'),
    ];
    includeCompletedTasksForDate(date, taskVisibilityConditions);

    // Fetch My Day items for date
    const dayItems = await db.select({
      id: myDayItems.id,
      taskId: myDayItems.taskId,
      order: myDayItems.order,
      isAutoIncluded: myDayItems.isAutoIncluded,
      addedAt: myDayItems.addedAt,
      // Task fields
      title: tasks.title,
      hasDescription: sql<number>`CASE WHEN length(trim(coalesce(${tasks.description}, ''), char(9) || char(10) || char(13) || ' ')) > 0 THEN 1 ELSE 0 END`,
      status: tasks.status,
      statusReason: tasks.statusReason,
      priority: tasks.priority,
      planningHorizon: tasks.planningHorizon,
      dueDate: tasks.dueDate,
      pushCount: tasks.pushCount,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
      assignee: tasks.assignee,
      createdAt: tasks.createdAt,
      completedAt: tasks.completedAt,
      metadata: tasks.metadata,
      effort: tasks.effort,
      microStatus: tasks.microStatus,
      localDisposition: tasks.localDisposition,
    })
      .from(myDayItems)
      .innerJoin(tasks, eq(myDayItems.taskId, tasks.id))
      .where(and(eq(myDayItems.date, date), ...taskVisibilityConditions))
      .orderBy(myDayItems.order);

    // Attach tags and subtask counts to each item
    const myDayTaskIds = dayItems.map(d => d.taskId);

    // Resolve authoritative list display names (userDisplayName takes priority)
    // Query all source lists since suggestions may reference any list
    const allSlRows = db.select({
      sourceId: sourceLists.sourceId,
      connectorInstanceId: sourceLists.connectorInstanceId,
      name: sourceLists.name,
      userDisplayName: sourceLists.userDisplayName,
    }).from(sourceLists).all();
    const slNameMap = new Map<string, string>();
    for (const sl of allSlRows) {
      slNameMap.set(`${sl.connectorInstanceId}:${sl.sourceId}`, resolveSourceListDisplayName(sl));
    }

    // Fetch subtask counts for My Day tasks
    const subtaskCountRows = myDayTaskIds.length > 0
      ? await db
          .select({
            parentId: tasks.parentId,
            total: sql<number>`COUNT(*)`.as('total'),
            done: sql<number>`SUM(CASE WHEN ${tasks.status} = 'done' THEN 1 ELSE 0 END)`.as('done'),
          })
          .from(tasks)
          .where(and(
           inArray(tasks.parentId, myDayTaskIds),
           ...taskVisibilityConditions,
          ))
          .groupBy(tasks.parentId)
      : [];

    const subtaskCounts = new Map<string, { total: number; done: number }>();
    for (const row of subtaskCountRows) {
      if (row.parentId) {
        subtaskCounts.set(row.parentId, { total: row.total, done: row.done });
      }
    }

    // Fetch estimated durations from task schedules
    const durationRows = myDayTaskIds.length > 0
      ? await db.select({
          taskId: taskSchedules.taskId,
          estimatedDuration: taskSchedules.estimatedDuration,
        })
          .from(taskSchedules)
          .where(inArray(taskSchedules.taskId, myDayTaskIds))
      : [];

    const durationByTask = new Map<string, number | null>();
    for (const row of durationRows) {
      durationByTask.set(row.taskId, row.estimatedDuration);
    }

    // Batch-load tags for all My Day tasks (fixes N+1 query)
    const tagsByTask = new Map<string, Array<{ id: string; name: string; slug: string; type: string; color: string | null }>>();
    if (myDayTaskIds.length > 0) {
      const allTags = await db.select({
        taskId: taskTags.taskId,
        id: tags.id,
        name: tags.name,
        slug: tags.slug,
        type: tags.type,
        color: tags.color,
      })
        .from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(inArray(taskTags.taskId, myDayTaskIds));

      for (const tag of allTags) {
        if (!tagsByTask.has(tag.taskId)) {
          tagsByTask.set(tag.taskId, []);
        }
        tagsByTask.get(tag.taskId)!.push({ id: tag.id, name: tag.name, slug: tag.slug, type: tag.type, color: tag.color });
      }
    }

    const yesterday = getYesterday(date);
    const weekEnd = addDays(date, 7);
    const isTopLevelTask = and(eq(tasks.depth, 0), isNull(tasks.parentId));

    // Batch-load hub project memberships for My Day tasks
    const projectsByTask = new Map<string, string[]>();
    const projectPhasesByTask = new Map<string, Map<string, Array<{ phaseId: string; phaseName: string }>>>();
    if (myDayTaskIds.length > 0) {
      const [tpRows, phaseRows] = await Promise.all([
        db.select({
          taskId: taskProjects.taskId,
          projectId: taskProjects.projectId,
        })
          .from(taskProjects)
          .where(inArray(taskProjects.taskId, myDayTaskIds)),
        db.select({
          taskId: projectPhaseItems.taskId,
          projectId: projectPhases.projectId,
          phaseId: projectPhases.id,
          phaseName: projectPhases.name,
        })
          .from(projectPhaseItems)
          .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
          .where(inArray(projectPhaseItems.taskId, myDayTaskIds)),
      ]);

      for (const row of tpRows) {
        if (!projectsByTask.has(row.taskId)) {
          projectsByTask.set(row.taskId, []);
        }
        projectsByTask.get(row.taskId)!.push(row.projectId);
      }

      for (const row of phaseRows) {
        if (!row.projectId) continue;
        if (!projectPhasesByTask.has(row.taskId)) {
          projectPhasesByTask.set(row.taskId, new Map());
        }
        const taskProjects = projectPhasesByTask.get(row.taskId)!;
        if (!taskProjects.has(row.projectId)) {
          taskProjects.set(row.projectId, []);
        }
        taskProjects.get(row.projectId)!.push({ phaseId: row.phaseId, phaseName: row.phaseName });
      }
    }

    const itemsWithTags = dayItems.map((item) => {
      const sc = subtaskCounts.get(item.taskId);
      const resolvedName = item.sourceListId
        ? slNameMap.get(`${item.connectorInstanceId}:${item.sourceListId}`)
        : undefined;
      return {
        ...item,
        hasDescription: Boolean(item.hasDescription),
        sourceListName: resolvedName || item.sourceListName,
        tags: tagsByTask.get(item.taskId) || [],
        subtaskTotal: sc?.total || 0,
        subtaskDone: sc?.done || 0,
        hubProjectIds: projectsByTask.get(item.taskId) || [],
        projectPhaseMemberships: (projectsByTask.get(item.taskId) || []).flatMap((
          projectId,
        ): Array<{ projectId: string; phaseId: string | null; phaseName: string | null }> => {
          const memberships = projectPhasesByTask.get(item.taskId)?.get(projectId);
          return memberships?.length
            ? memberships.map((membership) => ({ projectId, ...membership }))
            : [{ projectId, phaseId: null, phaseName: null }];
        }),
        estimatedDuration: durationByTask.get(item.taskId) || null,
      };
    });

    // Helper to pick suggestion fields and exclude already-in-my-day
    function pickSuggestionFields(task: typeof tasks.$inferSelect) {
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        microStatus: task.microStatus,
        priority: task.priority,
        planningHorizon: task.planningHorizon,
        dueDate: task.dueDate,
        pushCount: task.pushCount,
        connectorType: task.connectorType,
        connectorInstanceId: task.connectorInstanceId,
        sourceId: task.sourceId,
        sourceListName: resolveTaskListName(task, slNameMap),
        metadata: task.metadata,
        localDisposition: task.localDisposition,
      };
    }

    // Run all suggestion queries in parallel (independent reads)
    const twoDaysAgo = addDays(date, -2);

    const [
      yesterdayItems,
      overdueRows,
      dueTodayRows,
      dueThisWeekRows,
      planningNextRows,
      highPriorityRows,
      aiRows,
      recentlyAddedRows,
      repeatedlyRescheduledRows,
    ] = await Promise.all([
      // 1. Yesterday's Incomplete
      db.select({
        taskId: myDayItems.taskId,
        title: tasks.title,
        sourceId: tasks.sourceId,
        priority: tasks.priority,
        planningHorizon: tasks.planningHorizon,
        dueDate: tasks.dueDate,
        pushCount: tasks.pushCount,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceListId: tasks.sourceListId,
        sourceListName: tasks.sourceListName,
        status: tasks.status,
        microStatus: tasks.microStatus,
        metadata: tasks.metadata,
      })
        .from(myDayItems)
        .innerJoin(tasks, eq(myDayItems.taskId, tasks.id))
        .where(
          and(
            eq(myDayItems.date, yesterday),
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 2. Overdue
      db.select()
        .from(tasks)
        .where(
          and(
            sql`${tasks.dueDate} < ${date}`,
            eq(tasks.status, 'todo'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 3. Due Today
      db.select()
        .from(tasks)
        .where(
          and(
            eq(tasks.dueDate, date),
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 4. Due This Week
      db.select()
        .from(tasks)
        .where(
          and(
            gt(tasks.dueDate, date),
            lte(tasks.dueDate, weekEnd),
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // Tasks explicitly queued to be done next
      db.select()
        .from(tasks)
        .where(
          and(
            eq(tasks.planningHorizon, 'next'),
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 5. High Priority
      db.select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, 'todo'),
            sql`${tasks.priority} IN ('critical', 'high')`,
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 6. AI Recommended (recently updated, not done)
      db.select()
        .from(tasks)
        .where(
          and(
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            gte(tasks.updatedAt, twoDaysAgo),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 7. Recently Added (created in last 48 hours)
      db.select()
        .from(tasks)
        .where(
          and(
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            gte(tasks.createdAt, twoDaysAgo),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT),
      // 8. Repeatedly rescheduled
      db.select()
        .from(tasks)
        .where(
          and(
            gte(tasks.pushCount, 2),
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .orderBy(sql`${tasks.pushCount} DESC`, tasks.dueDate)
        .limit(SUGGESTION_LIMIT),
    ]);

    const yesterdaySuggestions = yesterdayItems
      .filter(t => !myDayTaskIds.includes(t.taskId))
      .map(t => ({
        id: t.taskId,
        title: t.title,
        status: t.status,
        microStatus: t.microStatus,
        priority: t.priority,
        planningHorizon: t.planningHorizon,
        dueDate: t.dueDate,
        pushCount: t.pushCount,
        connectorType: t.connectorType,
        connectorInstanceId: t.connectorInstanceId,
        sourceId: t.sourceId,
        sourceListName: (t.sourceListId ? slNameMap.get(`${t.connectorInstanceId}:${t.sourceListId}`) : undefined) || t.sourceListName,
        metadata: t.metadata,
      }));

    const overdueSuggestions = overdueRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const dueTodaySuggestions = dueTodayRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const dueThisWeekSuggestions = dueThisWeekRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const planningNextSuggestions = planningNextRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const highPrioritySuggestions = highPriorityRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const aiRecommendedSuggestions = aiRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .sort((a, b) => {
        const pOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
        return (pOrder[a.priority] ?? 4) - (pOrder[b.priority] ?? 4);
      })
      .map(pickSuggestionFields);

    const recentlyAddedSuggestions = recentlyAddedRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    const repeatedlyRescheduledSuggestions = repeatedlyRescheduledRows
      .filter(t => !myDayTaskIds.includes(t.id))
      .map(pickSuggestionFields);

    // ─── 9. Carried Forward (in My Day 3+ times, still incomplete) ───────────
    const [carriedForwardRows, planningSignalRows] = await Promise.all([db.select({
      taskId: myDayItems.taskId,
      count: sql<number>`COUNT(*)`.as('count'),
    })
      .from(myDayItems)
      .groupBy(myDayItems.taskId)
      .having(sql`COUNT(*) >= 3`),
    db.select({
      taskId: taskHistoryEvents.taskId,
      count: sql<number>`COUNT(*)`.as('count'),
    })
      .from(taskHistoryEvents)
      .where(and(
        inArray(taskHistoryEvents.eventType, [...planningFrictionEventTypes()]),
        gte(
          taskHistoryEvents.occurredAt,
          getLocalDateBoundsISO(addDays(date, -90)).dayStart,
        ),
      ))
      .groupBy(taskHistoryEvents.taskId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(SUGGESTION_LIMIT),
    ]);

    const carriedTaskIds = carriedForwardRows
      .map(r => r.taskId)
      .filter(id => !myDayTaskIds.includes(id));

    let carriedForwardSuggestions: ReturnType<typeof pickSuggestionFields>[] = [];
    if (carriedTaskIds.length > 0) {
      const carriedTasks = await db.select()
        .from(tasks)
        .where(
          and(
            sql`${tasks.id} IN (${sql.join(carriedTaskIds.map(id => sql`${id}`), sql`, `)})`,
            ne(tasks.status, 'done'),
            ne(tasks.status, 'cancelled'),
            isTopLevelTask,
            ...taskVisibilityConditions,
          )
        )
        .limit(SUGGESTION_LIMIT);
      carriedForwardSuggestions = carriedTasks.map(pickSuggestionFields);
    }

    const planningSignalCountByTask = new Map(
      planningSignalRows.map(row => [row.taskId, row.count]),
    );
    const planningSignalTaskIds = planningSignalRows
      .map(row => row.taskId)
      .filter(id => !myDayTaskIds.includes(id));
    let planningSignalSuggestions: Array<ReturnType<typeof pickSuggestionFields> & {
      planningSignalCount: number;
    }> = [];
    if (planningSignalTaskIds.length > 0) {
      const signaledTasks = await db.select()
        .from(tasks)
        .where(and(
          inArray(tasks.id, planningSignalTaskIds),
          ne(tasks.status, 'done'),
          ne(tasks.status, 'cancelled'),
          isTopLevelTask,
          ...taskVisibilityConditions,
        ))
        .limit(SUGGESTION_LIMIT);
      planningSignalSuggestions = signaledTasks
        .map(task => ({
          ...pickSuggestionFields(task),
          planningSignalCount: planningSignalCountByTask.get(task.id) ?? 0,
        }))
        .sort((left, right) => right.planningSignalCount - left.planningSignalCount);
    }

    const suggestionGroups = {
      planningSignals: planningSignalSuggestions,
      planningNext: planningNextSuggestions,
      yesterday: yesterdaySuggestions,
      overdue: overdueSuggestions,
      dueToday: dueTodaySuggestions,
      dueThisWeek: dueThisWeekSuggestions,
      highPriority: highPrioritySuggestions,
      aiRecommended: aiRecommendedSuggestions,
      recentlyAdded: recentlyAddedSuggestions,
      carriedForward: carriedForwardSuggestions,
      repeatedlyRescheduled: repeatedlyRescheduledSuggestions,
    };
    const policyTasks = [
      ...itemsWithTags.map((item) => ({
        id: item.taskId,
        sourceId: item.sourceId,
        connectorType: item.connectorType,
        connectorInstanceId: item.connectorInstanceId,
      })),
      ...Object.values(suggestionGroups).flat(),
    ];
    const editPolicies = await resolveTaskEditPolicies(policyTasks);

    return NextResponse.json({
      date,
      items: itemsWithTags.map((item) => {
        const editPolicy = requireTaskEditPolicy(editPolicies, item.taskId);
        return {
          ...item,
          taskSourceModel: editPolicy.sourceModel,
          editPolicy,
        };
      }),
      suggestions: Object.fromEntries(
        Object.entries(suggestionGroups).map(([group, suggestionTasks]) => [
          group,
          suggestionTasks.map((task) => {
            const editPolicy = requireTaskEditPolicy(editPolicies, task.id);
            return {
              ...task,
              taskSourceModel: editPolicy.sourceModel,
              editPolicy,
            };
          }),
        ]),
      ),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch My Day', error);
  }
}

/**
 * PATCH /api/my-day — Persist the complete manual order for a day.
 * Body: { date?: string, orderedItemIds: string[] }
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const date = typeof body.date === 'string' ? body.date : getLocalToday();
    const orderedItemIds = body.orderedItemIds;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return ApiErrors.badRequest('date must use YYYY-MM-DD format');
    }
    if (
      !Array.isArray(orderedItemIds)
      || orderedItemIds.length === 0
      || orderedItemIds.some((id) => typeof id !== 'string' || !id)
      || new Set(orderedItemIds).size !== orderedItemIds.length
    ) {
      return ApiErrors.badRequest('orderedItemIds must be a non-empty array of unique item IDs');
    }

    const taskVisibilityConditions = [
      ...getTaskSourceVisibilityConditions(),
      eq(tasks.localDisposition, 'active'),
    ];
    try {
      runTransaction((tx) => {
        const currentItems = tx
          .select({ id: myDayItems.id })
          .from(myDayItems)
          .innerJoin(tasks, eq(myDayItems.taskId, tasks.id))
          .where(and(eq(myDayItems.date, date), ...taskVisibilityConditions))
          .all();
        const currentIds = new Set(currentItems.map((item) => item.id));
        if (
          currentIds.size !== orderedItemIds.length
          || orderedItemIds.some((id: string) => !currentIds.has(id))
        ) {
          throw new StaleMyDayOrderError();
        }

        const allItems = tx
          .select({ id: myDayItems.id })
          .from(myDayItems)
          .where(eq(myDayItems.date, date))
          .orderBy(myDayItems.order)
          .all();
        const hiddenItemIds = allItems
          .map((item) => item.id)
          .filter((id) => !currentIds.has(id));
        const completeOrder = [...orderedItemIds, ...hiddenItemIds];

        for (let index = 0; index < completeOrder.length; index++) {
          tx.update(myDayItems)
            .set({ order: index + 1 })
            .where(and(
              eq(myDayItems.id, completeOrder[index]),
              eq(myDayItems.date, date),
            ))
            .run();
        }
      });
    } catch (error) {
      if (error instanceof StaleMyDayOrderError) {
        return ApiErrors.conflict('My Day changed while its order was being saved. Refresh and try again.');
      }
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to save My Day order', error);
  }
}

/**
 * POST /api/my-day — Add a task to My Day
 * Writes back isInMyDay=true to Microsoft Todo if applicable.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, date } = body;
    const targetDate = date || getLocalToday();

    if (!taskId) {
      return ApiErrors.badRequest('taskId is required');
    }

    // Check if task is already in My Day for this date
    const existing = await db.select({ id: myDayItems.id })
      .from(myDayItems)
      .where(and(eq(myDayItems.taskId, taskId), eq(myDayItems.date, targetDate)))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ id: existing[0].id, alreadyExists: true }, { status: 200 });
    }

    // Get max order
    const maxOrder = await db.select({ max: sql<number>`MAX("order")` })
      .from(myDayItems)
      .where(eq(myDayItems.date, targetDate));

    const order = (maxOrder[0]?.max || 0) + 1;
    const id = `md-${crypto.randomUUID().slice(0, 8)}`;

    const addedAt = new Date().toISOString();
    const planningSignals = await getPlanningSignalRepository();
    runTransaction((tx) => {
      tx.insert(myDayItems).values({
        id,
        taskId,
        date: targetDate,
        addedAt,
        isAutoIncluded: false,
        order,
      }).run();
      void planningSignals.append({
        taskId,
        eventType: 'my_day_committed',
        date: targetDate,
        occurredAt: addedAt,
        provenance: 'my-day-api',
        metadata: { origin: 'explicit-local' },
      });
    });

    // Write-back: set isInMyDay on Microsoft Todo
    const writeBack = isPublicDemoMode()
      ? { attempted: false, success: true }
      : await writeBackMyDayStatus(taskId, true);

    return NextResponse.json({ id, order, writeBack }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to add to My Day', error);
  }
}

/**
 * DELETE /api/my-day — Remove a task from My Day
 * Writes back isInMyDay=false to Microsoft Todo if applicable.
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('id');
  const taskId = searchParams.get('taskId');
  const requestedDate = searchParams.get('date');

  if (!itemId && !taskId) {
    return ApiErrors.badRequest('id or taskId is required');
  }
  if (requestedDate && !isValidDateParameter(requestedDate)) {
    return ApiErrors.badRequest('date must be a valid YYYY-MM-DD date');
  }

  try {
    const removedAt = new Date().toISOString();
    const planningSignals = await getPlanningSignalRepository();
    const resolvedTaskId = runTransaction((tx) => {
      let removedTaskId: string | null = taskId;
      let removedDate = requestedDate || getLocalToday();
      let removedExistingItem = false;

      if (itemId) {
        const item = tx.select({
          taskId: myDayItems.taskId,
          date: myDayItems.date,
        })
          .from(myDayItems)
          .where(eq(myDayItems.id, itemId))
          .get();
        removedTaskId = item?.taskId || null;
        removedDate = item?.date || removedDate;
        removedExistingItem = tx.delete(myDayItems).where(eq(myDayItems.id, itemId)).run().changes > 0;
      } else if (taskId) {
        removedExistingItem = tx.delete(myDayItems)
          .where(and(
            eq(myDayItems.taskId, taskId),
            eq(myDayItems.date, removedDate),
          ))
          .run().changes > 0;
      }

      if (removedTaskId && removedExistingItem) {
        void planningSignals.append({
          taskId: removedTaskId,
          eventType: 'my_day_withdrawn',
          date: removedDate,
          occurredAt: removedAt,
          provenance: 'my-day-api',
          metadata: { origin: 'explicit-local' },
        });
        const existingExclusion = tx.select({ id: myDayExclusions.id })
          .from(myDayExclusions)
          .where(and(
            eq(myDayExclusions.taskId, removedTaskId),
            eq(myDayExclusions.date, removedDate),
          ))
          .get();
        if (!existingExclusion) {
          tx.insert(myDayExclusions).values({
            id: `mde-${crypto.randomUUID().slice(0, 8)}`,
            taskId: removedTaskId,
            date: removedDate,
            removedAt,
          }).run();
        }
      }

      return removedTaskId;
    });

    // Write-back: remove isInMyDay on Microsoft Todo
    let writeBack = { attempted: false, success: true } as { attempted: boolean; success: boolean; error?: string };
    if (resolvedTaskId && !isPublicDemoMode()) {
      writeBack = await writeBackMyDayStatus(resolvedTaskId, false);
    }

    return NextResponse.json({ success: true, writeBack });
  } catch (error) {
    return ApiErrors.internal('Failed to remove from My Day', error);
  }
}

// ─── Write-back Helper ──────────────────────────────────────────────────────

/**
 * If the task belongs to a Microsoft Todo connector, write back isInMyDay status.
 * Uses the undocumented but functional isInMyDay write property on the beta endpoint.
 * Non-blocking: returns { attempted, success, error } so callers can surface warnings.
 */
async function writeBackMyDayStatus(taskId: string, isInMyDay: boolean): Promise<{ attempted: boolean; success: boolean; error?: string }> {
  try {
    const [task] = await db.select({
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(eq(tasks.id, taskId));

    if (!task || task.connectorType !== 'microsoft-todo') return { attempted: false, success: true };

    const connector = connectorRegistry.getConnector(task.connectorInstanceId) as MicrosoftTodoConnector | undefined;
    if (!connector || !('setMyDay' in connector)) return { attempted: false, success: true };

    await connector.setMyDay(task.sourceId, isInMyDay);
    return { attempted: true, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, taskId }, 'My Day write-back failed');
    return { attempted: true, success: false, error: message };
  }
}
