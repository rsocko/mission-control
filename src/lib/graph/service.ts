import 'server-only';

import { randomUUID } from 'crypto';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { requireGraphReportingPersistence } from '@/db/persistence/worker-repositories';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { buildProjectSubgraph } from './project-subgraph';
import type { ProjectSubgraph } from './types';
import { canonicalPair, normalizeGraphBudgets } from './query';
import {
  getNodeNeighbors,
  GraphNodeNotFoundError,
} from './neighbors-service';
import type {
  TaskRelationship,
  TaskRelationshipCandidate,
  TaskRelationshipsResult,
  TaskRelationshipTask,
} from '@/lib/task-relationships-types';
import {
  removeTaskDependencyFromSource,
  synchronizeCreatedTaskDependency,
} from '@/lib/sync/task-dependency-manager';

const DEFAULT_PROJECT_GRAPH_LIMIT = 500;

export class GraphServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

async function graphReporting() {
  return requireGraphReportingPersistence(
    await getWorkerPersistenceRepositories(),
  );
}

export async function getProjectSubgraph(
  projectId: string,
  maxNodes = DEFAULT_PROJECT_GRAPH_LIMIT,
  maxEdges?: number,
): Promise<ProjectSubgraph | null> {
  const budgets = normalizeGraphBudgets({ maxNodes, maxEdges });
  const rows = await (await graphReporting()).projects.read(projectId);
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
  return createValidatedTaskDependency(input);
}

export async function createGlobalTaskDependency(input: {
  sourceTaskId: string;
  targetTaskId: string;
  type: 'blocks' | 'related';
}) {
  return createValidatedTaskDependency(input);
}

async function createValidatedTaskDependency(input: {
  projectId?: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: 'blocks' | 'related';
}) {
  if (input.sourceTaskId === input.targetTaskId) {
    throw new GraphServiceError('A task cannot depend on itself', 400);
  }

  const [sourceTaskId, targetTaskId] = input.type === 'related'
    ? canonicalPair(input.sourceTaskId, input.targetTaskId)
    : [input.sourceTaskId, input.targetTaskId];

  const created = await (await graphReporting()).projects.createDependency({
    ...input,
    sourceTaskId,
    targetTaskId,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (created.kind === 'missing-project-membership') {
    throw new GraphServiceError('Both tasks must belong to this project', 404);
  }
  if (created.kind === 'missing-task') {
    throw new GraphServiceError('Both tasks must exist', 404);
  }
  if (created.kind === 'duplicate') {
    throw new GraphServiceError('This dependency already exists', 409);
  }
  if (created.kind === 'cycle') {
    throw new GraphServiceError('This dependency would create a cycle', 409);
  }

  // The dependency is durable before any connector call is attempted.
  return synchronizeCreatedTaskDependency(
    created.dependency,
    created.blocker,
    created.blocked,
  );
}

export async function deleteTaskDependency(input: {
  projectId: string;
  dependencyId: string;
}): Promise<{ deleted: true }> {
  return deleteValidatedTaskDependency(input);
}

export async function deleteGlobalTaskDependency(input: {
  taskId: string;
  dependencyId: string;
}): Promise<{ deleted: true }> {
  return deleteValidatedTaskDependency(input);
}

async function deleteValidatedTaskDependency(input: {
  projectId?: string;
  taskId?: string;
  dependencyId: string;
}): Promise<{ deleted: true }> {
  const context = await (await graphReporting()).projects.getDependencyDeleteContext(input);
  if (context.kind === 'missing') {
    throw new GraphServiceError('Dependency not found', 404);
  }
  if (context.kind === 'wrong-task') {
    throw new GraphServiceError('Dependency not found for this task', 404);
  }
  if (context.kind === 'missing-project-membership') {
    throw new GraphServiceError('Dependency not found in this project', 404);
  }
  if (context.kind === 'missing-task') {
    throw new GraphServiceError('Dependency tasks no longer exist', 404);
  }

  // Remote first: the local row is only removed once the source agrees.
  const result = await removeTaskDependencyFromSource(
    context.dependency,
    context.blocker,
    context.blocked,
  );
  if (!result.deleted) {
    throw new GraphServiceError(
      result.error || 'Failed to remove dependency from source',
      502,
    );
  }
  return { deleted: true };
}

async function getRelationshipTaskDetails(
  taskIds: string[],
): Promise<Map<string, TaskRelationshipTask>> {
  if (taskIds.length === 0) return new Map();

  const rows = await (await graphReporting()).neighbors.listRelationshipTasks(taskIds);
  return new Map(rows.map((task) => [task.id, {
    id: task.id,
    title: task.title,
    status: task.status,
    connectorType: task.connectorType,
    sourceId: task.sourceId,
    metadata: task.metadata,
    projectIds: task.projectIds,
    projectNames: task.projectNames,
  }]));
}

export async function getTaskRelationships(
  taskId: string,
): Promise<TaskRelationshipsResult | null> {
  let graph;
  try {
    graph = await getNodeNeighbors({
      nodeId: `task:${taskId}`,
      include: ['explicit'],
      maxNodes: 250,
      // The center task consumes one node from the shared neighbor budget.
      maxEdges: 249,
    });
  } catch (error) {
    if (error instanceof GraphNodeNotFoundError) return null;
    throw error;
  }

  const centerNodeId = `task:${taskId}`;
  const relationshipEdges = graph.edges.filter((edge) =>
    edge.provenance === 'explicit'
    && (edge.type === 'blocks' || edge.type === 'related'));
  const relatedTaskIds = relationshipEdges.map((edge) => {
    const nodeId = edge.source === centerNodeId ? edge.target : edge.source;
    return nodeId.slice('task:'.length);
  });
  const taskById = await getRelationshipTaskDetails(relatedTaskIds);

  const relationships = relationshipEdges.flatMap((edge): TaskRelationship[] => {
    const relatedTaskNodeId = edge.source === centerNodeId ? edge.target : edge.source;
    const relatedTaskId = relatedTaskNodeId.slice('task:'.length);
    const relatedTask = taskById.get(relatedTaskId);
    if (!relatedTask) return [];

    return [{
      edge: {
        ...edge,
        syncStatus: edge.syncStatus ?? 'local',
        syncAction: edge.syncAction ?? null,
        syncError: edge.syncError ?? null,
        lastSyncedAt: edge.lastSyncedAt ?? null,
      },
      direction: edge.type === 'related'
        ? 'related'
        : edge.source === centerNodeId ? 'outgoing' : 'incoming',
      task: relatedTask,
    }];
  });
  return { relationships, pageInfo: graph.pageInfo };
}

export async function searchTaskRelationshipCandidates(
  taskId: string,
  query: string,
  limit = 20,
): Promise<TaskRelationshipCandidate[] | null> {
  const persistence = await getTaskCorePersistence();
  const candidates = await persistence.taskReads.searchRelationshipCandidates({
    taskId,
    query,
    limit,
  });
  if (!candidates) return null;

  return candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    status: candidate.status,
    connectorType: candidate.connectorType,
    sourceListName: candidate.sourceListName,
    projectIds: candidate.projectIds,
    projectNames: candidate.projectNames,
  }));
}
