import 'server-only';

import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import { findSimilarTaskEmbeddings } from '@/lib/search/semantic';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { requireGraphReportingPersistence } from '@/db/persistence/worker-repositories';
import type { NeighborAggregateRef } from '@/db/persistence/graph-reporting';
import { isUniverseSemanticNeighborsEnabled } from './universe-semantic-config';
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
  eligibleTaskIds?: string[];
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

async function getAggregateNodeNeighbors(
  nodeRef: Exclude<NeighborNodeRef, { kind: 'task' }>,
  include: Set<NeighborRelationship>,
  budgets: { maxNodes: number; maxEdges: number },
  eligibleTaskIds?: string[],
) {
  if (
    nodeRef.kind === 'property'
    && nodeRef.dimension === 'effort'
    && !Number.isInteger(Number(nodeRef.value))
  ) {
    throw new GraphQueryValidationError('Effort property value must be an integer');
  }
  if (
    nodeRef.kind === 'property'
    && nodeRef.dimension === 'list'
    && (
      nodeRef.value.indexOf(':') <= 0
      || nodeRef.value.indexOf(':') === nodeRef.value.length - 1
    )
  ) {
    throw new GraphQueryValidationError(
      'List property value must use connector-instance:list-id',
    );
  }
  const repository = requireGraphReportingPersistence(
    await getWorkerPersistenceRepositories(),
  ).neighbors;
  const result = await repository.readAggregate({
    ref: nodeRef as NeighborAggregateRef,
    eligibleTaskIds,
    limit: budgets.maxNodes,
  });
  if (!result.center) throw new GraphNodeNotFoundError('Graph node not found');
  if (nodeRef.kind === 'property' && !result.tasks.length) {
    throw new GraphNodeNotFoundError('Graph node not found');
  }
  let centerNode: SharedGraphNode;
  if (result.center.kind === 'tag') {
    centerNode = {
      id: `tag:${result.center.row.id}`,
      entityId: result.center.row.id,
      kind: 'tag',
      label: result.center.row.name,
      color: result.center.row.color,
    };
  } else if (result.center.kind === 'project') {
    centerNode = {
      id: `project:${result.center.row.id}`,
      entityId: result.center.row.id,
      kind: 'project',
      label: result.center.row.name,
      description: result.center.row.description,
      status: normalizeStatus(result.center.row.status),
      color: result.center.row.color,
    };
  } else {
    const propertyRef = nodeRef as Extract<NeighborNodeRef, { kind: 'property' }>;
    centerNode = propertyNode(propertyRef.dimension, propertyRef.value);
  }
  let taskRows = result.tasks;

  if (eligibleTaskIds && taskRows.length === 0) {
    throw new GraphNodeNotFoundError('Graph node not found');
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
  let eligibleTaskIds = input.eligibleTaskIds;
  if (input.authorizeTask) {
    if (!eligibleTaskIds) {
      throw new GraphAuthorizationError(
        'An eligible task scope is required before authorized neighborhood expansion',
      );
    }
    const authorized = await Promise.all(eligibleTaskIds.map(async (id) => ({
      id,
      allowed: await input.authorizeTask?.(id),
    })));
    eligibleTaskIds = authorized
      .filter((candidate) => candidate.allowed)
      .map((candidate) => candidate.id);
  }
  if (nodeRef.kind !== 'task') {
    return getAggregateNodeNeighbors(
      nodeRef,
      include,
      budgets,
      eligibleTaskIds,
    );
  }
  const taskId = nodeRef.id;
  if (eligibleTaskIds && !eligibleTaskIds.includes(taskId)) {
    throw new GraphAuthorizationError('Access to this graph node is forbidden');
  }
  if (input.authorizeTask && !await input.authorizeTask(taskId)) {
    throw new GraphAuthorizationError('Access to this graph node is forbidden');
  }
  const repository = requireGraphReportingPersistence(
    await getWorkerPersistenceRepositories(),
  ).neighbors;
  const context = await repository.readTask({
    taskId,
    eligibleTaskIds,
    dependencyLimit: budgets.maxEdges + 1,
    includeExplicit: include.has('explicit'),
    includeDerived: include.has('derived'),
  });
  const center = context.center;
  if (!center) {
    throw new GraphNodeNotFoundError('Graph node not found');
  }

  const nodes = new Map<string, SharedGraphNode>([
    [`task:${center.id}`, taskNode(center)],
  ]);
  const edges = new Map<string, SharedGraphEdge>();

  if (include.has('explicit')) {
    const dependencies = context.dependencies;
    const neighborTaskIds = [...new Set(dependencies.flatMap((dependency) => [
      dependency.taskId,
      dependency.dependsOnTaskId,
    ]).filter((id) => id !== taskId))];
    const eligibleNeighborTaskIds = neighborTaskIds;
    const dependencyTaskById = new Map(context.dependencyTasks.map((task) => [task.id, task]));
    for (const taskId of eligibleNeighborTaskIds) {
      const dependencyTask = dependencyTaskById.get(taskId);
      if (!dependencyTask) continue;
      nodes.set(`task:${dependencyTask.id}`, taskNode(dependencyTask));
    }
    for (const dependency of dependencies) {
      if (
        dependency.taskId !== taskId
        && !eligibleNeighborTaskIds.includes(dependency.taskId)
      ) continue;
      if (
        dependency.dependsOnTaskId !== taskId
        && !eligibleNeighborTaskIds.includes(dependency.dependsOnTaskId)
      ) continue;
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
    const [projectRows, phaseRows, tagRows] = [
      context.projects,
      context.phases,
      context.tags,
    ];
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
      | 'partial'
      | 'denied'
      | 'unavailable'
      | 'missing'
      | 'stale'
      | 'incompatible';
    note?: string;
  } = { requested: false, status: 'not-requested' };
  if (include.has('semantic')) {
    if (!isUniverseSemanticNeighborsEnabled()) {
      semantic = {
        requested: true,
        status: 'denied',
        note: 'Universe semantic neighborhoods are disabled by the independent feature gate.',
      };
    } else {
      const deletedConnectorIds = await repository.listDeletedConnectorIds();
      const similarity = await findSimilarTaskEmbeddings(taskId, {
        limit: semanticTopK,
        eligibleTaskIds,
        eligibilityFilters: [
          {
            keys: ['connectorType'],
            match: 'none',
            values: [...NOTIFICATION_ONLY_CONNECTOR_TYPES],
          },
        ],
        excludedConnectorInstanceIds: deletedConnectorIds,
      });
    semantic = {
      requested: true,
      status: similarity.status,
      ...('note' in similarity ? { note: similarity.note } : {}),
    };
    if (
      (similarity.status === 'available' || similarity.status === 'partial')
      && similarity.neighbors.length
    ) {
      const semanticTasks = await repository.listTasks(
        similarity.neighbors.map((neighbor) => neighbor.taskId),
      );
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
            indexId: similarity.indexId,
            projectionVersion: similarity.projectionVersion,
            sourceUpdatedAt: similarity.sourceUpdatedAt,
            targetUpdatedAt: neighbor.sourceUpdatedAt,
            sourceEmbeddedAt: similarity.sourceEmbeddedAt,
            targetEmbeddedAt: neighbor.embeddedAt,
          },
        });
        edges.set(edge.id, edge);
      }
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
