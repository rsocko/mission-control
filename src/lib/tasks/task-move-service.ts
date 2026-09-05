type SourceAction = 'move' | 'copy';
type SubtaskStrategy =
  | 'move-as-subtasks'
  | 'flatten-to-checklist'
  | 'preserve-details-and-steps';

export interface ExecuteTaskMoveInput {
  taskId: string;
  targetConnectorInstanceId: string;
  targetSourceListId: string;
  sourceAction: SourceAction;
  expectedSourceConnectorInstanceId?: string;
  subtaskStrategy?: SubtaskStrategy;
  addCrossReference?: boolean;
}

export interface DeferredTaskMoveInput {
  targetConnectorInstanceId: string;
  targetListId?: string;
  keepTags?: boolean;
}

export interface CrossAccountTaskMoveInput {
  taskId: string;
  targetInstanceId: string;
  action: SourceAction;
  targetListId?: string;
}

export interface TaskMoveServiceResult {
  status: number;
  body: Record<string, unknown>;
}

export type TaskMoveCommand =
  | {
      strategy: 'write-through';
      input: ExecuteTaskMoveInput;
      traceId?: string;
    }
  | {
      strategy: 'pending-sync';
      taskId: string;
      input: DeferredTaskMoveInput;
    };

/**
 * Canonical task-move workflow. Destination strategies preserve the distinct
 * immediate-write and deferred-sync API contracts behind one service boundary.
 */
export async function executeTaskMove(command: TaskMoveCommand): Promise<TaskMoveServiceResult> {
  if (command.strategy === 'pending-sync') {
    const { executePendingSyncTaskMove } = await import('./task-move-pending-sync');
    return executePendingSyncTaskMove(command.taskId, command.input);
  }

  const { executeWriteThroughTaskMove } = await import('./task-move-write-through');
  return executeWriteThroughTaskMove(command.input, command.traceId);
}

/**
 * Compatibility boundary for the legacy connector-scoped cross-account route.
 * It delegates all durable and remote work to the canonical write-through move
 * workflow while retaining the route's response contract.
 */
export async function executeCrossAccountTaskMove(
  sourceConnectorInstanceId: string,
  input: CrossAccountTaskMoveInput,
  traceId?: string,
): Promise<TaskMoveServiceResult> {
  const { getTaskCorePersistence } = await import('./core/runtime');
  const moves = (await getTaskCorePersistence()).writeThroughMoves;
  const sourceTask = await moves.getTask(input.taskId);
  if (!sourceTask || sourceTask.connectorInstanceId !== sourceConnectorInstanceId) {
    return {
      status: 404,
      body: { error: 'Task not found for this connector' },
    };
  }

  const { getCorePersistenceRepositoriesForBackend } = await import(
    '@/lib/persistence/runtime'
  );
  const targetConnector = await (
    await getCorePersistenceRepositoriesForBackend()
  ).connectors.get(input.targetInstanceId);
  if (!targetConnector) {
    return {
      status: 404,
      body: { error: 'Target connector not found' },
    };
  }

  const targetListId = input.targetListId
    ?? (await moves.findDefaultTargetList(input.targetInstanceId))?.sourceId;
  if (!targetListId) {
    return {
      status: 400,
      body: { error: 'No target list available' },
    };
  }

  const result = await executeTaskMove({
    strategy: 'write-through',
    input: {
      taskId: input.taskId,
      targetConnectorInstanceId: input.targetInstanceId,
      targetSourceListId: targetListId,
      sourceAction: input.action,
      expectedSourceConnectorInstanceId: sourceConnectorInstanceId,
      addCrossReference: false,
    },
    traceId,
  });
  if (result.status < 200 || result.status >= 300) return result;

  return {
    status: 200,
    body: {
      success: true,
      action: input.action,
      sourceTaskId: input.taskId,
      targetTaskId: result.body.newTaskId,
      targetRemoteId: result.body.newSourceId,
      targetInstance: input.targetInstanceId,
      ...(Array.isArray(result.body.warnings) ? { warnings: result.body.warnings } : {}),
    },
  };
}
