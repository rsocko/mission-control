import { dbLogger } from '@/lib/logger';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';
import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
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

function serviceResult(
  body: Record<string, unknown>,
  status = 200,
): TaskMoveServiceResult {
  return { body, status };
}

/**
 * Deferred ("pending sync") task move.
 *
 * Backend-neutral as of L04: validation and budget enforcement happen here,
 * outside any transaction, and the *whole* state transition — optimistically
 * claiming the source, materializing the successor with `pending_push` sync
 * status, repointing every durable reference, and deleting the source — is a
 * single adapter-owned atomic operation. There is deliberately no connector
 * or network I/O inside that boundary: this variant defers the upstream write
 * to the sync pipeline, and the durable `pending_push` intent is what carries
 * it, so it must land in the same transaction as the move itself.
 */
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

  const core = await getCorePersistenceRepositoriesForBackend();
  // Deliberate tightening: the portable `ConnectorRepository.get` excludes
  // soft-deleted connectors, so a move whose target connector has been deleted
  // now fails with 404 instead of silently materializing the successor inside a
  // connector whose tasks the canonical filter already hides.
  const connectorConfig = await core.connectors.get(targetConnectorInstanceId);
  if (!connectorConfig) {
    return serviceResult({ error: 'Connector instance not found' }, 404);
  }

  const taskCore = await getTaskCorePersistence();

  let resolvedTargetListId: string | null = null;
  if (targetListId) {
    const targetList = await taskCore.moves.findTargetList(
      targetConnectorInstanceId,
      targetListId,
    );
    if (!targetList || !isSourceListSelected(connectorConfig, targetList)) {
      return serviceResult(
        { error: 'Target list is not selected for sync', code: 'BAD_REQUEST' },
        400,
      );
    }
    resolvedTargetListId = targetList.sourceId;
  }

  const sourceTask = await taskCore.moves.getMoveSource(taskId);
  if (!sourceTask) {
    return serviceResult({ error: 'Task not found' }, 404);
  }

  if (sourceTask.connectorInstanceId === targetConnectorInstanceId && !targetListId) {
    return serviceResult(
      { error: 'Cannot move to same location without a different targetListId' },
      400,
    );
  }

  const sourceAttachments = await taskCore.moves.listTaskAttachments(taskId);
  const unavailableAttachment = sourceAttachments.find(
    (attachment) => attachment.contentBase64 === null,
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
      sourceAttachments
        .filter((attachment): attachment is typeof attachment & { contentBase64: string } =>
          attachment.contentBase64 !== null)
        .map((attachment) => ({
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

  let outcome;
  try {
    outcome = await taskCore.moves.executePendingSyncMove({
      sourceTaskId: taskId,
      newTaskId: newId,
      expectedSourceId: sourceTask.sourceId,
      expectedUpdatedAt: sourceTask.updatedAt,
      attachmentSnapshot: sourceAttachments.map((attachment) => ({
        id: attachment.id,
        size: attachment.size,
        sourceAttachmentId: attachment.sourceAttachmentId,
      })),
      targetConnectorType: connectorConfig.type,
      targetConnectorInstanceId,
      targetSourceListId: resolvedTargetListId,
      keepTags,
      now,
    });
  } catch (error) {
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

  if (outcome.kind === 'not-found') {
    return serviceResult({ error: 'Task not found' }, 404);
  }
  if (outcome.kind === 'source-changed') {
    return serviceResult(
      {
        error: 'Task changed before the move could be committed',
        code: 'TASK_MOVE_SOURCE_CHANGED',
      },
      409,
    );
  }

  return serviceResult({
    id: newId,
    message: `Task moved to ${connectorConfig.type}`,
    previousId: taskId,
    previousSource: sourceTask.connectorType,
  });
}
