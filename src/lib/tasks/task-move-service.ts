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
  subtaskStrategy?: SubtaskStrategy;
  addCrossReference?: boolean;
}

export interface DeferredTaskMoveInput {
  targetConnectorInstanceId: string;
  targetListId?: string;
  keepTags?: boolean;
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
