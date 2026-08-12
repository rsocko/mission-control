import type { GraphEdgeType } from './types';

interface FocusEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
}

export interface GraphFocus {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export function getDescendantFocus(nodeId: string, edges: FocusEdge[]): GraphFocus {
  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, FocusEdge[]>();

  for (const edge of edges) {
    if (edge.type !== 'contains') continue;
    const current = outgoing.get(edge.source) ?? [];
    current.push(edge);
    outgoing.set(edge.source, current);
  }

  const pending = [nodeId];
  while (pending.length > 0) {
    const source = pending.shift();
    if (!source) continue;

    for (const edge of outgoing.get(source) ?? []) {
      edgeIds.add(edge.id);
      if (nodeIds.has(edge.target)) continue;
      nodeIds.add(edge.target);
      pending.push(edge.target);
    }
  }

  return { nodeIds, edgeIds };
}

export function getConnectedFocus(nodeId: string, edges: FocusEdge[]): GraphFocus {
  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set<string>();

  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
    edgeIds.add(edge.id);
  }

  return { nodeIds, edgeIds };
}

export function getSelectionFocus(nodeId: string, edges: FocusEdge[]): GraphFocus {
  const descendants = getDescendantFocus(nodeId, edges);
  const connected = getConnectedFocus(nodeId, edges);

  return {
    nodeIds: new Set([...descendants.nodeIds, ...connected.nodeIds]),
    edgeIds: new Set([...descendants.edgeIds, ...connected.edgeIds]),
  };
}
