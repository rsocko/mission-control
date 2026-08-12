import type {
  GraphEdge,
  GraphPageInfo,
  GraphPropertyDimension,
  SemanticSimilarityGraphEdge,
  SharedGraphEdge,
  SharedGraphNode,
} from './types';

export const GRAPH_QUERY_LIMITS = {
  nodes: { default: 500, min: 1, max: 1_000 },
  edges: { default: 1_000, min: 0, max: 2_000 },
  neighbors: { default: 100, min: 1, max: 250 },
  semanticTopK: { default: 10, min: 1, max: 25 },
} as const;

export class GraphQueryValidationError extends Error {
  readonly status = 400;
}

function boundedInteger(
  value: number | undefined,
  bounds: { default: number; min: number; max: number },
  name: string,
): number {
  if (value === undefined) return bounds.default;
  if (!Number.isFinite(value)) {
    throw new GraphQueryValidationError(`${name} must be a finite number`);
  }
  return Math.min(Math.max(Math.trunc(value), bounds.min), bounds.max);
}

export function normalizeGraphBudgets(input: {
  maxNodes?: number;
  maxEdges?: number;
  neighborQuery?: boolean;
} = {}) {
  const nodeBounds = input.neighborQuery
    ? GRAPH_QUERY_LIMITS.neighbors
    : GRAPH_QUERY_LIMITS.nodes;
  return {
    maxNodes: boundedInteger(input.maxNodes, nodeBounds, 'maxNodes'),
    maxEdges: boundedInteger(input.maxEdges, GRAPH_QUERY_LIMITS.edges, 'maxEdges'),
  };
}

export function normalizeSemanticTopK(value?: number): number {
  return boundedInteger(value, GRAPH_QUERY_LIMITS.semanticTopK, 'semanticTopK');
}

export function createPageInfo(input: {
  nodeLimit: number;
  edgeLimit: number;
  returnedNodes: number;
  returnedEdges: number;
  sourceTruncated?: boolean;
  nodesTruncated?: boolean;
  edgesTruncated?: boolean;
  nextCursor?: string;
}): GraphPageInfo {
  const truncationReasons: GraphPageInfo['truncationReasons'] = [];
  if (input.nodesTruncated) truncationReasons.push('node-limit');
  if (input.edgesTruncated) truncationReasons.push('edge-limit');
  if (input.sourceTruncated) truncationReasons.push('source-limit');
  return {
    nodeLimit: input.nodeLimit,
    edgeLimit: input.edgeLimit,
    returnedNodes: input.returnedNodes,
    returnedEdges: input.returnedEdges,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  };
}

export function canonicalPair(first: string, second: string): [string, string] {
  return first <= second ? [first, second] : [second, first];
}

export function graphPropertyNodeId(
  dimension: GraphPropertyDimension,
  value: string,
): string {
  return `property:${dimension}:${encodeURIComponent(value)}`;
}

export function graphPropertyLabel(
  dimension: GraphPropertyDimension,
  value: string,
  preferredLabel?: string,
): string {
  if (preferredLabel) return preferredLabel;
  if (dimension === 'effort') return `Effort ${value}`;
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function createSemanticSimilarityEdge(input: {
  source: string;
  target: string;
  score: number;
  embedding?: SemanticSimilarityGraphEdge['embedding'];
}): SemanticSimilarityGraphEdge {
  if (
    input.source === input.target
    || !Number.isFinite(input.score)
    || input.score < 0
    || input.score > 1
  ) {
    throw new GraphQueryValidationError(
      'Semantic similarity requires distinct nodes and a finite score between 0 and 1',
    );
  }
  const [source, target] = canonicalPair(input.source, input.target);
  const endpointsSwapped = source !== input.source;
  const embedding = input.embedding ?? {};
  return {
    id: `semantic-similarity:${source}:${target}`,
    source,
    target,
    type: 'semantic-similarity',
    provenance: 'embedding',
    score: input.score,
    embedding: endpointsSwapped
      ? {
          ...embedding,
          sourceUpdatedAt: embedding.targetUpdatedAt,
          targetUpdatedAt: embedding.sourceUpdatedAt,
        }
      : embedding,
  };
}

export function boundGraph<TNode extends SharedGraphNode, TEdge extends SharedGraphEdge>(
  nodes: TNode[],
  edges: TEdge[],
  input: {
    maxNodes: number;
    maxEdges: number;
    sourceTruncated?: boolean;
  },
) {
  const boundedNodes = nodes.slice(0, input.maxNodes);
  const includedNodeIds = new Set(boundedNodes.map((node) => node.id));
  const eligibleEdges = edges.filter(
    (edge) => includedNodeIds.has(edge.source) && includedNodeIds.has(edge.target),
  );
  const boundedEdges = eligibleEdges.slice(0, input.maxEdges);
  const pageInfo = createPageInfo({
    nodeLimit: input.maxNodes,
    edgeLimit: input.maxEdges,
    returnedNodes: boundedNodes.length,
    returnedEdges: boundedEdges.length,
    nodesTruncated: nodes.length > boundedNodes.length,
    edgesTruncated: eligibleEdges.length > boundedEdges.length,
    sourceTruncated: input.sourceTruncated,
  });
  return {
    nodes: boundedNodes,
    edges: boundedEdges,
    pageInfo,
    truncated: pageInfo.truncated,
  };
}

export function canonicalizeExplicitEdge(edge: GraphEdge): GraphEdge {
  if (edge.type !== 'related') return edge;
  const [source, target] = canonicalPair(edge.source, edge.target);
  return { ...edge, source, target };
}
