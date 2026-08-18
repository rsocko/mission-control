import { deterministicUniversePosition } from './universe-visuals';
import type {
  UniverseEdge,
  UniverseLod,
  UniverseNode,
  UniverseSubgraph,
} from './universe-types';

export type UniversePosition = { x: number; y: number };

export function universeEndpointId(endpoint: UniverseEdge['source'] | unknown): string {
  if (typeof endpoint === 'string') return endpoint;
  if (typeof endpoint === 'object' && endpoint !== null && 'id' in endpoint) {
    const id = endpoint.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  }
  return '';
}

export function connectedUniverseNodes(
  graph: UniverseSubgraph,
  nodeId: string,
): UniverseNode[] {
  const connectedIds = new Set<string>();
  for (const edge of graph.edges) {
    const source = universeEndpointId(edge.source);
    const target = universeEndpointId(edge.target);
    if (source === nodeId) connectedIds.add(target);
    if (target === nodeId) connectedIds.add(source);
  }
  return graph.nodes.filter((node) => connectedIds.has(node.id));
}

export function collectUniversePositions(
  nodes: UniverseNode[],
  positions = new Map<string, UniversePosition>(),
): Map<string, UniversePosition> {
  for (const node of nodes) {
    if (node.x !== undefined && node.y !== undefined) {
      positions.set(node.id, { x: node.x, y: node.y });
    }
  }
  return positions;
}

export function positionUniverseGraph(
  graph: UniverseSubgraph,
  positions: ReadonlyMap<string, UniversePosition>,
): UniverseSubgraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...(positions.get(node.id) ?? deterministicUniversePosition(node.id)),
    })),
  };
}

export function pinPositionedUniverseNodes(
  nodes: UniverseNode[],
): UniverseNode[] {
  return nodes.map((node) => ({
    ...node,
    ...(node.x !== undefined && node.y !== undefined ? { fx: node.x, fy: node.y } : {}),
  }));
}

export function releaseUniverseNodePins(nodes: UniverseNode[]): void {
  for (const node of nodes) {
    delete node.fx;
    delete node.fy;
  }
}

export function visibleUniverseGraph(
  graph: UniverseSubgraph | null,
  hiddenNodeIds: Iterable<string>,
): UniverseSubgraph | null {
  if (!graph) return null;
  const hidden = new Set(hiddenNodeIds);
  if (!hidden.size) return graph;
  const nodes = graph.nodes.filter((node) => !hidden.has(node.id));
  const visible = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) =>
    visible.has(universeEndpointId(edge.source))
    && visible.has(universeEndpointId(edge.target)));
  return {
    ...graph,
    nodes,
    edges,
    stats: {
      ...graph.stats,
      taskCount: nodes.filter((node) => node.kind === 'task').length,
      attributeCount: nodes.filter((node) => node.kind !== 'task').length,
    },
    pageInfo: {
      ...graph.pageInfo,
      returnedNodes: nodes.length,
      returnedEdges: edges.length,
    },
  };
}

export function universeNeighborhood(
  graph: UniverseSubgraph | null,
  nodeIds: Iterable<string>,
): Set<string> {
  const selected = new Set(nodeIds);
  const neighborhood = new Set(selected);
  if (!graph) return neighborhood;
  for (const edge of graph.edges) {
    const source = universeEndpointId(edge.source);
    const target = universeEndpointId(edge.target);
    if (selected.has(source)) neighborhood.add(target);
    if (selected.has(target)) neighborhood.add(source);
  }
  return neighborhood;
}

export function matchingUniverseNodeIds(
  graph: UniverseSubgraph | null,
  search: string,
): Set<string> | null {
  const query = search.trim().toLowerCase();
  if (!graph || !query) return null;
  return new Set(
    graph.nodes
      .filter((node) => node.label.toLowerCase().includes(query))
      .map((node) => node.id),
  );
}

export function emphasizedUniverseNodeIds(
  graph: UniverseSubgraph | null,
  selectedNodeIds: string[],
  hoveredNodeId: string | null,
): Set<string> | null {
  if (!graph || (!selectedNodeIds.length && !hoveredNodeId)) return null;
  const contextIds = new Set(selectedNodeIds.length ? selectedNodeIds : [hoveredNodeId as string]);
  const ids = universeNeighborhood(graph, contextIds);
  return ids;
}

export function universeTooltipPosition(input: {
  anchor: UniversePosition;
  viewportWidth: number;
  viewportHeight: number;
  tooltipWidth: number;
  tooltipHeight: number;
  margin?: number;
  offset?: number;
}): UniversePosition {
  const margin = input.margin ?? 8;
  const offset = input.offset ?? 14;
  const maxX = Math.max(input.viewportWidth - input.tooltipWidth - margin, margin);
  const maxY = Math.max(input.viewportHeight - input.tooltipHeight - margin, margin);
  const preferredX = input.anchor.x + offset + input.tooltipWidth <= input.viewportWidth
    ? input.anchor.x + offset
    : input.anchor.x - input.tooltipWidth - offset;
  return {
    x: Math.round(Math.min(Math.max(preferredX, margin), maxX)),
    y: Math.round(Math.min(Math.max(input.anchor.y - offset, margin), maxY)),
  };
}

export function universeFitTransform(input: {
  bounds: { x: [number, number]; y: [number, number] };
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}): UniversePosition & { zoom: number } {
  const padding = input.padding ?? 112;
  const graphWidth = Math.max(input.bounds.x[1] - input.bounds.x[0], 24);
  const graphHeight = Math.max(input.bounds.y[1] - input.bounds.y[0], 24);
  return {
    x: (input.bounds.x[0] + input.bounds.x[1]) / 2,
    y: (input.bounds.y[0] + input.bounds.y[1]) / 2,
    zoom: Math.max(input.minZoom ?? 0.1, Math.min(
      input.maxZoom ?? 5,
      (input.viewportWidth - padding) / graphWidth,
      (input.viewportHeight - padding) / graphHeight,
    )),
  };
}

export function universeLodForZoom(zoom: number): UniverseLod {
  return zoom < 0.45 ? 'far' : zoom < 1.2 ? 'medium' : 'close';
}
