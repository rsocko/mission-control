import db, { runTransaction } from '@/db';
import {
  connectorConfigs,
  sourceLists,
  taskAttachments,
  taskSchedules,
  taskTags,
  tasks,
} from '@/db/schema';
import { and, eq, or, sql } from 'drizzle-orm';
import { dbLogger } from '@/lib/logger';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { repointTaskReferences } from '@/lib/tasks/task-reference-repoint';
import type {
  DeferredTaskMoveInput,
  TaskMoveServiceResult,
} from '@/lib/tasks/task-move-service';
import {
  assertMaterializedTaskMoveAttachmentBudget,
  assertTaskMoveAttachmentBudget,
  TASK_MOVE_BUDGETS,
  TaskMoveBudgetError,
} from '@/lib/tasks/task-move-budgets';
import { taskAttachmentSnapshotPredicates } from '@/lib/tasks/task-move-snapshot';

function serviceResult(
  body: Record<string, unknown>,
  status = 200,
): TaskMoveServiceResult {
  return { body, status };
}

class PendingTaskMoveSourceChangedError extends Error {
  constructor() {
    super('Task changed before the move could be committed');
    this.name = 'PendingTaskMoveSourceChangedError';
  }
}

export async function executePendingSyncTaskMove(
  taskId: string,
  input: DeferredTaskMoveInput,
): Promise<TaskMoveServiceResult> {
  const {
    targetConnectorInstanceId,
    targetListId,
    keepTags = true,
  } = input;

  if (!targetConnectorInstanceId) {
    return serviceResult({ error: 'targetConnectorInstanceId is required' }, 400);
  }

  const [connectorConfig] = await db.select().from(connectorConfigs)
    .where(eq(connectorConfigs.id, targetConnectorInstanceId)).limit(1);
  if (!connectorConfig) {
    return serviceResult({ error: 'Connector instance not found' }, 404);
  }

  let resolvedTargetListId: string | undefined;
  if (targetListId) {
    const [targetList] = await db.select().from(sourceLists)
      .where(and(
        eq(sourceLists.connectorInstanceId, targetConnectorInstanceId),
        or(eq(sourceLists.id, targetListId), eq(sourceLists.sourceId, targetListId)),
      ))
      .limit(1);
    if (!targetList || !isSourceListSelected(connectorConfig, targetList)) {
      return serviceResult(
        { error: 'Target list is not selected for sync', code: 'BAD_REQUEST' },
        400,
      );
    }
    resolvedTargetListId = targetList.sourceId;
  }

  const [sourceTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!sourceTask) {
    return serviceResult({ error: 'Task not found' }, 404);
  }

  if (sourceTask.connectorInstanceId === targetConnectorInstanceId && !targetListId) {
    return serviceResult(
      { error: 'Cannot move to same location without a different targetListId' },
      400,
    );
  }

  const sourceAttachments = await db.select().from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId));
  const unavailableAttachment = sourceAttachments.find(
    (attachment) => !hasMaterializedContent(attachment),
  );
  if (unavailableAttachment) {
    return serviceResult(
      {
        error: `Attachment "${unavailableAttachment.name}" cannot be read from the source. The operation was stopped to prevent data loss.`,
        code: 'ATTACHMENT_CONTENT_UNAVAILABLE',
      },
      409,
    );
  }
  try {
    assertTaskMoveAttachmentBudget(sourceAttachments);
    assertMaterializedTaskMoveAttachmentBudget(
      sourceAttachments.filter(hasMaterializedContent).map((attachment) => ({
        name: attachment.name,
        contentBase64: attachment.contentBase64,
      })),
    );
  } catch (error) {
    if (error instanceof TaskMoveBudgetError) {
      return serviceResult(
        {
          error: error.message,
          code: 'TASK_MOVE_BUDGET_EXCEEDED',
          budgets: TASK_MOVE_BUDGETS,
        },
        413,
      );
    }
    throw error;
  }

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    runTransaction((tx) => {
      const claim = tx.update(tasks).set({
        updatedAt: sql`${tasks.updatedAt}`,
      }).where(and(
        eq(tasks.id, taskId),
        eq(tasks.sourceId, sourceTask.sourceId),
        eq(tasks.updatedAt, sourceTask.updatedAt),
        ...taskAttachmentSnapshotPredicates(taskId, sourceAttachments),
      )).run();
      if (claim.changes !== 1) {
        throw new PendingTaskMoveSourceChangedError();
      }

      tx.insert(tasks).values({
        id: newId,
        sourceId: `local:${newId}`,
        connectorType: connectorConfig.type,
        connectorInstanceId: targetConnectorInstanceId,
        title: sourceTask.title,
        description: sourceTask.description,
        status: sourceTask.status,
        priority: sourceTask.priority,
        dueDate: sourceTask.dueDate,
        createdAt: sourceTask.createdAt,
        updatedAt: now,
        completedAt: sourceTask.completedAt,
        depth: 0,
        isChecklistItem: false,
        sourceListId: resolvedTargetListId,
        metadata: '{}',
        syncStatus: 'pending_push',
        lastSyncedAt: now,
      }).run();

      if (keepTags) {
        const sourceTags = tx.select().from(taskTags)
          .where(eq(taskTags.taskId, taskId)).all();
        if (sourceTags.length > 0) {
          tx.insert(taskTags).values(
            sourceTags.map((tag) => ({ taskId: newId, tagId: tag.tagId })),
          ).run();
        }
      }

      const sourceSchedules = tx.select().from(taskSchedules)
        .where(eq(taskSchedules.taskId, taskId)).all();
      if (sourceSchedules.length > 0) {
        tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
        tx.insert(taskSchedules).values(
          sourceSchedules.map((schedule) => ({ ...schedule, taskId: newId })),
        ).run();
      }

      if (sourceAttachments.length > 0) {
        tx.insert(taskAttachments).values(
          sourceAttachments.map((attachment) => ({
            ...attachment,
            id: crypto.randomUUID(),
            taskId: newId,
            sourceAttachmentId: null,
          })),
        ).run();
      }

      repointTaskReferences(tx, taskId, newId);

      tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
      tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
      tx.delete(tasks).where(eq(tasks.id, taskId)).run();
    });
  } catch (error) {
    if (error instanceof PendingTaskMoveSourceChangedError) {
      const [current] = await db.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.id, taskId)).limit(1);
      return current
        ? serviceResult(
            {
              error: error.message,
              code: 'TASK_MOVE_SOURCE_CHANGED',
            },
            409,
          )
        : serviceResult({ error: 'Task not found' }, 404);
    }
    dbLogger.error(
      {
        err: error,
        sourceTaskId: taskId,
        newTaskId: newId,
        targetConnectorType: connectorConfig.type,
        op: 'moveTask',
      },
      'Transaction rolled back: task move failed — source preserved, no data lost',
    );
    throw error;
  }

  return serviceResult({
    id: newId,
    message: `Task moved to ${connectorConfig.type}`,
    previousId: taskId,
    previousSource: sourceTask.connectorType,
  });
}

function hasMaterializedContent<T extends { contentBase64: string | null }>(
  attachment: T,
): attachment is T & { contentBase64: string } {
  return attachment.contentBase64 !== null;
}
