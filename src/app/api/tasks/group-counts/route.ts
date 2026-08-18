import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, taskTags, tags, taskProjects, hubProjects, projectPhaseItems, projectPhases } from '@/db/schema';
import { eq, and, inArray, sql, count, countDistinct } from 'drizzle-orm';
import {
  TaskQueryValidationError,
  validateTaskQueryParams,
} from '../query-input';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import { getCanonicalTaskFilterWhere } from '../canonical-filter';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import { getTaskListGroupExpression } from '../grouping';

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

  if (!groupBy) {
    return NextResponse.json({ error: 'groupBy parameter required' }, { status: 400 });
  }

  try {
    const { taskWhere, today } = await getCanonicalTaskFilterWhere(searchParams);

    // Determine the group expression
    let groupExpr: ReturnType<typeof sql>;
    const todayStr = today;

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
        groupExpr = sql`COALESCE(NULLIF(${tasks.priority}, ''), 'none')`;
        break;
      case 'source':
        groupExpr = sql`COALESCE(NULLIF(${tasks.connectorType}, ''), 'local')`;
        break;
      case 'list':
        groupExpr = getTaskListGroupExpression();
        break;
      case 'effort':
        groupExpr = sql`CASE
          WHEN ${tasks.effort} IS NULL THEN ${NO_EFFORT_GROUP_LABEL}
          ELSE CAST(${tasks.effort} AS TEXT)
        END`;
        break;
      case 'dueDate':
        groupExpr = sql`CASE
          WHEN ${tasks.dueDate} IS NULL OR ${tasks.dueDate} = '' THEN 'No Due Date'
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
            count: countDistinct(tasks.id).as('count'),
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

        const taskIdsByGroup = new Map<string, Set<string>>();
        for (const row of projectResult) {
          const phaseNames = phaseLookup.get(`${row.taskId}:${row.projectId}`);
          if (phaseNames && phaseNames.length > 0) {
            for (const phaseName of phaseNames) {
              const groupKey = `${row.projectName} › ${phaseName}`;
              if (!taskIdsByGroup.has(groupKey)) taskIdsByGroup.set(groupKey, new Set());
              taskIdsByGroup.get(groupKey)!.add(row.taskId);
            }
          } else {
            const groupKey = `${row.projectName} › Unphased`;
            if (!taskIdsByGroup.has(groupKey)) taskIdsByGroup.set(groupKey, new Set());
            taskIdsByGroup.get(groupKey)!.add(row.taskId);
          }
        }
        const counts = Object.fromEntries(
          [...taskIdsByGroup].map(([groupKey, taskIds]) => [groupKey, taskIds.size]),
        );

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
        return NextResponse.json({ error: 'Unsupported groupBy value' }, { status: 400 });
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
