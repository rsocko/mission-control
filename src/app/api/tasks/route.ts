import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tasks, taskTags, taskProjects, tags, sourceLists, connectorConfigs, taskSchedules, sourceRankings, hubProjects, projectPhaseItems, projectPhases, taskLinkedSources, triageActionClaims, triageItems } from '@/db/schema';
import { eq, desc, asc, and, isNull, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { emitEvent } from '@/lib/events';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler, logWriteThrough } from '@/lib/sync';
import { CAPABILITY_DEFAULTS, getConnectorCapabilities } from '@/lib/connectors/capabilities';
import { ApiErrors } from '@/lib/api-error';
import { getResolvedPriorityEntities } from '@/lib/priority-entities';
import logger from '@/lib/logger';
import {
  computeBatchSmartScores,
  createScoreInput,
  type ScoredTask,
  type ScoreInputTask,
  type SourceRanking,
} from '@/lib/smart-score';
import { buildSourceListNameMap } from '@/lib/utils/resolve-task-list-names';
import { getLocalToday } from '@/lib/utils/date';
import { isDemoMode } from '@/lib/mode';
import type { TaskPriority } from '@/types';
import { isPlanningHorizon } from '@/lib/tasks/planning-horizon';
import type { ConnectorCapabilities } from '@/types';
import { resolveConnectorCapabilities } from '@/lib/connectors/task-source-profiles';
import { resolveTaskSourceModel } from '@/lib/tasks/field-policy';
import { claimTaskForPush, completeTaskPush, failTaskPush, heartbeatTaskPush } from '@/lib/sync/push-lease';
import { persistCreatedTaskIdentity } from '@/lib/connectors/transfer-identity';
import {
  releaseTriageTaskCreation,
  reserveTriageTaskCreation,
} from '@/lib/triage/actions';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';

import { createEmptyResponse, getTagIdsFilterCondition } from './filter-factory';
import { countTasks, getStats, getSourceCounts, getAvailableTags } from './stats-computer';
import { buildCanonicalTaskFilterConditions } from './canonical-filter';
import {
  requireTaskEditPolicy,
  resolveTaskEditPolicies,
  type ConnectorEditPolicyContext,
} from '@/lib/tasks/edit-policy';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { evaluateRulesForTasks } from '@/lib/rules';
import {
  MAX_TASK_PAGE_SIZE,
  SMART_SCORE_CANDIDATE_LIMIT,
  parseTaskPagination,
} from './pagination';
import {
  containsLiteral,
  normalizedCsv,
  TaskQueryValidationError,
  validateTaskQueryParams,
} from './query-input';
import { getTaskStatusGroupFilter } from '@/lib/tasks/task-status-groups';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import { getTaskListGroupExpression } from './grouping';

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'];

function isTaskPriority(value: unknown): value is TaskPriority {
  return VALID_PRIORITIES.includes(String(value));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pagination = parseTaskPagination(searchParams);
  if (!pagination.ok) {
    logger.warn({
      event: 'task_pagination_rejected',
      limit: searchParams.get('limit'),
      offset: searchParams.get('offset'),
      reason: pagination.message,
    }, 'Rejected invalid task pagination');
    return ApiErrors.badRequest(pagination.message);
  }
  try {
    validateTaskQueryParams(searchParams);
  } catch (error) {
    if (error instanceof TaskQueryValidationError) {
      logger.warn({ queryKeys: [...searchParams.keys()] }, 'Rejected over-budget task query');
      return ApiErrors.validation(error.message);
    }
    throw error;
  }

  const noProject = searchParams.get('noProject') === 'true';
  const tagIds = normalizedCsv(searchParams, 'tagIds');
  const sortBy = searchParams.get('sortBy') || 'priority';
  const sortDirection = searchParams.get('sortDirection') || 'asc';
  const { limit, offset } = pagination;
  const includeTags = searchParams.get('includeTags') !== 'false';
  const countsOnly = searchParams.get('countsOnly') === 'true';
  const includeScoreBreakdown = searchParams.get('includeScoreBreakdown') === 'true';
  const search = searchParams.get('search')?.trim();
  const groupBy = searchParams.get('groupBy');
  const groupValue = searchParams.get('groupValue');
  const emptyResponse = () => ({
    ...createEmptyResponse(),
    pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
  });
  if (sortBy === 'smartScore' && offset >= SMART_SCORE_CANDIDATE_LIMIT) {
    logger.warn({
      event: 'smart_score_budget_rejected',
      offset,
      candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
    }, 'Rejected smart-score offset outside candidate budget');
    return ApiErrors.badRequest(
      `offset must be less than ${SMART_SCORE_CANDIDATE_LIMIT} for smart-score sorting`,
    );
  }

  try {
    const {
      conditions,
      myDayTaskIds,
      openOnly,
      quickFilterCondition,
      today,
      weekFromNow,
    } = await buildCanonicalTaskFilterConditions(searchParams);
    const effort = searchParams.get('effort');
    if (effort) conditions.push(eq(tasks.effort, parseInt(effort, 10)));
    // Text search: match title, sourceId, assignee, sourceListName, metadata, or tag names
    if (search) {
      // Strip leading '#' for numeric issue searches
      const stripped = search.startsWith('#') ? search.slice(1) : null;
      const searchConditions = [
        containsLiteral(tasks.title, search),
        containsLiteral(tasks.sourceId, search),
        containsLiteral(tasks.assignee, search),
        containsLiteral(tasks.sourceListName, search),
        containsLiteral(tasks.metadata, search),
      ];
      if (stripped && /^\d+$/.test(stripped)) {
        // Match sourceId ending with ":NUMBER" (GitHub issue format "repo:123")
        searchConditions.push(like(tasks.sourceId, `%:${stripped}`));
        // Match metadata containing the issue number
        searchConditions.push(like(tasks.metadata, `%"issueNumber":${stripped}%`));
        searchConditions.push(like(tasks.metadata, `%"issueNumber": ${stripped}%`));
      }
      // Also match tasks that have a tag whose name or slug matches
      const tagMatchIds = db
        .select({ taskId: taskTags.taskId })
        .from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(or(containsLiteral(tags.name, search), containsLiteral(tags.slug, search)));
      searchConditions.push(inArray(tasks.id, tagMatchIds));
      conditions.push(or(...searchConditions)!);
    }

    if (tagIds.length > 0) {
      conditions.push(getTagIdsFilterCondition(tagIds));
    }

    if (noProject) {
      conditions.push(
        sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`
      );
    }

    // Group-scoped filtering: restrict results to a specific group value
    if (groupBy && groupValue) {
      const todayStr = getLocalToday();
      switch (groupBy) {
        case 'status': {
          const statusFilter = getTaskStatusGroupFilter(groupValue);
          if (statusFilter?.mode === 'include') {
            conditions.push(inArray(tasks.status, statusFilter.statuses));
          } else if (statusFilter?.mode === 'exclude') {
            conditions.push(notInArray(tasks.status, statusFilter.statuses));
          }
          break;
        }
        case 'priority':
          conditions.push(groupValue === 'none'
            ? sql`(${tasks.priority} IS NULL OR ${tasks.priority} = '' OR ${tasks.priority} = 'none')`
            : eq(tasks.priority, groupValue));
          break;
        case 'planningHorizon': {
          const horizonByLabel: Record<string, 'next' | 'soon' | 'later' | 'someday'> = {
            Next: 'next',
            Soon: 'soon',
            Later: 'later',
            Someday: 'someday',
          };
          conditions.push(groupValue === 'Not set'
            ? isNull(tasks.planningHorizon)
            : horizonByLabel[groupValue]
              ? eq(tasks.planningHorizon, horizonByLabel[groupValue])
              : sql`1 = 0`);
          break;
        }
        case 'source':
          conditions.push(groupValue === 'local'
            ? sql`(${tasks.connectorType} IS NULL OR ${tasks.connectorType} = '' OR ${tasks.connectorType} = 'local')`
            : eq(tasks.connectorType, groupValue));
          break;
        case 'list':
          conditions.push(sql`${getTaskListGroupExpression()} = ${groupValue}`);
          break;
        case 'effort': {
          if (groupValue === NO_EFFORT_GROUP_LABEL) {
            conditions.push(isNull(tasks.effort));
            break;
          }
          const effort = Number(groupValue);
          if (!Number.isInteger(effort)) return NextResponse.json(emptyResponse());
          conditions.push(eq(tasks.effort, effort));
          break;
        }
        case 'dueDate':
          if (groupValue === 'No Due Date') {
            conditions.push(sql`(${tasks.dueDate} IS NULL OR ${tasks.dueDate} = '')`);
          } else if (groupValue === 'Overdue') {
            conditions.push(sql`${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} <> '' AND ${tasks.dueDate} < ${todayStr}`);
          } else if (groupValue === 'Today') {
            conditions.push(eq(tasks.dueDate, todayStr));
          } else {
            conditions.push(eq(tasks.dueDate, groupValue));
          }
          break;
        case 'tag':
          if (groupValue === 'Untagged') {
            conditions.push(
              sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`
            );
          } else {
            const tagTaskIds = db
              .select({ taskId: taskTags.taskId })
              .from(taskTags)
              .innerJoin(tags, eq(taskTags.tagId, tags.id))
              .where(eq(tags.name, groupValue));
            conditions.push(inArray(tasks.id, tagTaskIds));
          }
          break;
        case 'project': {
          if (groupValue === 'No Project') {
            conditions.push(
              sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`
            );
          } else {
            // groupValue is "Project Name › Phase Name" or "Project Name › Unphased"
            // Use lastIndexOf to handle project names containing ' › '
            const separatorIdx = groupValue.lastIndexOf(' › ');
            if (separatorIdx >= 0) {
              const projectName = groupValue.substring(0, separatorIdx);
              const phasePart = groupValue.substring(separatorIdx + 3);
              const projectTaskIds = db
                .select({ taskId: taskProjects.taskId })
                .from(taskProjects)
                .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
                .where(eq(hubProjects.name, projectName));

              if (phasePart === 'Unphased') {
                const phasedTaskIds = db
                  .select({ taskId: projectPhaseItems.taskId })
                  .from(projectPhaseItems)
                  .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
                  .innerJoin(hubProjects, eq(projectPhases.projectId, hubProjects.id))
                  .where(eq(hubProjects.name, projectName));
                conditions.push(
                  inArray(tasks.id, projectTaskIds),
                  notInArray(tasks.id, phasedTaskIds),
                );
              } else {
                const phaseTaskIds = db
                  .select({ taskId: projectPhaseItems.taskId })
                  .from(projectPhaseItems)
                  .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
                  .innerJoin(hubProjects, eq(projectPhases.projectId, hubProjects.id))
                  .innerJoin(taskProjects, and(
                    eq(taskProjects.taskId, projectPhaseItems.taskId),
                    eq(taskProjects.projectId, projectPhases.projectId),
                  ))
                  .where(and(
                    eq(hubProjects.name, projectName),
                    eq(projectPhases.name, phasePart),
                  ));
                conditions.push(inArray(tasks.id, phaseTaskIds));
              }
            } else {
                // No separator found — invalid group key, return empty
                return NextResponse.json(emptyResponse());
            }
          }
          break;
        }
      }
    }

    const dir = sortDirection === 'desc' ? desc : asc;
    const priorityOrder = sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
    const effortOrder = sql`COALESCE(${tasks.effort}, 0)`;
    const planningHorizonOrder = sql`CASE ${tasks.planningHorizon}
      WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2
      WHEN 'someday' THEN 3 ELSE 4 END`;

    const orderBy = sortBy === 'smartScore'
      ? asc(tasks.id)
      : sortBy === 'planningHorizon'
        ? dir(planningHorizonOrder)
      : sortBy === 'dueDate'
        ? dir(tasks.dueDate)
        : sortBy === 'createdAt'
          ? dir(tasks.createdAt)
          : sortBy === 'completedAt'
            ? dir(tasks.completedAt)
          : sortBy === 'updated'
            ? dir(tasks.updatedAt)
            : sortBy === 'title'
              ? dir(tasks.title)
              : sortBy === 'sourceList'
                ? dir(tasks.sourceListName)
                : sortBy === 'effort'
                  ? dir(effortOrder)
                  : dir(priorityOrder);

    const baseWhere = conditions.length > 0 ? and(...conditions) : undefined;
    const taskWhere = quickFilterCondition
      ? and(baseWhere, quickFilterCondition)
      : baseWhere;

    // Fast path: return only source counts without processing tasks
    if (countsOnly) {
      const [stats, sourceCounts, total] = await Promise.all([
        getStats(baseWhere, openOnly, today, weekFromNow, myDayTaskIds),
        getSourceCounts(baseWhere),
        countTasks(taskWhere),
      ]);
      return NextResponse.json({
        tasks: [],
        total,
        stats,
        hasMore: false,
        sourceCounts,
        availableTags: [],
        pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
      });
    }

    // Smart Score sorting
    let smartScoreOrderedIds: string[] | null = null;
    const smartScoreMap = new Map<string, ScoredTask>();
    if (sortBy === 'smartScore') {
      const entities = getResolvedPriorityEntities();
      const rankings = db.select().from(sourceRankings).orderBy(asc(sourceRankings.rank)).all() as unknown as SourceRanking[];

      const candidateTasks = db.select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        priority: tasks.priority,
        planningHorizon: tasks.planningHorizon,
        effort: tasks.effort,
        dueDate: tasks.dueDate,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        connectorType: tasks.connectorType,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceListId: tasks.sourceListId,
        sourceListName: tasks.sourceListName,
        assignee: tasks.assignee,
        snoozedUntil: tasks.snoozedUntil,
      })
        .from(tasks)
        .where(taskWhere)
        .orderBy(
          priorityOrder,
          sql`CASE WHEN ${tasks.dueDate} IS NULL THEN 1 ELSE 0 END`,
          asc(tasks.dueDate),
          desc(tasks.updatedAt),
          asc(tasks.id),
        )
        .limit(SMART_SCORE_CANDIDATE_LIMIT)
        .all();

      const candidateIds = candidateTasks.map((task) => task.id);
      const linkedTagRows = candidateIds.length === 0
        ? []
        : db.select({
            taskId: taskTags.taskId,
            id: tags.id,
            unifiedInto: tags.unifiedInto,
            name: tags.name,
          })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(inArray(taskTags.taskId, candidateIds))
          .all();
      const linkedProjectRows = candidateIds.length === 0
        ? []
        : db.select({ taskId: taskProjects.taskId, id: hubProjects.id, name: hubProjects.name })
          .from(taskProjects)
          .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
          .where(inArray(taskProjects.taskId, candidateIds))
          .all();
      const candidateScheduleRows = candidateIds.length === 0
        ? []
        : db.select({
            taskId: taskSchedules.taskId,
            estimatedDuration: taskSchedules.estimatedDuration,
          })
          .from(taskSchedules)
          .where(inArray(taskSchedules.taskId, candidateIds))
          .all();
      const linkedTagsByTask = new Map<string, Array<{ id: string; name: string }>>();
      const linkedProjectsByTask = new Map<string, Array<{ id: string; name: string }>>();
      const durationByCandidate = new Map(
        candidateScheduleRows.map((row) => [row.taskId, row.estimatedDuration]),
      );
      for (const row of linkedTagRows) {
        if (!linkedTagsByTask.has(row.taskId)) linkedTagsByTask.set(row.taskId, []);
        linkedTagsByTask.get(row.taskId)!.push({ id: row.unifiedInto || row.id, name: row.name });
      }
      for (const row of linkedProjectRows) {
        if (!linkedProjectsByTask.has(row.taskId)) linkedProjectsByTask.set(row.taskId, []);
        linkedProjectsByTask.get(row.taskId)!.push({ id: row.id, name: row.name });
      }
      const scoreInputs = candidateTasks.map((task) => createScoreInput(
        {
          ...task,
          priority: task.priority as ScoreInputTask['priority'],
          estimatedDuration: durationByCandidate.get(task.id),
        },
        linkedTagsByTask.get(task.id),
        linkedProjectsByTask.get(task.id),
      ));

      const scored = computeBatchSmartScores(scoreInputs, entities, rankings);
      const scoresForResponse = scored.slice(offset, offset + limit);
      smartScoreOrderedIds = scoresForResponse.map((s) => s.taskId);
      for (const s of scoresForResponse) {
        smartScoreMap.set(s.taskId, s);
      }
    }

    const [stats, sourceCounts, availableTags, total, result] = await Promise.all([
      getStats(baseWhere, openOnly, today, weekFromNow, myDayTaskIds),
      getSourceCounts(baseWhere),
      getAvailableTags(baseWhere),
      countTasks(taskWhere),
      (async () => {
        if (smartScoreOrderedIds && smartScoreOrderedIds.length > 0) {
          const rows = db.select().from(tasks).where(inArray(tasks.id, smartScoreOrderedIds)).all();
          const byId = new Map(rows.map((r) => [r.id, r]));
          return smartScoreOrderedIds.map((id) => byId.get(id)).filter(Boolean) as typeof rows;
        }
        if (smartScoreOrderedIds && smartScoreOrderedIds.length === 0) {
          return [];
        }

        return db
          .select()
          .from(tasks)
          .where(taskWhere)
          .orderBy(orderBy, asc(tasks.id))
          .limit(limit)
          .offset(offset);
      })(),
    ]);

    if (result.length === 0) {
      const smartScoreBudgetReached = sortBy === 'smartScore'
        && total > SMART_SCORE_CANDIDATE_LIMIT;
      if (smartScoreBudgetReached) {
        logger.warn({
          event: 'smart_score_budget_reached',
          total,
          candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
        }, 'Smart-score candidate budget reached');
      }
      return NextResponse.json({
        tasks: [],
        total,
        stats,
        hasMore: false,
        sourceCounts,
        availableTags,
        pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
        ...(sortBy === 'smartScore' ? {
          smartScoreBudget: {
            candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
            reached: smartScoreBudgetReached,
          },
        } : {}),
      });
    }

    const taskIdsForPage = result.map((task) => task.id);

    // Resolve authoritative display names from source_lists (userDisplayName takes priority)
    // This prevents stale denormalized sourceListName from showing after renames.
    const sourceListNameMap = buildSourceListNameMap(result);

    // Fetch related data in parallel
    const connectorInstanceIds = [...new Set(
      result
        .map((task) => task.connectorInstanceId)
        .filter((id) => id && id !== 'local'),
    )];
    const [scheduleRows, allTaskProjects, subtaskCountRows, tagsByTaskResult, phaseItemRows, linkedSourceCountRows, connectorConfigRows] = await Promise.all([
      db.select({ taskId: taskSchedules.taskId, estimatedDuration: taskSchedules.estimatedDuration })
        .from(taskSchedules)
        .where(inArray(taskSchedules.taskId, taskIdsForPage)),
      db.select({ taskId: taskProjects.taskId, projectId: taskProjects.projectId })
        .from(taskProjects)
        .where(inArray(taskProjects.taskId, taskIdsForPage)),
      db.select({
        parentId: tasks.parentId,
        total: sql<number>`COUNT(*)`.as('total'),
        done: sql<number>`SUM(CASE WHEN ${tasks.status} = 'done' THEN 1 ELSE 0 END)`.as('done'),
      })
        .from(tasks)
        .where(inArray(tasks.parentId, taskIdsForPage))
        .groupBy(tasks.parentId),
      includeTags || includeScoreBreakdown
        ? db.select({
            taskId: taskTags.taskId,
            tagId: tags.id,
            tagName: tags.name,
            tagSlug: tags.slug,
            tagType: tags.type,
            tagSource: tags.source,
            tagColor: tags.color,
            tagConfirmed: tags.confirmed,
            tagUnifiedInto: tags.unifiedInto,
          })
            .from(taskTags)
            .innerJoin(tags, eq(taskTags.tagId, tags.id))
            .where(inArray(taskTags.taskId, taskIdsForPage))
        : Promise.resolve([]),
      // Fetch project-phase memberships for each task
      db.select({
        taskId: projectPhaseItems.taskId,
        phaseId: projectPhaseItems.phaseId,
        phaseName: projectPhases.name,
        projectId: projectPhases.projectId,
      })
        .from(projectPhaseItems)
        .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
        .where(inArray(projectPhaseItems.taskId, taskIdsForPage)),
      // Fetch linked source counts per task
      db.select({
        taskId: taskLinkedSources.taskId,
        count: sql<number>`COUNT(*)`.as('count'),
      })
        .from(taskLinkedSources)
        .where(inArray(taskLinkedSources.taskId, taskIdsForPage))
        .groupBy(taskLinkedSources.taskId),
      connectorInstanceIds.length > 0
        ? db.select({
            id: connectorConfigs.id,
            type: connectorConfigs.type,
            enabled: connectorConfigs.enabled,
            deletedAt: connectorConfigs.deletedAt,
            capabilities: connectorConfigs.capabilities,
            settings: connectorConfigs.settings,
          })
            .from(connectorConfigs)
           .where(inArray(connectorConfigs.id, connectorInstanceIds))
        : Promise.resolve([]),
    ]);
    const connectorEditPolicyContexts = new Map<string, ConnectorEditPolicyContext>(
      connectorConfigRows.map((config) => {
        const stored = config.capabilities as ConnectorCapabilities;
        const defaults = CAPABILITY_DEFAULTS[config.type] ?? {};
        return [
          config.id,
          {
            capabilities: resolveConnectorCapabilities(
              config.type,
              { ...defaults, ...stored } as ConnectorCapabilities,
              config.settings as Record<string, unknown>,
            ),
            connectorEnabled: !config.deletedAt && config.enabled,
          },
        ] as const;
      }),
    );
    for (const connectorInstanceId of connectorInstanceIds) {
      if (!connectorEditPolicyContexts.has(connectorInstanceId)) {
        connectorEditPolicyContexts.set(connectorInstanceId, {
          capabilities: null,
          connectorEnabled: false,
        });
      }
    }

    const linkedSourceCountByTask = new Map<string, number>();
    for (const row of linkedSourceCountRows) {
      linkedSourceCountByTask.set(row.taskId, row.count);
    }

    const durationByTask = new Map<string, number | null>();
    for (const row of scheduleRows) {
      durationByTask.set(row.taskId, row.estimatedDuration);
    }

    const projectIdsByTask = new Map<string, string[]>();
    for (const row of allTaskProjects) {
      if (!projectIdsByTask.has(row.taskId)) projectIdsByTask.set(row.taskId, []);
      projectIdsByTask.get(row.taskId)!.push(row.projectId);
    }

    // Build project-phase membership data for grouping
    // Collect all project IDs referenced by page tasks and fetch their names
    const allProjectIds = new Set<string>();
    for (const row of allTaskProjects) allProjectIds.add(row.projectId);
    const projectNameMap = new Map<string, string>();
    if (allProjectIds.size > 0) {
      const projectRows = await db.select({ id: hubProjects.id, name: hubProjects.name })
        .from(hubProjects).where(inArray(hubProjects.id, Array.from(allProjectIds)));
      for (const row of projectRows) projectNameMap.set(row.id, row.name);
    }

    // Build phase membership: taskId+projectId → phase details
    const phaseByTaskProject = new Map<string, Map<string, Array<{ id: string; name: string }>>>();
    for (const row of phaseItemRows) {
      const key = row.taskId;
      if (!phaseByTaskProject.has(key)) phaseByTaskProject.set(key, new Map());
      if (row.projectId) {
        const projMap = phaseByTaskProject.get(key)!;
        if (!projMap.has(row.projectId)) projMap.set(row.projectId, []);
        projMap.get(row.projectId)!.push({ id: row.phaseId, name: row.phaseName });
      }
    }

    // Build projectPhaseMemberships for each task
    // One entry per project+phase combination (a task in 2 phases of 1 project → 2 entries)
    const projectPhaseMembershipsByTask = new Map<string, Array<{ projectId: string; projectName: string; phaseId: string | null; phaseName: string | null }>>();
    for (const [taskId, projIds] of projectIdsByTask) {
      const memberships: Array<{ projectId: string; projectName: string; phaseId: string | null; phaseName: string | null }> = [];
      for (const projId of projIds) {
        const projectName = projectNameMap.get(projId) || 'Unknown Project';
        const phaseNames = phaseByTaskProject.get(taskId)?.get(projId);
        if (phaseNames && phaseNames.length > 0) {
          for (const phase of phaseNames) {
            memberships.push({ projectId: projId, projectName, phaseId: phase.id, phaseName: phase.name });
          }
        } else {
          memberships.push({ projectId: projId, projectName, phaseId: null, phaseName: null });
        }
      }
      projectPhaseMembershipsByTask.set(taskId, memberships);
    }

    const subtaskCounts = new Map<string, { total: number; done: number }>();
    for (const row of subtaskCountRows) {
      if (row.parentId) {
        subtaskCounts.set(row.parentId, { total: row.total, done: row.done });
      }
    }

    const tagsByTask = new Map<string, typeof tagsByTaskResult[number][]>();
    for (const taskTag of tagsByTaskResult) {
      if (!tagsByTask.has(taskTag.taskId)) tagsByTask.set(taskTag.taskId, []);
      tagsByTask.get(taskTag.taskId)!.push(taskTag);
    }

    if (includeScoreBreakdown && sortBy !== 'smartScore') {
      const entities = getResolvedPriorityEntities();
      const rankings = db.select().from(sourceRankings).orderBy(asc(sourceRankings.rank)).all() as unknown as SourceRanking[];
      const scoreInputs = result.map((task) => createScoreInput(
        {
          ...task,
          priority: task.priority as ScoreInputTask['priority'],
          estimatedDuration: durationByTask.get(task.id),
        },
        (tagsByTask.get(task.id) || []).map((taskTag) => ({
          id: taskTag.tagUnifiedInto || taskTag.tagId,
          name: taskTag.tagName,
        })),
        (projectIdsByTask.get(task.id) || [])
          .map((projectId) => {
            const name = projectNameMap.get(projectId);
            return name ? { id: projectId, name } : null;
          })
          .filter((project): project is { id: string; name: string } => project !== null),
      ));
      for (const scored of computeBatchSmartScores(scoreInputs, entities, rankings)) {
        smartScoreMap.set(scored.taskId, scored);
      }
    }

    const editPolicies = await resolveTaskEditPolicies(
      result,
      connectorEditPolicyContexts,
    );

    const smartScoreBudgetReached = sortBy === 'smartScore'
      && total > SMART_SCORE_CANDIDATE_LIMIT;
    if (smartScoreBudgetReached) {
      logger.warn({
        event: 'smart_score_budget_reached',
        total,
        candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
      }, 'Smart-score candidate budget reached');
    }

    return NextResponse.json({
      tasks: result.map((task) => {
        const scored = smartScoreMap.get(task.id);
        const { description, ...taskWithoutDescription } = task;
        const resolvedListName = task.sourceListId
          ? sourceListNameMap.get(`${task.connectorInstanceId}:${task.sourceListId}`)
          : undefined;
        const connectorContext = connectorEditPolicyContexts.get(task.connectorInstanceId);
        const capabilities = connectorContext?.capabilities ?? null;
        const taskSourceModel = resolveTaskSourceModel({
          sourceId: task.sourceId,
          connectorType: task.connectorType,
          connectorEnabled: connectorContext?.connectorEnabled ?? true,
          forceLocal: isDemoMode(),
        }, capabilities);
        return {
          ...taskWithoutDescription,
          hasDescription: Boolean(description?.trim()),
          sourceListName: resolvedListName || task.sourceListName,
          taskSourceModel,
          estimatedDuration: durationByTask.get(task.id) || null,
          subtaskTotal: subtaskCounts.get(task.id)?.total || 0,
          subtaskDone: subtaskCounts.get(task.id)?.done || 0,
          hubProjectIds: projectIdsByTask.get(task.id) || [],
          projectPhaseMemberships: projectPhaseMembershipsByTask.get(task.id) || [],
          linkedSourceCount: linkedSourceCountByTask.get(task.id) || 0,
          editPolicy: requireTaskEditPolicy(editPolicies, task.id),
          ...(scored ? { smartScore: Number.isFinite(scored.score.total) ? scored.score.total : 0, scoreBreakdown: scored.score } : {}),
          ...(includeTags
            ? {
                tags: (tagsByTask.get(task.id) || []).map((taskTag) => ({
                  id: taskTag.tagId,
                  name: taskTag.tagName,
                  slug: taskTag.tagSlug,
                  type: taskTag.tagType,
                  source: taskTag.tagSource,
                  color: taskTag.tagColor,
                  confirmed: taskTag.tagConfirmed,
                })),
              }
            : {}),
        };
      }),
      total,
      stats,
      hasMore: offset + result.length < (
        sortBy === 'smartScore'
          ? Math.min(total, SMART_SCORE_CANDIDATE_LIMIT)
          : total
      ),
      sourceCounts,
      availableTags,
      pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
      ...(sortBy === 'smartScore' ? {
        smartScoreBudget: {
          candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
          reached: smartScoreBudgetReached,
        },
      } : {}),
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch tasks', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, description, priority, planningHorizon, dueDate, connectorType, sourceListId, sourceListName, tags: tagIdsList, tagSlugs, projectIds, recurrence, estimatedDuration, effort } = body;
    const recurrenceMode = body.recurrenceMode === 'completion' ? 'completion' : 'schedule';
    const requestedConnectorInstanceId = typeof body.connectorInstanceId === 'string'
      && body.connectorInstanceId.trim()
      ? body.connectorInstanceId.trim()
      : null;
    const triageItemId = typeof body.triageItemId === 'string' && body.triageItemId
      ? body.triageItemId
      : null;
    if (typeof title !== 'string' || !title.trim()) {
      return ApiErrors.badRequest('title is required');
    }
    const resolvedPriority: TaskPriority = isTaskPriority(priority) ? priority : 'none';
    if (planningHorizon !== undefined && planningHorizon !== null && !isPlanningHorizon(planningHorizon)) {
      return ApiErrors.badRequest('planningHorizon must be now, next, later, someday, or null');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const metadata: Record<string, unknown> = {};
    if (recurrence) {
      metadata.recurrence = recurrence;
    }
    if (triageItemId) {
      metadata.triageItemId = triageItemId;
    }
    metadata.missionControlTaskId = id;

    const isRemote = typeof connectorType === 'string' && connectorType !== 'local';
    if (recurrenceMode === 'completion' && !recurrence) {
      return ApiErrors.badRequest(
        'Choose a recurrence interval before anchoring it to completion',
      );
    }
    if (recurrenceMode === 'completion' && isRemote) {
      return ApiErrors.badRequest('Completion-anchored recurrence is available only for local tasks');
    }
    let connectorInstanceId = isRemote
      ? requestedConnectorInstanceId ?? 'local'
      : 'local';
    let requestedSourceList: {
      id: string;
      sourceId: string;
      connectorInstanceId: string;
    } | null = null;
    const shouldWriteThrough = Boolean(isRemote) && !isDemoMode();

    if (isRemote && sourceListId) {
      const matchingLists = await db.select({
        id: sourceLists.id,
        sourceId: sourceLists.sourceId,
        connectorInstanceId: sourceLists.connectorInstanceId,
      })
        .from(sourceLists)
        .where(and(
          eq(sourceLists.sourceId, sourceListId),
          ...(requestedConnectorInstanceId
            ? [eq(sourceLists.connectorInstanceId, requestedConnectorInstanceId)]
            : []),
        ))
        .limit(2);
      if (matchingLists.length === 0) {
        return ApiErrors.badRequest('sourceListId does not belong to the selected connector');
      }
      if (!requestedConnectorInstanceId && matchingLists.length > 1) {
        return ApiErrors.badRequest('connectorInstanceId is required for an ambiguous sourceListId');
      }
      requestedSourceList = matchingLists[0];
      connectorInstanceId = matchingLists[0].connectorInstanceId;
    }

    if (isRemote && connectorInstanceId === 'local') {
      const matchingConnectors = await db.select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(and(
          eq(connectorConfigs.type, connectorType),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ))
        .limit(2);
      if (matchingConnectors.length > 1) {
        return ApiErrors.badRequest('connectorInstanceId is required when multiple connector instances are available');
      }
      if (matchingConnectors[0]) {
        connectorInstanceId = matchingConnectors[0].id;
      } else {
        return ApiErrors.badRequest(`No enabled ${connectorType} connector is available`);
      }
    }

    if (isRemote && connectorInstanceId !== 'local') {
      const [selectedConnector] = await db.select({
        enabled: connectorConfigs.enabled,
        type: connectorConfigs.type,
        settings: connectorConfigs.settings,
        syncedLists: connectorConfigs.syncedLists,
      })
        .from(connectorConfigs)
        .where(and(
          eq(connectorConfigs.id, connectorInstanceId),
          isNull(connectorConfigs.deletedAt),
        ));
      if (!selectedConnector || selectedConnector.type !== connectorType) {
        return ApiErrors.badRequest('connectorInstanceId does not match connectorType');
      }
      if (!selectedConnector.enabled) {
        return ApiErrors.forbidden('Connector is disabled');
      }
      if (requestedSourceList && !isSourceListSelected(selectedConnector, requestedSourceList)) {
        return ApiErrors.badRequest('sourceListId is not selected for sync');
      }
      const caps = await getConnectorCapabilities(connectorInstanceId);
      if (
        caps
        && (
          caps.notificationOnly
          || !(caps.taskCreate ?? caps.write)
        )
      ) {
        return ApiErrors.forbidden('Task creation is disabled for this connector');
      }
      // Reject task creation when the connector requires a list but none was provided
      if (caps && caps.listSelectionMode === 'required' && !sourceListId) {
        return ApiErrors.badRequest(`sourceListId is required for ${connectorType} connector`);
      }
    }

    const syncStatus = shouldWriteThrough ? 'pending_push' : 'synced';

    // Resolve tagSlugs to tag IDs (respecting tagCreationMode)
    const resolvedSlugIds: string[] = [];
    let taskTagCreationMode: 'freeform' | 'predefined' = 'freeform';
    if (isRemote && connectorInstanceId !== 'local') {
      const caps = await getConnectorCapabilities(connectorInstanceId);
      if (caps?.tagCreationMode === 'predefined') {
        taskTagCreationMode = 'predefined';
      }
    }

    if (tagSlugs?.length) {
      for (const raw of tagSlugs as string[]) {
        const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug) continue;

        if (taskTagCreationMode === 'predefined') {
          // Only accept tags that already exist in the DB
          const [existing] = await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, slug)).limit(1);
          if (existing) {
            resolvedSlugIds.push(existing.id);
          }
          // Skip unknown tags silently — they aren't valid for predefined sources
        } else {
          const tagId = `tag-${slug}`;
          await db.insert(tags).values({
            id: tagId,
            name: raw,
            slug,
            type: 'hub',
            source: null,
            color: '#6b7280',
            confirmed: true,
            createdAt: now,
          }).onConflictDoNothing();
          resolvedSlugIds.push(tagId);
        }
      }
    }

    const allTagIds = [...(tagIdsList || []), ...resolvedSlugIds];
    let triageClaimId: string | null = null;
    if (triageItemId) {
      const reservation = await reserveTriageTaskCreation(triageItemId);
      if (!reservation) {
        return ApiErrors.badRequest('Triage item not found');
      }

      if (reservation.kind === 'completed') {
        const existingTaskId = reservation.record?.metadata?.mcTaskId;
        if (typeof existingTaskId === 'string') {
          return NextResponse.json({ id: existingTaskId }, { status: 200 });
        }
        return ApiErrors.conflict('A task has already been created from this triage item');
      }

      if (reservation.kind === 'pending') {
        return ApiErrors.conflict('Task creation for this triage item is still in progress');
      }

      triageClaimId = reservation.claimId;
    }

    const triageRecord = triageItemId && triageClaimId ? {
      actionType: 'create_task_todo' as const,
      appliedAt: now,
      note: 'Created task from triage',
      metadata: {
        mcTaskId: id,
        connectorType: connectorType || 'local',
        sourceListId,
      },
    } : null;

    try {
      runTransaction((tx) => {
        tx.insert(tasks).values({
          id,
          sourceId: triageItemId ? `local:triage:${triageItemId}` : `local:${id}`,
          connectorType: connectorType || 'local',
          connectorInstanceId,
          title,
          description,
          status: 'todo',
          priority: resolvedPriority,
          planningHorizon: planningHorizon ?? null,
          dueDate,
          createdAt: now,
          updatedAt: now,
          depth: 0,
          isChecklistItem: false,
          sourceListId,
          sourceListName: sourceListName || null,
          syncStatus,
          lastSyncedAt: now,
          metadata: JSON.stringify(metadata),
          effort: effort || null,
        }).run();

        if (allTagIds.length) {
          tx.insert(taskTags).values(
            allTagIds.map((tagId: string) => ({ taskId: id, tagId })),
          ).run();
        }

        if (projectIds?.length) {
          tx.insert(taskProjects).values(
            projectIds.map((projectId: string) => ({ taskId: id, projectId })),
          ).onConflictDoNothing().run();
        }

        if (estimatedDuration || dueDate || recurrence) {
          tx.insert(taskSchedules).values({
            taskId: id,
            scheduledDate: dueDate || getLocalToday(),
            estimatedDuration: estimatedDuration || null,
            recurrence: recurrence || null,
            recurrenceMode,
            isTimeBlocked: false,
          }).onConflictDoUpdate({
            target: taskSchedules.taskId,
            set: {
              estimatedDuration: estimatedDuration || null,
              scheduledDate: dueDate || getLocalToday(),
              recurrence: recurrence || null,
              recurrenceMode,
            },
          }).run();
        }

        if (triageItemId && triageClaimId && triageRecord) {
          const completed = tx.update(triageActionClaims).set({
            state: 'completed',
            completedAt: now,
            result: triageRecord,
          }).where(and(
            eq(triageActionClaims.id, triageClaimId),
            eq(triageActionClaims.state, 'pending'),
          )).run();
          if (completed.changes === 0) {
            throw new Error('Triage task creation claim was lost before persistence');
          }
          tx.update(triageItems).set({
            status: 'actioned',
            snoozedUntil: null,
            actionsTaken: sql`json_insert(${triageItems.actionsTaken}, '$[#]', json(${JSON.stringify(triageRecord)}))`,
          }).where(eq(triageItems.id, triageItemId)).run();
        }
      });
    } catch (error) {
      if (triageClaimId) {
        await releaseTriageTaskCreation(triageClaimId);
      }
      throw error;
    }

    emitEvent({
      type: 'task.created',
      timestamp: now,
      payload: {
        id,
        title,
        description: description || null,
        priority: resolvedPriority,
        dueDate: dueDate || null,
        connectorType: connectorType || 'local',
        sourceListId: sourceListId || null,
        projectIds: projectIds || [],
        tags: tagIdsList || [],
      },
    }).catch((err) => logger.error({ err, taskId: id }, 'Failed to emit task created event'));

    // Immediate write-through for remote tasks
    if (shouldWriteThrough) {
      // Resolve tag names to include on the remote issue
      let tagNamesForCreate: string[] = [];
      if (allTagIds.length) {
        const tagRows = await db.select({ name: tags.name, type: tags.type }).from(tags).where(inArray(tags.id, allTagIds));
        tagNamesForCreate = tagRows.filter(t => t.type === 'source').map(t => t.name);
      }

      writeThroughCreate({
        id,
        title,
        description,
        priority: resolvedPriority,
        dueDate,
        sourceListId,
        connectorInstanceId,
        metadata,
        tagNames: tagNamesForCreate,
      }).catch((err) => {
        logger.error({ err, taskId: id }, 'Write-through task creation failed unexpectedly');
      });
    }

    try {
      await evaluateRulesForTasks([id]);
    } catch (error) {
      logger.error({ err: error, taskId: id }, 'Project auto-include evaluation failed after task creation');
    }

    const sourceId = triageItemId ? `local:triage:${triageItemId}` : `local:${id}`;
    const [editPolicy] = (await resolveTaskEditPolicies([{
      id,
      sourceId,
      connectorType: connectorType || 'local',
      connectorInstanceId,
    }])).values();
    return NextResponse.json({ id, editPolicy }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create task', error);
  }
}

async function writeThroughCreate(params: {
  id: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  dueDate?: string;
  sourceListId?: string;
  connectorInstanceId: string;
  metadata: Record<string, unknown>;
  tagNames?: string[];
}) {
  let pushLeaseToken: string | null = null;
  try {
    pushLeaseToken = await claimTaskForPush(params.id);
    if (!pushLeaseToken) {
      return;
    }
    const heartbeat = async () => {
      const renewed = await heartbeatTaskPush(params.id, pushLeaseToken!);
      if (!renewed) throw new Error('Task push lease was lost');
      pushLeaseToken = renewed;
    };
    let connector = connectorRegistry.getConnector(params.connectorInstanceId) ?? null;
    if (!connector) {
      connector = await syncScheduler.initializeConnectorFromDb(params.connectorInstanceId);
    }
    if (!connector || !connector.createTask) {
      throw new Error('Connector does not support task creation');
    }

    await heartbeat();
    const createRemote = () => connector.createTask!({
      title: params.title,
      description: params.description,
      priority: params.priority,
      dueDate: params.dueDate,
      sourceListId: params.sourceListId,
      metadata: connector.type === 'microsoft-todo'
        ? {
            ...params.metadata,
            missionControlPushHeartbeat: heartbeat,
          }
        : params.metadata,
      tags: params.tagNames?.length
        ? params.tagNames.map(name => ({
            id: '',
            name,
            slug: name.toLowerCase().replace(/\s+/g, '-'),
            type: 'source' as const,
            source: '',
            confirmed: true,
            createdAt: new Date().toISOString(),
          }))
        : undefined,
    });
    const created = connector.type === 'github-issues'
      ? await executeFencedGitHubTaskMutation({
        connectorInstanceId: params.connectorInstanceId,
        taskId: params.id,
        operation: 'create',
        connector,
        write: createRemote,
      })
      : await createRemote();

    const finalized = await completeTaskPush(
      params.id,
      pushLeaseToken,
      created.sourceId,
      created.metadata,
    );
    if (!finalized) return;

    try {
      persistCreatedTaskIdentity({
        taskId: params.id,
        connectorInstanceId: params.connectorInstanceId,
        sourceId: created.sourceId,
        sourceListId: created.sourceListId ?? params.sourceListId,
        evidence: created.externalIdentity,
      });
    } catch (error) {
      logger.warn(
        { err: error, taskId: params.id },
        'Task created but external identity persistence requires reconciliation',
      );
    }

    await logWriteThrough({
      connectorId: params.connectorInstanceId,
      action: 'created',
      taskId: params.id,
      taskTitle: params.title,
      taskSourceId: created.sourceId,
    });
  } catch (err) {
    if (pushLeaseToken) {
      await failTaskPush(
        params.id,
        pushLeaseToken,
        err instanceof GitHubUnknownWriteOutcomeError ? 'push_failed' : 'push_error',
        err instanceof GitHubUnknownWriteOutcomeError ? 5 : undefined,
      );
    }
    logger.error({ err, taskId: params.id }, 'Write-through task creation failed');
  }
}
