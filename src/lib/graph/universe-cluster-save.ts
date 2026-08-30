import type { UniverseClusterDestination } from './universe-types';

export const MAX_UNIVERSE_CLUSTER_SAVE_TASKS = 500;

export interface UniverseClusterSaveInput {
  destination: UniverseClusterDestination;
  name: string;
  taskIds: string[];
  clusterId: string;
  projectionFingerprint: string;
}

export interface UniverseClusterSaveFailure {
  taskId?: string;
  code: string;
  message: string;
}

export interface UniverseClusterSaveResult {
  status: 'saved' | 'partial';
  destination: UniverseClusterDestination;
  destinationId: string;
  savedTaskIds: string[];
  failures: UniverseClusterSaveFailure[];
}

export class UniverseClusterSaveError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UniverseClusterSaveError';
  }
}

export interface UniverseClusterSaveAdapters {
  authorizeTaskIds(taskIds: string[]): Promise<string[]>;
  createProject(name: string): Promise<string>;
  assignProjectTasks(projectId: string, taskIds: string[]): Promise<void>;
  rollbackProject(projectId: string): Promise<void>;
  createTag(name: string): Promise<string>;
  addTagToTask(taskId: string, tagName: string): Promise<void>;
  recordTagAudit(input: UniverseClusterSaveInput, tagId: string, taskIds: string[]): Promise<void>;
}

export async function saveUniverseCluster(
  input: UniverseClusterSaveInput,
  adapters: UniverseClusterSaveAdapters,
): Promise<UniverseClusterSaveResult> {
  if (!/[a-z0-9]/i.test(input.name)) {
    throw new UniverseClusterSaveError(
      'Destination name must include a letter or number',
      'INVALID_DESTINATION_NAME',
      400,
    );
  }
  const taskIds = [...new Set(input.taskIds)].sort();
  if (!taskIds.length || taskIds.length > MAX_UNIVERSE_CLUSTER_SAVE_TASKS) {
    throw new UniverseClusterSaveError(
      `Choose between 1 and ${MAX_UNIVERSE_CLUSTER_SAVE_TASKS} tasks to save`,
      'INVALID_MEMBERSHIP',
      400,
    );
  }
  const authorizedTaskIds = new Set(await adapters.authorizeTaskIds(taskIds));
  if (taskIds.some((taskId) => !authorizedTaskIds.has(taskId))) {
    throw new UniverseClusterSaveError(
      'Cluster membership changed or includes tasks outside the current authorized scope',
      'CLUSTER_MEMBERSHIP_CONFLICT',
      409,
    );
  }

  if (input.destination === 'project') {
    const destinationId = await adapters.createProject(input.name);
    try {
      await adapters.assignProjectTasks(destinationId, taskIds);
      return {
        status: 'saved',
        destination: input.destination,
        destinationId,
        savedTaskIds: taskIds,
        failures: [],
      };
    } catch (error) {
      try {
        await adapters.rollbackProject(destinationId);
      } catch (rollbackError) {
        return {
          status: 'partial',
          destination: input.destination,
          destinationId,
          savedTaskIds: [],
          failures: [{
            code: 'PROJECT_ROLLBACK_FAILED',
            message: `Project membership failed and the empty project could not be removed: ${
              rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'
            }`,
          }],
        };
      }
      if (error instanceof UniverseClusterSaveError) throw error;
      throw new UniverseClusterSaveError(
        error instanceof Error ? error.message : 'Project membership could not be saved',
        'PROJECT_ASSIGNMENT_FAILED',
        500,
      );
    }
  }

  const destinationId = await adapters.createTag(input.name);
  const savedTaskIds: string[] = [];
  const failures: UniverseClusterSaveFailure[] = [];
  for (const taskId of taskIds) {
    try {
      await adapters.addTagToTask(taskId, input.name);
      savedTaskIds.push(taskId);
    } catch (error) {
      failures.push({
        taskId,
        code: 'TAG_ASSIGNMENT_FAILED',
        message: error instanceof Error ? error.message : 'Tag membership could not be saved',
      });
    }
  }
  if (savedTaskIds.length) {
    try {
      await adapters.recordTagAudit(input, destinationId, savedTaskIds);
    } catch (error) {
      failures.push({
        code: 'AUDIT_RECORD_FAILED',
        message: error instanceof Error ? error.message : 'The save audit could not be recorded',
      });
    }
  }
  return {
    status: failures.length ? 'partial' : 'saved',
    destination: input.destination,
    destinationId,
    savedTaskIds,
    failures,
  };
}
