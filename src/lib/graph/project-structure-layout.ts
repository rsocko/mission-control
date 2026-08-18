import { layoutProjectHierarchy, type GraphLayoutDirection } from './layout';
import type { GraphEdge, GraphNode, GraphNodeKind, ProjectSubgraph } from './types';

export type ProjectGraphLineStyle = 'orthogonal' | 'curved';
export type ProjectGraphNodeVisibility = Record<GraphNodeKind, boolean>;

export interface ProjectGraphDisplayOptions {
  direction: GraphLayoutDirection;
  lineStyle: ProjectGraphLineStyle;
  showDependencies: boolean;
  visibleKinds: ProjectGraphNodeVisibility;
  collapsedPhaseIds: ReadonlySet<string>;
}

export interface ProjectFlowNodeSpec {
  id: string;
  type: GraphNodeKind;
  position: { x: number; y: number };
  graphNode: GraphNode;
  canCollapse: boolean;
  isCollapsed: boolean;
}

export interface ProjectFlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  type: 'bezier' | 'smoothstep';
  animated: boolean;
  style: {
    stroke: string;
    strokeWidth: number;
    strokeDasharray?: string;
    opacity: number;
  };
  markerEnd?: { color: string };
  ariaLabel?: string;
  data: {
    relationshipType: GraphEdge['type'];
    syncStatus?: GraphEdge['syncStatus'];
    syncAction?: GraphEdge['syncAction'];
    syncError?: GraphEdge['syncError'];
  };
}

const EDGE_SYNC_LABELS = {
  local: 'Local only',
  pending: 'Sync pending',
  synced: 'Synced with source',
  failed: 'Source sync failed',
} as const;

export function toProjectStructureFlowEdge(
  edge: GraphEdge,
  lineStyle: ProjectGraphLineStyle,
  nodeLabels: ReadonlyMap<string, string>,
): ProjectFlowEdgeSpec {
  const isDependency = edge.type !== 'contains';
  const syncStatus = edge.syncStatus;
  const sourceLabel = nodeLabels.get(edge.source) ?? 'Unknown source';
  const targetLabel = nodeLabels.get(edge.target) ?? 'Unknown target';
  const dependencyStroke = syncStatus === 'failed'
    ? 'var(--danger)'
    : syncStatus === 'pending'
      ? 'var(--warning)'
      : 'var(--accent-400)';

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: lineStyle === 'curved' ? 'bezier' : 'smoothstep',
    animated: edge.type === 'blocks' && syncStatus !== 'failed',
    style: {
      stroke: edge.type === 'related'
        ? 'var(--warning)'
        : isDependency
          ? dependencyStroke
          : 'var(--border-strong)',
      strokeWidth: isDependency ? 2 : 1.25,
      strokeDasharray: edge.type === 'related' || syncStatus === 'local' ? '6 4' : undefined,
      opacity: isDependency ? 0.9 : 0.65,
    },
    markerEnd: edge.type === 'blocks'
      ? { color: dependencyStroke }
      : undefined,
    ariaLabel: isDependency
      ? edge.type === 'blocks'
        ? `${sourceLabel} blocks ${targetLabel}, ${EDGE_SYNC_LABELS[syncStatus ?? 'local']}`
        : `${sourceLabel} is related to ${targetLabel}, ${EDGE_SYNC_LABELS[syncStatus ?? 'local']}`
      : undefined,
    data: {
      relationshipType: edge.type,
      syncStatus,
      syncAction: edge.syncAction,
      syncError: edge.syncError,
    },
  };
}

export function createProjectStructureFlowModel(
  graph: ProjectSubgraph,
  options: ProjectGraphDisplayOptions,
): { nodes: ProjectFlowNodeSpec[]; edges: ProjectFlowEdgeSpec[] } {
  const collapsedTaskIds = new Set(
    graph.edges
      .filter((edge) => edge.type === 'contains' && options.collapsedPhaseIds.has(edge.source))
      .map((edge) => edge.target),
  );
  const taskNodeIds = new Set(
    graph.nodes.filter((node) => node.kind === 'task').map((node) => node.id),
  );
  const phasesWithTasks = new Set(
    graph.edges
      .filter((edge) => edge.type === 'contains' && taskNodeIds.has(edge.target))
      .map((edge) => edge.source),
  );
  const layoutNodes = graph.nodes.filter((node) => (
    node.kind !== 'task'
    || (options.visibleKinds.task && !collapsedTaskIds.has(node.id))
  ));
  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const layoutGraph: ProjectSubgraph = {
    ...graph,
    nodes: layoutNodes,
    edges: graph.edges.filter((edge) => (
      layoutNodeIds.has(edge.source) && layoutNodeIds.has(edge.target)
    )),
  };
  const positions = layoutProjectHierarchy(layoutGraph, options.direction);
  const visibleNodes = layoutNodes.filter((node) => options.visibleKinds[node.kind]);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const nodeLabels = new Map(layoutNodes.map((node) => [node.id, node.label]));

  return {
    nodes: visibleNodes.map((node) => ({
      id: node.id,
      type: node.kind,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      graphNode: node,
      canCollapse: options.visibleKinds.task && phasesWithTasks.has(node.id),
      isCollapsed: options.collapsedPhaseIds.has(node.id),
    })),
    edges: layoutGraph.edges
      .filter((edge) => (
        visibleNodeIds.has(edge.source)
        && visibleNodeIds.has(edge.target)
        && (edge.type === 'contains' || options.showDependencies)
      ))
      .map((edge) => toProjectStructureFlowEdge(edge, options.lineStyle, nodeLabels)),
  };
}
