import 'server-only';

import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, like, ne } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  hubProjects,
  projectPhaseItems,
  projectPhases,
  taskDependencies,
  taskProjects,
  tasks,
} from '@/db/schema';
import {
  buildProjectSubgraph,
  hasDuplicateDependency,
  wouldCreateBlockingCycle,
} from './project-subgraph';
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

export async function getProjectSubgraph(
  projectId: string,
  maxNodes = DEFAULT_PROJECT_GRAPH_LIMIT,
  maxEdges?: number,
): Promise<ProjectSubgraph | null> {
  const budgets = normalizeGraphBudgets({ maxNodes, maxEdges });
  const [project] = await db.select({
    id: hubProjects.id,
    name: hubProjects.name,
    description: hubProjects.description,
    status: hubProjects.status,
    color: hubProjects.color,
  }).from(hubProjects).where(eq(hubProjects.id, projectId));

  if (!project) return null;

  const phases = await db.select({
    id: projectPhases.id,
    name: projectPhases.name,
    description: projectPhases.description,
    status: projectPhases.status,
    color: projectPhases.color,
    startAfterPhaseId: projectPhases.startAfterPhaseId,
  }).from(projectPhases)
    .where(eq(projectPhases.projectId, projectId))
    .orderBy(projectPhases.sortOrder);

  const projectTasks = await db.select({
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    microStatus: tasks.microStatus,
  }).from(taskProjects)
    .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
    .where(eq(taskProjects.projectId, projectId));

  const phaseIds = phases.map((phase) => phase.id);
  const phaseItems = phaseIds.length > 0
    ? await db.select({
        phaseId: projectPhaseItems.phaseId,
        taskId: projectPhaseItems.taskId,
      }).from(projectPhaseItems).where(inArray(projectPhaseItems.phaseId, phaseIds))
        .orderBy(
          asc(projectPhaseItems.phaseId),
          asc(projectPhaseItems.sortOrder),
          asc(projectPhaseItems.createdAt),
          asc(projectPhaseItems.id),
        )
    : [];

  const taskIds = projectTasks.map((task) => task.id);
  const dependencies = taskIds.length > 0
    ? await db.select({
        id: taskDependencies.id,
        taskId: taskDependencies.taskId,
        dependsOnTaskId: taskDependencies.dependsOnTaskId,
        type: taskDependencies.type,
        syncStatus: taskDependencies.syncStatus,
        syncAction: taskDependencies.syncAction,
        syncError: taskDependencies.syncError,
        lastSyncedAt: taskDependencies.lastSyncedAt,
      }).from(taskDependencies).where(
        and(
          inArray(taskDependencies.taskId, taskIds),
          inArray(taskDependencies.dependsOnTaskId, taskIds),
        ),
      )
    : [];

  return buildProjectSubgraph({
    project,
    phases,
    tasks: projectTasks,
    phaseItems,
    taskDependencies: dependencies,
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

  try {
    const created = runTransaction((tx) => {
      if (input.projectId) {
        const memberships = tx.select({ taskId: taskProjects.taskId })
          .from(taskProjects)
          .where(and(
            eq(taskProjects.projectId, input.projectId),
            inArray(taskProjects.taskId, [sourceTaskId, targetTaskId]),
          ))
          .all();
        if (new Set(memberships.map((membership) => membership.taskId)).size !== 2) {
          throw new GraphServiceError('Both tasks must belong to this project', 404);
        }
      }
      const dependencyTasks = tx.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorInstanceId: tasks.connectorInstanceId,
        isChecklistItem: tasks.isChecklistItem,
        metadata: tasks.metadata,
      }).from(tasks).where(
        inArray(tasks.id, [sourceTaskId, targetTaskId]),
      ).all();
      const taskById = new Map(dependencyTasks.map((task) => [task.id, task]));
      const blocker = taskById.get(sourceTaskId);
      const blocked = taskById.get(targetTaskId);
      if (!blocker || !blocked) {
        throw new GraphServiceError('Both tasks must exist', 404);
      }

      // Dependencies are global: validation must include cross-project paths.
      const existingDependencies = tx.select({
        taskId: taskDependencies.taskId,
        dependsOnTaskId: taskDependencies.dependsOnTaskId,
        type: taskDependencies.type,
      }).from(taskDependencies).all();
      const existingTaskIds = new Set(
        tx.select({ id: tasks.id }).from(tasks).all().map((task) => task.id),
      );
      const validDependencies = existingDependencies.filter((dependency) =>
        existingTaskIds.has(dependency.taskId)
        && existingTaskIds.has(dependency.dependsOnTaskId));

      if (hasDuplicateDependency(
        validDependencies,
        sourceTaskId,
        targetTaskId,
        input.type,
      )) {
        throw new GraphServiceError('This dependency already exists', 409);
      }

      if (
        input.type === 'blocks'
        && wouldCreateBlockingCycle(
          validDependencies,
          sourceTaskId,
          targetTaskId,
        )
      ) {
        throw new GraphServiceError('This dependency would create a cycle', 409);
      }

      const dependency = {
        id: randomUUID(),
        taskId: targetTaskId,
        dependsOnTaskId: sourceTaskId,
        type: input.type,
        connectorInstanceId: null,
        syncStatus: 'local' as const,
        syncAction: null,
        syncError: null,
        lastSyncedAt: null,
        createdAt: new Date().toISOString(),
      };
      tx.insert(taskDependencies).values(dependency).run();
      return { dependency, blocker, blocked };
    });
    return await synchronizeCreatedTaskDependency(
      created.dependency,
      created.blocker,
      created.blocked,
    );
  } catch (error) {
    if (error instanceof GraphServiceError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      throw new GraphServiceError('This dependency already exists', 409);
    }
    throw error;
  }
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
  const dependencyId = input.dependencyId.startsWith('dependency:')
    ? input.dependencyId.slice('dependency:'.length)
    : input.dependencyId;
  const [dependency] = await db.select().from(taskDependencies).where(
    eq(taskDependencies.id, dependencyId),
  );
  if (!dependency) {
    throw new GraphServiceError('Dependency not found', 404);
  }

  if (
    input.taskId
    && dependency.taskId !== input.taskId
    && dependency.dependsOnTaskId !== input.taskId
  ) {
    throw new GraphServiceError('Dependency not found for this task', 404);
  }

  if (input.projectId) {
    const memberships = await db.select({ taskId: taskProjects.taskId })
      .from(taskProjects)
      .where(and(
        eq(taskProjects.projectId, input.projectId),
        inArray(taskProjects.taskId, [dependency.taskId, dependency.dependsOnTaskId]),
      ));
    if (new Set(memberships.map((membership) => membership.taskId)).size !== 2) {
      throw new GraphServiceError('Dependency not found in this project', 404);
    }
  }

  const dependencyTasks = await db.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
    connectorInstanceId: tasks.connectorInstanceId,
    isChecklistItem: tasks.isChecklistItem,
    metadata: tasks.metadata,
  }).from(tasks).where(
    inArray(tasks.id, [dependency.taskId, dependency.dependsOnTaskId]),
  );
  const taskById = new Map(dependencyTasks.map((task) => [task.id, task]));
  const blocker = taskById.get(dependency.dependsOnTaskId);
  const blocked = taskById.get(dependency.taskId);
  if (!blocker || !blocked) {
    throw new GraphServiceError('Dependency tasks no longer exist', 404);
  }

  const result = await removeTaskDependencyFromSource(
    dependency,
    blocker,
    blocked,
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

  const [taskRows, membershipRows] = await Promise.all([
    db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      connectorType: tasks.connectorType,
      sourceId: tasks.sourceId,
      metadata: tasks.metadata,
    }).from(tasks).where(inArray(tasks.id, taskIds)),
    db.select({
      taskId: taskProjects.taskId,
      projectId: taskProjects.projectId,
    }).from(taskProjects).where(inArray(taskProjects.taskId, taskIds)),
  ]);
  const projectIds = [...new Set(membershipRows.map((row) => row.projectId))];
  const projectRows = projectIds.length > 0
    ? await db.select({
        id: hubProjects.id,
        name: hubProjects.name,
      }).from(hubProjects).where(inArray(hubProjects.id, projectIds))
    : [];
  const projectNameById = new Map(projectRows.map((project) => [project.id, project.name]));
  const membershipsByTask = new Map<string, string[]>();
  for (const membership of membershipRows) {
    const ids = membershipsByTask.get(membership.taskId) ?? [];
    ids.push(membership.projectId);
    membershipsByTask.set(membership.taskId, ids);
  }

  return new Map(taskRows.map((task) => {
    const taskProjectIds = membershipsByTask.get(task.id) ?? [];
    return [task.id, {
      ...task,
      projectIds: taskProjectIds,
      projectNames: taskProjectIds
        .map((projectId) => projectNameById.get(projectId))
        .filter((name): name is string => Boolean(name)),
    }];
  }));
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
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;

  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const normalizedQuery = query.trim();
  const taskRows = await db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    connectorType: tasks.connectorType,
    sourceListName: tasks.sourceListName,
  }).from(tasks).where(and(
    ne(tasks.id, taskId),
    normalizedQuery ? like(tasks.title, `%${normalizedQuery}%`) : undefined,
  )).orderBy(asc(tasks.title)).limit(boundedLimit);

  const details = await getRelationshipTaskDetails(taskRows.map((candidate) => candidate.id));
  return taskRows.map((candidate) => ({
    ...candidate,
    projectIds: details.get(candidate.id)?.projectIds ?? [],
    projectNames: details.get(candidate.id)?.projectNames ?? [],
  }));
}
