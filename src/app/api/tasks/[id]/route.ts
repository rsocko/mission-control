import { NextResponse } from 'next/server';
import { formatInTimeZone } from 'date-fns-tz';
import { resolveOutboundPriority } from '@/lib/priority';
import { randomUUID } from 'crypto';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { logWriteThrough } from '@/lib/sync/write-through-log';
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
import {
  indexTask as indexTaskKeyword,
  removeTaskFromIndex,
  type SearchableTaskRecord,
} from '@/lib/search/fts';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';
import { resolveTaskEditPolicy } from '@/lib/tasks/edit-policy';
import {
  isMergeableTaskField,
  resolveLocalOverrideChange,
  type LocalOverrideChange,
} from '@/lib/tasks/field-state';
import { parseTaskPatchInput, type TaskPatchInput } from '@/lib/tasks/task-patch';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import type { TaskField, TaskItem, TaskPriority } from '@/types';
import { evaluateRulesForTasks } from '@/lib/rules';
import { resolveRelativeReminderMutation } from '@/lib/tasks/relative-reminder';
import { computeRelativeReminderAt, isReminderRelativeRule } from '@/lib/tasks/relative-reminder';
import { getCompletionAnchoredDueDate } from '@/lib/utils/recurrence';
import {
  executeFencedGitHubTaskMutation,
  GitHubUnknownWriteOutcomeError,
} from '@/lib/external-identities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  TaskCoreTaskPatch,
  TaskCoreTaskRow,
  TaskMutationRequest,
} from '@/lib/tasks/core/contracts';
import {
  claimTaskForPush,
  completeTaskPush,
  failTaskPush,
  heartbeatTaskPush,
  loadClaimedTaskForPush,
  releaseTaskPush,
} from '@/lib/sync/push-lease';

async function indexTaskSearch(task: SearchableTaskRecord): Promise<void> {
  await indexTaskKeyword(task);
  await publishSemanticEntityUpsert('task', task.id);
}

async function publishTaskSemanticUpdate(taskId: string): Promise<void> {
  await publishSemanticEntityUpsert('task', taskId);
}

async function removeTaskSearch(taskId: string): Promise<void> {
  await removeTaskFromIndex(taskId);
  await publishSemanticEntityDelete('task', taskId);
}

const taskWriteThroughQueues = new Map<string, Promise<void>>();

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
    if (!parsed.success) return ApiErrors.badRequest(parsed.error);
    const input = parsed.input;
    const persistence = await getTaskCorePersistence();
    const writeContext = await persistence.mutations.getTaskWriteContext(id, parsed.input.tags);
    if (!writeContext) return ApiErrors.notFound('Task');
    const currentTask = writeContext.task;
    const currentSchedule = writeContext.schedule;
    const requestedVersion = request.headers.get('x-expected-task-updated-at');
    if (requestedVersion && currentTask.updatedAt !== requestedVersion) {
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
    if (currentTask.connectorType === 'microsoft-todo-work' && input.status === 'cancelled') {
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
      && !(input.recurrence ?? currentSchedule?.recurrence)
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
      const currentIds = new Set(writeContext.tagIds);
      const requestedIds = new Set(input.tags);
      tagWriteThrough = {
        add: input.tags
          .filter((tagId) => !currentIds.has(tagId))
          .flatMap((tagId) => writeContext.tagNamesById[tagId] ?? []),
        remove: writeContext.tagIds
          .filter((tagId) => !requestedIds.has(tagId))
          .flatMap((tagId) => writeContext.tagNamesById[tagId] ?? []),
      };
    }

    const now = new Date().toISOString();
    const isReopening = input.status !== undefined
      && currentTask.status !== input.status
      && ['done', 'cancelled'].includes(currentTask.status)
      && !['done', 'cancelled'].includes(input.status);
    const isBecomingTerminal = input.status !== undefined
      && currentTask.status !== input.status
      && !['done', 'cancelled'].includes(currentTask.status)
      && ['done', 'cancelled'].includes(input.status);
    const shouldReturnCompletionOccurrence = input.status === 'done'
      && currentSchedule?.recurrenceMode === 'completion'
      && Boolean(currentSchedule.recurrence)
      && localIdentity;

    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.localDisposition !== undefined) updates.localDisposition = input.localDisposition;
    const lifecycleUpdates = getStatusLifecycleUpdates({
      status: input.status,
      explicitReason: input.statusReason,
      completedAt: now,
      currentStatus: currentTask.status,
      currentCompletedAt: currentTask.completedAt,
      currentStatusReason: currentTask.statusReason,
    });
    if (input.status !== undefined && statusReasonPolicy?.mutation === 'blocked') {
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
      if (!currentSchedule?.recurrence) {
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
        const metadata = currentTask.metadata;
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
    if (input.recurrence !== undefined) {
      const parsedMetadata = parseTaskMetadataCompat(currentTask.metadata);
      if (
        !parsedMetadata.recoveredLegacy
        && Object.prototype.hasOwnProperty.call(parsedMetadata.metadata, 'recurrence')
      ) {
        const metadata = { ...parsedMetadata.metadata };
        delete metadata.recurrence;
        updates.metadata = metadata;
      }
    }

    const mergeableFields = parsed.fields.filter(isMergeableTaskField);
    const sourceModel = [...policies.values()][0]?.sourceModel;
    const overrideChanges: LocalOverrideChange[] = sourceModel === 'ingested'
      ? mergeableFields.map((fieldName) => resolveLocalOverrideChange({
          taskId: id,
          fieldName,
          newValue: input[fieldName],
          currentSourceValue: currentTask[fieldName],
          state: writeContext.fieldStates.find((state) => state.fieldName === fieldName),
          sourceObservedAt: currentTask.lastSyncedAt,
          now,
        }))
      : [];

    let recurrenceSuccessor: TaskMutationRequest['recurrenceSuccessor'];
    if (shouldReturnCompletionOccurrence) {
      const recurrence = currentSchedule!.recurrence!;
      const nextTaskId = randomUUID();
      const recurrenceTimezone = getTimezone();
      const includeCompletionTime = Boolean(
        currentTask.dueDate?.includes('T') || currentSchedule?.scheduledTime,
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
      const metadata = { ...parseTaskMetadataCompat(currentTask.metadata).metadata };
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
      recurrenceSuccessor = {
        id: nextTaskId,
        dueDate: nextDueDate,
        scheduledDate: nextScheduledDate,
        scheduledTime: nextScheduledTime,
        reminderAt: nextReminderAt,
        metadata,
      };
    }

    const priorityLog = input.priority !== undefined && input.priority !== currentTask.priority
      ? (() => {
          const outbound = resolveOutboundPriority(
            currentTask.priority as TaskPriority,
            input.priority,
            currentTask.connectorType,
          );
          return {
            id: randomUUID(),
            previousPriority: currentTask.priority,
            newPriority: input.priority,
            writeBackTriggered: policies.get('priority')?.mutation === 'write-through'
              && outbound.shouldWrite,
            note: outbound.event?.note || `Priority changed to ${input.priority}`,
          };
        })()
      : undefined;
    const completedNow = input.status === 'done' && currentTask.status !== 'done';
    const mutation = await persistence.mutations.mutateTask({
      taskId: id,
      expectedUpdatedAt: currentTask.updatedAt,
      expectedStatusForTerminalTransition: isBecomingTerminal ? currentTask.status : null,
      now,
      patch: updates as TaskCoreTaskPatch,
      ...(input.estimatedDuration !== undefined
        || input.recurrence !== undefined
        || input.recurrenceMode !== undefined ? {
          schedulePatch: {
            scheduledDate: currentSchedule?.scheduledDate ?? getLocalToday(),
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
        } : {}),
      ...(input.tags !== undefined ? { replaceTagIds: input.tags } : {}),
      fieldStates: overrideChanges,
      priorityLog,
      planningHistory: input.planningHorizon !== undefined
        && input.planningHorizon !== currentTask.planningHorizon ? {
          previousValue: currentTask.planningHorizon,
          newValue: input.planningHorizon,
        } : undefined,
      suppressAutoCompletionAfterReopen: isReopening
        && writeContext.wasAutoCompletedByReconciliation,
      supersedePendingReconciliation: isBecomingTerminal,
      recurrenceSuccessor,
      events: completedNow ? [{
        stableKey: `task-completed:${id}:${currentTask.updatedAt}`,
        type: 'task.completed',
        timestamp: now,
        payload: {
          id,
          title: input.title ?? currentTask.title,
          connectorType: currentTask.connectorType,
          priority: input.priority ?? currentTask.priority,
          completedAt: updates.completedAt ?? now,
        },
      }] : undefined,
    });
    if (mutation.kind === 'not-found') return ApiErrors.notFound('Task');
    if (mutation.kind === 'revision-conflict') {
      return NextResponse.json({
        error: 'Task changed during update',
        code: 'TASK_REVISION_CONFLICT',
      }, { status: 409 });
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
      await indexTaskSearch(mutation.task);
    } else {
      await publishTaskSemanticUpdate(id);
    }

    if (shouldWriteThrough) {
      const writeThroughUpdates = {
        ...pickWriteThroughUpdates(input, updates, policies, statusReasonPolicy),
        ...(tagWriteThrough ? { tags: tagWriteThrough } : {}),
      };
      void enqueueTaskWriteThrough(
        id,
        () => writeThrough(currentTask, writeThroughUpdates, id, mutation.task.updatedAt),
      ).catch((error) => {
        logger.error({ err: error, taskId: id }, 'Write-through task update failed unexpectedly');
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
    const reminder = reminderChanged ? {
      reminderAt: updates.reminderAt !== undefined
        ? updates.reminderAt
        : currentTask.reminderAt ?? null,
      reminderRelative: updates.reminderRelative !== undefined
        ? updates.reminderRelative
        : currentTask.reminderRelative ?? null,
      reminderDueTime: updates.reminderDueTime !== undefined
        ? updates.reminderDueTime
        : currentTask.reminderDueTime ?? null,
    } : undefined;

    return NextResponse.json({
      success: true,
      fields: Object.fromEntries(
        [...policies.values()].map((policy) => [
          policy.field,
          { mode: policy.mutation, persisted: true },
        ]),
      ),
      ...(reminder ? { reminder } : {}),
      ...(mutation.recurrenceNextTaskId
        ? { recurrenceNextTaskId: mutation.recurrenceNextTaskId }
        : {}),
    });
  } catch (error) {
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
  currentTask: TaskCoreTaskRow,
  updates: WriteThroughUpdates,
  taskId: string,
  expectedTaskVersion: string,
) {
  let pushLeaseToken: string | null = null;
  try {
    pushLeaseToken = await claimTaskForPush(taskId);
    if (!pushLeaseToken) return;
    const claimedTask = await loadClaimedTaskForPush(taskId, pushLeaseToken);
    if (!claimedTask || claimedTask.updatedAt !== expectedTaskVersion) {
      await releaseTaskPush(taskId, pushLeaseToken, 'pending_push', expectedTaskVersion);
      return;
    }
    const connector = await getOrInitializeConnector(claimedTask.connectorInstanceId);
    if (!connector || connector.writeDelivery === 'deferred') {
      await releaseTaskPush(taskId, pushLeaseToken, 'pending_push', expectedTaskVersion);
      return;
    }
    const renewed = await heartbeatTaskPush(taskId, pushLeaseToken);
    if (!renewed) return;
    pushLeaseToken = renewed;

    if (claimedTask.sourceId.startsWith('checklist:')) {
      await completeTaskPush(
        taskId,
        pushLeaseToken,
        claimedTask.sourceId,
        undefined,
        undefined,
        expectedTaskVersion,
      );
      return;
    }

    let localUpdates: { status?: 'done' | 'cancelled'; completedAt?: string | null } | undefined;
    const performRemoteWrite = async () => {
      if (updates.tags) {
        if (updates.tags.add.length > 0 && !connector.addTagToTask) {
          throw new Error('Connector does not support adding task tags');
        }
        if (updates.tags.remove.length > 0 && !connector.removeTagFromTask) {
          throw new Error('Connector does not support removing task tags');
        }
        for (const tagName of updates.tags.add) {
          await connector.addTagToTask!(claimedTask.sourceId, tagName);
        }
        for (const tagName of updates.tags.remove) {
          await connector.removeTagFromTask!(claimedTask.sourceId, tagName);
        }
      }
      const hasTaskUpdates = Object.entries(updates)
        .some(([field, value]) => field !== 'tags' && value !== undefined);
      if (!hasTaskUpdates) return;

      if (updates.status === 'done' && claimedTask.isChecklistItem && claimedTask.parentId) {
        const parent = await (await getTaskCorePersistence()).mutations
          .getTaskWriteContext(claimedTask.parentId);
        if (parent?.task.sourceId.includes(':') && connector.completeSubTask) {
          await connector.completeSubTask(parent.task.sourceId, claimedTask.sourceId);
        } else if (parent?.task.sourceId.includes(':') && connector.updateSubTask) {
          await connector.updateSubTask(parent.task.sourceId, claimedTask.sourceId, { status: 'done' });
        } else if (connector.completeTask) {
          await connector.completeTask(claimedTask.sourceId);
        }
      } else if (claimedTask.isChecklistItem && claimedTask.parentId && connector.updateSubTask) {
        const parent = await (await getTaskCorePersistence()).mutations
          .getTaskWriteContext(claimedTask.parentId);
        if (parent?.task.sourceId.includes(':')) {
          await connector.updateSubTask(parent.task.sourceId, claimedTask.sourceId, {
            title: updates.title,
            description: updates.description === null ? '' : updates.description,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            status: updates.status as any,
          });
        }
      } else if (
        claimedTask.isChecklistItem
        && claimedTask.parentId
        && !connector.updateSubTask
        && connector.updateTask
      ) {
        await connector.updateTask(claimedTask.sourceId, {
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
        await connector.closeTaskWithReason(claimedTask.sourceId, updates.statusReason);
      } else if (updates.status === 'done') {
        if (connector.completeTask) {
          await connector.completeTask(claimedTask.sourceId);
        } else if (connector.updateTask) {
          await connector.updateTask(claimedTask.sourceId, {
            status: 'done',
            ...(updates.statusReason !== undefined
              ? { statusReason: updates.statusReason as TaskItem['statusReason'] }
              : {}),
          });
        } else {
          throw new Error('Connector does not support task completion');
        }
      } else if (updates.status === 'cancelled' && connector.closeTaskWithReason) {
        const reason = updates.statusReason === 'duplicate' ? 'duplicate' : 'not_planned';
        await connector.closeTaskWithReason(claimedTask.sourceId, reason);
      } else {
        if (!connector.updateTask) throw new Error('Connector does not support task updates');
        const remoteResult = await connector.updateTask(claimedTask.sourceId, {
          title: updates.title,
          description: updates.description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          priority: updates.priority as any,
          dueDate: updates.dueDate,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: updates.status as any,
          statusReason: updates.statusReason as TaskItem['statusReason'],
          microStatus: updates.microStatus,
          ...(updates.recurrence !== undefined
            ? { metadata: { recurrence: updates.recurrence } }
            : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        const remoteIsTerminal = remoteResult?.status === 'done'
          || remoteResult?.status === 'cancelled';
        const localNonTerminal = currentTask.status !== 'done'
          && currentTask.status !== 'cancelled';
        const explicitlySettingTerminal = updates.status === 'done'
          || updates.status === 'cancelled';
        if (remoteIsTerminal && localNonTerminal && !explicitlySettingTerminal) {
          localUpdates = {
            status: remoteResult.status,
            completedAt: remoteResult.completedAt || new Date().toISOString(),
          };
        }
      }
    };

    if (connector.type === 'github-issues') {
      const onlyTags = Boolean(updates.tags)
        && !Object.entries(updates)
          .some(([field, value]) => field !== 'tags' && value !== undefined);
      await executeFencedGitHubTaskMutation({
        connectorInstanceId: claimedTask.connectorInstanceId,
        taskId,
        operation: claimedTask.isChecklistItem
          ? 'sub_issue'
          : onlyTags
            ? 'label'
            : updates.status === 'done' || updates.status === 'cancelled'
              ? 'complete'
              : 'update',
        connector,
        participantTaskIds: claimedTask.isChecklistItem && claimedTask.parentId
          ? [{ role: 'parent_issue', taskId: claimedTask.parentId }]
          : undefined,
        write: performRemoteWrite,
      });
    } else {
      await performRemoteWrite();
    }

    const finalized = await completeTaskPush(
      taskId,
      pushLeaseToken,
      claimedTask.sourceId,
      undefined,
      localUpdates,
      expectedTaskVersion,
    );
    if (!finalized) return;
    const action = updates.status === 'done' ? 'completed' : 'updated';
    await logWriteThrough({
      connectorId: claimedTask.connectorInstanceId,
      action,
      taskId: claimedTask.id,
      taskTitle: updates.title ?? claimedTask.title,
      taskSourceId: claimedTask.sourceId,
    }).catch((error) => {
      logger.warn({ err: error, taskId }, 'Failed to log write-through to sync history');
    });
  } catch (error) {
    logger.error({ err: error, taskId }, 'Write-through task update failed');
    if (!pushLeaseToken) return;
    if (error instanceof GitHubUnknownWriteOutcomeError) {
      await failTaskPush(taskId, pushLeaseToken, 'push_failed', 5, expectedTaskVersion);
    } else {
      await releaseTaskPush(taskId, pushLeaseToken, 'pending_push', expectedTaskVersion);
    }
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
    const persistence = await getTaskCorePersistence();
    const context = await persistence.removals.getTaskRemovalContext(id);
    if (!context) return ApiErrors.notFound('Task');
    const task = context.task;
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
    if (caps?.notificationOnly || isNotificationOnlyConnectorType(task.connectorType)) {
      return ApiErrors.forbidden('Tasks from notification-only connectors cannot be deleted');
    }

    const now = new Date().toISOString();
    if (editPolicy.sourceModel === 'remote-mirror') {
      const outcome = await persistence.removals.applyTaskRemoval({
        taskId: id,
        expectedUpdatedAt: task.updatedAt,
        mode: 'mirror-dismiss',
        now,
      });
      if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
      if (outcome.kind === 'revision-conflict') {
        return NextResponse.json({
          error: 'Task changed during deletion',
          code: 'TASK_REVISION_CONFLICT',
        }, { status: 409 });
      }
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
      const outcome = await persistence.removals.applyTaskRemoval({
        taskId: id,
        expectedUpdatedAt: task.updatedAt,
        mode: 'ingested-cancel',
        now,
      });
      if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
      if (outcome.kind === 'revision-conflict') {
        return NextResponse.json({
          error: 'Task changed during deletion',
          code: 'TASK_REVISION_CONFLICT',
        }, { status: 409 });
      }
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

    if (editPolicy.removalMode !== 'local-delete') {
      const willClose = editPolicy.removalMode === 'upstream-close';
      const outcome = await persistence.removals.applyTaskRemoval({
        taskId: id,
        expectedUpdatedAt: task.updatedAt,
        mode: 'remote-cancel-intent',
        now,
      });
      if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
      if (outcome.kind === 'revision-conflict') {
        return NextResponse.json({
          error: 'Task changed during deletion',
          code: 'TASK_REVISION_CONFLICT',
        }, { status: 409 });
      }
      await publishTaskSemanticUpdate(id);
      void writeThroughDelete(
        task,
        caps?.delete !== false,
        outcome.taskVersion ?? now,
      ).catch((error) => {
        logger.error({ err: error, taskId: task.id }, 'Write-through task delete failed unexpectedly');
      });
      return NextResponse.json({
        success: true,
        action: willClose ? 'closed' : 'deleted',
        connectorType: task.connectorType,
      });
    }

    const outcome = await persistence.removals.applyTaskRemoval({
      taskId: id,
      expectedUpdatedAt: task.updatedAt,
      mode: 'local-delete',
      now,
    });
    if (outcome.kind === 'not-found') return ApiErrors.notFound('Task');
    if (outcome.kind === 'revision-conflict') {
      return NextResponse.json({
        error: 'Task changed during deletion',
        code: 'TASK_REVISION_CONFLICT',
      }, { status: 409 });
    }
    await removeTaskSearch(id);
    return NextResponse.json({ success: true, action: 'deleted' });
  } catch (error) {
    return ApiErrors.internal('Failed to delete task', error);
  }
}

async function writeThroughDelete(
  task: TaskCoreTaskRow,
  allowDelete: boolean,
  expectedTaskVersion: string,
) {
  let pushLeaseToken: string | null = null;
  try {
    pushLeaseToken = await claimTaskForPush(task.id);
    if (!pushLeaseToken) return;
    const claimedTask = await loadClaimedTaskForPush(task.id, pushLeaseToken);
    if (!claimedTask || claimedTask.updatedAt !== expectedTaskVersion) {
      await releaseTaskPush(task.id, pushLeaseToken, 'pending_push', expectedTaskVersion);
      return;
    }
    const connector = await getOrInitializeConnector(claimedTask.connectorInstanceId);
    if (!connector || connector.writeDelivery === 'deferred') {
      await releaseTaskPush(task.id, pushLeaseToken, 'pending_push', expectedTaskVersion);
      return;
    }
    const renewed = await heartbeatTaskPush(task.id, pushLeaseToken);
    if (!renewed) return;
    pushLeaseToken = renewed;
    const deleteRemote = async () => {
      if (allowDelete && connector.deleteTask) {
        await connector.deleteTask(claimedTask.sourceId);
      } else if (connector.closeTaskWithReason) {
        await connector.closeTaskWithReason(claimedTask.sourceId, 'not_planned');
      } else {
        throw new Error('Connector does not support task deletion');
      }
    };
    if (connector.type === 'github-issues') {
      await executeFencedGitHubTaskMutation({
        connectorInstanceId: claimedTask.connectorInstanceId,
        taskId: task.id,
        operation: 'delete',
        connector,
        write: deleteRemote,
      });
    } else {
      await deleteRemote();
    }
    const persistence = await getTaskCorePersistence();
    const finalized = await persistence.removals.finalizeRemoteTaskRemoval({
      taskId: task.id,
      leaseToken: pushLeaseToken,
      expectedUpdatedAt: expectedTaskVersion,
    });
    if (finalized.kind === 'committed') await removeTaskSearch(task.id);
  } catch (error) {
    logger.error({ err: error, taskId: task.id }, 'Write-through task delete failed');
    if (!pushLeaseToken) return;
    if (error instanceof GitHubUnknownWriteOutcomeError) {
      await failTaskPush(task.id, pushLeaseToken, 'push_failed', 5, expectedTaskVersion);
    } else {
      await releaseTaskPush(task.id, pushLeaseToken, 'pending_push', expectedTaskVersion);
    }
  }
}

/** GET /api/tasks/[id] - Get a single task with full details. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const persistence = await getTaskCorePersistence();
    const detail = await persistence.details.getTaskDetail(id, getLocalToday());
    if (!detail) return ApiErrors.notFound('Task');
    const task = detail.task;
    const legacyMetadata = parseTaskMetadataCompat(task.metadata);
    if (legacyMetadata.recoveredLegacy) {
      logger.warn({ taskId: id }, 'Recovered unstructured legacy task metadata');
    }
    const legacyRecurrence = typeof legacyMetadata.metadata.recurrence === 'string'
      ? legacyMetadata.metadata.recurrence
      : null;
    const localIdentity = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    const [caps, connectorEnabled] = localIdentity
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(task.connectorInstanceId),
          isConnectorEnabled(task.connectorInstanceId),
        ]);
    const sourceUrl = caps?.deepLinks
      ? buildDeepLinkUrl(task.connectorType, task.sourceId)
      : null;
    const editPolicy = resolveTaskEditPolicy({
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, caps);

    return NextResponse.json({
      task: {
        ...task,
        sourceUrl,
        reminderTimezone: getTimezone(),
        estimatedDuration: detail.schedule?.estimatedDuration ?? null,
        recurrence: detail.schedule?.recurrence ?? legacyRecurrence,
        recurrenceMode: detail.schedule?.recurrenceMode ?? 'schedule',
        tagIds: detail.tagIds,
        projectIds: detail.projectIds,
        subtasks: detail.subtasks,
        isInMyDay: detail.isInMyDay,
        taskSourceModel: editPolicy.sourceModel,
        editPolicy,
        supportedStatusValues: caps?.supportedTaskStatuses,
      },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch task', error);
  }
}
