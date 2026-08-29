import db, { runTransaction } from '@/db';
import {
  tasks,
  taskTags,
  taskProjects,
  taskSchedules,
  taskAttachments,
  sourceLists,
  connectorConfigs,
  tags,
} from '@/db/schema';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { connectorRegistry } from '@/lib/connectors';
import { dbLogger, connectorLogger } from '@/lib/logger';
import {
  isGitHubNativeTransfer,
  buildCrossReferenceNote,
  priorityToGitHubLabel,
} from '@/lib/connectors/field-mapper';
import type { ConnectorCapabilities, ConnectorConfig, TaskItem } from '@/types';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
import { normalizeTraceId } from '@/lib/trace-id';
import {
  persistCreatedTaskIdentity,
  reconcileTransferIdentity,
} from '@/lib/connectors/transfer-identity';
import {
  executeFencedGitHubSourceMutation,
  executeFencedGitHubTaskMutation,
  GitHubWriteFenceError,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';
import { refreshGitHubIssueMetadata } from '@/lib/connectors/github-issues/issue-transformer';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { repointTaskReferences } from '@/lib/tasks/task-reference-repoint';
import type {
  ExecuteTaskMoveInput,
  TaskMoveServiceResult,
} from '@/lib/tasks/task-move-service';
import {
  assertTaskMoveAttachmentBudget,
  TASK_MOVE_BUDGETS,
  TaskMoveBudgetError,
} from '@/lib/tasks/task-move-budgets';
import { taskAttachmentSnapshotPredicates } from '@/lib/tasks/task-move-snapshot';

type SourceAction = 'move' | 'copy';
type MoveAttachment = {
  storedAttachmentId: string | null;
  name: string;
  contentType: string;
  size: number;
  contentBase64: string;
  sourceAttachmentId: string | null;
  createdAt: string;
};

class TaskMoveSourceChangedError extends Error {
  constructor() {
    super('Task attachments changed while the move was in progress');
    this.name = 'TaskMoveSourceChangedError';
  }
}

function serviceResult(
  body: Record<string, unknown>,
  status = 200,
): TaskMoveServiceResult {
  return { body, status };
}

export async function executeWriteThroughTaskMove(
  body: ExecuteTaskMoveInput,
  requestedTraceId?: string,
): Promise<TaskMoveServiceResult> {
  let compensateRemoteCreation: (() => Promise<void>) | null = null;
  let moveClaim: TaskMoveClaim | null = null;
  const startedAt = Date.now();
  const traceId = normalizeTraceId(requestedTraceId);
  const logContext: TaskMoveLogContext = {
    operation: 'task_move',
    traceId,
  };
  let startLogged = false;
  const logStart = () => {
    if (startLogged) return;
    startLogged = true;
    connectorLogger.info(
      { ...logContext, phase: 'start', durationMs: 0 },
      'Task move started',
    );
  };
  const failureResponse = (
    response: TaskMoveServiceResult,
    failureCode: string,
    error?: unknown,
  ) => {
    logStart();
    connectorLogger.error(
      {
        ...logContext,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        failureCode,
        ...sanitizeException(error),
      },
      'Task move failed',
    );
    return response;
  };
  const successResponse = (body: Record<string, unknown>, status = 200) => {
    logStart();
    connectorLogger.info(
      { ...logContext, outcome: 'success', durationMs: Date.now() - startedAt },
      'Task move succeeded',
    );
    return serviceResult(body, status);
  };

  try {
    const {
      taskId,
      targetConnectorInstanceId,
      targetSourceListId,
      sourceAction,
      subtaskStrategy = 'move-as-subtasks',
      addCrossReference = true,
    } = body;
    logContext.taskId = boundedLogValue(taskId);
    logContext.destinationConnectorInstanceId = boundedLogValue(targetConnectorInstanceId);
    logContext.destinationListId = boundedLogValue(targetSourceListId);
    logContext.sourceAction = sourceAction === 'move' || sourceAction === 'copy'
      ? sourceAction
      : undefined;

    // ── Validation ───────────────────────────────────────────────────────────
    if (!taskId || !targetConnectorInstanceId || !targetSourceListId) {
      return failureResponse(
        serviceResult(
          { error: 'taskId, targetConnectorInstanceId, and targetSourceListId are required' },
          400,
        ),
        'validation_error',
      );
    }
    if (sourceAction !== 'move' && sourceAction !== 'copy') {
      return failureResponse(
        serviceResult(
          { error: 'sourceAction must be "move" or "copy"' },
          400,
        ),
        'validation_error',
      );
    }
    if (
      subtaskStrategy !== 'move-as-subtasks' &&
      subtaskStrategy !== 'flatten-to-checklist' &&
      subtaskStrategy !== 'preserve-details-and-steps'
    ) {
      return failureResponse(
        serviceResult(
          { error: 'subtaskStrategy must preserve subtasks' },
          400,
        ),
        'validation_error',
      );
    }

    // ── Fetch source task ────────────────────────────────────────────────────
    let [srcTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!srcTask) {
      return failureResponse(
        serviceResult({ error: 'Task not found' }, 404),
        'source_task_not_found',
      );
    }
    const previousMove = parseMetadata(srcTask.metadata).movedTo;
    if (
      sourceAction === 'move'
      && srcTask.statusReason === 'moved'
      && previousMove
      && typeof previousMove === 'object'
      && !Array.isArray(previousMove)
    ) {
      const successorTaskId = (previousMove as Record<string, unknown>).taskId;
      return failureResponse(
        serviceResult(
          {
            error: 'This task has already been moved',
            code: 'TASK_ALREADY_MOVED',
            ...(typeof successorTaskId === 'string' ? { successorTaskId } : {}),
          },
          409,
        ),
        'source_task_already_moved',
      );
    }
    logContext.sourceConnectorType = boundedLogValue(srcTask.connectorType);
    logContext.source_type = boundedLogValue(srcTask.connectorType);
    logContext.sourceConnectorInstanceId = boundedLogValue(srcTask.connectorInstanceId);
    if (
      srcTask.connectorInstanceId === targetConnectorInstanceId
      && srcTask.sourceListId === targetSourceListId
    ) {
      return failureResponse(
        serviceResult(
          {
            error: 'This task is already in the selected destination',
            code: 'SAME_SOURCE_DESTINATION',
          },
          409,
        ),
        'same_source_destination',
      );
    }

    // ── Fetch target connector ───────────────────────────────────────────────
    const [targetConnectorRow] = await db
      .select()
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.id, targetConnectorInstanceId), isNull(connectorConfigs.deletedAt)))
      .limit(1);

    if (!targetConnectorRow) {
      return failureResponse(
        serviceResult({ error: 'Target connector not found' }, 404),
        'destination_connector_not_found',
      );
    }
    logContext.destinationConnectorType = boundedLogValue(targetConnectorRow.type);
    logStart();

    const storedCaps = targetConnectorRow.capabilities as ConnectorCapabilities;
    const capDefaults = CAPABILITY_DEFAULTS[targetConnectorRow.type] ?? {};
    const targetCaps = { ...capDefaults, ...storedCaps } as ConnectorCapabilities;
    if (!targetCaps?.write) {
      return failureResponse(
        serviceResult(
          { error: 'Target connector does not support write operations' },
          400,
        ),
        'destination_write_unsupported',
      );
    }
    if (!targetCaps?.taskCreate) {
      return failureResponse(
        serviceResult(
          { error: 'Target connector does not support task creation' },
          400,
        ),
        'destination_create_unsupported',
      );
    }

    // ── Resolve target list name ─────────────────────────────────────────────
    const [targetListRow] = await db
      .select({ id: sourceLists.id, name: sourceLists.name, sourceId: sourceLists.sourceId })
      .from(sourceLists)
      .where(
        and(
          eq(sourceLists.connectorInstanceId, targetConnectorInstanceId),
          eq(sourceLists.sourceId, targetSourceListId),
        ),
      )
      .limit(1);
    if (
      targetSourceListId
      && (!targetListRow || !isSourceListSelected(targetConnectorRow, targetListRow))
    ) {
      return failureResponse(
        serviceResult(
          { error: 'Target list is not selected for sync', code: 'BAD_REQUEST' },
          400,
        ),
        'destination_list_not_selected',
      );
    }
    const targetListName = targetListRow?.name ?? targetSourceListId;

    // ── Fetch task tags ──────────────────────────────────────────────────────
    const taskTagRows = await db
      .select({ id: tags.id, name: tags.name, slug: tags.slug, type: tags.type, color: tags.color })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(eq(taskTags.taskId, taskId));

    // ── Fetch subtasks ───────────────────────────────────────────────────────
    const subtasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentId, taskId)))
      .limit(TASK_MOVE_BUDGETS.maxSubtasks + 1);
    if (subtasks.length > TASK_MOVE_BUDGETS.maxSubtasks) {
      throw new TaskMoveBudgetError(
        `Task moves support at most ${TASK_MOVE_BUDGETS.maxSubtasks} subtasks; reduce the task size and retry.`,
      );
    }

    const attachmentTaskIds = [taskId, ...subtasks.map((subtask) => subtask.id)];
    const storedAttachmentRows = await db
      .select({
        id: taskAttachments.id,
        taskId: taskAttachments.taskId,
        name: taskAttachments.name,
        contentType: taskAttachments.contentType,
        size: taskAttachments.size,
        sourceAttachmentId: taskAttachments.sourceAttachmentId,
        createdAt: taskAttachments.createdAt,
      })
      .from(taskAttachments)
      .where(inArray(taskAttachments.taskId, attachmentTaskIds))
      .limit(TASK_MOVE_BUDGETS.maxAttachments + 1);

    const [sourceSchedule] = await db
      .select()
      .from(taskSchedules)
      .where(eq(taskSchedules.taskId, taskId))
      .limit(1);

    const storedAttachments = storedAttachmentRows.filter((attachment) => attachment.taskId === taskId);
    const storedSubtaskAttachments = new Map(
      subtasks.map((subtask) => [subtask.id, [] as MoveAttachment[]]),
    );
    for (const subtask of subtasks) {
      storedSubtaskAttachments.set(
        subtask.id,
        storedAttachmentRows
          .filter((attachment) => attachment.taskId === subtask.id)
          .map((attachment) => ({
          storedAttachmentId: attachment.id,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          contentBase64: '',
          sourceAttachmentId: attachment.sourceAttachmentId,
          createdAt: attachment.createdAt,
        })),
      );
    }

    // A remote capture can still be finishing its asynchronous write-through.
    if (srcTask.connectorType !== 'local' && srcTask.sourceId.startsWith('local:')) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && srcTask.sourceId.startsWith('local:')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [latest] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        if (!latest) break;
        srcTask = latest;
        if (srcTask.syncStatus === 'push_error' || srcTask.syncStatus === 'push_failed') break;
      }
      if (srcTask.sourceId.startsWith('local:')) {
        return failureResponse(
          serviceResult(
            { error: 'The source task is still being created. Try the move again shortly.' },
            409,
          ),
          'source_task_not_ready',
        );
      }
    }

    // ── Get connector instances ──────────────────────────────────────────────
    const isLocalSource = srcTask.connectorType === 'local' || srcTask.sourceId.startsWith('local:');
    let sourceConnector = connectorRegistry.getConnector(srcTask.connectorInstanceId);
    let targetConnector = connectorRegistry.getConnector(targetConnectorInstanceId);

    if (!sourceConnector && !isLocalSource) {
      const [sourceConnectorRow] = await db
        .select()
        .from(connectorConfigs)
        .where(and(
          eq(connectorConfigs.id, srcTask.connectorInstanceId),
          isNull(connectorConfigs.deletedAt),
        ))
        .limit(1);
      if (!sourceConnectorRow) {
        throw new Error('Source connector is unavailable. The operation was stopped to prevent data loss.');
      }

      const sourceStoredCaps = sourceConnectorRow.capabilities as ConnectorCapabilities;
      const sourceCaps = {
        ...(CAPABILITY_DEFAULTS[sourceConnectorRow.type] ?? {}),
        ...sourceStoredCaps,
      } as ConnectorCapabilities;
      sourceConnector = await connectorRegistry.createConnector({
        id: sourceConnectorRow.id,
        type: sourceConnectorRow.type,
        name: sourceConnectorRow.name,
        enabled: sourceConnectorRow.enabled ?? true,
        syncMode: (sourceConnectorRow.syncMode as ConnectorConfig['syncMode']) || 'poll',
        capabilities: sourceCaps,
        credentials: parseRecord(sourceConnectorRow.credentials),
        settings: parseRecord(sourceConnectorRow.settings),
        syncedLists: parseStringArray(sourceConnectorRow.syncedLists),
      } as ConnectorConfig);
    }

    // If target connector isn't initialized in registry, try to create it from DB config
    if (!targetConnector) {
      try {
        const credentials = (typeof targetConnectorRow.credentials === 'string'
          ? JSON.parse(targetConnectorRow.credentials) : targetConnectorRow.credentials) || {};
        const settings = (typeof targetConnectorRow.settings === 'string'
          ? JSON.parse(targetConnectorRow.settings) : targetConnectorRow.settings) || {};
        const syncedLists = (typeof targetConnectorRow.syncedLists === 'string'
          ? JSON.parse(targetConnectorRow.syncedLists) : targetConnectorRow.syncedLists) || [];

        targetConnector = await connectorRegistry.createConnector({
          id: targetConnectorRow.id,
          type: targetConnectorRow.type,
          name: targetConnectorRow.name,
          enabled: targetConnectorRow.enabled ?? true,
          syncMode: (targetConnectorRow.syncMode as ConnectorConfig['syncMode']) || 'poll',
          capabilities: targetCaps,
          credentials,
          settings,
          syncedLists,
        } as ConnectorConfig);
      } catch (err) {
        if (err instanceof GitHubWriteFenceError || err instanceof GitHubUnknownWriteOutcomeError) {
          throw err;
        }
        connectorLogger.warn(
          { ...logContext, ...sanitizeException(err) },
          'Failed to initialize target connector',
        );
      }
    }

    // ── Check for GitHub native transfer ─────────────────────────────────────
    const useNativeTransfer = isGitHubNativeTransfer(
      srcTask.connectorType,
      targetConnectorRow.type,
      srcTask.sourceListId || '',
      targetSourceListId,
    );
    const nativeTransferCandidate =
      useNativeTransfer
      && sourceAction === 'move'
      && srcTask.connectorInstanceId === targetConnectorInstanceId
      && !!sourceConnector?.transferTask;
    let performNativeTransfer =
      nativeTransferCandidate
      && (!sourceConnector?.canTransferTask
        || await sourceConnector.canTransferTask(srcTask.sourceId, targetSourceListId));
    if (
      nativeTransferCandidate
      && !performNativeTransfer
      && sourceConnector?.refreshTransferIdentity
      && sourceConnector.canTransferTask
    ) {
      try {
        const refresh = await sourceConnector.refreshTransferIdentity(
          srcTask.sourceId,
          targetSourceListId,
        );
        reconcileTransferIdentity(taskId, srcTask.connectorInstanceId, refresh);
        const [refreshedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        if (refreshedTask) srcTask = refreshedTask;
        performNativeTransfer = await sourceConnector.canTransferTask(
          srcTask.sourceId,
          targetSourceListId,
        );
      } catch (error) {
        connectorLogger.warn(
          { ...logContext, ...sanitizeException(error) },
          'Targeted task identity refresh failed; using safe move fallback',
        );
      }
    }

    if (sourceAction === 'move' && !performNativeTransfer) {
      moveClaim = claimTaskMove(srcTask);
      if (!moveClaim) {
        return failureResponse(
          serviceResult(
            {
              error: 'This task is already being moved',
              code: 'TASK_MOVE_IN_PROGRESS',
            },
            409,
          ),
          'source_task_move_in_progress',
        );
      }
    }

    const now = new Date().toISOString();
    const attachmentsBySourceId = new Map(
      storedAttachments
        .filter((attachment) => attachment.sourceAttachmentId)
        .map((attachment) => [attachment.sourceAttachmentId!, attachment]),
    );
    const attachmentsToPreserve: MoveAttachment[] = storedAttachments.map((attachment) => ({
      storedAttachmentId: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      contentBase64: '',
      sourceAttachmentId: attachment.sourceAttachmentId,
      createdAt: attachment.createdAt,
    }));

    if (!performNativeTransfer && sourceConnector?.listAttachments) {
      const remoteAttachments = await sourceConnector.listAttachments(srcTask.sourceId);
      for (const remoteAttachment of remoteAttachments) {
        if (!attachmentsBySourceId.has(remoteAttachment.id)) {
          attachmentsToPreserve.push({
            storedAttachmentId: null,
            name: remoteAttachment.name,
            contentType: remoteAttachment.contentType,
            size: remoteAttachment.size,
            contentBase64: '',
            sourceAttachmentId: remoteAttachment.id,
            createdAt: now,
          });
        }
      }
    }

    if (!performNativeTransfer) {
      for (const subtask of subtasks) {
        const subtaskAttachments = storedSubtaskAttachments.get(subtask.id) ?? [];
        const knownSourceIds = new Set(
          subtaskAttachments
            .map((attachment) => attachment.sourceAttachmentId)
            .filter((id): id is string => !!id),
        );
        if (!subtask.isChecklistItem && sourceConnector?.listAttachments) {
          const remoteAttachments = await sourceConnector.listAttachments(subtask.sourceId);
          for (const remoteAttachment of remoteAttachments) {
            if (!knownSourceIds.has(remoteAttachment.id)) {
              subtaskAttachments.push({
                storedAttachmentId: null,
                name: remoteAttachment.name,
                contentType: remoteAttachment.contentType,
                size: remoteAttachment.size,
                contentBase64: '',
                sourceAttachmentId: remoteAttachment.id,
                createdAt: now,
              });
            }
          }
        }

        storedSubtaskAttachments.set(subtask.id, subtaskAttachments);
      }

      const allAttachments = [
        ...attachmentsToPreserve,
        ...Array.from(storedSubtaskAttachments.values()).flat(),
      ];
      assertTaskMoveAttachmentBudget(allAttachments);

      const storedIds = allAttachments
        .map((attachment) => attachment.storedAttachmentId)
        .filter((id): id is string => !!id);
      if (storedIds.length > 0) {
        const storedContents = await db.select({
          id: taskAttachments.id,
          contentBase64: taskAttachments.contentBase64,
        })
          .from(taskAttachments)
          .where(inArray(taskAttachments.id, storedIds));
        const contentById = new Map(
          storedContents.map((attachment) => [attachment.id, attachment.contentBase64 ?? '']),
        );
        for (const attachment of allAttachments) {
          if (attachment.storedAttachmentId) {
            attachment.contentBase64 = contentById.get(attachment.storedAttachmentId) ?? '';
          }
        }
      }

      let materializedBytes = 0;
      for (const attachment of attachmentsToPreserve) {
        materializedBytes += await materializeMoveAttachment(
          attachment,
          srcTask.sourceId,
          sourceConnector,
          `Attachment "${attachment.name}"`,
        );
        if (materializedBytes > TASK_MOVE_BUDGETS.maxTotalAttachmentBytes) {
          throw new TaskMoveBudgetError('Attachment content exceeded the task move byte budget.');
        }
      }
      for (const subtask of subtasks) {
        for (const attachment of storedSubtaskAttachments.get(subtask.id) ?? []) {
          materializedBytes += await materializeMoveAttachment(
            attachment,
            subtask.sourceId,
            sourceConnector,
            `Attachment "${attachment.name}" on subtask "${subtask.title}"`,
          );
          if (materializedBytes > TASK_MOVE_BUDGETS.maxTotalAttachmentBytes) {
            throw new TaskMoveBudgetError('Attachment content exceeded the task move byte budget.');
          }
        }
      }
    }

    let newSourceId = '';
    let newTaskNativeId = '';
    let subtasksMoved = 0;
    const warnings: string[] = [];
    const destinationAttachments: Array<typeof taskAttachments.$inferInsert> = [];
    const destinationSubtaskAttachments = new Map<
      string,
      Array<typeof taskAttachments.$inferInsert>
    >();
    const createdSubtasks: Array<{ sourceTaskId: string; created: TaskItem }> = [];
    const createdRemoteSourceIds: string[] = [];
    let destinationMetadata: Record<string, unknown> = {};
    const newMcTaskId = crypto.randomUUID();

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Create in target (or native transfer)
    // ════════════════════════════════════════════════════════════════════════

    if (performNativeTransfer && sourceConnector?.transferTask) {
      // GitHub → GitHub same-owner: use Transfer Issue API (preserves history)
      const transferred = await executeFencedGitHubTaskMutation({
        connectorInstanceId: srcTask.connectorInstanceId,
        taskId,
        operation: 'transfer',
        connector: sourceConnector,
        targetSourceListId: targetListRow?.id,
        write: () => sourceConnector.transferTask!(srcTask.sourceId, targetSourceListId),
      });
      if (transferred.identityVerified !== true) {
        throw new Error('Native GitHub transfer did not verify stable issue identity');
      }
      newSourceId = transferred.newSourceId;
      newTaskNativeId = newSourceId;
    } else {
      // Generic cross-source create
      if (!targetConnector?.createTask) {
        return failureResponse(
          serviceResult(
            { error: 'Target connector does not support task creation' },
            400,
          ),
          'destination_create_unsupported',
        );
      }

      // Preserve subtask details in notes for strategies that request it.
      let descriptionWithSubtasks = srcTask.description || '';
      if (
        subtasks.length > 0 &&
        (subtaskStrategy === 'flatten-to-checklist' || subtaskStrategy === 'preserve-details-and-steps')
      ) {
        const checklistItems = subtasks.map(formatSubtaskForDescription).join('\n');
        const separator = descriptionWithSubtasks ? '\n\n' : '';
        descriptionWithSubtasks += `${separator}**Subtasks:**\n${checklistItems}`;
      }

      // Map tags to the target format
      const sourceTags = taskTagRows.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        type: t.type as 'source' | 'hub' | 'ai-inferred',
        color: t.color ?? undefined,
        confirmed: true,
        createdAt: now,
      }));

      // For GitHub targets: translate priority field into a label
      let tagsForTarget = [...sourceTags];
      if (targetConnectorRow.type === 'github-issues' && srcTask.priority && srcTask.priority !== 'none') {
        const priorityLabel = priorityToGitHubLabel(srcTask.priority);
        if (priorityLabel && !tagsForTarget.some((t) => t.name === priorityLabel)) {
          tagsForTarget = [
            ...tagsForTarget,
            { id: priorityLabel, name: priorityLabel, slug: priorityLabel, type: 'source', color: undefined, confirmed: true, createdAt: now },
          ];
        }
      }
      if (targetConnectorRow.type === 'github-issues') {
        tagsForTarget = tagsForTarget.map((tag) => ({ ...tag, type: 'source' as const }));
      }

      const taskMetadata = {
        ...parseMetadata(srcTask.metadata),
        ...(sourceSchedule?.recurrence ? { recurrence: sourceSchedule.recurrence } : {}),
      };
      const taskPayload: Partial<TaskItem> = {
        title: srcTask.title,
        description: descriptionWithSubtasks || undefined,
        priority: srcTask.priority as TaskItem['priority'],
        dueDate: srcTask.dueDate ?? undefined,
        status: srcTask.status as TaskItem['status'],
        localDisposition: srcTask.localDisposition,
        planningHorizon: srcTask.planningHorizon,
        microStatus: (srcTask.microStatus ?? undefined) as TaskItem['microStatus'],
        snoozedUntil: srcTask.snoozedUntil,
        effort: srcTask.effort,
        metadata: taskMetadata,
        sourceListId: targetSourceListId,
        sourceListName: targetListName,
        tags: tagsForTarget,
        assignee: srcTask.assignee ?? undefined,
      };

      const createDestination = async () => {
        const createdTask = await targetConnector.createTask!(taskPayload);
        newSourceId = createdTask.sourceId;
        newTaskNativeId = newSourceId;
        destinationMetadata = targetConnectorRow.type === 'github-issues'
          ? refreshGitHubIssueMetadata(
              createdTask.metadata,
              createdTask.sourceId,
              createdTask.externalIdentity,
            )
          : parseMetadata(createdTask.metadata);
        createdRemoteSourceIds.push(newSourceId);
        if (targetConnectorRow.type === 'github-issues' && createdTask.externalIdentity) {
          persistCreatedTaskIdentity({
            taskId: newMcTaskId,
            connectorInstanceId: targetConnectorInstanceId,
            sourceId: createdTask.sourceId,
            sourceListId: targetSourceListId,
            evidence: createdTask.externalIdentity,
          });
        }
        compensateRemoteCreation = async () => {
          const cleanupErrors: unknown[] = [];
          for (const sourceId of [...createdRemoteSourceIds].reverse()) {
            try {
              if (targetConnector.deleteTask) {
                await targetConnector.deleteTask(sourceId);
              } else if (targetConnector.completeTask) {
                await targetConnector.completeTask(sourceId);
              }
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          try {
            runTransaction((tx) => {
              tx.delete(taskAttachments).where(eq(taskAttachments.taskId, newMcTaskId)).run();
              tx.delete(taskSchedules).where(eq(taskSchedules.taskId, newMcTaskId)).run();
              tx.delete(taskTags).where(eq(taskTags.taskId, newMcTaskId)).run();
              tx.delete(taskProjects).where(eq(taskProjects.taskId, newMcTaskId)).run();
              tx.delete(tasks).where(eq(tasks.id, newMcTaskId)).run();
            });
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, 'One or more destination tasks could not be cleaned up');
          }
        };

      if (targetConnector.addTagToTask) {
        for (const tag of sourceTags) {
          await targetConnector.addTagToTask(newSourceId, tag.name);
        }
      }

      for (const attachment of attachmentsToPreserve) {
        if (targetCaps.attachments && targetConnector.uploadAttachment) {
          const uploaded = await targetConnector.uploadAttachment(newSourceId, {
            name: attachment.name,
            contentType: attachment.contentType,
            contentBase64: attachment.contentBase64,
          });
          destinationAttachments.push({
            id: crypto.randomUUID(),
            taskId: '',
            name: uploaded.name,
            contentType: attachment.contentType,
            size: uploaded.size,
            sourceAttachmentId: uploaded.id,
            createdAt: now,
          });
        } else {
          destinationAttachments.push({
            id: crypto.randomUUID(),
            taskId: '',
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
            contentBase64: attachment.contentBase64,
            createdAt: attachment.createdAt,
          });
        }
      }

      if (
        (srcTask.status === 'done' || srcTask.status === 'cancelled') &&
        targetConnector.completeTask
      ) {
        await targetConnector.completeTask(newSourceId);
      }

      // ── Create native destination subtasks when requested ────────────────
      if (
        subtasks.length > 0 &&
        subtaskStrategy !== 'flatten-to-checklist' &&
        targetConnector.createSubTask
      ) {
        for (const sub of subtasks) {
          const createdSubtask = await targetConnector.createSubTask(newSourceId, {
            title: sub.title,
            description: sub.description ?? undefined,
            status: sub.status as TaskItem['status'],
            priority: sub.priority as TaskItem['priority'],
            dueDate: sub.dueDate ?? undefined,
            assignee: sub.assignee ?? undefined,
            effort: sub.effort,
            microStatus: (sub.microStatus ?? undefined) as TaskItem['microStatus'],
            metadata: parseMetadata(sub.metadata),
          });
          createdSubtasks.push({ sourceTaskId: sub.id, created: createdSubtask });
          createdRemoteSourceIds.push(createdSubtask.sourceId);

          const preservedAttachments: Array<typeof taskAttachments.$inferInsert> = [];
          for (const attachment of storedSubtaskAttachments.get(sub.id) ?? []) {
            if (targetCaps.attachments && targetConnector.uploadAttachment) {
              const uploaded = await targetConnector.uploadAttachment(createdSubtask.sourceId, {
                name: attachment.name,
                contentType: attachment.contentType,
                contentBase64: attachment.contentBase64,
              });
              preservedAttachments.push({
                id: crypto.randomUUID(),
                taskId: '',
                name: uploaded.name,
                contentType: attachment.contentType,
                size: uploaded.size,
                sourceAttachmentId: uploaded.id,
                createdAt: now,
              });
            } else {
              preservedAttachments.push({
                id: crypto.randomUUID(),
                taskId: '',
                name: attachment.name,
                contentType: attachment.contentType,
                size: attachment.size,
                contentBase64: attachment.contentBase64,
                createdAt: attachment.createdAt,
              });
            }
          }
          destinationSubtaskAttachments.set(sub.id, preservedAttachments);
          subtasksMoved++;
        }
      }
      if (sourceAction === 'copy' && addCrossReference && targetConnector.addComment) {
        const crossRef = buildCrossReferenceNote(
          'target',
          srcTask.connectorType,
          srcTask.sourceListName ?? srcTask.sourceListId ?? srcTask.connectorType,
          srcTask.title,
        );
        await targetConnector.addComment(newSourceId, crossRef);
      }
      };
      if (targetConnector.type === 'github-issues') {
        if (!targetListRow) {
          throw new Error('The target GitHub repository has no local identity binding');
        }
        await executeFencedGitHubSourceMutation({
          connectorInstanceId: targetConnectorInstanceId,
          sourceListId: targetListRow.id,
          operation: 'create',
          connector: targetConnector,
          write: createDestination,
        });
      } else {
        await createDestination();
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 2: Write provenance to local DB
    // ════════════════════════════════════════════════════════════════════════

    const provenanceMetadata = {
      ...parseMetadata(srcTask.metadata),
      ...destinationMetadata,
      movedFrom: {
        taskId: srcTask.id,
        sourceId: srcTask.sourceId,
        connectorType: srcTask.connectorType,
        connectorInstanceId: srcTask.connectorInstanceId,
        sourceListId: srcTask.sourceListId,
        [sourceAction === 'move' ? 'movedAt' : 'copiedAt']: now,
      },
    };

    if (!performNativeTransfer) {
      // Insert the new task record in the local DB
      try {
        runTransaction((tx) => {
          tx.insert(tasks).values({
            id: newMcTaskId,
            sourceId: newTaskNativeId,
            connectorType: targetConnectorRow.type,
            connectorInstanceId: targetConnectorInstanceId,
            title: srcTask.title,
            description: srcTask.description,
            status: srcTask.status,
            localDisposition: srcTask.localDisposition,
            priority: srcTask.priority,
            planningHorizon: srcTask.planningHorizon,
            dueDate: srcTask.dueDate,
            pushCount: srcTask.pushCount,
            createdAt: srcTask.createdAt,
            updatedAt: now,
            completedAt: srcTask.completedAt,
            recurrenceGeneratedFromTaskId: srcTask.recurrenceGeneratedFromTaskId,
            parentId: srcTask.parentId,
            depth: srcTask.depth,
            isChecklistItem: srcTask.isChecklistItem,
            sourceListId: targetSourceListId,
            sourceListName: targetListName,
            assignee: srcTask.assignee,
            microStatus: srcTask.microStatus,
            statusReason: srcTask.statusReason,
            snoozedUntil: srcTask.snoozedUntil,
            reminderAt: srcTask.reminderAt,
            reminderRelative: srcTask.reminderRelative,
            reminderDueTime: srcTask.reminderDueTime,
            effort: srcTask.effort,
            kanbanColumn: srcTask.kanbanColumn,
            kanbanOrder: srcTask.kanbanOrder,
            isBulkImport: srcTask.isBulkImport,
            metadata: JSON.stringify(provenanceMetadata),
            syncStatus: 'synced',
            lastSyncedAt: now,
          }).run();

          // Copy tag associations
          if (taskTagRows.length > 0) {
            tx.insert(taskTags).values(
              taskTagRows.map((tt) => ({ taskId: newMcTaskId, tagId: tt.id })),
            ).run();
          }

          // Copy project associations
          const sourceProjects = tx.select().from(taskProjects).where(eq(taskProjects.taskId, taskId)).all();
          if (sourceAction === 'copy' && sourceProjects.length > 0) {
            tx.insert(taskProjects).values(
              sourceProjects.map((tp) => ({ taskId: newMcTaskId, projectId: tp.projectId })),
            ).run();
          }

          // Preserve local planning data for both moves and copies.
          if (sourceSchedule) {
            tx.insert(taskSchedules).values({ ...sourceSchedule, taskId: newMcTaskId }).run();
          }

          if (destinationAttachments.length > 0) {
            tx.insert(taskAttachments).values(
              destinationAttachments.map((attachment) => ({
                ...attachment,
                taskId: newMcTaskId,
              })),
            ).run();
          }

          if (sourceAction === 'copy' && subtasks.length > 0) {
            const createdBySourceId = new Map(
              createdSubtasks.map(({ sourceTaskId, created }) => [sourceTaskId, created]),
            );

            for (const subtask of subtasks) {
              const created = createdBySourceId.get(subtask.id);
              const destinationSubtaskId = crypto.randomUUID();
              tx.insert(tasks).values({
                ...subtask,
                id: destinationSubtaskId,
                sourceId: created?.sourceId ?? `local:${destinationSubtaskId}`,
                connectorType: created ? targetConnectorRow.type : 'local',
                connectorInstanceId: created ? targetConnectorInstanceId : 'local',
                parentId: newMcTaskId,
                depth: (srcTask.depth ?? 0) + 1,
                sourceListId: created ? targetSourceListId : null,
                sourceListName: created ? targetListName : null,
                updatedAt: now,
                metadata: JSON.stringify({
                  ...parseMetadata(subtask.metadata),
                  copiedFrom: {
                    taskId: subtask.id,
                    sourceId: subtask.sourceId,
                    copiedAt: now,
                  },
                }),
                syncStatus: 'synced',
                lastSyncedAt: now,
                pushRetryCount: 0,
              }).run();

              const subtaskTags = tx.select().from(taskTags).where(eq(taskTags.taskId, subtask.id)).all();
              if (subtaskTags.length > 0) {
                tx.insert(taskTags).values(
                  subtaskTags.map((tag) => ({ taskId: destinationSubtaskId, tagId: tag.tagId })),
                ).run();
              }

              const subtaskProjects = tx.select().from(taskProjects).where(eq(taskProjects.taskId, subtask.id)).all();
              if (subtaskProjects.length > 0) {
                tx.insert(taskProjects).values(
                  subtaskProjects.map((project) => ({
                    taskId: destinationSubtaskId,
                    projectId: project.projectId,
                  })),
                ).run();
              }

              const subtaskSchedules = tx.select().from(taskSchedules).where(eq(taskSchedules.taskId, subtask.id)).all();
              if (subtaskSchedules.length > 0) {
                tx.insert(taskSchedules).values(
                  subtaskSchedules.map((schedule) => ({
                    ...schedule,
                    taskId: destinationSubtaskId,
                  })),
                ).run();
              }

              const subtaskAttachments = destinationSubtaskAttachments.get(subtask.id)
                ?? (storedSubtaskAttachments.get(subtask.id) ?? []).map((attachment) => ({
                  id: crypto.randomUUID(),
                  taskId: destinationSubtaskId,
                  name: attachment.name,
                  contentType: attachment.contentType,
                  size: attachment.size,
                  contentBase64: attachment.contentBase64,
                  createdAt: attachment.createdAt,
                }));
              if (subtaskAttachments.length > 0) {
                tx.insert(taskAttachments).values(
                  subtaskAttachments.map((attachment) => ({
                    ...attachment,
                    id: crypto.randomUUID(),
                    taskId: destinationSubtaskId,
                  })),
                ).run();
              }
            }
          }
        });
      } catch (err) {
        dbLogger.error({ ...logContext, ...sanitizeException(err) },
          'Failed to write new task to DB after successful remote create');
        throw err;
      }
    }
    // ════════════════════════════════════════════════════════════════════════
    // PHASE 3: Handle source
    // ════════════════════════════════════════════════════════════════════════

    const movedToMeta = {
      taskId: performNativeTransfer ? taskId : newMcTaskId,
      sourceId: newSourceId,
      connectorType: targetConnectorRow.type,
      connectorInstanceId: targetConnectorInstanceId,
      sourceListId: targetSourceListId,
      [sourceAction === 'move' ? 'movedAt' : 'copiedAt']: now,
    };

    if (performNativeTransfer) {
      // The connector's identity-safe transfer has already updated active routing atomically.
      compensateRemoteCreation = null;
      return successResponse({
        newTaskId: taskId,
        newSourceId,
        sourceAction: 'move',
        nativeTransfer: true,
        warnings,
      });
    }

    if (sourceAction === 'move') {
      // Finalize the local graph before touching the source. Until this commits,
      // remote destination creation is still compensatable.
      let sourceDeletionFailed = !isLocalSource;
      const pendingSourceMeta = {
        ...parseMetadata(srcTask.metadata),
        movedTo: movedToMeta,
        ...(sourceDeletionFailed ? { pendingCleanup: true } : {}),
      };
      if (!moveClaim) throw new TaskMoveSourceChangedError();
      const activeMoveClaim = moveClaim;
      runTransaction((tx) => {
        const sourceUnchanged = tx.update(tasks).set({
          updatedAt: sql`${tasks.updatedAt}`,
        }).where(and(
          eq(tasks.id, taskId),
          sql`json_extract(${tasks.metadata}, '$.taskMoveClaim.token') = ${activeMoveClaim.token}`,
          ...taskAttachmentSnapshotPredicates(taskId, storedAttachments),
        )).run();
        if (sourceUnchanged.changes !== 1) {
          throw new TaskMoveSourceChangedError();
        }

        repointTaskReferences(tx, taskId, newMcTaskId);
        if (createdSubtasks.length > 0) {
          for (const { sourceTaskId, created } of createdSubtasks) {
            tx.update(tasks).set({
              sourceId: created.sourceId,
              connectorType: targetConnectorRow.type,
              connectorInstanceId: targetConnectorInstanceId,
              sourceListId: targetSourceListId,
              sourceListName: targetListName,
              parentId: newMcTaskId,
              updatedAt: now,
              syncStatus: 'synced',
              lastSyncedAt: now,
            }).where(eq(tasks.id, sourceTaskId)).run();
            tx.delete(taskAttachments).where(eq(taskAttachments.taskId, sourceTaskId)).run();
            const preservedAttachments = destinationSubtaskAttachments.get(sourceTaskId) ?? [];
            if (preservedAttachments.length > 0) {
              tx.insert(taskAttachments).values(
                preservedAttachments.map((attachment) => ({
                  ...attachment,
                  taskId: sourceTaskId,
                })),
              ).run();
            }
          }
        } else {
          for (const subtask of subtasks) {
            tx.update(tasks).set({
              sourceId: `local:${subtask.id}`,
              connectorType: 'local',
              connectorInstanceId: 'local',
              sourceListId: null,
              sourceListName: null,
              parentId: newMcTaskId,
              updatedAt: now,
              syncStatus: 'synced',
              lastSyncedAt: now,
            }).where(eq(tasks.id, subtask.id)).run();
            tx.delete(taskAttachments).where(eq(taskAttachments.taskId, subtask.id)).run();
            const preservedAttachments = storedSubtaskAttachments.get(subtask.id) ?? [];
            if (preservedAttachments.length > 0) {
              tx.insert(taskAttachments).values(
                preservedAttachments.map((attachment) => ({
                  id: crypto.randomUUID(),
                  taskId: subtask.id,
                  name: attachment.name,
                  contentType: attachment.contentType,
                  size: attachment.size,
                  contentBase64: attachment.contentBase64,
                  createdAt: attachment.createdAt,
                })),
              ).run();
            }
          }
        }

        tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
        tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();

        if (isLocalSource) {
          tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
          tx.delete(tasks).where(eq(tasks.id, taskId)).run();
        } else {
          const movedNote = `[Moved to ${targetConnectorRow.type}${targetListName ? ` / ${targetListName}` : ''} on ${now.slice(0, 10)}]`;
          const updatedDescription = srcTask.description
            ? `${movedNote}\n\n${srcTask.description}`
            : movedNote;
          tx.update(tasks).set({
            status: sourceConnector?.completeTask && !sourceConnector.deleteTask
              ? 'done'
              : 'cancelled',
            statusReason: 'moved',
            description: updatedDescription,
            updatedAt: now,
            syncStatus: 'pending_push',
            metadata: JSON.stringify(pendingSourceMeta),
          }).where(eq(tasks.id, taskId)).run();
        }
      });
      compensateRemoteCreation = null;

      // Dispose the source only after the durable local move is complete.
      if (sourceConnector?.deleteTask) {
        try {
          const deleteSource = () => sourceConnector.deleteTask!(srcTask.sourceId);
          if (sourceConnector.type === 'github-issues') {
            await executeFencedGitHubTaskMutation({
              connectorInstanceId: srcTask.connectorInstanceId,
              taskId,
              operation: 'delete',
              connector: sourceConnector,
              write: deleteSource,
            });
          } else {
            await deleteSource();
          }
          sourceDeletionFailed = false;
        } catch (err) {
          if (err instanceof GitHubWriteFenceError || err instanceof GitHubUnknownWriteOutcomeError) {
            throw err;
          }
          connectorLogger.warn(
            { ...logContext, ...sanitizeException(err) },
            'Source deletion failed after move - marking as pending cleanup',
          );
          warnings.push('Source task could not be deleted. It has been marked for cleanup on next sync.');
        }
      } else if (sourceConnector?.completeTask) {
        // Connector doesn't support deletion (e.g. GitHub) — close + comment instead
        try {
          const closeSource = async () => {
            await sourceConnector.completeTask!(srcTask.sourceId);
            if (addCrossReference && sourceConnector.addComment) {
              const crossRef = buildCrossReferenceNote('source', targetConnectorRow.type, targetListName, srcTask.title);
              await sourceConnector.addComment(srcTask.sourceId, crossRef);
            }
          };
          if (sourceConnector.type === 'github-issues') {
            await executeFencedGitHubTaskMutation({
              connectorInstanceId: srcTask.connectorInstanceId,
              taskId,
              operation: 'complete',
              connector: sourceConnector,
              write: closeSource,
            });
          } else {
            await closeSource();
          }
          sourceDeletionFailed = false;
        } catch (err) {
          if (err instanceof GitHubWriteFenceError || err instanceof GitHubUnknownWriteOutcomeError) {
            throw err;
          }
          connectorLogger.warn(
            { ...logContext, ...sanitizeException(err) },
            'Failed to close source task after move',
          );
          warnings.push('Source task could not be closed automatically. It has been marked for cleanup on next sync.');
        }
      }

      if (!isLocalSource) {
        const sourceMeta = {
          ...parseMetadata(srcTask.metadata),
          movedTo: movedToMeta,
          ...(sourceDeletionFailed ? { pendingCleanup: true } : {}),
        };
        await db.update(tasks).set({
          syncStatus: sourceDeletionFailed ? 'pending_push' : 'synced',
          metadata: JSON.stringify(sourceMeta),
        }).where(eq(tasks.id, taskId));
      }
    } else {
      // Copy: keep source alive, add cross-reference comment
      compensateRemoteCreation = null;
      if (addCrossReference && sourceConnector?.addComment) {
        const crossRef = buildCrossReferenceNote('source', targetConnectorRow.type, targetListName, srcTask.title);
        const addSourceComment = () => sourceConnector.addComment!(srcTask.sourceId, crossRef);
        const commentPromise = sourceConnector.type === 'github-issues'
          ? executeFencedGitHubTaskMutation({
            connectorInstanceId: srcTask.connectorInstanceId,
            taskId,
            operation: 'comment',
            connector: sourceConnector,
            write: addSourceComment,
          })
          : addSourceComment();
        await commentPromise.catch((err) => {
          if (err instanceof GitHubWriteFenceError || err instanceof GitHubUnknownWriteOutcomeError) {
            throw err;
          }
          connectorLogger.warn(
            { ...logContext, ...sanitizeException(err) },
            'Failed to add cross-reference comment to source',
          );
          warnings.push('Could not add cross-reference link to the original task.');
        });
      }

      // Update source task metadata with "movedTo" provenance
      const srcMeta = { ...parseMetadata(srcTask.metadata), copiedTo: movedToMeta };
      await db.update(tasks).set({
        updatedAt: now,
        metadata: JSON.stringify(srcMeta),
      }).where(eq(tasks.id, taskId));
    }

    return successResponse({
      newTaskId: newMcTaskId,
      newSourceId,
      sourceAction,
      subtasksMoved,
      warnings,
    }, 201);
  } catch (error) {
    let compensationError: unknown;
    if (compensateRemoteCreation && !(error instanceof GitHubUnknownWriteOutcomeError)) {
      try {
        await compensateRemoteCreation();
      } catch (cleanupError) {
        compensationError = cleanupError;
      }
    }
    if (moveClaim) {
      try {
        releaseTaskMoveClaim(moveClaim.taskId, moveClaim);
      } catch (cleanupError) {
        compensationError ??= cleanupError;
      }
    }
    if (compensationError) {
      connectorLogger.error(
        {
          ...logContext,
          phase: 'compensation',
          compensationStatus: 'failure',
          durationMs: Date.now() - startedAt,
          ...sanitizeException(compensationError),
        },
        'Task move compensation failed',
      );
    }
    if (error instanceof TaskMoveSourceChangedError && !compensationError) {
      return failureResponse(
        serviceResult(
          {
            error: error.message,
            code: 'TASK_MOVE_SOURCE_CHANGED',
          },
          409,
        ),
        'source_task_changed',
        error,
      );
    }
    if (error instanceof TaskMoveBudgetError && !compensationError) {
      return failureResponse(
        serviceResult(
          { error: error.message, code: 'TASK_MOVE_BUDGET_EXCEEDED', budgets: TASK_MOVE_BUDGETS },
          413,
        ),
        'resource_budget_exceeded',
        error,
      );
    }
    return failureResponse(
      serviceResult(
        {
          error: 'Failed to execute task move',
          code: 'INTERNAL_ERROR',
          ...(traceId ? { traceId } : {}),
        },
        500,
      ),
      compensationError ? 'internal_error_compensation_failed' : 'internal_error',
      error,
    );
  }

  async function materializeMoveAttachment(
    attachment: MoveAttachment,
    taskSourceId: string,
    sourceConnector: ReturnType<typeof connectorRegistry.getConnector>,
    description: string,
  ): Promise<number> {
    if (!attachment.contentBase64) {
      if (!attachment.sourceAttachmentId || !sourceConnector?.getAttachmentContent) {
        throw new Error(
          `${description} cannot be read from the source. The operation was stopped to prevent data loss.`,
        );
      }
      const content = await sourceConnector.getAttachmentContent(
        taskSourceId,
        attachment.sourceAttachmentId,
      );
      attachment.contentBase64 = content.contentBase64;
      attachment.contentType = content.contentType || attachment.contentType;
    }
    const materializedBytes = Buffer.from(attachment.contentBase64, 'base64').byteLength;
    if (materializedBytes > TASK_MOVE_BUDGETS.maxAttachmentBytes) {
      throw new TaskMoveBudgetError(`${description} exceeds the attachment byte limit.`);
    }
    return materializedBytes;
  }
}

interface TaskMoveLogContext {
  operation: 'task_move';
  traceId?: string;
  taskId?: string;
  source_type?: string;
  sourceConnectorType?: string;
  sourceConnectorInstanceId?: string;
  destinationConnectorType?: string;
  destinationConnectorInstanceId?: string;
  destinationListId?: string;
  sourceAction?: SourceAction;
}

interface TaskMoveClaim {
  token: string;
  taskId: string;
  originalMetadata: Record<string, unknown>;
  originalSyncStatus: string;
}

function claimTaskMove(sourceTask: typeof tasks.$inferSelect): TaskMoveClaim | null {
  const metadata = parseMetadata(sourceTask.metadata);
  if (sourceTask.syncStatus === 'move_in_progress') return null;

  const originalMetadata = { ...metadata };
  delete originalMetadata.taskMoveClaim;
  const originalSyncStatus = sourceTask.syncStatus;
  const token = crypto.randomUUID();
  return runTransaction((tx) => {
    const result = tx.update(tasks).set({
      syncStatus: 'move_in_progress',
      metadata: {
        ...originalMetadata,
        taskMoveClaim: {
          token,
          claimedAt: new Date().toISOString(),
          previousSyncStatus: originalSyncStatus,
        },
      },
    }).where(and(
      eq(tasks.id, sourceTask.id),
      eq(tasks.sourceId, sourceTask.sourceId),
      eq(tasks.syncStatus, sourceTask.syncStatus),
    )).run();
    if (result.changes !== 1) return null;

    return {
      token,
      taskId: sourceTask.id,
      originalMetadata,
      originalSyncStatus,
    };
  });
}

function releaseTaskMoveClaim(taskId: string, claim: TaskMoveClaim): void {
  runTransaction((tx) => {
    tx.update(tasks).set({
      syncStatus: claim.originalSyncStatus,
      metadata: claim.originalMetadata,
    }).where(and(
      eq(tasks.id, taskId),
      sql`json_extract(${tasks.metadata}, '$.taskMoveClaim.token') = ${claim.token}`,
    )).run();
  });
}

function boundedLogValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, 128);
}

function sanitizeException(error: unknown): {
  exceptionType?: string;
  exceptionCode?: string;
  exceptionStatus?: number;
} {
  if (!error || typeof error !== 'object') return {};
  const record = error as Record<string, unknown>;
  const rawName = error instanceof Error ? error.name : record.name;
  const exceptionType = typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : 'Error';
  const rawCode = record.code;
  const exceptionCode = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode)
    ? rawCode
    : undefined;
  const rawStatus = record.status;
  const exceptionStatus = typeof rawStatus === 'number'
    && Number.isInteger(rawStatus)
    && rawStatus >= 100
    && rawStatus <= 599
    ? rawStatus
    : undefined;
  return { exceptionType, exceptionCode, exceptionStatus };
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try { return JSON.parse(raw as string) as Record<string, unknown>; } catch { return {}; }
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

function parseStringArray(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  const parsed = JSON.parse(String(raw)) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === 'string')
    : [];
}

function formatSubtaskForDescription(subtask: typeof tasks.$inferSelect): string {
  const details = [
    subtask.description && `description: ${subtask.description.replace(/\s+/g, ' ').trim()}`,
    subtask.priority !== 'none' && `priority: ${subtask.priority}`,
    subtask.dueDate && `due: ${subtask.dueDate}`,
    subtask.assignee && `assignee: ${subtask.assignee}`,
    subtask.effort && `effort: ${subtask.effort}`,
    subtask.microStatus && `status detail: ${subtask.microStatus}`,
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` — ${details.join('; ')}` : '';
  return `- [${subtask.status === 'done' ? 'x' : ' '}] ${subtask.title}${suffix}`;
}
