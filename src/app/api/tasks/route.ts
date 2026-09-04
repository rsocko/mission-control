import { NextResponse } from 'next/server';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { logWriteThrough } from '@/lib/sync/write-through-log';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
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
import { getLocalToday } from '@/lib/utils/date';
import { isDemoMode } from '@/lib/mode';
import type { TaskPriority } from '@/types';
import { isPlanningHorizon } from '@/lib/tasks/planning-horizon';
import type { ConnectorCapabilities } from '@/types';
import { resolveConnectorCapabilities } from '@/lib/connectors/task-source-profiles';
import { resolveTaskSourceModel } from '@/lib/tasks/field-policy';
import {
  claimTaskForPush,
  completeTaskPush,
  failTaskPush,
  heartbeatTaskPush,
  releaseTaskPush,
} from '@/lib/sync/push-lease';
import { persistCreatedTaskIdentity } from '@/lib/connectors/transfer-identity';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';

import {
  requireTaskEditPolicy,
  resolveTaskEditPolicies,
  type ConnectorEditPolicyContext,
} from '@/lib/tasks/edit-policy';
import { evaluateRulesForTasks } from '@/lib/rules';
import {
  MAX_TASK_PAGE_SIZE,
  SMART_SCORE_CANDIDATE_LIMIT,
  parseTaskPagination,
} from './pagination';
import { normalizedCsv, TaskQueryValidationError, validateTaskQueryParams } from './query-input';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import {
  buildTaskFilterSpec,
  taskCollectionGroupReturnsEmpty,
} from '@/lib/tasks/core/filter-spec';
import type { TaskCoreTaskRow, TaskListSortField } from '@/lib/tasks/core/contracts';

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'];

function isTaskPriority(value: unknown): value is TaskPriority {
  return VALID_PRIORITIES.includes(String(value));
}

const TASK_SORT_FIELDS = new Set<TaskListSortField>([
  'dueDate',
  'priority',
  'planningHorizon',
  'title',
  'createdAt',
  'completedAt',
  'updatedAt',
  'updated',
  'status',
  'sourceList',
  'effort',
  'smartScore',
]);

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

  const requestedSort = searchParams.get('sortBy') || 'priority';
  const sortBy: TaskListSortField = TASK_SORT_FIELDS.has(requestedSort as TaskListSortField)
    ? requestedSort as TaskListSortField
    : 'priority';
  const sortDirection = searchParams.get('sortDirection') === 'desc' ? 'desc' : 'asc';
  const { limit, offset } = pagination;
  const includeTags = searchParams.get('includeTags') !== 'false';
  const countsOnly = searchParams.get('countsOnly') === 'true';
  const includeScoreBreakdown = searchParams.get('includeScoreBreakdown') === 'true';
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
    const persistence = await getTaskCorePersistence();
    const spec = buildTaskFilterSpec(searchParams, { readCsv: normalizedCsv });
    if (taskCollectionGroupReturnsEmpty(spec.group)) {
      return NextResponse.json({
        tasks: [],
        total: 0,
        stats: {
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
        },
        hasMore: false,
        sourceCounts: {},
        availableTags: [],
        pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
      });
    }
    const collection = await persistence.collections.readTaskCollection({
      spec,
      page: {
        order: { field: sortBy, direction: sortDirection },
        limit,
        offset,
      },
      includeTags,
      includeScoreInputs: includeScoreBreakdown,
      countsOnly,
      smartScoreCandidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
    });

    if (countsOnly) {
      return NextResponse.json({
        tasks: [],
        total: collection.total,
        stats: collection.stats,
        hasMore: false,
        sourceCounts: collection.sourceCounts,
        availableTags: [],
        pagination: { limit, offset, maxLimit: MAX_TASK_PAGE_SIZE },
      });
    }

    const connectorEditPolicyContexts = new Map<string, ConnectorEditPolicyContext>(
      collection.connectorContexts.map((config) => {
        const defaults = CAPABILITY_DEFAULTS[config.type] ?? {};
        return [
          config.id,
          {
            capabilities: resolveConnectorCapabilities(
              config.type,
              { ...defaults, ...config.capabilities } as ConnectorCapabilities,
              config.settings,
            ),
            connectorEnabled: !config.deletedAt && config.enabled,
          },
        ] as const;
      }),
    );
    for (const connectorInstanceId of new Set(
      collection.rows
        .map((task) => task.connectorInstanceId)
        .filter((id) => id && id !== 'local'),
    )) {
      if (!connectorEditPolicyContexts.has(connectorInstanceId)) {
        connectorEditPolicyContexts.set(connectorInstanceId, {
          capabilities: null,
          connectorEnabled: false,
        });
      }
    }

    const entities = sortBy === 'smartScore' || includeScoreBreakdown
      ? await getResolvedPriorityEntities()
      : [];
    const scoreInputs = collection.smartScore;
    const scoredRows = scoreInputs
      ? computeBatchSmartScores(
          scoreInputs.rows.map((task) => createScoreInput(
            {
              ...task,
              priority: task.priority as ScoreInputTask['priority'],
              estimatedDuration: task.estimatedDuration ?? undefined,
            },
            task.tags.map((tag) => ({ id: tag.unifiedInto || tag.id, name: tag.name })),
            task.projectPhaseMemberships
              .filter((membership, index, all) => all.findIndex(
                (candidate) => candidate.projectId === membership.projectId,
              ) === index)
              .map((membership) => ({
                id: membership.projectId,
                name: membership.projectName,
              })),
          )),
          entities,
          scoreInputs.sourceRankings as SourceRanking[],
        )
      : [];
    const scoredById = new Map<string, ScoredTask>();
    let result = collection.rows;
    if (sortBy === 'smartScore') {
      const pageScores = scoredRows.slice(offset, offset + limit);
      for (const score of pageScores) scoredById.set(score.taskId, score);
      const byId = new Map(collection.rows.map((task) => [task.id, task]));
      result = pageScores.flatMap((score) => byId.get(score.taskId) ?? []);
    } else if (includeScoreBreakdown) {
      for (const score of scoredRows) scoredById.set(score.taskId, score);
    }

    const editPolicies = await resolveTaskEditPolicies(result, connectorEditPolicyContexts);
    const smartScoreBudgetReached = sortBy === 'smartScore'
      && collection.total > SMART_SCORE_CANDIDATE_LIMIT;
    if (smartScoreBudgetReached) {
      logger.warn({
        event: 'smart_score_budget_reached',
        total: collection.total,
        candidateLimit: SMART_SCORE_CANDIDATE_LIMIT,
      }, 'Smart-score candidate budget reached');
    }

    return NextResponse.json({
      tasks: result.map((task) => {
        const scored = scoredById.get(task.id);
        const {
          description,
          authoritativeSourceListName,
          projectIds,
          tags,
          parentTitle: _parentTitle,
          ...taskWithoutDescription
        } = task;
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
          sourceListName: authoritativeSourceListName || task.sourceListName,
          taskSourceModel,
          estimatedDuration: task.estimatedDuration || null,
          subtaskTotal: task.subtaskTotal || 0,
          subtaskDone: task.subtaskDone || 0,
          hubProjectIds: projectIds,
          projectPhaseMemberships: task.projectPhaseMemberships,
          linkedSourceCount: task.linkedSourceCount || 0,
          editPolicy: requireTaskEditPolicy(editPolicies, task.id),
          ...(scored ? {
            smartScore: Number.isFinite(scored.score.total) ? scored.score.total : 0,
            scoreBreakdown: scored.score,
          } : {}),
          ...(includeTags ? {
            tags: tags.map(({ unifiedInto: _unifiedInto, ...tag }) => tag),
          } : {}),
        };
      }),
      total: collection.total,
      stats: collection.stats,
      hasMore: offset + result.length < (
        sortBy === 'smartScore'
          ? Math.min(collection.total, SMART_SCORE_CANDIDATE_LIMIT)
          : collection.total
      ),
      sourceCounts: collection.sourceCounts,
      availableTags: collection.availableTags,
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
    const {
      title,
      description,
      priority,
      planningHorizon,
      dueDate,
      connectorType,
      sourceListId,
      sourceListName,
      tags: tagIdsList,
      tagSlugs,
      projectIds,
      recurrence,
      estimatedDuration,
      effort,
    } = body;
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
    if (
      planningHorizon !== undefined
      && planningHorizon !== null
      && !isPlanningHorizon(planningHorizon)
    ) {
      return ApiErrors.badRequest('planningHorizon must be now, next, later, someday, or null');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata: Record<string, unknown> = {};
    if (recurrence) metadata.recurrence = recurrence;
    if (triageItemId) metadata.triageItemId = triageItemId;
    metadata.missionControlTaskId = id;

    const resolvedConnectorType = typeof connectorType === 'string' ? connectorType : 'local';
    const isRemote = resolvedConnectorType !== 'local';
    if (recurrenceMode === 'completion' && !recurrence) {
      return ApiErrors.badRequest(
        'Choose a recurrence interval before anchoring it to completion',
      );
    }
    if (recurrenceMode === 'completion' && isRemote) {
      return ApiErrors.badRequest('Completion-anchored recurrence is available only for local tasks');
    }

    const persistence = await getTaskCorePersistence();
    let connectorInstanceId = 'local';
    let capabilities: ConnectorCapabilities | null = null;
    if (isRemote) {
      const target = await persistence.creates.resolveTaskCreateTarget({
        connectorType: resolvedConnectorType,
        requestedConnectorInstanceId,
        sourceListId: typeof sourceListId === 'string' && sourceListId ? sourceListId : null,
      });
      if (target.kind !== 'resolved') {
        if (target.kind === 'source-list-not-found') {
          return ApiErrors.badRequest('sourceListId does not belong to the selected connector');
        }
        if (target.kind === 'source-list-ambiguous') {
          return ApiErrors.badRequest('connectorInstanceId is required for an ambiguous sourceListId');
        }
        if (target.kind === 'connector-ambiguous') {
          return ApiErrors.badRequest(
            'connectorInstanceId is required when multiple connector instances are available',
          );
        }
        if (target.kind === 'connector-disabled') return ApiErrors.forbidden('Connector is disabled');
        if (target.kind === 'source-list-not-selected') {
          return ApiErrors.badRequest('sourceListId is not selected for sync');
        }
        if (target.kind === 'connector-mismatch' || requestedConnectorInstanceId) {
          return ApiErrors.badRequest('connectorInstanceId does not match connectorType');
        }
        return ApiErrors.badRequest(`No enabled ${resolvedConnectorType} connector is available`);
      }
      connectorInstanceId = target.connectorInstanceId;
      const defaults = CAPABILITY_DEFAULTS[resolvedConnectorType] ?? {};
      capabilities = resolveConnectorCapabilities(
        resolvedConnectorType,
        { ...defaults, ...target.capabilities } as ConnectorCapabilities,
        target.settings,
      );
      if (capabilities.notificationOnly || !(capabilities.taskCreate ?? capabilities.write)) {
        return ApiErrors.forbidden('Task creation is disabled for this connector');
      }
      if (capabilities.listSelectionMode === 'required' && !sourceListId) {
        return ApiErrors.badRequest(
          `sourceListId is required for ${resolvedConnectorType} connector`,
        );
      }
    }

    const shouldWriteThrough = isRemote && !isDemoMode();
    const task: TaskCoreTaskRow = {
      id,
      sourceId: triageItemId ? `local:triage:${triageItemId}` : `local:${id}`,
      connectorType: resolvedConnectorType,
      connectorInstanceId,
      title,
      description: typeof description === 'string' ? description : null,
      status: 'todo',
      localDisposition: 'active',
      priority: resolvedPriority,
      planningHorizon: planningHorizon ?? null,
      dueDate: dueDate || null,
      pushCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      recurrenceGeneratedFromTaskId: null,
      parentId: null,
      depth: 0,
      isChecklistItem: false,
      sourceListId: sourceListId || null,
      sourceListName: sourceListName || null,
      assignee: null,
      microStatus: null,
      statusReason: null,
      metadata,
      syncStatus: shouldWriteThrough ? 'pending_push' : 'synced',
      lastSyncedAt: now,
      pushRetryCount: 0,
      kanbanColumn: null,
      kanbanOrder: null,
      snoozedUntil: null,
      reminderAt: null,
      reminderRelative: null,
      reminderDueTime: null,
      effort: effort || null,
      isBulkImport: false,
    };
    const createResult = await persistence.creates.createTask({
      task,
      tagIds: Array.isArray(tagIdsList)
        ? tagIdsList.filter((value): value is string => typeof value === 'string')
        : [],
      tagSlugs: Array.isArray(tagSlugs)
        ? tagSlugs.filter((value): value is string => typeof value === 'string')
        : [],
      tagCreationMode: capabilities?.tagCreationMode === 'predefined' ? 'predefined' : 'freeform',
      projectIds: Array.isArray(projectIds)
        ? projectIds.filter((value): value is string => typeof value === 'string')
        : [],
      schedule: estimatedDuration || dueDate || recurrence ? {
        taskId: id,
        scheduledDate: dueDate || getLocalToday(),
        scheduledTime: null,
        estimatedDuration: estimatedDuration || null,
        isTimeBlocked: false,
        recurrence: recurrence || null,
        recurrenceMode,
      } : null,
      triageItemId,
      triageClaimId: triageItemId ? crypto.randomUUID() : null,
      requireConnectorEnabled: isRemote,
      requireSelectedSourceList: capabilities?.listSelectionMode === 'required',
      event: {
        stableKey: `task-created:${id}`,
        type: 'task.created',
        timestamp: now,
        payload: {
          id,
          title,
          description: description || null,
          priority: resolvedPriority,
          dueDate: dueDate || null,
          connectorType: resolvedConnectorType,
          sourceListId: sourceListId || null,
          projectIds: projectIds || [],
          tags: tagIdsList || [],
        },
      },
    });
    if (createResult.kind !== 'committed') {
      if (createResult.kind === 'triage-not-found') {
        return ApiErrors.badRequest('Triage item not found');
      }
      if (createResult.kind === 'triage-pending') {
        return ApiErrors.conflict('Task creation for this triage item is still in progress');
      }
      if (createResult.kind === 'triage-replay') {
        return createResult.taskId
          ? NextResponse.json({ id: createResult.taskId }, { status: 200 })
          : ApiErrors.conflict('A task has already been created from this triage item');
      }
      if (createResult.kind === 'connector-disabled') return ApiErrors.forbidden('Connector is disabled');
      if (createResult.kind === 'source-list-not-selected') {
        return ApiErrors.badRequest('sourceListId is not selected for sync');
      }
      if (createResult.kind === 'source-list-not-found') {
        return ApiErrors.badRequest('sourceListId does not belong to the selected connector');
      }
      if (createResult.kind === 'source-list-ambiguous') {
        return ApiErrors.badRequest('connectorInstanceId is required for an ambiguous sourceListId');
      }
      if (createResult.kind === 'connector-mismatch') {
        return ApiErrors.badRequest('connectorInstanceId does not match connectorType');
      }
      if (createResult.kind === 'project-not-found') {
        return ApiErrors.badRequest(`Project not found: ${createResult.projectId}`);
      }
      if (createResult.kind === 'tag-not-found') {
        return ApiErrors.badRequest(`Tag not found: ${createResult.tagId}`);
      }
      return ApiErrors.badRequest(`No enabled ${resolvedConnectorType} connector is available`);
    }

    const committedTask = createResult.task;
    if (shouldWriteThrough) {
      void writeThroughCreate({
        id: committedTask.id,
        createdFromSourceId: committedTask.sourceId,
        expectedTaskVersion: committedTask.updatedAt,
        title: committedTask.title,
        description: description as string | undefined,
        priority: resolvedPriority,
        dueDate: dueDate as string | undefined,
        sourceListId: committedTask.sourceListId ?? undefined,
        connectorInstanceId: committedTask.connectorInstanceId,
        metadata,
        tagNames: createResult.sourceTagNames,
      }).catch((error) => {
        logger.error({ err: error, taskId: id }, 'Write-through task creation failed unexpectedly');
      });
    }

    try {
      await evaluateRulesForTasks([id]);
    } catch (error) {
      logger.error({ err: error, taskId: id }, 'Project auto-include evaluation failed after task creation');
    }

    const [editPolicy] = (await resolveTaskEditPolicies([committedTask])).values();
    return NextResponse.json({ id, editPolicy }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create task', error);
  }
}

async function writeThroughCreate(params: {
  id: string;
  createdFromSourceId: string;
  expectedTaskVersion: string;
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
    const connector = await getOrInitializeConnector(params.connectorInstanceId);
    if (!connector || connector.writeDelivery === 'deferred') {
      await releaseTaskPush(
        params.id,
        pushLeaseToken,
        'pending_push',
        params.expectedTaskVersion,
      );
      return;
    }
    if (!connector.createTask) {
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
      undefined,
      params.expectedTaskVersion,
      params.createdFromSourceId,
    );
    if (!finalized) return;

    try {
      await persistCreatedTaskIdentity({
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
      if (err instanceof GitHubUnknownWriteOutcomeError) {
        await failTaskPush(
          params.id,
          pushLeaseToken,
          'push_failed',
          5,
          params.expectedTaskVersion,
        );
      } else {
        await releaseTaskPush(
          params.id,
          pushLeaseToken,
          'pending_push',
          params.expectedTaskVersion,
        );
      }
    }
    logger.error({ err, taskId: params.id }, 'Write-through task creation failed');
  }
}
