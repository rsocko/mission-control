import { NextResponse } from 'next/server';
import db from '@/db';
import {
  hubProjects,
  projectPhaseItems,
  projectPhases,
  taskProjects,
  tasks,
  taskTags,
  tags,
} from '@/db/schema';
import { eq, and, isNull, notInArray, asc, desc, inArray, lte, or, sql } from 'drizzle-orm';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';

export type QuickSortQueueMode = 'no_priority' | 'quadrant' | 'no_effort' | 'no_tags' | 'no_planning_horizon';
export type QuickSortOrder = 'smart' | 'priority' | 'oldest' | 'newest' | 'random';

const LIMIT = 50;

const PRIORITY_ORDER = sql`CASE ${tasks.priority}
  WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
  WHEN 'low' THEN 4 ELSE 5 END`;

/**
 * GET /api/tasks/quick-sort?mode=no_priority|quadrant|no_effort|no_tags|no_planning_horizon
 *    &counts=true                         (return badge counts only)
 *    &source=connectorType                (optional scope filter)
 *    &sourceList=sourceListName           (optional scope filter)
 *    &connectorId=connectorInstanceId     (optional scope filter)
 *
 * Smart sort per mode:
 *   no_priority → most recent first (new items need priority urgently)
 *   quadrant    → most recent first (same candidates, guided decision)
 *   no_effort   → highest priority first, then most recent
 *   no_tags     → grouped by source list, then most recent within group
 *   no_planning_horizon → highest priority first, then most recent
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode') as QuickSortQueueMode | null;
  const order = (searchParams.get('order') ?? 'smart') as QuickSortOrder;
  const countsOnly = searchParams.get('counts') === 'true';

  // Optional scope filters
  const sourceFilter = searchParams.get('source');
  const sourceListFilter = searchParams.get('sourceList');
  const connectorIdFilter = searchParams.get('connectorId');

  // Exclude tasks from soft-deleted connectors
  const activeConnectorCondition = sql`${tasks.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`;
  const openCondition = notInArray(tasks.status, ['done', 'cancelled'] as string[]);
  // Exclude subtasks — only top-level tasks should appear in quick sort
  const notSubtaskCondition = isNull(tasks.parentId);
  const availableCondition = or(
    isNull(tasks.snoozedUntil),
    lte(tasks.snoozedUntil, new Date().toISOString()),
  );

  // Return available sources for scope filter UI
  if (searchParams.get('sources') === 'true') {
    const sourceRows = await db
      .select({
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceId: tasks.sourceId,
        sourceListName: tasks.sourceListName,
        count: sql<number>`COUNT(*)`.as('count'),
      })
      .from(tasks)
      .where(and(activeConnectorCondition, openCondition, notSubtaskCondition, availableCondition))
      .groupBy(tasks.connectorType, tasks.connectorInstanceId, tasks.sourceListName)
      .orderBy(sql`COUNT(*) DESC`);

    const grouped: Record<string, { connectorId: string; lists: Array<{ name: string; count: number }> }> = {};
    for (const row of sourceRows) {
      if (!grouped[row.connectorType]) {
        grouped[row.connectorType] = { connectorId: row.connectorInstanceId, lists: [] };
      }
      if (row.sourceListName) {
        grouped[row.connectorType].lists.push({ name: row.sourceListName, count: row.count });
      }
    }

    return NextResponse.json({ sources: grouped });
  }

  // Build scope conditions
  const scopeConditions = [activeConnectorCondition, openCondition, notSubtaskCondition, availableCondition];
  if (sourceFilter) {
    scopeConditions.push(eq(tasks.connectorType, sourceFilter));
  }
  if (sourceListFilter) {
    scopeConditions.push(eq(tasks.sourceListName, sourceListFilter));
  }
  if (connectorIdFilter) {
    scopeConditions.push(eq(tasks.connectorInstanceId, connectorIdFilter));
  }

  if (countsOnly) {
    const [noPriorityCount, noEffortCount, noTagsCount, noPlanningHorizonCount] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)`.as('count') })
        .from(tasks)
        .where(and(...scopeConditions, eq(tasks.priority, 'none')))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`COUNT(*)`.as('count') })
        .from(tasks)
        .where(and(...scopeConditions, isNull(tasks.effort)))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`COUNT(*)`.as('count') })
        .from(tasks)
        .where(
          and(
            ...scopeConditions,
            sql`${tasks.id} NOT IN (SELECT task_id FROM task_tags)`
          )
        )
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`COUNT(*)`.as('count') })
        .from(tasks)
        .where(
          and(
            ...scopeConditions,
            isNull(tasks.planningHorizon)
          )
        )
        .then((r) => r[0]?.count ?? 0),
    ]);

    return NextResponse.json({
      counts: {
        no_priority: noPriorityCount,
        quadrant: noPriorityCount,
        no_effort: noEffortCount,
        no_tags: noTagsCount,
        no_planning_horizon: noPlanningHorizonCount,
      },
    });
  }

  if (!mode || !['no_priority', 'quadrant', 'no_effort', 'no_tags', 'no_planning_horizon'].includes(mode)) {
    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
  }

  const conditions = [...scopeConditions];

  if (mode === 'no_priority' || mode === 'quadrant') {
    conditions.push(eq(tasks.priority, 'none'));
  } else if (mode === 'no_effort') {
    conditions.push(isNull(tasks.effort));
  } else if (mode === 'no_tags') {
    conditions.push(sql`${tasks.id} NOT IN (SELECT task_id FROM task_tags)`);
  } else if (mode === 'no_planning_horizon') {
    conditions.push(isNull(tasks.planningHorizon));
  }

  // Smart sort per mode (default), or user-selected order
  let orderClauses;
  if (order === 'priority') {
    orderClauses = [PRIORITY_ORDER, desc(tasks.createdAt)];
  } else if (order === 'oldest') {
    orderClauses = [asc(tasks.createdAt)];
  } else if (order === 'newest') {
    orderClauses = [desc(tasks.createdAt)];
  } else if (order === 'random') {
    orderClauses = [sql`RANDOM()`];
  } else {
    // "smart" — per-mode defaults
    orderClauses =
      mode === 'no_priority' || mode === 'quadrant'
        ? [desc(tasks.createdAt)]                           // newest first
        : mode === 'no_effort' || mode === 'no_planning_horizon'
          ? [PRIORITY_ORDER, desc(tasks.createdAt)]         // highest priority, then newest
          : [asc(tasks.sourceListName), desc(tasks.createdAt)]; // group by list, newest within
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      effort: tasks.effort,
      status: tasks.status,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      sourceListId: tasks.sourceListId,
      sourceListName: tasks.sourceListName,
      dueDate: tasks.dueDate,
      planningHorizon: tasks.planningHorizon,
      createdAt: tasks.createdAt,
      localDisposition: tasks.localDisposition,
    })
    .from(tasks)
    .where(and(...conditions))
    .orderBy(...orderClauses)
    .limit(LIMIT);
  const editPolicies = await resolveTaskEditPolicies(rows);

  // Fetch compact context for all returned tasks
  const taskIds = rows.map((r) => r.id);
  const [tagRows, projectRows, phaseRows] = taskIds.length > 0
    ? await Promise.all([
        db
          .select({
            taskId: taskTags.taskId,
            tagId: tags.id,
            tagName: tags.name,
            tagSlug: tags.slug,
            tagColor: tags.color,
          })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(inArray(taskTags.taskId, taskIds)),
        db
          .select({
            taskId: taskProjects.taskId,
            projectId: hubProjects.id,
            projectName: hubProjects.name,
            projectColor: hubProjects.color,
          })
          .from(taskProjects)
          .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
          .where(inArray(taskProjects.taskId, taskIds)),
        db
          .select({
            taskId: projectPhaseItems.taskId,
            phaseId: projectPhases.id,
            phaseName: projectPhases.name,
            projectId: projectPhases.projectId,
          })
          .from(projectPhaseItems)
          .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
          .where(and(
            inArray(projectPhaseItems.taskId, taskIds),
            eq(projectPhaseItems.isProposed, false),
          )),
      ])
    : [[], [], []];

  const tagsByTask = new Map<string, Array<{ id: string; name: string; slug: string; color: string | null }>>();
  for (const row of tagRows) {
    if (!tagsByTask.has(row.taskId)) tagsByTask.set(row.taskId, []);
    tagsByTask.get(row.taskId)!.push({ id: row.tagId, name: row.tagName, slug: row.tagSlug, color: row.tagColor });
  }

  const projectsByTask = new Map<string, Array<{ id: string; name: string; color: string }>>();
  for (const row of projectRows) {
    if (!projectsByTask.has(row.taskId)) projectsByTask.set(row.taskId, []);
    projectsByTask.get(row.taskId)!.push({
      id: row.projectId,
      name: row.projectName,
      color: row.projectColor,
    });
  }

  const phasesByTask = new Map<string, Array<{ id: string; name: string; projectId: string | null }>>();
  for (const row of phaseRows) {
    if (!phasesByTask.has(row.taskId)) phasesByTask.set(row.taskId, []);
    phasesByTask.get(row.taskId)!.push({
      id: row.phaseId,
      name: row.phaseName,
      projectId: row.projectId,
    });
  }

  return NextResponse.json({
    tasks: rows.map((row) => {
      const { description, ...task } = row;
      const editPolicy = requireTaskEditPolicy(editPolicies, row.id);
      return {
        ...task,
        hasNotes: Boolean(description?.trim()),
        projects: projectsByTask.get(row.id) ?? [],
        phases: phasesByTask.get(row.id) ?? [],
        tags: tagsByTask.get(row.id) ?? [],
        taskSourceModel: editPolicy.sourceModel,
        editPolicy,
      };
    }),
    returned: rows.length,
    limit: LIMIT,
  });
}
