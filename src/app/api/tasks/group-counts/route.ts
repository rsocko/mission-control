import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, myDayItems, taskTags, tags, taskProjects, hubProjects, projectPhaseItems, projectPhases } from '@/db/schema';
import { eq, and, notInArray, inArray, sql, count } from 'drizzle-orm';

import {
  getAssignedFilterCondition,
  getDateBounds,
  getInboxFilterCondition,
  getQuickFilterCondition,
  withCondition,
} from '../query-builder';
import {
  getMultiTagFilterCondition,
  getProjectFilterCondition,
  getTagSlugFilterCondition,
} from '../filter-factory';
import { getLocalToday } from '@/lib/utils/date';
import {
  getFilterQueryConditions,
  getSourceListGroupCondition,
  getSourceListIdsCondition,
} from '../filter-query';
import {
  normalizedCsv,
  TaskQueryValidationError,
  validateTaskQueryParams,
} from '../query-input';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';

/**
 * GET /api/tasks/group-counts?groupBy=status&...filters
 *
 * Returns total counts per group for the current filter set,
 * without pagination. Used by the dashboard to show accurate
 * group header counts (e.g., "To Do (127)") even when only
 * a page of tasks has been loaded.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    validateTaskQueryParams(searchParams);
  } catch (error) {
    if (error instanceof TaskQueryValidationError) {
      logger.warn({ queryKeys: [...searchParams.keys()] }, 'Rejected over-budget task group query');
      return ApiErrors.validation(error.message);
    }
    throw error;
  }

  const groupBy = searchParams.get('groupBy');
  const source = searchParams.get('source');
  const sources = normalizedCsv(searchParams, 'sources');
  const listId = searchParams.get('listId');
  const listIds = normalizedCsv(searchParams, 'listIds');
  const listGroupId = searchParams.get('listGroupId');
  const tagSlug = searchParams.get('tag');
  const tagSlugs = normalizedCsv(searchParams, 'tagSlugs');
  const projectId = searchParams.get('projectId');
  const quickFilter = searchParams.get('quickFilter');
  const myDayDate = searchParams.get('myDayDate');
  const openOnly = searchParams.get('openOnly') === 'true';
  const parentOnly = searchParams.get('parentOnly') === 'true';
  const priorities = normalizedCsv(searchParams, 'priorities');
  const statuses = normalizedCsv(searchParams, 'statuses');
  const filterQuery = searchParams.get('filterQuery')?.trim();
  const ageMin = searchParams.get('ageMin') ? parseInt(searchParams.get('ageMin')!, 10) : null;
  const ageMax = searchParams.get('ageMax') ? parseInt(searchParams.get('ageMax')!, 10) : null;

  if (!groupBy) {
    return NextResponse.json({ error: 'groupBy parameter required' }, { status: 400 });
  }

  try {
    const { today, weekFromNow } = getDateBounds();
    const conditions = [];

    // Exclude soft-deleted connectors
    conditions.push(
      sql`${tasks.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`
    );

    if (sources.length > 0) conditions.push(inArray(tasks.connectorType, sources));
    else if (source) conditions.push(eq(tasks.connectorType, source));
    if (parentOnly) conditions.push(sql`${tasks.parentId} IS NULL`);
    if (openOnly && statuses.length === 0) conditions.push(notInArray(tasks.status, ['done', 'cancelled']));
    if (listIds.length > 0) {
      conditions.push(getSourceListIdsCondition(listIds));
    } else if (listId) {
      conditions.push(getSourceListIdsCondition([listId]));
    }
    if (listGroupId) {
      conditions.push(getSourceListGroupCondition(listGroupId));
    }
    if (priorities.length > 0) conditions.push(inArray(tasks.priority, priorities));
    if (statuses.length > 0) conditions.push(inArray(tasks.status, statuses));
    if (filterQuery) {
      conditions.push(...await getFilterQueryConditions(filterQuery, today, weekFromNow));
    }
    if (ageMin !== null && !isNaN(ageMin)) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - ageMin);
      conditions.push(sql`${tasks.createdAt} <= ${cutoff.toISOString()}`);
    }
    if (ageMax !== null && !isNaN(ageMax)) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - ageMax);
      conditions.push(sql`${tasks.createdAt} >= ${cutoff.toISOString()}`);
    }

    if (tagSlug) {
      conditions.push(getTagSlugFilterCondition(tagSlug));
    }

    if (tagSlugs.length > 0) {
      conditions.push(getMultiTagFilterCondition(tagSlugs));
    }

    if (projectId) {
      conditions.push(getProjectFilterCondition(projectId));
    }

    const baseWhere = conditions.length > 0 ? and(...conditions) : undefined;

    // Apply quick filters
    const myDayRows = quickFilter === 'myDay'
      ? await db.select({ taskId: myDayItems.taskId }).from(myDayItems).where(eq(
          myDayItems.date,
          myDayDate && /^\d{4}-\d{2}-\d{2}$/.test(myDayDate) ? myDayDate : getLocalToday(),
        ))
      : [];
    const myDayTaskIds = myDayRows.map(r => r.taskId);

    const quickFilterCondition = quickFilter === 'assigned'
      ? await getAssignedFilterCondition()
      : quickFilter === 'inbox'
        ? await getInboxFilterCondition()
        : getQuickFilterCondition(quickFilter, today, weekFromNow, myDayTaskIds);
    const taskWhere = withCondition(baseWhere, quickFilterCondition);

    // Determine the group expression
    let groupExpr: ReturnType<typeof sql>;
    const todayStr = getLocalToday();

    switch (groupBy) {
      case 'status':
        groupExpr = sql`CASE
          WHEN ${tasks.status} = 'done' THEN 'Completed'
          WHEN ${tasks.status} = 'cancelled' THEN 'Cancelled'
          WHEN ${tasks.status} = 'in_progress' THEN 'In Progress'
          ELSE 'To Do'
        END`;
        break;
      case 'priority':
        groupExpr = sql`COALESCE(${tasks.priority}, 'none')`;
        break;
      case 'list':
        groupExpr = sql`COALESCE(${tasks.sourceListName}, 'No List')`;
        break;
      case 'dueDate':
        groupExpr = sql`CASE
          WHEN ${tasks.dueDate} IS NULL THEN 'No Due Date'
          WHEN ${tasks.dueDate} < ${todayStr} THEN 'Overdue'
          WHEN ${tasks.dueDate} = ${todayStr} THEN 'Today'
          ELSE ${tasks.dueDate}
        END`;
        break;
      case 'tag': {
        // Tags are many-to-many — a task can appear in multiple tag groups.
        // We query tagged tasks via JOIN, then untagged separately.
        const taggedResult = await db
          .select({
            group: sql<string>`${tags.name}`.as('group_key'),
            count: count().as('count'),
          })
          .from(tasks)
          .innerJoin(taskTags, eq(taskTags.taskId, tasks.id))
          .innerJoin(tags, eq(tags.id, taskTags.tagId))
          .where(taskWhere)
          .groupBy(tags.name);

        const untaggedResult = await db
          .select({ count: count().as('count') })
          .from(tasks)
          .where(and(
            taskWhere,
            sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`
          ));

        const counts: Record<string, number> = {};
        for (const row of taggedResult) {
          counts[row.group as string] = Number(row.count);
        }
        const untaggedCount = Number(untaggedResult[0]?.count ?? 0);
        if (untaggedCount > 0) counts['Untagged'] = untaggedCount;

        return NextResponse.json({ counts });
      }
      case 'project': {
        // Project+Phase is many-to-many — tasks can appear in multiple project groups.
        // Query tasks in projects via JOIN, then unprojecte tasks separately.
        const projectResult = await db
          .select({
            taskId: taskProjects.taskId,
            projectId: taskProjects.projectId,
            projectName: hubProjects.name,
          })
          .from(tasks)
          .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
          .innerJoin(hubProjects, eq(hubProjects.id, taskProjects.projectId))
          .where(taskWhere);

        // Get phase assignments for these tasks
        const taskIdsInProjects = [...new Set(projectResult.map(r => r.taskId))];
        const phaseAssignments = taskIdsInProjects.length > 0
          ? await db
              .select({
                taskId: projectPhaseItems.taskId,
                phaseId: projectPhaseItems.phaseId,
                phaseName: projectPhases.name,
                projectId: projectPhases.projectId,
              })
              .from(projectPhaseItems)
              .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
              .where(inArray(projectPhaseItems.taskId, taskIdsInProjects))
          : [];

        // Build phase lookup: taskId+projectId → array of phase names
        // A task can be in multiple phases of the same project
        const phaseLookup = new Map<string, string[]>();
        for (const pa of phaseAssignments) {
          if (pa.projectId) {
            const key = `${pa.taskId}:${pa.projectId}`;
            if (!phaseLookup.has(key)) phaseLookup.set(key, []);
            phaseLookup.get(key)!.push(pa.phaseName);
          }
        }

        const counts: Record<string, number> = {};
        for (const row of projectResult) {
          const phaseNames = phaseLookup.get(`${row.taskId}:${row.projectId}`);
          if (phaseNames && phaseNames.length > 0) {
            for (const phaseName of phaseNames) {
              const groupKey = `${row.projectName} › ${phaseName}`;
              counts[groupKey] = (counts[groupKey] || 0) + 1;
            }
          } else {
            const groupKey = `${row.projectName} › Unphased`;
            counts[groupKey] = (counts[groupKey] || 0) + 1;
          }
        }

        // Count tasks with no project
        const unprojectResult = await db
          .select({ count: count().as('count') })
          .from(tasks)
          .where(and(
            taskWhere,
            sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`
          ));
        const unprojectCount = Number(unprojectResult[0]?.count ?? 0);
        if (unprojectCount > 0) counts['No Project'] = unprojectCount;

        return NextResponse.json({ counts });
      }
      default:
        return NextResponse.json({ counts: {} });
    }

    const result = await db
      .select({
        group: groupExpr.as('group_key'),
        count: count().as('count'),
      })
      .from(tasks)
      .where(taskWhere)
      .groupBy(sql`group_key`);

    const counts: Record<string, number> = {};
    for (const row of result) {
      counts[row.group as string] = Number(row.count);
    }

    return NextResponse.json({ counts });
  } catch (error) {
    console.error('Group counts error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
