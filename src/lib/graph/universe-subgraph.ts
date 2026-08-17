import {
  DEFAULT_UNIVERSE_DIMENSIONS,
  UNIVERSE_DIMENSION_COLORS,
  getUniverseSourceColor,
  type UniverseDimension,
  type UniverseEdge,
  type UniverseFacets,
  type UniverseNode,
  type UniverseProjectRecord,
  type UniverseSubgraph,
  type UniverseTagRecord,
  type UniverseTaskRecord,
} from './universe-types';
import {
  boundGraph,
  graphPropertyLabel,
  graphPropertyNodeId,
} from './query';
import type { GraphPropertyDimension } from './types';
import type { GraphSubgraph, SharedGraphNode } from './types';
import { getTaskPriorityVisual, getTaskStatusVisual } from '@/lib/constants/task-formatting';

function attributeId(dimension: UniverseDimension, key: string): string {
  return dimension === 'tags'
    ? `tag:${key}`
    : graphPropertyNodeId(dimension as GraphPropertyDimension, key);
}

function emptyFacets(): UniverseFacets {
  return { priorities: [], statuses: [], sources: [], lists: [] };
}

function toUniverseNode(node: SharedGraphNode): UniverseNode | null {
  if (node.kind === 'task') {
    return { ...node, color: '#e2e8f0' };
  }
  if (node.kind === 'project') {
    return { ...node, color: node.color ?? UNIVERSE_DIMENSION_COLORS.project };
  }
  if (node.kind === 'tag') {
    return {
      ...node,
      color: node.color ?? UNIVERSE_DIMENSION_COLORS.tags,
      dimension: 'tags',
      value: node.entityId,
    };
  }
  if (node.kind === 'property') {
    return {
      ...node,
      color: node.color ?? UNIVERSE_DIMENSION_COLORS[node.dimension],
    };
  }
  return null;
}

function endpointId(endpoint: unknown): string {
  if (typeof endpoint === 'string') return endpoint;
  if (typeof endpoint === 'object' && endpoint !== null && 'id' in endpoint) {
    return typeof endpoint.id === 'string' ? endpoint.id : '';
  }
  return '';
}

export function mergeUniverseSubgraph(
  current: UniverseSubgraph,
  incoming: GraphSubgraph,
  options: {
    dimensions?: UniverseDimension[];
    maxNodes?: number;
    maxEdges?: number;
  } = {},
): {
  graph: UniverseSubgraph;
  droppedNodes: number;
  droppedEdges: number;
} {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const dimensions = new Set(options.dimensions ?? DEFAULT_UNIVERSE_DIMENSIONS);
  const maxNodes = options.maxNodes ?? 500;
  const maxEdges = options.maxEdges ?? 2_000;
  const budgetDroppedNodeIds = new Set<string>();
  for (const node of incoming.nodes) {
    const enabled = node.kind === 'task'
      || (node.kind === 'project' && dimensions.has('project'))
      || (node.kind === 'tag' && dimensions.has('tags'))
      || (node.kind === 'property' && dimensions.has(node.dimension));
    if (!enabled || nodes.has(node.id)) continue;
    if (nodes.size >= maxNodes) {
      budgetDroppedNodeIds.add(node.id);
      continue;
    }
    const universeNode = toUniverseNode(node);
    if (universeNode) nodes.set(universeNode.id, universeNode);
  }

  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  let droppedEdges = 0;
  for (const edge of incoming.edges) {
    if (
      budgetDroppedNodeIds.has(edge.source)
      || budgetDroppedNodeIds.has(edge.target)
    ) {
      droppedEdges += 1;
      continue;
    }
    if (
      edges.has(edge.id)
      || !nodes.has(edge.source)
      || !nodes.has(edge.target)
    ) continue;
    if (edges.size >= maxEdges) {
      droppedEdges += 1;
      continue;
    }
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    let universeEdge: UniverseEdge = edge;
    if (edge.type === 'has-tag') {
      universeEdge = { ...edge, dimension: 'tags' };
    } else if (
      edge.type === 'contains'
      && (source?.kind === 'project' || target?.kind === 'project')
    ) {
      universeEdge = { ...edge, dimension: 'project' };
    }
    edges.set(edge.id, universeEdge);
  }

  const attributeTaskCounts = new Map<string, number>();
  for (const edge of edges.values()) {
    const source = nodes.get(endpointId(edge.source));
    const target = nodes.get(endpointId(edge.target));
    const attributeId = source?.kind === 'task' && target?.kind !== 'task'
      ? target?.id
      : target?.kind === 'task' && source?.kind !== 'task'
        ? source?.id
        : undefined;
    if (attributeId) {
      attributeTaskCounts.set(attributeId, (attributeTaskCounts.get(attributeId) ?? 0) + 1);
    }
  }
  const nodeList = [...nodes.values()].map((node) =>
    node.kind === 'task'
      ? node
      : { ...node, taskCount: attributeTaskCounts.get(node.id) ?? 0 });
  const edgeList = [...edges.values()];
  return {
    graph: {
      ...current,
      nodes: nodeList,
      edges: edgeList,
      stats: {
        ...current.stats,
        taskCount: nodeList.filter((node) => node.kind === 'task').length,
        attributeCount: nodeList.filter((node) => node.kind !== 'task').length,
      },
      pageInfo: {
        ...current.pageInfo,
        nodeLimit: Math.max(current.pageInfo.nodeLimit, maxNodes),
        edgeLimit: Math.max(current.pageInfo.edgeLimit, maxEdges),
        returnedNodes: nodeList.length,
        returnedEdges: edgeList.length,
      },
      truncated: current.truncated,
    },
    droppedNodes: budgetDroppedNodeIds.size,
    droppedEdges,
  };
}

export function buildUniverseSubgraph(input: {
  tasks: UniverseTaskRecord[];
  tags: UniverseTagRecord[];
  projects: UniverseProjectRecord[];
  dimensions: UniverseDimension[];
  maxNodes: number;
  maxEdges?: number;
  hasMoreTasks?: boolean;
}): UniverseSubgraph {
  const dimensions = new Set(input.dimensions);
  const tagsByTask = new Map<string, UniverseTagRecord[]>();
  const projectsByTask = new Map<string, UniverseProjectRecord[]>();

  for (const tag of input.tags) {
    tagsByTask.set(tag.taskId, [...(tagsByTask.get(tag.taskId) ?? []), tag]);
  }
  for (const project of input.projects) {
    projectsByTask.set(project.taskId, [...(projectsByTask.get(project.taskId) ?? []), project]);
  }

  const nodes = new Map<string, UniverseNode>();
  const edges: UniverseEdge[] = [];
  let nodeBudgetTruncated = false;
  let edgeBudgetTruncated = false;
  let taskCount = 0;
  const maxEdges = input.maxEdges ?? Math.min(input.maxNodes * 4, 2_000);

  const addAttribute = (
    task: UniverseTaskRecord,
    dimension: UniverseDimension,
    key: string | null | undefined,
    label: string | null | undefined,
    color = UNIVERSE_DIMENSION_COLORS[dimension],
  ) => {
    if (!key || !dimensions.has(dimension)) return;
    const id = attributeId(dimension, key);
    if (!nodes.has(id)) {
      nodes.set(id, dimension === 'tags'
        ? {
            id,
            entityId: key,
            kind: 'tag',
            dimension,
            value: key,
            label: label ?? key,
            color,
            taskCount: 0,
          }
        : {
            id,
            entityId: key,
            kind: 'property',
            dimension: dimension as GraphPropertyDimension,
            value: key,
            label: graphPropertyLabel(
              dimension as GraphPropertyDimension,
              key,
              label ?? undefined,
            ),
            color,
            taskCount: 0,
          });
    }
    const attribute = nodes.get(id);
    if (attribute) attribute.taskCount = (attribute.taskCount ?? 0) + 1;
    edges.push(dimension === 'tags'
      ? {
          id: `has-tag:task:${task.id}:tag:${key}`,
          source: `task:${task.id}`,
          target: id,
          type: 'has-tag',
          provenance: 'derived',
          dimension,
        }
      : {
          id: `has-property:task:${task.id}:${dimension}:${encodeURIComponent(key)}`,
          source: `task:${task.id}`,
          target: id,
          type: 'has-property',
          provenance: 'derived',
          dimension: dimension as GraphPropertyDimension,
        });
  };
  const addProject = (task: UniverseTaskRecord, project: UniverseProjectRecord) => {
    if (!dimensions.has('project')) return;
    const id = `project:${project.id}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        entityId: project.id,
        kind: 'project',
        label: project.name,
        color: project.color,
        status: project.status === 'done' || project.status === 'completed'
          ? 'done'
          : project.status === 'in_progress' || project.status === 'active'
            ? 'in_progress'
            : project.status === 'blocked'
              ? 'blocked'
              : 'todo',
        taskCount: 0,
      });
    }
    const projectNode = nodes.get(id);
    if (projectNode) projectNode.taskCount = (projectNode.taskCount ?? 0) + 1;
    edges.push({
      id: `contains:${id}:task:${task.id}`,
      source: id,
      target: `task:${task.id}`,
      type: 'contains',
      provenance: 'derived',
      dimension: 'project',
    });
  };

  for (const task of input.tasks) {
    const pendingAttributes = new Set<string>();
    const countPending = (dimension: UniverseDimension, key: string | null | undefined) => {
      if (!key || !dimensions.has(dimension)) return;
      const id = attributeId(dimension, key);
      if (!nodes.has(id)) pendingAttributes.add(id);
    };

    countPending('priority', task.priority);
    countPending('status', task.status);
    countPending('source', task.connectorType);
    countPending('list', task.sourceListId
      ? `${task.connectorInstanceId}:${task.sourceListId}`
      : null);
    countPending('effort', task.effort === null ? null : String(task.effort));
    for (const tag of tagsByTask.get(task.id) ?? []) countPending('tags', tag.id);
    for (const project of projectsByTask.get(task.id) ?? []) {
      if (dimensions.has('project') && !nodes.has(`project:${project.id}`)) {
        pendingAttributes.add(`project:${project.id}`);
      }
    }
    const pendingEdgeCount = [
      dimensions.has('priority') && task.priority,
      dimensions.has('status') && task.status,
      dimensions.has('source') && task.connectorType,
      dimensions.has('list') && task.sourceListId,
      dimensions.has('effort') && task.effort !== null,
    ].filter(Boolean).length
      + (dimensions.has('tags') ? (tagsByTask.get(task.id)?.length ?? 0) : 0)
      + (dimensions.has('project') ? (projectsByTask.get(task.id)?.length ?? 0) : 0);

    if (nodes.size + 1 + pendingAttributes.size > input.maxNodes) {
      nodeBudgetTruncated = true;
      continue;
    }
    if (edges.length + pendingEdgeCount > maxEdges) {
      edgeBudgetTruncated = true;
      continue;
    }

    const taskNodeId = `task:${task.id}`;
    nodes.set(taskNodeId, {
      id: taskNodeId,
      entityId: task.id,
      kind: 'task',
      label: task.title,
      color: '#e2e8f0',
      status: task.status === 'done' || task.status === 'completed'
        ? 'done'
        : task.status === 'in_progress' || task.status === 'active'
          ? 'in_progress'
          : task.status === 'blocked'
            ? 'blocked'
            : 'todo',
    });
    taskCount += 1;

    addAttribute(task, 'priority', task.priority, undefined, getTaskPriorityVisual(task.priority).color);
    addAttribute(task, 'status', task.status, undefined, getTaskStatusVisual(task.status).color);
    addAttribute(
      task,
      'source',
      task.connectorType,
      undefined,
      getUniverseSourceColor(task.connectorType),
    );
    addAttribute(
      task,
      'list',
      task.sourceListId ? `${task.connectorInstanceId}:${task.sourceListId}` : null,
      task.sourceListName,
    );
    addAttribute(
      task,
      'effort',
      task.effort === null ? null : String(task.effort),
      undefined,
    );
    for (const tag of tagsByTask.get(task.id) ?? []) {
      addAttribute(task, 'tags', tag.id, tag.name, tag.color ?? UNIVERSE_DIMENSION_COLORS.tags);
    }
    for (const project of projectsByTask.get(task.id) ?? []) {
      addProject(task, project);
    }
  }

  const nodeList = [...nodes.values()];
  const nodeIds = new Set(nodeList.map((node) => node.id));
  const facets = input.tasks.reduce<UniverseFacets>((result, task) => {
    if (!result.priorities.includes(task.priority)) result.priorities.push(task.priority);
    if (!result.statuses.includes(task.status)) result.statuses.push(task.status);
    if (!result.sources.includes(task.connectorType)) result.sources.push(task.connectorType);
    if (task.sourceListId && task.sourceListName) {
      const id = `${task.connectorInstanceId}:${task.sourceListId}`;
      if (!result.lists.some((list) => list.id === id)) {
        result.lists.push({ id, label: task.sourceListName });
      }
    }
    return result;
  }, emptyFacets());

  facets.priorities.sort();
  facets.statuses.sort();
  facets.sources.sort();
  facets.lists.sort((a, b) => a.label.localeCompare(b.label));

  const bounded = boundGraph(
    nodeList,
    edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    {
      maxNodes: input.maxNodes,
      maxEdges,
      sourceTruncated: input.hasMoreTasks,
    },
  );
  if (nodeBudgetTruncated && !bounded.pageInfo.truncationReasons.includes('node-limit')) {
    bounded.pageInfo.truncationReasons.unshift('node-limit');
    bounded.pageInfo.truncated = true;
    bounded.truncated = true;
  }
  if (edgeBudgetTruncated && !bounded.pageInfo.truncationReasons.includes('edge-limit')) {
    bounded.pageInfo.truncationReasons.push('edge-limit');
    bounded.pageInfo.truncated = true;
    bounded.truncated = true;
  }
  return {
    ...bounded,
    stats: {
      taskCount,
      filteredTaskCount: taskCount,
      attributeCount: nodeList.length - taskCount,
    },
    facets,
  };
}
