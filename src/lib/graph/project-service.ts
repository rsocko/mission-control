import 'server-only';

import { randomUUID } from 'crypto';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { requireGraphReportingPersistence } from '@/db/persistence/worker-repositories';
import {
  buildProjectSubgraph,
} from './project-subgraph';
import type { ProjectSubgraph } from './types';
import { canonicalPair, normalizeGraphBudgets } from './query';
import {
  removeTaskDependencyFromSource,
  synchronizeCreatedTaskDependency,
} from '@/lib/sync/task-dependency-manager';

const DEFAULT_PROJECT_GRAPH_LIMIT = 500;

export class ProjectGraphServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

async function repository() {
  return requireGraphReportingPersistence(
    await getWorkerPersistenceRepositories(),
  ).projects;
}

export async function getProjectSubgraph(
  projectId: string,
  maxNodes = DEFAULT_PROJECT_GRAPH_LIMIT,
  maxEdges?: number,
): Promise<ProjectSubgraph | null> {
  const budgets = normalizeGraphBudgets({ maxNodes, maxEdges });
  const rows = await (await repository()).read(projectId);
  if (!rows.project) return null;
  return buildProjectSubgraph({
    project: rows.project,
    phases: rows.phases,
    tasks: rows.tasks,
    phaseItems: rows.phaseItems,
    taskDependencies: rows.dependencies,
  }, budgets.maxNodes, budgets.maxEdges);
}

export async function createTaskDependency(input: {
  projectId: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: 'blocks' | 'related';
}) {
  if (input.sourceTaskId === input.targetTaskId) {
    throw new ProjectGraphServiceError('A task cannot depend on itself', 400);
  }
  const [sourceTaskId, targetTaskId] = input.type === 'related'
    ? canonicalPair(input.sourceTaskId, input.targetTaskId)
    : [input.sourceTaskId, input.targetTaskId];
  const result = await (await repository()).createDependency({
    ...input,
    sourceTaskId,
    targetTaskId,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (result.kind === 'missing-project-membership') {
    throw new ProjectGraphServiceError('Both tasks must belong to this project', 404);
  }
  if (result.kind === 'missing-task') {
    throw new ProjectGraphServiceError('Both tasks must exist', 404);
  }
  if (result.kind === 'duplicate') {
    throw new ProjectGraphServiceError('This dependency already exists', 409);
  }
  if (result.kind === 'cycle') {
    throw new ProjectGraphServiceError('This dependency would create a cycle', 409);
  }
  return synchronizeCreatedTaskDependency(
    result.dependency,
    result.blocker,
    result.blocked,
  );
}

export async function deleteTaskDependency(input: {
  projectId: string;
  dependencyId: string;
}): Promise<{ deleted: true }> {
  const result = await (await repository()).getDependencyDeleteContext(input);
  if (result.kind === 'missing') {
    throw new ProjectGraphServiceError('Dependency not found', 404);
  }
  if (result.kind === 'wrong-task') {
    throw new ProjectGraphServiceError('Dependency not found for this task', 404);
  }
  if (result.kind === 'missing-project-membership') {
    throw new ProjectGraphServiceError('Dependency not found in this project', 404);
  }
  if (result.kind === 'missing-task') {
    throw new ProjectGraphServiceError('Dependency tasks no longer exist', 404);
  }
  const removed = await removeTaskDependencyFromSource(
    result.dependency,
    result.blocker,
    result.blocked,
  );
  if (!removed.deleted) {
    throw new ProjectGraphServiceError(
      removed.error || 'Failed to remove dependency from source',
      502,
    );
  }
  return { deleted: true };
}
