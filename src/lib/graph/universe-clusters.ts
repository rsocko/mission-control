import type {
  UniverseCluster,
  UniverseClusterProjection,
  UniverseClusterSettings,
  UniverseEdge,
  UniverseNode,
  UniverseSubgraph,
} from './universe-types';
import { universeEndpointId, visibleUniverseGraph } from './universe-geometry';

export const DEFAULT_UNIVERSE_CLUSTER_SETTINGS: UniverseClusterSettings = {
  algorithm: 'deterministic-threshold-components-v1',
  resolution: 0.72,
  minimumSize: 2,
  outlierThreshold: 0.45,
  includeExplicitEdges: false,
  seed: 1666,
};

const CLUSTER_COLORS = [
  '#a78bfa',
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#60a5fa',
  '#f472b6',
  '#a3e635',
] as const;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
]);

type WeightedNeighbor = { nodeId: string; weight: number };

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableId(prefix: string, values: string[], seed: number): string {
  return `${prefix}-${stableHash(`${seed}:${values.slice().sort().join('|')}`).toString(36)}`;
}

function validateSettings(settings: UniverseClusterSettings): UniverseClusterSettings {
  if (
    !Number.isFinite(settings.resolution)
    || settings.resolution < 0
    || settings.resolution > 1
  ) {
    throw new Error('Cluster resolution must be between 0 and 1');
  }
  if (!Number.isInteger(settings.minimumSize) || settings.minimumSize < 2) {
    throw new Error('Cluster minimum size must be an integer of at least 2');
  }
  if (
    !Number.isFinite(settings.outlierThreshold)
    || settings.outlierThreshold < 0
    || settings.outlierThreshold > 1
  ) {
    throw new Error('Cluster outlier threshold must be between 0 and 1');
  }
  if (!Number.isSafeInteger(settings.seed)) {
    throw new Error('Cluster seed must be a safe integer');
  }
  return settings;
}

function edgeWeight(
  edge: UniverseEdge,
  settings: UniverseClusterSettings,
): number | null {
  if (edge.type === 'semantic-similarity') {
    return edge.score >= settings.resolution ? edge.score : null;
  }
  if (
    settings.includeExplicitEdges
    && edge.provenance === 'explicit'
  ) {
    return 1;
  }
  return null;
}

function connectedComponents(
  nodeIds: string[],
  adjacency: Map<string, WeightedNeighbor[]>,
  seed: number,
): string[][] {
  const remaining = new Set(nodeIds);
  const ordered = nodeIds.slice().sort((left, right) => {
    const bySeed = stableHash(`${seed}:${left}`) - stableHash(`${seed}:${right}`);
    return bySeed || left.localeCompare(right);
  });
  const components: string[][] = [];

  for (const start of ordered) {
    if (!remaining.delete(start)) continue;
    const component: string[] = [];
    const queue = [start];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      component.push(current);
      const neighbors = (adjacency.get(current) ?? [])
        .map((neighbor) => neighbor.nodeId)
        .sort();
      for (const neighbor of neighbors) {
        if (remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component.sort());
  }
  return components;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function describeComponent(
  memberNodeIds: string[],
  nodesById: Map<string, UniverseNode>,
  adjacency: Map<string, WeightedNeighbor[]>,
  resolution: number,
  seed: number,
): Pick<
  UniverseCluster,
  'label' | 'explanation' | 'confidence' | 'representativeNodeIds' | 'terms'
> {
  const members = new Set(memberNodeIds);
  const weightedDegree = memberNodeIds.map((nodeId) => ({
    nodeId,
    degree: (adjacency.get(nodeId) ?? []).reduce(
      (sum, neighbor) => sum + (members.has(neighbor.nodeId) ? neighbor.weight : 0),
      0,
    ),
  })).sort((left, right) =>
    right.degree - left.degree
    || stableHash(`${seed}:${left.nodeId}`) - stableHash(`${seed}:${right.nodeId}`)
    || left.nodeId.localeCompare(right.nodeId));
  const representativeNodeIds = weightedDegree.slice(0, 3).map(({ nodeId }) => nodeId);
  const termCounts = new Map<string, number>();
  for (const nodeId of memberNodeIds) {
    const label = nodesById.get(nodeId)?.label ?? '';
    for (const term of new Set(tokenize(label))) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }
  const terms = [...termCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) =>
      right[1] - left[1]
      || stableHash(`${seed}:${left[0]}`) - stableHash(`${seed}:${right[0]}`)
      || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([term]) => term);
  const fallbackLabel = nodesById.get(representativeNodeIds[0])?.label ?? 'Related work';
  const label = terms.length >= 2
    ? terms.slice(0, 2).map((term) => term[0].toUpperCase() + term.slice(1)).join(' + ')
    : terms[0]
      ? terms[0][0].toUpperCase() + terms[0].slice(1)
      : fallbackLabel;
  const strongestConnections = memberNodeIds.map((nodeId) =>
    Math.max(
      0,
      ...(adjacency.get(nodeId) ?? [])
        .filter((neighbor) => members.has(neighbor.nodeId))
        .map((neighbor) => neighbor.weight),
    ));
  const confidence = strongestConnections.length
    ? strongestConnections.reduce((sum, value) => sum + value, 0) / strongestConnections.length
    : 0;
  const representativeLabels = representativeNodeIds
    .slice(0, 2)
    .map((nodeId) => nodesById.get(nodeId)?.label)
    .filter((value): value is string => Boolean(value));

  return {
    label,
    explanation: [
      `${memberNodeIds.length} tasks connected at or above the ${Math.round(
        resolution * 100,
      )}% semantic threshold.`,
      representativeLabels.length
        ? `Represented by ${representativeLabels.join(' and ')}.`
        : null,
      terms.length ? `Shared terms: ${terms.join(', ')}.` : null,
    ].filter(Boolean).join(' '),
    confidence,
    representativeNodeIds,
    terms,
  };
}

export function clusterUniverseGraph(
  graph: Pick<UniverseSubgraph, 'nodes' | 'edges'>,
  overrides: Partial<UniverseClusterSettings> = {},
): UniverseClusterProjection {
  const settings = validateSettings({
    ...DEFAULT_UNIVERSE_CLUSTER_SETTINGS,
    ...overrides,
  });
  const taskNodes = graph.nodes
    .filter((node) => node.kind === 'task')
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const taskNodeIds = new Set(taskNodes.map((node) => node.id));
  const nodesById = new Map(taskNodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, WeightedNeighbor[]>(
    taskNodes.map((node) => [node.id, []]),
  );
  const acceptedEdges: Array<{ source: string; target: string; weight: number }> = [];

  for (const edge of graph.edges) {
    const source = universeEndpointId(edge.source);
    const target = universeEndpointId(edge.target);
    if (source === target || !taskNodeIds.has(source) || !taskNodeIds.has(target)) continue;
    const weight = edgeWeight(edge, settings);
    if (weight === null) continue;
    adjacency.get(source)?.push({ nodeId: target, weight });
    adjacency.get(target)?.push({ nodeId: source, weight });
    acceptedEdges.push({ source, target, weight });
  }

  const components = connectedComponents(
    taskNodes.map((node) => node.id),
    adjacency,
    settings.seed,
  );
  const clusters: UniverseCluster[] = [];
  const outlierNodeIds: string[] = [];

  for (const memberNodeIds of components) {
    const description = describeComponent(
      memberNodeIds,
      nodesById,
      adjacency,
      settings.resolution,
      settings.seed,
    );
    if (
      memberNodeIds.length < settings.minimumSize
      || description.confidence < settings.outlierThreshold
    ) {
      outlierNodeIds.push(...memberNodeIds);
      continue;
    }
    const id = stableId('cluster', memberNodeIds, settings.seed);
    clusters.push({
      id,
      ...description,
      color: CLUSTER_COLORS[
        stableHash(`${settings.seed}:${memberNodeIds[0]}`) % CLUSTER_COLORS.length
      ],
      memberNodeIds,
      taskIds: memberNodeIds.map((nodeId) => nodesById.get(nodeId)?.entityId ?? nodeId),
    });
  }

  clusters.sort((left, right) =>
    right.memberNodeIds.length - left.memberNodeIds.length
    || left.id.localeCompare(right.id));
  outlierNodeIds.sort();
  const membershipByNodeId = Object.fromEntries(
    clusters.flatMap((cluster) =>
      cluster.memberNodeIds.map((nodeId) => [nodeId, cluster.id])),
  );
  const fingerprintParts = [
    settings.algorithm,
    String(settings.resolution),
    String(settings.minimumSize),
    String(settings.outlierThreshold),
    String(settings.includeExplicitEdges),
    String(settings.seed),
    ...taskNodes.map((node) => node.id),
    ...acceptedEdges
      .map((edge) => `${edge.source}:${edge.target}:${edge.weight}`)
      .sort(),
  ];

  return {
    clusters,
    outlierNodeIds,
    membershipByNodeId,
    fingerprint: stableId('projection', fingerprintParts, settings.seed),
    settings,
  };
}

export function filterUniverseGraphToCluster(
  graph: UniverseSubgraph,
  taskNodeIds: Iterable<string>,
): UniverseSubgraph {
  const retained = new Set(taskNodeIds);
  const nodeKinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  for (const edge of graph.edges) {
    const source = universeEndpointId(edge.source);
    const target = universeEndpointId(edge.target);
    if (retained.has(source) && nodeKinds.get(target) !== 'task') retained.add(target);
    if (retained.has(target) && nodeKinds.get(source) !== 'task') retained.add(source);
  }
  return visibleUniverseGraph(
    graph,
    graph.nodes.filter((node) => !retained.has(node.id)).map((node) => node.id),
  ) ?? graph;
}
