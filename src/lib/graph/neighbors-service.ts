import 'server-only';

import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import db from '@/db';
import {
  hubProjects,
  projectPhaseItems,
  projectPhases,
  tags,
  taskDependencies,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { findSimilarTaskEmbeddings } from '@/lib/search/semantic';
import {
  boundGraph,
  canonicalizeExplicitEdge,
  createSemanticSimilarityEdge,
  graphPropertyLabel,
  graphPropertyNodeId,
  GraphQueryValidationError,
  normalizeGraphBudgets,
  normalizeSemanticTopK,
} from './query';
import type {
  GraphEdge,
  GraphPropertyDimension,
  SharedGraphEdge,
  SharedGraphNode,
  TaskGraphNode,
} from './types';

const NEIGHBOR_RELATIONSHIPS = ['explicit', 'derived', 'semantic'] as const;
export type NeighborRelationship = (typeof NEIGHBOR_RELATIONSHIPS)[number];

export class GraphNodeNotFoundError extends Error {
  readonly status = 404;
}

export class GraphAuthorizationError extends Error {
  readonly status = 403;
}

export interface NodeNeighborQuery {
  nodeId: string;
  include?: NeighborRelationship[];
  maxNodes?: number;
  maxEdges?: number;
  semanticTopK?: number;
  authorizeTask?: (taskId: string) => boolean | Promise<boolean>;
}

function normalizeStatus(status: string, microStatus?: string | null) {
  if (
    status === 'blocked'
    || microStatus === 'blocked_external'
    || microStatus === 'started_but_stuck'
    || microStatus === 'waiting_on_someone'
  ) return 'blocked' as const;
  if (status === 'done' || status === 'completed') return 'done' as const;
  if (status === 'in_progress' || status === 'active') return 'in_progress' as const;
  return 'todo' as const;
}

function taskNode(task: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  microStatus: string | null;
}): TaskGraphNode {
  return {
    id: `task:${task.id}`,
    entityId: task.id,
    kind: 'task',
    label: task.title,
    description: task.description,
    status: normalizeStatus(task.status, task.microStatus),
  };
}

function propertyNode(
  dimension: GraphPropertyDimension,
  value: string,
  label?: string,
): SharedGraphNode {
  return {
    id: graphPropertyNodeId(dimension, value),
    entityId: value,
    kind: 'property',
    dimension,
    value,
    label: graphPropertyLabel(dimension, value, label),
  };
}

type NeighborNodeRef =
  | { kind: 'task'; id: string }
  | { kind: 'tag'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'property'; dimension: GraphPropertyDimension; value: string };

const PROPERTY_DIMENSIONS: GraphPropertyDimension[] = [
  'priority',
  'source',
  'status',
  'list',
  'effort',
];

function isGraphPropertyDimension(value: string): value is GraphPropertyDimension {
  return PROPERTY_DIMENSIONS.some((dimension) => dimension === value);
}

function parseNeighborNodeId(nodeId: string): NeighborNodeRef {
  if (nodeId.length > 405) {
    throw new GraphQueryValidationError('Graph node ID is too long');
  }
  for (const kind of ['task', 'tag', 'project'] as const) {
    const prefix = `${kind}:`;
    if (nodeId.startsWith(prefix) && nodeId.length > prefix.length) {
      return { kind, id: nodeId.slice(prefix.length) };
    }
  }
  if (nodeId.startsWith('property:')) {
    const [, rawDimension, ...rawValue] = nodeId.split(':');
    if (!isGraphPropertyDimension(rawDimension) || !rawValue.length) {
      throw new GraphQueryValidationError(
        'Property node IDs must use property:<dimension>:<value>',
      );
    }
    try {
      const value = decodeURIComponent(rawValue.join(':'));
      if (!value) throw new URIError();
      return {
        kind: 'property',
        dimension: rawDimension,
        value,
      };
    } catch {
      throw new GraphQueryValidationError('Property node value must be URI encoded');
    }
  }
  throw new GraphQueryValidationError(
    'Node neighbors support task, tag, project, and property node IDs',
  );
}

function normalizeRelationships(include?: NeighborRelationship[]) {
  const relationships = include ?? ['explicit', 'derived'];
  if (
    !relationships.length
    || relationships.some((value) => !NEIGHBOR_RELATIONSHIPS.includes(value))
  ) {
    throw new GraphQueryValidationError(
      'include must contain explicit, derived, or semantic',
    );
  }
  return new Set(relationships);
}

const neighborTaskColumns = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  microStatus: tasks.microStatus,
};

async function getAggregateNodeNeighbors(
  nodeRef: Exclude<NeighborNodeRef, { kind: 'task' }>,
  include: Set<NeighborRelationship>,
  budgets: { maxNodes: number; maxEdges: number },
  authorizeTask?: NodeNeighborQuery['authorizeTask'],
) {
  let centerNode: SharedGraphNode;
  let taskRows: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    microStatus: string | null;
  }>;

  if (nodeRef.kind === 'tag') {
    const [tag] = await db.select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
    }).from(tags).where(eq(tags.id, nodeRef.id));
    if (!tag) throw new GraphNodeNotFoundError('Graph node not found');
    centerNode = {
      id: `tag:${tag.id}`,
      entityId: tag.id,
      kind: 'tag',
      label: tag.name,
      color: tag.color,
    };
    taskRows = await db.select(neighborTaskColumns)
      .from(taskTags)
      .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
      .where(eq(taskTags.tagId, nodeRef.id))
      .orderBy(asc(tasks.id))
      .limit(budgets.maxNodes);
  } else if (nodeRef.kind === 'project') {
    const [project] = await db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      description: hubProjects.description,
      status: hubProjects.status,
      color: hubProjects.color,
    }).from(hubProjects).where(eq(hubProjects.id, nodeRef.id));
    if (!project) throw new GraphNodeNotFoundError('Graph node not found');
    centerNode = {
      id: `project:${project.id}`,
      entityId: project.id,
      kind: 'project',
      label: project.name,
      description: project.description,
      status: normalizeStatus(project.status),
      color: project.color,
    };
    taskRows = await db.select(neighborTaskColumns)
      .from(taskProjects)
      .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
      .where(eq(taskProjects.projectId, nodeRef.id))
      .orderBy(asc(tasks.id))
      .limit(budgets.maxNodes);
  } else {
    centerNode = propertyNode(nodeRef.dimension, nodeRef.value);
    let condition: SQL;
    if (nodeRef.dimension === 'priority') {
      condition = eq(tasks.priority, nodeRef.value);
    } else if (nodeRef.dimension === 'status') {
      condition = eq(tasks.status, nodeRef.value);
    } else if (nodeRef.dimension === 'source') {
      condition = eq(tasks.connectorType, nodeRef.value);
    } else if (nodeRef.dimension === 'effort') {
      const effort = Number(nodeRef.value);
      if (!Number.isInteger(effort)) {
        throw new GraphQueryValidationError('Effort property value must be an integer');
      }
      condition = eq(tasks.effort, effort);
    } else {
      const separator = nodeRef.value.indexOf(':');
      if (separator <= 0 || separator === nodeRef.value.length - 1) {
        throw new GraphQueryValidationError(
          'List property value must use connector-instance:list-id',
        );
      }
      const listCondition = and(
        eq(tasks.connectorInstanceId, nodeRef.value.slice(0, separator)),
        eq(tasks.sourceListId, nodeRef.value.slice(separator + 1)),
      );
      if (!listCondition) {
        throw new GraphQueryValidationError('Unable to construct list property query');
      }
      condition = listCondition;
    }
    taskRows = await db.select(neighborTaskColumns)
      .from(tasks)
      .where(condition)
      .orderBy(asc(tasks.id))
      .limit(budgets.maxNodes);
    if (!taskRows.length) throw new GraphNodeNotFoundError('Graph node not found');
  }

  if (authorizeTask) {
    const candidateCount = taskRows.length;
    const authorized = await Promise.all(taskRows.map(async (task) => ({
      task,
      allowed: await authorizeTask(task.id),
    })));
    taskRows = authorized.filter((result) => result.allowed).map((result) => result.task);
    if (candidateCount > 0 && taskRows.length === 0) {
      throw new GraphAuthorizationError('Access to this graph node is forbidden');
    }
  }
  if (!include.has('derived')) taskRows = [];
  const sourceTruncated = taskRows.length >= budgets.maxNodes;
  const boundedTasks = taskRows.slice(0, Math.max(budgets.maxNodes - 1, 0));
  const nodes: SharedGraphNode[] = [
    centerNode,
    ...boundedTasks.map((task) => taskNode(task)),
  ];
  const edges: SharedGraphEdge[] = boundedTasks.map((task) => {
    if (nodeRef.kind === 'tag') {
      return {
        id: `has-tag:task:${task.id}:tag:${nodeRef.id}`,
        source: `task:${task.id}`,
        target: `tag:${nodeRef.id}`,
        type: 'has-tag',
        provenance: 'derived',
      };
    }
    if (nodeRef.kind === 'project') {
      return {
        id: `contains:project:${nodeRef.id}:task:${task.id}`,
        source: `project:${nodeRef.id}`,
        target: `task:${task.id}`,
        type: 'contains',
        provenance: 'derived',
      };
    }
    return {
      id: `has-property:task:${task.id}:${nodeRef.dimension}:${encodeURIComponent(nodeRef.value)}`,
      source: `task:${task.id}`,
      target: graphPropertyNodeId(nodeRef.dimension, nodeRef.value),
      type: 'has-property',
      provenance: 'derived',
      dimension: nodeRef.dimension,
    };
  });
  return {
    ...boundGraph(nodes, edges, { ...budgets, sourceTruncated }),
    centerNodeId: centerNode.id,
    semantic: { requested: false, status: 'not-requested' as const },
  };
}

export async function getNodeNeighbors(input: NodeNeighborQuery) {
  const nodeRef = parseNeighborNodeId(input.nodeId);
  const include = normalizeRelationships(input.include);
  const budgets = normalizeGraphBudgets({
    maxNodes: input.maxNodes,
    maxEdges: input.maxEdges,
    neighborQuery: true,
  });
  const semanticTopK = normalizeSemanticTopK(input.semanticTopK);
  if (nodeRef.kind !== 'task') {
    return getAggregateNodeNeighbors(nodeRef, include, budgets, input.authorizeTask);
  }
  const taskId = nodeRef.id;
  if (input.authorizeTask && !await input.authorizeTask(taskId)) {
    throw new GraphAuthorizationError('Access to this graph node is forbidden');
  }
  const [center] = await db.select({
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    microStatus: tasks.microStatus,
    priority: tasks.priority,
    connectorType: tasks.connectorType,
    connectorInstanceId: tasks.connectorInstanceId,
    sourceListId: tasks.sourceListId,
    sourceListName: tasks.sourceListName,
    effort: tasks.effort,
  }).from(tasks).where(eq(tasks.id, taskId));
  if (!center) {
    throw new GraphNodeNotFoundError('Graph node not found');
  }

  const nodes = new Map<string, SharedGraphNode>([
    [`task:${center.id}`, taskNode(center)],
  ]);
  const edges = new Map<string, SharedGraphEdge>();

  if (include.has('explicit')) {
    const dependencies = await db.select().from(taskDependencies).where(or(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, taskId),
    )).orderBy(asc(taskDependencies.createdAt), asc(taskDependencies.id));
    const neighborTaskIds = [...new Set(dependencies.flatMap((dependency) => [
      dependency.taskId,
      dependency.dependsOnTaskId,
    ]).filter((id) => id !== taskId))];
    const dependencyTasks = neighborTaskIds.length
      ? await db.select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          microStatus: tasks.microStatus,
        }).from(tasks).where(inArray(tasks.id, neighborTaskIds))
      : [];
    const dependencyTaskById = new Map(dependencyTasks.map((task) => [task.id, task]));
    for (const taskId of neighborTaskIds) {
      const dependencyTask = dependencyTaskById.get(taskId);
      if (!dependencyTask) continue;
      nodes.set(`task:${dependencyTask.id}`, taskNode(dependencyTask));
    }
    for (const dependency of dependencies) {
      const metadata = {
        id: `dependency:${dependency.id}`,
        source: `task:${dependency.dependsOnTaskId}`,
        target: `task:${dependency.taskId}`,
        provenance: 'explicit',
        syncStatus: dependency.syncStatus,
        syncAction: dependency.syncAction,
        syncError: dependency.syncError,
        lastSyncedAt: dependency.lastSyncedAt,
      } as const;
      const edge: GraphEdge = canonicalizeExplicitEdge(
        dependency.type === 'blocks'
          ? { ...metadata, type: 'blocks' }
          : { ...metadata, type: 'related' },
      );
      edges.set(edge.id, edge);
    }
  }

  if (include.has('derived')) {
    const [projectRows, phaseRows, tagRows] = await Promise.all([
      db.select({
        id: hubProjects.id,
        name: hubProjects.name,
        description: hubProjects.description,
        status: hubProjects.status,
        color: hubProjects.color,
      }).from(taskProjects)
        .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
        .where(eq(taskProjects.taskId, taskId)),
      db.select({
        id: projectPhases.id,
        name: projectPhases.name,
        description: projectPhases.description,
        status: projectPhases.status,
        color: projectPhases.color,
      }).from(projectPhaseItems)
        .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
        .where(and(
          eq(projectPhaseItems.taskId, taskId),
          eq(projectPhaseItems.isProposed, false),
        )),
      db.select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
      }).from(taskTags)
        .innerJoin(tags, eq(taskTags.tagId, tags.id))
        .where(eq(taskTags.taskId, taskId)),
    ]);
    for (const project of projectRows) {
      const nodeId = `project:${project.id}`;
      nodes.set(nodeId, {
        id: nodeId,
        entityId: project.id,
        kind: 'project',
        label: project.name,
        description: project.description,
        status: normalizeStatus(project.status),
        color: project.color,
      });
      edges.set(`contains:${nodeId}:task:${taskId}`, {
        id: `contains:${nodeId}:task:${taskId}`,
        source: nodeId,
        target: `task:${taskId}`,
        type: 'contains',
        provenance: 'derived',
      });
    }
    for (const phase of phaseRows) {
      const nodeId = `phase:${phase.id}`;
      nodes.set(nodeId, {
        id: nodeId,
        entityId: phase.id,
        kind: 'phase',
        label: phase.name,
        description: phase.description,
        status: normalizeStatus(phase.status),
        color: phase.color,
      });
      edges.set(`contains:${nodeId}:task:${taskId}`, {
        id: `contains:${nodeId}:task:${taskId}`,
        source: nodeId,
        target: `task:${taskId}`,
        type: 'contains',
        provenance: 'derived',
      });
    }
    for (const tag of tagRows) {
      const nodeId = `tag:${tag.id}`;
      nodes.set(nodeId, {
        id: nodeId,
        entityId: tag.id,
        kind: 'tag',
        label: tag.name,
        color: tag.color,
      });
      edges.set(`has-tag:task:${taskId}:${nodeId}`, {
        id: `has-tag:task:${taskId}:${nodeId}`,
        source: `task:${taskId}`,
        target: nodeId,
        type: 'has-tag',
        provenance: 'derived',
      });
    }
    const properties: Array<[GraphPropertyDimension, string | null, string?]> = [
      ['priority', center.priority],
      ['status', center.status],
      ['source', center.connectorType],
      [
        'list',
        center.sourceListId
          ? `${center.connectorInstanceId}:${center.sourceListId}`
          : null,
        center.sourceListName ?? undefined,
      ],
      ['effort', center.effort === null ? null : String(center.effort)],
    ];
    for (const [dimension, value, label] of properties) {
      if (!value) continue;
      const node = propertyNode(dimension, value, label);
      nodes.set(node.id, node);
      const edgeId = `has-property:task:${taskId}:${dimension}:${encodeURIComponent(value)}`;
      edges.set(edgeId, {
        id: edgeId,
        source: `task:${taskId}`,
        target: node.id,
        type: 'has-property',
        provenance: 'derived',
        dimension,
      });
    }
  }

  let semantic: {
    requested: boolean;
    status:
      | 'not-requested'
      | 'available'
      | 'unavailable'
      | 'missing'
      | 'stale'
      | 'incompatible';
    note?: string;
  } = { requested: false, status: 'not-requested' };
  if (include.has('semantic')) {
    const similarity = await findSimilarTaskEmbeddings(taskId, { limit: semanticTopK });
    semantic = {
      requested: true,
      status: similarity.status,
      ...('note' in similarity ? { note: similarity.note } : {}),
    };
    if (similarity.status === 'available' && similarity.neighbors.length) {
      const semanticTasks = await db.select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        microStatus: tasks.microStatus,
      }).from(tasks).where(inArray(
        tasks.id,
        similarity.neighbors.map((neighbor) => neighbor.taskId),
      ));
      for (const semanticTask of semanticTasks) {
        nodes.set(`task:${semanticTask.id}`, taskNode(semanticTask));
      }
      for (const neighbor of similarity.neighbors) {
        const edge = createSemanticSimilarityEdge({
          source: `task:${taskId}`,
          target: `task:${neighbor.taskId}`,
          score: neighbor.score,
          embedding: {
            provider: similarity.provider,
            model: similarity.model,
            sourceUpdatedAt: similarity.sourceUpdatedAt,
            targetUpdatedAt: neighbor.embeddingUpdatedAt,
          },
        });
        edges.set(edge.id, edge);
      }
    }
  }

  return {
    ...boundGraph([...nodes.values()], [...edges.values()], budgets),
    centerNodeId: `task:${taskId}`,
    semantic,
  };
}

export function parseNodeNeighborSearchParams(
  nodeId: string,
  searchParams: URLSearchParams,
): NodeNeighborQuery {
  const rawInclude = searchParams.get('include');
  const include = rawInclude
    ? rawInclude.split(',').map((value) => value.trim()).filter(Boolean)
    : undefined;
  const number = (key: string) => {
    const raw = searchParams.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new GraphQueryValidationError(`${key} must be a finite number`);
    }
    return value;
  };
  return {
    nodeId,
    include: include as NeighborRelationship[] | undefined,
    maxNodes: number('maxNodes'),
    maxEdges: number('maxEdges'),
    semanticTopK: number('semanticTopK'),
  };
}
