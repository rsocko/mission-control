import { NextResponse } from 'next/server';
import { formatInTimeZone } from 'date-fns-tz';
import db, { runTransaction } from '@/db';
import {
  tasks,
  taskTags,
  taskProjects,
  taskDependencies,
  taskAttachments,
  taskSchedules,
  taskFieldStates,
  taskHistoryEvents,
  prioritySyncLog,
  myDayItems,
  tags as tagsTable,
  projectPhaseItems,
} from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveOutboundPriority } from '@/lib/priority';
import { randomUUID } from 'crypto';
import { emitEvent } from '@/lib/events';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler, logWriteThrough } from '@/lib/sync';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { getLocalToday } from '@/lib/utils/date';
import { buildDeepLinkUrl } from '@/lib/utils/deep-links';
import logger from '@/lib/logger';
import { getStatusLifecycleUpdates } from '@/lib/tasks/status-lifecycle';
import { getTimezone, isDemoMode } from '@/lib/mode';
import {
  resolveTaskFieldPolicy,
  type FieldPolicy,
} from '@/lib/tasks/field-policy';
import { isNotificationOnlyConnectorType } from '@/lib/connectors/task-source-profiles';
import { indexTaskSearch, publishTaskSemanticUpdate, removeTaskSearch } from '@/lib/search';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import {
  isMergeableTaskField,
  resolveLocalOverrideChange,
  type LocalOverrideChange,
  type TaskFieldStateRecord,
} from '@/lib/tasks/field-state';
import { parseTaskPatchInput, type TaskPatchInput } from '@/lib/tasks/task-patch';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import { deleteTaskLocally } from '@/lib/tasks/local-task-lifecycle';
import type { TaskField, TaskItem, TaskPriority } from '@/types';
import {
  suppressAutoCompletionAfterReopen,
  supersedePendingReconciliationSuggestions,
  wasTaskAutoCompletedByReconciliation,
} from '@/lib/connectors/scout/reconciliation-service';
import { evaluateRulesForTasks } from '@/lib/rules';
import { resolveRelativeReminderMutation } from '@/lib/tasks/relative-reminder';
import { computeRelativeReminderAt, isReminderRelativeRule } from '@/lib/tasks/relative-reminder';
import { getCompletionAnchoredDueDate } from '@/lib/utils/recurrence';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';

const taskWriteThroughQueues = new Map<string, Promise<void>>();

class TaskRevisionConflictError extends Error {}

function enqueueTaskWriteThrough(taskId: string, write: () => Promise<void>): Promise<void> {
  const previous = taskWriteThroughQueues.get(taskId) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(write);
  taskWriteThroughQueues.set(taskId, queued);
  void queued.finally(() => {
    if (taskWriteThroughQueues.get(taskId) === queued) {
      taskWriteThroughQueues.delete(taskId);
    }
  }).catch(() => {});
  return queued;
}

/**
 * PATCH /api/tasks/[id] — Update a task (title, status, priority, tags, etc.)
 * Immediate write-through: updates local DB optimistically, then pushes to source.
 * Returns success immediately (optimistic). Write-back errors are logged and
 * the task stays `pending_push` for retry on next sync.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const parsed = parseTaskPatchInput(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error);
    }
    const input = parsed.input;

    const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!currentTask) {
      return ApiErrors.notFound('Task');
    }
    const currentSchedule = (
      input.status === 'done'
      || input.status === 'cancelled'
      || input.recurrenceMode !== undefined
    )
      ? await db.select({
          recurrence: taskSchedules.recurrence,
          recurrenceMode: taskSchedules.recurrenceMode,
          estimatedDuration: taskSchedules.estimatedDuration,
          scheduledTime: taskSchedules.scheduledTime,
          isTimeBlocked: taskSchedules.isTimeBlocked,
        })
          .from(taskSchedules)
          .where(eq(taskSchedules.taskId, id))
      : [];
    const expectedUpdatedAt = request.headers.get('x-expected-task-updated-at');
    if (expectedUpdatedAt && currentTask.updatedAt !== expectedUpdatedAt) {
      return NextResponse.json({
        error: 'Task changed before this update could be applied',
        code: 'TASK_REVISION_CONFLICT',
      }, { status: 409 });
    }
    if (
      currentTask.connectorType === 'microsoft-todo-work'
      && currentTask.isChecklistItem
      && parsed.fields.length > 0
    ) {
      return NextResponse.json({
        error: 'Microsoft To Do checklist items are read-only until checklist write-back is enabled',
        code: 'FORBIDDEN',
      }, { status: 403 });
    }
    if (
      currentTask.connectorType === 'microsoft-todo-work'
      && input.status === 'cancelled'
    ) {
      return NextResponse.json({
        error: 'Microsoft To Do tasks cannot be cancelled through this bridge',
        code: 'FORBIDDEN',
      }, { status: 403 });
    }

    const localIdentity = currentTask.sourceId.startsWith('local:')
      || currentTask.connectorType === 'local';
    if (input.recurrenceMode === 'completion' && !localIdentity) {
      return ApiErrors.badRequest(
        'Completion-anchored recurrence is available only for local tasks',
      );
    }
    if (
      input.recurrenceMode === 'completion'
      && !(input.recurrence ?? currentSchedule[0]?.recurrence)
    ) {
      return ApiErrors.badRequest(
        'Choose a recurrence interval before anchoring it to completion',
      );
    }
    const [capabilities, connectorEnabled] = localIdentity
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(currentTask.connectorInstanceId),
          isConnectorEnabled(currentTask.connectorInstanceId),
        ]);
    const taskIdentity = {
      sourceId: currentTask.sourceId,
      connectorType: currentTask.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    };
    if (
      input.status !== undefined
      && capabilities?.supportedTaskStatuses
      && !capabilities.supportedTaskStatuses.includes(input.status)
    ) {
      return ApiErrors.validation(
        `This task source does not support status "${input.status}"`,
      );
    }
    const policies = new Map<TaskField, FieldPolicy>(
      parsed.fields.map((field) => [
        field,
        resolveTaskFieldPolicy(taskIdentity, capabilities, field),
      ]),
    );
    const statusReasonPolicy = input.status !== undefined
      ? resolveTaskFieldPolicy(taskIdentity, capabilities, 'statusReason')
      : policies.get('statusReason');
    const dispositionPolicy = policies.get('localDisposition');
    if (
      input.localDisposition === 'active'
      && currentTask.localDisposition !== 'active'
      && dispositionPolicy
      && dispositionPolicy.sourceModel !== 'remote-mirror'
    ) {
      policies.set('localDisposition', {
        ...dispositionPolicy,
        mutation: 'local',
        reason: undefined,
      });
    }
    const blockedFields = Object.fromEntries(
      [...policies.values()]
        .filter((policy) => policy.mutation === 'blocked')
        .map((policy) => [policy.field, policy.reason]),
    );
    if (Object.keys(blockedFields).length > 0) {
      logger.warn({
        taskId: id,
        connectorInstanceId: currentTask.connectorInstanceId,
        sourceModel: [...policies.values()][0]?.sourceModel,
        blockedFields: Object.keys(blockedFields),
      }, 'Task update blocked by field policy');
      return NextResponse.json({
        error: 'Some fields cannot be changed for this task source',
        code: 'FORBIDDEN',
        blockedFields,
      }, { status: 403 });
    }

    let tagWriteThrough: WriteThroughUpdates['tags'];
    if (input.tags !== undefined && policies.get('tags')?.mutation === 'write-through') {
      const currentLinks = await db.select({ tagId: taskTags.tagId })
        .from(taskTags)
        .where(eq(taskTags.taskId, id));
      const currentIds = new Set(currentLinks.map((link) => link.tagId));
      const requestedIds = new Set(input.tags);
      const changedIds = [
        ...new Set([
          ...input.tags.filter((tagId) => !currentIds.has(tagId)),
          ...currentLinks.filter((link) => !requestedIds.has(link.tagId)).map((link) => link.tagId),
        ]),
      ];
      const changedTags = changedIds.length > 0
        ? await db.select({ id: tagsTable.id, name: tagsTable.name })
            .from(tagsTable)
            .where(inArray(tagsTable.id, changedIds))
        : [];
      const namesById = new Map(changedTags.map((tag) => [tag.id, tag.name]));
      tagWriteThrough = {
        add: input.tags
          .filter((tagId) => !currentIds.has(tagId))
          .flatMap((tagId) => namesById.get(tagId) ?? []),
        remove: currentLinks
          .filter((link) => !requestedIds.has(link.tagId))
          .flatMap((link) => namesById.get(link.tagId) ?? []),
      };
    }

    const now = new Date().toISOString();
    const isReopening = input.status !== undefined
      && currentTask.status !== input.status
      && ['done', 'cancelled'].includes(currentTask.status)
      && !['done', 'cancelled'].includes(input.status);
    const suppressFutureAutoCompletion = isReopening
      && await wasTaskAutoCompletedByReconciliation(id);
    const isBecomingTerminal = input.status !== undefined
      && currentTask.status !== input.status
      && !['done', 'cancelled'].includes(currentTask.status)
      && ['done', 'cancelled'].includes(input.status);
    const shouldReturnCompletionOccurrence = input.status === 'done'
      && currentSchedule[0]?.recurrenceMode === 'completion'
      && Boolean(currentSchedule[0].recurrence)
      && localIdentity;
    const shouldCreateCompletionOccurrence = shouldReturnCompletionOccurrence
      && isBecomingTerminal;

    const updates: Record<string, unknown> = { updatedAt: now };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.localDisposition !== undefined) {
      updates.localDisposition = input.localDisposition;
    }
    const lifecycleUpdates = getStatusLifecycleUpdates({
      status: input.status,
      explicitReason: input.statusReason,
      completedAt: now,
      currentStatus: currentTask.status,
      currentCompletedAt: currentTask.completedAt,
      currentStatusReason: currentTask.statusReason,
    });
    if (
      input.status !== undefined
      && statusReasonPolicy?.mutation === 'blocked'
    ) {
      lifecycleUpdates.statusReason = currentTask.statusReason;
    }
    Object.assign(updates, lifecycleUpdates);
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.planningHorizon !== undefined) updates.planningHorizon = input.planningHorizon;
    if (input.dueDate !== undefined) updates.dueDate = input.dueDate;
    if (input.kanbanColumn !== undefined) updates.kanbanColumn = input.kanbanColumn;
    if (input.kanbanOrder !== undefined) updates.kanbanOrder = input.kanbanOrder;
    if (input.microStatus !== undefined) updates.microStatus = input.microStatus;
    if (input.snoozedUntil !== undefined) updates.snoozedUntil = input.snoozedUntil;
    if (input.effort !== undefined) updates.effort = input.effort;
    if (
      input.dueDate !== undefined
      || input.reminderAt !== undefined
      || input.reminderRelative !== undefined
      || input.reminderDueTime !== undefined
    ) {
      const reminderMutation = resolveRelativeReminderMutation({
        current: currentTask,
        input,
        timezone: getTimezone(),
        now: new Date(now),
      });
      if (!reminderMutation.success) {
        return NextResponse.json({
          error: reminderMutation.error,
          code: reminderMutation.code,
        }, { status: reminderMutation.status });
      }
      Object.assign(updates, reminderMutation.updates);
    }

    if (input.status === 'done' || input.status === 'cancelled') {
      updates.microStatus = null;
      updates.snoozedUntil = null;
      updates.reminderAt = null;
      if (!currentSchedule[0]?.recurrence) {
        updates.reminderRelative = null;
        updates.reminderDueTime = null;
      }
    }

    const shouldWriteThrough = [...policies.values()]
      .some((policy) => policy.mutation === 'write-through');
    if (shouldWriteThrough) {
      updates.syncStatus = 'pending_push';
      updates.pushRetryCount = 0;
      if (currentTask.connectorType === 'microsoft-todo-work') {
        const metadata = currentTask.metadata
          && typeof currentTask.metadata === 'object'
          && !Array.isArray(currentTask.metadata)
          ? currentTask.metadata as Record<string, unknown>
          : {};
        const priorDirtyFields = Array.isArray(metadata.workTodoDirtyFields)
          ? metadata.workTodoDirtyFields.filter((field): field is string => typeof field === 'string')
          : [];
        const outboundFields = parsed.fields.filter((field) => (
          field === 'title'
          || field === 'description'
          || field === 'status'
          || field === 'priority'
          || field === 'dueDate'
        ));
        updates.metadata = {
          ...metadata,
          workTodoDirtyFields: [...new Set([...priorDirtyFields, ...outboundFields])],
        };
      }
    }

    const mergeableFields = parsed.fields.filter(isMergeableTaskField);
    const sourceModel = [...policies.values()][0]?.sourceModel;
    let overrideChanges: LocalOverrideChange[] = [];
    let recurrenceNextTaskId: string | null = null;
    let statusTransitionApplied = true;
    runTransaction((tx) => {
      if (sourceModel === 'ingested' && mergeableFields.length > 0) {
        const stateRows = tx
          .select()
          .from(taskFieldStates)
          .where(eq(taskFieldStates.taskId, id))
          .all() as TaskFieldStateRecord[];
        const statesByField = new Map(stateRows.map((state) => [state.fieldName, state]));
        overrideChanges = mergeableFields.map((fieldName) => resolveLocalOverrideChange({
          taskId: id,
          fieldName,
          newValue: input[fieldName],
          currentSourceValue: currentTask[fieldName],
          state: statesByField.get(fieldName),
          sourceObservedAt: currentTask.lastSyncedAt,
          now,
        }));
      }

      if (input.recurrence !== undefined) {
        const metadataRow = tx
          .select({ metadata: tasks.metadata })
          .from(tasks)
          .where(eq(tasks.id, id))
          .get();
        const parsedMetadata = parseTaskMetadataCompat(metadataRow?.metadata);
        if (
          !parsedMetadata.recoveredLegacy
          && Object.prototype.hasOwnProperty.call(parsedMetadata.metadata, 'recurrence')
        ) {
          const metadata = { ...parsedMetadata.metadata };
          delete metadata.recurrence;
          updates.metadata = JSON.stringify(metadata);
        }
      }

      const updateResult = tx.update(tasks)
        .set(updates)
        .where(and(
          eq(tasks.id, id),
          expectedUpdatedAt ? eq(tasks.updatedAt, expectedUpdatedAt) : undefined,
          isBecomingTerminal ? eq(tasks.status, currentTask.status) : undefined,
        ))
        .run();
      if (expectedUpdatedAt && updateResult.changes === 0) {
        throw new TaskRevisionConflictError('Task changed during update');
      }
      if (isBecomingTerminal && updateResult.changes === 0) {
        statusTransitionApplied = false;
      }

      if (
        input.estimatedDuration !== undefined
        || input.recurrence !== undefined
        || input.recurrenceMode !== undefined
      ) {
        tx.insert(taskSchedules).values({
          taskId: id,
          scheduledDate: getLocalToday(),
          estimatedDuration: input.estimatedDuration,
          recurrence: input.recurrence,
          recurrenceMode: input.recurrence === null
            ? 'schedule'
            : input.recurrenceMode,
          isTimeBlocked: false,
        }).onConflictDoUpdate({
          target: taskSchedules.taskId,
          set: {
            ...(input.estimatedDuration !== undefined
              ? { estimatedDuration: input.estimatedDuration }
              : {}),
            ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
            ...(input.recurrence === null
              ? { recurrenceMode: 'schedule' as const }
              : input.recurrenceMode !== undefined
                ? { recurrenceMode: input.recurrenceMode }
                : {}),
          },
        }).run();
      }

      if (input.tags !== undefined) {
        tx.delete(taskTags).where(eq(taskTags.taskId, id)).run();
        if (input.tags.length > 0) {
          tx.insert(taskTags).values(
            input.tags.map((tagId) => ({ taskId: id, tagId }))
          ).run();
        }
      }

      for (const change of overrideChanges) {
        tx.insert(taskFieldStates).values({
          taskId: id,
          fieldName: change.fieldName,
          sourceValue: change.sourceValue,
          locallyOverridden: change.locallyOverridden,
          sourceObservedAt: change.sourceObservedAt,
          localEditedAt: change.localEditedAt,
          updatedAt: change.updatedAt,
        }).onConflictDoUpdate({
          target: [taskFieldStates.taskId, taskFieldStates.fieldName],
          set: {
            sourceValue: change.sourceValue,
            locallyOverridden: change.locallyOverridden,
            sourceObservedAt: change.sourceObservedAt,
            localEditedAt: change.localEditedAt,
            updatedAt: change.updatedAt,
          },
        }).run();
      }

      if (input.priority !== undefined && input.priority !== currentTask.priority) {
        const outbound = resolveOutboundPriority(
          currentTask.priority as TaskPriority,
          input.priority,
          currentTask.connectorType,
        );

        tx.insert(prioritySyncLog).values({
          id: randomUUID(),
          taskId: id,
          connectorType: currentTask.connectorType,
          connectorInstanceId: currentTask.connectorInstanceId,
          previousPriority: currentTask.priority,
          newPriority: input.priority,
          direction: 'outbound',
          writeBackTriggered: policies.get('priority')?.mutation === 'write-through'
            && outbound.shouldWrite,
          note: outbound.event?.note || `Priority changed to ${input.priority}`,
          timestamp: now,
        }).run();
      }
      if (
        input.planningHorizon !== undefined
        && input.planningHorizon !== currentTask.planningHorizon
      ) {
        tx.insert(taskHistoryEvents).values({
          taskId: id,
          eventType: 'planning_horizon_changed',
          fieldName: 'planningHorizon',
          previousValue: currentTask.planningHorizon,
          newValue: input.planningHorizon,
          occurredAt: now,
          recordedAt: now,
          provenance: 'task-patch',
        }).run();
      }
      if (suppressFutureAutoCompletion) {
        suppressAutoCompletionAfterReopen(tx, id, now);
      }
      if (isBecomingTerminal && statusTransitionApplied) {
        supersedePendingReconciliationSuggestions(tx, id, now);
      }

      if (shouldCreateCompletionOccurrence && statusTransitionApplied) {
        const recurrence = currentSchedule[0]!.recurrence!;
        const nextTaskId = randomUUID();
        const recurrenceTimezone = getTimezone();
        const includeCompletionTime = Boolean(
          currentTask.dueDate?.includes('T') || currentSchedule[0]?.scheduledTime,
        );
        const nextDueDate = getCompletionAnchoredDueDate(
          now,
          recurrence,
          recurrenceTimezone,
          includeCompletionTime,
        );
        const nextScheduledDate = nextDueDate.includes('T')
          ? formatInTimeZone(nextDueDate, recurrenceTimezone, 'yyyy-MM-dd')
          : nextDueDate;
        const nextScheduledTime = includeCompletionTime
          ? formatInTimeZone(now, recurrenceTimezone, 'HH:mm')
          : null;
        const metadata = parseTaskMetadataCompat(currentTask.metadata).metadata;
        delete metadata.workTodoDirtyFields;
        delete metadata.triageItemId;
        metadata.missionControlTaskId = nextTaskId;
        metadata.recurrencePreviousTaskId = id;

        let nextReminderAt: string | null = null;
        const relativeRule = currentTask.reminderRelative ?? '';
        if (isReminderRelativeRule(relativeRule) && currentTask.reminderDueTime) {
          const reminder = computeRelativeReminderAt({
            dueDate: nextScheduledDate,
            dueTime: currentTask.reminderDueTime,
            timezone: recurrenceTimezone,
            rule: relativeRule,
          });
          if (reminder.success) nextReminderAt = reminder.reminderAt;
        }

        const inserted = tx.insert(tasks).values({
          id: nextTaskId,
          sourceId: `local:${nextTaskId}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          title: currentTask.title,
          description: currentTask.description,
          status: 'todo',
          localDisposition: 'active',
          priority: currentTask.priority,
          planningHorizon: currentTask.planningHorizon,
          dueDate: nextDueDate,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          recurrenceGeneratedFromTaskId: id,
          parentId: currentTask.parentId,
          depth: currentTask.depth,
          isChecklistItem: currentTask.isChecklistItem,
          sourceListId: currentTask.sourceListId,
          sourceListName: currentTask.sourceListName,
          assignee: currentTask.assignee,
          metadata,
          syncStatus: 'synced',
          lastSyncedAt: now,
          kanbanColumn: currentTask.kanbanColumn,
          kanbanOrder: currentTask.kanbanOrder,
          reminderAt: nextReminderAt,
          reminderRelative: isReminderRelativeRule(currentTask.reminderRelative ?? '')
            ? currentTask.reminderRelative
            : null,
          reminderDueTime: isReminderRelativeRule(currentTask.reminderRelative ?? '')
            ? currentTask.reminderDueTime
            : null,
          effort: currentTask.effort,
          isBulkImport: false,
        }).onConflictDoNothing().run();

        if (inserted.changes > 0) {
          recurrenceNextTaskId = nextTaskId;
          tx.insert(taskSchedules).values({
            taskId: nextTaskId,
            scheduledDate: nextScheduledDate,
            scheduledTime: nextScheduledTime,
            estimatedDuration: currentSchedule[0]?.estimatedDuration,
            isTimeBlocked: currentSchedule[0]?.isTimeBlocked ?? false,
            recurrence,
            recurrenceMode: 'completion',
          }).run();

          const tagRows = tx.select({ tagId: taskTags.tagId })
            .from(taskTags).where(eq(taskTags.taskId, id)).all();
          if (tagRows.length) {
            tx.insert(taskTags).values(tagRows.map((row) => ({
              taskId: nextTaskId,
              tagId: row.tagId,
            }))).run();
          }
          const projectRows = tx.select({ projectId: taskProjects.projectId })
            .from(taskProjects).where(eq(taskProjects.taskId, id)).all();
          if (projectRows.length) {
            tx.insert(taskProjects).values(projectRows.map((row) => ({
              taskId: nextTaskId,
              projectId: row.projectId,
            }))).run();
          }
          const phaseRows = tx.select().from(projectPhaseItems)
            .where(eq(projectPhaseItems.taskId, id)).all();
          if (phaseRows.length) {
            tx.insert(projectPhaseItems).values(phaseRows.map((row) => ({
              ...row,
              id: randomUUID(),
              taskId: nextTaskId,
              createdAt: now,
            }))).run();
          }
          const dependencyRows = tx.select().from(taskDependencies)
            .where(eq(taskDependencies.taskId, id)).all();
          if (dependencyRows.length) {
            tx.insert(taskDependencies).values(dependencyRows.map((row) => ({
              ...row,
              id: randomUUID(),
              taskId: nextTaskId,
              syncStatus: 'local' as const,
              syncAction: null,
              syncError: null,
              lastSyncedAt: null,
              createdAt: now,
            }))).run();
          }
          const attachmentRows = tx.select().from(taskAttachments)
            .where(eq(taskAttachments.taskId, id)).all();
          if (attachmentRows.length) {
            tx.insert(taskAttachments).values(attachmentRows.map((row) => ({
              ...row,
              id: randomUUID(),
              taskId: nextTaskId,
              createdAt: now,
            }))).run();
          }
        } else {
          recurrenceNextTaskId = tx.select({ id: tasks.id }).from(tasks)
            .where(eq(tasks.recurrenceGeneratedFromTaskId, id)).get()?.id ?? null;
        }
      }
    });
    if (shouldReturnCompletionOccurrence && !recurrenceNextTaskId) {
      recurrenceNextTaskId = (await db.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.recurrenceGeneratedFromTaskId, id)).limit(1))[0]?.id ?? null;
    }

    logger.info({
      taskId: id,
      connectorInstanceId: currentTask.connectorInstanceId,
      sourceModel,
      fieldsByMode: Object.fromEntries(
        ['local', 'write-through', 'pull-write-back'].map((mode) => [
          mode,
          [...policies.values()]
            .filter((policy) => policy.mutation === mode)
            .map((policy) => policy.field),
        ]),
      ),
      overridesCreated: overrideChanges
        .filter((change) => change.action === 'created')
        .map((change) => change.fieldName),
      overridesCleared: overrideChanges
        .filter((change) => change.action === 'cleared')
        .map((change) => change.fieldName),
    }, 'Applied task field policies');

    if (input.title !== undefined || input.description !== undefined) {
      const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (updatedTask) await indexTaskSearch(updatedTask);
    } else {
      // The keyword index only tracks title/description, but the semantic
      // projection also carries status, priority, tags, and list membership, so
      // any accepted mutation still has to publish a re-index intent.
      await publishTaskSemanticUpdate(id);
    }
    const completedNow = input.status === 'done'
      && currentTask.status !== 'done'
      && statusTransitionApplied;
    if (completedNow) {
      emitEvent({
        type: 'task.completed',
        timestamp: now,
        payload: {
          id,
          title: input.title ?? currentTask.title,
          connectorType: currentTask.connectorType,
          priority: input.priority ?? currentTask.priority,
          completedAt: updates.completedAt ?? now,
        },
      }).catch((err) => logger.error({ err, taskId: id }, 'Failed to emit task completed event'));
    }

    if (shouldWriteThrough) {
      const writeThroughUpdates = {
        ...pickWriteThroughUpdates(input, updates, policies, statusReasonPolicy),
        ...(tagWriteThrough ? { tags: tagWriteThrough } : {}),
      };
      enqueueTaskWriteThrough(id, () => writeThrough(currentTask, writeThroughUpdates, id)).catch((err) => {
        logger.error({ err, taskId: id }, 'Write-through task update failed unexpectedly');
      });
    }

    if (input.title !== undefined || input.tags !== undefined) {
      try {
        await evaluateRulesForTasks([id]);
      } catch (error) {
        logger.error({ err: error, taskId: id }, 'Project auto-include evaluation failed after task update');
      }
    }

    const reminderChanged = (
      input.dueDate !== undefined
      || input.reminderAt !== undefined
      || input.reminderRelative !== undefined
      || input.reminderDueTime !== undefined
      || input.status === 'done'
      || input.status === 'cancelled'
    );
    const reminder = reminderChanged
      ? {
          reminderAt: updates.reminderAt !== undefined
            ? updates.reminderAt
            : currentTask.reminderAt ?? null,
          reminderRelative: updates.reminderRelative !== undefined
            ? updates.reminderRelative
            : currentTask.reminderRelative ?? null,
          reminderDueTime: updates.reminderDueTime !== undefined
            ? updates.reminderDueTime
            : currentTask.reminderDueTime ?? null,
        }
      : undefined;

    return NextResponse.json({
      success: true,
      fields: Object.fromEntries(
        [...policies.values()].map((policy) => [
          policy.field,
          { mode: policy.mutation, persisted: true },
        ]),
      ),
      ...(reminder ? { reminder } : {}),
      ...(recurrenceNextTaskId ? { recurrenceNextTaskId } : {}),
    });
  } catch (error) {
    if (error instanceof TaskRevisionConflictError) {
      return NextResponse.json({
        error: error.message,
        code: 'TASK_REVISION_CONFLICT',
      }, { status: 409 });
    }
    return ApiErrors.internal('Failed to update task', error);
  }
}

type WriteThroughUpdates = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  recurrence?: string | null;
  microStatus?: string | null;
  statusReason?: string | null;
  tags?: { add: string[]; remove: string[] };
};

function pickWriteThroughUpdates(
  input: TaskPatchInput,
  lifecycleUpdates: Record<string, unknown>,
  policies: Map<TaskField, FieldPolicy>,
  statusReasonPolicy: FieldPolicy | undefined,
): WriteThroughUpdates {
  const writes = (field: TaskField) => policies.get(field)?.mutation === 'write-through';
  return {
    ...(writes('title') && input.title !== undefined ? { title: input.title } : {}),
    ...(writes('description') && input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(writes('status') && input.status !== undefined
      ? {
          status: input.status,
          ...(statusReasonPolicy?.mutation === 'write-through' && (
            typeof lifecycleUpdates.statusReason === 'string'
            || lifecycleUpdates.statusReason === null
          )
            ? { statusReason: lifecycleUpdates.statusReason }
            : {}),
        }
      : {}),
    ...(writes('statusReason') && input.statusReason !== undefined
      ? { statusReason: input.statusReason }
      : {}),
    ...(writes('priority') && input.priority !== undefined ? { priority: input.priority } : {}),
    ...(writes('dueDate') && input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    ...(writes('recurrence') && input.recurrence !== undefined
      ? { recurrence: input.recurrence }
      : {}),
    ...(writes('microStatus') && input.microStatus !== undefined
      ? { microStatus: input.microStatus }
      : {}),
  };
}

/**
 * Attempt immediate write-through to source connector.
 * On success: marks task as synced.
 * On failure: marks task as pending_push (will retry on next sync).
 */
async function writeThrough(
  currentTask: { id: string; sourceId: string; connectorInstanceId: string; connectorType: string; status: string; isChecklistItem: boolean; parentId: string | null; title: string },
  updates: WriteThroughUpdates,
  taskId: string,
) {
  try {
    let connector = connectorRegistry.getConnector(currentTask.connectorInstanceId) ?? null;
    if (!connector) {
      connector = await syncScheduler.initializeConnectorFromDb(currentTask.connectorInstanceId);
    }
    if (!connector) {
      // Can't reach connector — leave as pending_push
      await db.update(tasks).set({ syncStatus: 'pending_push' }).where(eq(tasks.id, taskId));
      return;
    }
    if (connector.writeDelivery === 'deferred') {
      // The bridge change endpoint snapshots this pending task for Scout/Power Automate.
      return;
    }

    // Route to the appropriate connector method
    // Legacy checklist items (body checkboxes with checklist: sourceIds) can't be
    // pushed individually — mark as synced since they live in the parent's description.
    if (currentTask.sourceId.startsWith('checklist:')) {
      await db.update(tasks).set({ syncStatus: 'synced', lastSyncedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
      return;
    }

    const performRemoteWrite = async () => {
    if (updates.tags) {
      if (updates.tags.add.length > 0 && !connector.addTagToTask) {
        throw new Error('Connector does not support adding task tags');
      }
      if (updates.tags.remove.length > 0 && !connector.removeTagFromTask) {
        throw new Error('Connector does not support removing task tags');
      }
      for (const tagName of updates.tags.add) {
        await connector.addTagToTask!(currentTask.sourceId, tagName);
      }
      for (const tagName of updates.tags.remove) {
        await connector.removeTagFromTask!(currentTask.sourceId, tagName);
      }
    }
    const hasTaskUpdates = Object.entries(updates)
      .some(([field, value]) => field !== 'tags' && value !== undefined);
    if (!hasTaskUpdates) {
      await db.update(tasks).set({
        syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString(),
      }).where(eq(tasks.id, taskId));
      return;
    }

    if (updates.status === 'done' && currentTask.isChecklistItem && currentTask.parentId) {
      // Checklist item completion — look up parent's sourceId and use completeSubTask
      const [parentTask] = await db.select({ sourceId: tasks.sourceId }).from(tasks).where(eq(tasks.id, currentTask.parentId));
      if (parentTask && parentTask.sourceId.includes(':') && connector.completeSubTask) {
        await connector.completeSubTask(parentTask.sourceId, currentTask.sourceId);
      } else if (connector.updateSubTask && parentTask && parentTask.sourceId.includes(':')) {
        await connector.updateSubTask(parentTask.sourceId, currentTask.sourceId, { status: 'done' });
      } else if (connector.completeTask) {
        // Fallback for sub-issues that are real issues (e.g. GH sub-issues)
        await connector.completeTask(currentTask.sourceId);
      }
    } else if (currentTask.isChecklistItem && currentTask.parentId && connector.updateSubTask) {
      // Checklist item update (title, etc.) — route to updateSubTask
      const [parentTask] = await db.select({ sourceId: tasks.sourceId }).from(tasks).where(eq(tasks.id, currentTask.parentId));
      if (parentTask && parentTask.sourceId.includes(':')) {
        await connector.updateSubTask(parentTask.sourceId, currentTask.sourceId, {
          title: updates.title,
          description: updates.description === null ? '' : updates.description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: updates.status as any,
        });
      }
    } else if (currentTask.isChecklistItem && currentTask.parentId && !connector.updateSubTask && connector.updateTask) {
      // Fallback for sub-issues that are real tasks (e.g. GH sub-issues) — use updateTask directly
      await connector.updateTask(currentTask.sourceId, {
        title: updates.title,
        description: updates.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: updates.status as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    } else if (
      updates.status === 'done'
      && isConnectorCloseReason(updates.statusReason)
      && connector.closeTaskWithReason
    ) {
      await connector.closeTaskWithReason(currentTask.sourceId, updates.statusReason);
    } else if (updates.status === 'done') {
      if (connector.completeTask) {
        await connector.completeTask(currentTask.sourceId);
      } else if (connector.updateTask) {
        await connector.updateTask(currentTask.sourceId, {
          status: 'done',
          ...(updates.statusReason !== undefined
            ? { statusReason: updates.statusReason as TaskItem['statusReason'] }
            : {}),
        });
      } else {
        throw new Error('Connector does not support task completion');
      }
    } else if (updates.status === 'cancelled' && connector.closeTaskWithReason) {
      // Map cancelled to a close reason: use provided reason or default to 'not_planned'
      const reason = updates.statusReason === 'duplicate' ? 'duplicate' : 'not_planned';
      await connector.closeTaskWithReason(currentTask.sourceId, reason);
    } else {
      if (!connector.updateTask) {
        throw new Error('Connector does not support task updates');
      }
      const remoteResult = await connector.updateTask(currentTask.sourceId, {
        title: updates.title,
        description: updates.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        priority: updates.priority as any,
        dueDate: updates.dueDate,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: updates.status as any,
        statusReason: updates.statusReason as TaskItem['statusReason'],
        microStatus: updates.microStatus,
        ...(updates.recurrence !== undefined ? { metadata: { recurrence: updates.recurrence } } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      // If the remote reports a terminal status that differs from local,
      // apply it immediately. This handles the case where a task is set to
      // 'in_progress' locally but the upstream issue is already closed — the
      // write-through learns the truth from the response and corrects locally.
      const remoteIsTerminal = remoteResult?.status === 'done' || remoteResult?.status === 'cancelled';
      const localNonTerminal = currentTask.status !== 'done' && currentTask.status !== 'cancelled';
      const explicitlySettingTerminal = updates.status === 'done' || updates.status === 'cancelled';
      if (remoteIsTerminal && localNonTerminal && !explicitlySettingTerminal) {
        await db.update(tasks).set({
          status: remoteResult.status,
          completedAt: remoteResult.completedAt || new Date().toISOString(),
          syncStatus: 'synced',
          lastSyncedAt: new Date().toISOString(),
        }).where(eq(tasks.id, taskId));
        return;
      }

    }
    };
    if (connector.type === 'github-issues') {
      const onlyTags = Boolean(updates.tags)
        && !Object.entries(updates).some(([field, value]) => field !== 'tags' && value !== undefined);
      await executeFencedGitHubTaskMutation({
        connectorInstanceId: currentTask.connectorInstanceId,
        taskId,
        operation: currentTask.isChecklistItem
          ? 'sub_issue'
          : onlyTags
            ? 'label'
            : updates.status === 'done' || updates.status === 'cancelled'
              ? 'complete'
              : 'update',
        connector,
        participantTaskIds: currentTask.isChecklistItem && currentTask.parentId
          ? [{ role: 'parent_issue', taskId: currentTask.parentId }]
          : undefined,
        write: performRemoteWrite,
      });
    } else {
      await performRemoteWrite();
    }

    // Success — mark as synced
    await db.update(tasks).set({ syncStatus: 'synced', lastSyncedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));

    // Log to sync history so updates (including priority label sync) appear in Sync History
    const action = updates.status === 'done' ? 'completed' : 'updated';
    await logWriteThrough({
      connectorId: currentTask.connectorInstanceId,
      action,
      taskId: currentTask.id,
      taskTitle: updates.title ?? currentTask.title,
      taskSourceId: currentTask.sourceId,
    }).catch((err) => {
      logger.warn({ err, taskId }, 'Failed to log write-through to sync history');
    });
  } catch (err) {
    logger.error({ err, taskId }, 'Write-through task update failed');
    await db.update(tasks).set({
      syncStatus: err instanceof GitHubUnknownWriteOutcomeError ? 'push_failed' : 'pending_push',
      ...(err instanceof GitHubUnknownWriteOutcomeError ? { pushRetryCount: 5 } : {}),
    }).where(eq(tasks.id, taskId));
  }
}

function isConnectorCloseReason(
  reason: string | null | undefined,
): reason is 'completed' | 'not_planned' | 'duplicate' {
  return reason === 'completed' || reason === 'not_planned' || reason === 'duplicate';
}

/**
 * DELETE /api/tasks/[id] — Remove a task according to its source authority.
 * Ingested tasks are cancelled locally so pull-based sources can observe the change.
 * Remote-managed tasks retain write-through deletion, while local tasks are deleted.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) {
      return ApiErrors.notFound('Task');
    }

    const isLocalOnly = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    let caps: Awaited<ReturnType<typeof getConnectorCapabilities>> = null;
    let connectorEnabled = true;
    if (!isLocalOnly) {
      [caps, connectorEnabled] = await Promise.all([
        getConnectorCapabilities(task.connectorInstanceId),
        isConnectorEnabled(task.connectorInstanceId),
      ]);
    }
    const taskIdentity = {
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    };
    const editPolicy = resolveTaskEditPolicy(taskIdentity, caps);
    const sourceModel = editPolicy.sourceModel;

    if (
      caps?.notificationOnly
      || isNotificationOnlyConnectorType(task.connectorType)
    ) {
      return ApiErrors.forbidden('Tasks from notification-only connectors cannot be deleted');
    }

    if (sourceModel === 'remote-mirror') {
      const now = new Date().toISOString();
      await db.update(tasks).set({
        localDisposition: 'dismissed',
        updatedAt: now,
      }).where(eq(tasks.id, id));
      await publishTaskSemanticUpdate(id);
      return NextResponse.json({
        success: true,
        action: 'dismissed',
        connectorType: task.connectorType,
        writeBack: 'none',
      });
    }

    if (editPolicy.removalMode === 'local-cancel') {
      const statusPolicy = resolveTaskFieldPolicy(taskIdentity, caps, 'status');
      if (statusPolicy.mutation === 'blocked') {
        return ApiErrors.forbidden(statusPolicy.reason ?? 'Task cancellation is unavailable');
      }
      const now = new Date().toISOString();
      const lifecycleUpdates = getStatusLifecycleUpdates({
        status: 'cancelled',
        explicitReason: 'not_planned',
        completedAt: now,
        currentStatus: task.status,
        currentCompletedAt: task.completedAt,
        currentStatusReason: task.statusReason,
      });
      runTransaction((tx) => {
        tx.update(tasks).set({
          ...lifecycleUpdates,
          microStatus: null,
          snoozedUntil: null,
          reminderAt: null,
          reminderRelative: null,
          reminderDueTime: null,
          updatedAt: now,
        }).where(eq(tasks.id, id)).run();
      });
      await publishTaskSemanticUpdate(id);
      return NextResponse.json({
        success: true,
        action: 'cancelled',
        connectorType: task.connectorType,
        writeBack: statusPolicy.mutation,
      });
    }

    if (editPolicy.removalMode === 'blocked') {
      return ApiErrors.forbidden(editPolicy.removalReason ?? 'Task removal is unavailable');
    }

    const deleteLocally = editPolicy.removalMode === 'local-delete';

    // If it's a remote task (has a real sourceId), mark for push-delete
    if (!deleteLocally) {
      const willClose = editPolicy.removalMode === 'upstream-close';

      // Mark as cancelled locally (optimistic); tag with 'undo' reason when closing
      await db.update(tasks).set({
        status: 'cancelled',
        statusReason: 'undo',
        updatedAt: new Date().toISOString(),
      }).where(eq(tasks.id, id));
      await publishTaskSemanticUpdate(id);

      // Attempt immediate delete on source
      writeThroughDelete(task, caps?.delete !== false).catch((err) => {
        logger.error({ err, taskId: task.id }, 'Write-through task delete failed unexpectedly');
      });

      return NextResponse.json({
        success: true,
        action: willClose ? 'closed' : 'deleted',
        connectorType: task.connectorType,
      });
    } else {
      deleteTaskLocally(id);
      await removeTaskSearch(id);
    }

    return NextResponse.json({ success: true, action: 'deleted' });
  } catch (error) {
    return ApiErrors.internal('Failed to delete task', error);
  }
}

/**
 * Attempt immediate delete on source connector.
 * On success: removes the local task entirely.
 * On failure: marks task as pending_push for retry.
 */
async function writeThroughDelete(
  task: { id: string; sourceId: string; connectorInstanceId: string },
  allowDelete: boolean,
) {
  try {
    let connector = connectorRegistry.getConnector(task.connectorInstanceId) ?? null;
    if (!connector) {
      connector = await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId);
    }
    if (!connector) {
      await db.update(tasks).set({ syncStatus: 'pending_push' }).where(eq(tasks.id, task.id));
      return;
    }
    if (connector.writeDelivery === 'deferred') {
      await db.update(tasks).set({ syncStatus: 'pending_push' }).where(eq(tasks.id, task.id));
      return;
    }

    const deleteRemote = async () => {
      if (allowDelete && connector.deleteTask) {
        await connector.deleteTask(task.sourceId);
      } else if (connector.closeTaskWithReason) {
        await connector.closeTaskWithReason(task.sourceId, 'not_planned');
      } else {
        throw new Error('Connector does not support task deletion');
      }
    };
    if (connector.type === 'github-issues') {
      await executeFencedGitHubTaskMutation({
        connectorInstanceId: task.connectorInstanceId,
        taskId: task.id,
        operation: 'delete',
        connector,
        write: deleteRemote,
      });
    } else {
      await deleteRemote();
    }

    deleteTaskLocally(task.id);
    await removeTaskSearch(task.id);
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'Write-through task delete failed');
    await db.update(tasks).set({
      syncStatus: err instanceof GitHubUnknownWriteOutcomeError ? 'push_failed' : 'pending_push',
      ...(err instanceof GitHubUnknownWriteOutcomeError ? { pushRetryCount: 5 } : {}),
    }).where(eq(tasks.id, task.id));
  }
}

/**
 * GET /api/tasks/[id] — Get a single task with full details
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const task = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task.length) {
      return ApiErrors.notFound('Task');
    }

    // Get tags
    const taskTagRows = await db.select().from(taskTags).where(eq(taskTags.taskId, id));

    // Get projects
    const taskProjectRows = await db.select().from(taskProjects).where(eq(taskProjects.taskId, id));

    // Get subtasks (children)
    const subtasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      effort: tasks.effort,
    }).from(tasks).where(eq(tasks.parentId, id));

    // Get local schedule fields from taskSchedules
    const scheduleRow = await db.select({
      estimatedDuration: taskSchedules.estimatedDuration,
      recurrence: taskSchedules.recurrence,
      recurrenceMode: taskSchedules.recurrenceMode,
    }).from(taskSchedules).where(eq(taskSchedules.taskId, id)).limit(1);
    const myDayRow = await db.select({ id: myDayItems.id })
      .from(myDayItems)
      .where(and(eq(myDayItems.taskId, id), eq(myDayItems.date, getLocalToday())))
      .limit(1);
    const legacyMetadata = parseTaskMetadataCompat(task[0].metadata);
    if (legacyMetadata.recoveredLegacy) {
      logger.warn({ taskId: id }, 'Recovered unstructured legacy task metadata');
    }
    const legacyRecurrence = typeof legacyMetadata.metadata.recurrence === 'string'
      ? legacyMetadata.metadata.recurrence
      : null;

    // Compute deep link URL if the connector supports it
    const localIdentity = task[0].sourceId.startsWith('local:')
      || task[0].connectorType === 'local';
    const [caps, connectorEnabled] = localIdentity
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(task[0].connectorInstanceId),
          isConnectorEnabled(task[0].connectorInstanceId),
        ]);
    const sourceUrl = caps?.deepLinks
      ? buildDeepLinkUrl(task[0].connectorType, task[0].sourceId)
      : null;
    const editPolicy = resolveTaskEditPolicy({
      sourceId: task[0].sourceId,
      connectorType: task[0].connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, caps);

    return NextResponse.json({
      task: {
        ...task[0],
        sourceUrl,
        reminderTimezone: getTimezone(),
        estimatedDuration: scheduleRow[0]?.estimatedDuration ?? null,
        recurrence: scheduleRow[0]?.recurrence ?? legacyRecurrence,
        recurrenceMode: scheduleRow[0]?.recurrenceMode ?? 'schedule',
        tagIds: taskTagRows.map(tt => tt.tagId),
        projectIds: taskProjectRows.map(tp => tp.projectId),
        subtasks,
        isInMyDay: myDayRow.length > 0,
        taskSourceModel: editPolicy.sourceModel,
        editPolicy,
        supportedStatusValues: caps?.supportedTaskStatuses,
      },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch task', error);
  }
}
