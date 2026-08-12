'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type IsValidConnection,
  type Node,
  type OnConnectEnd,
  type OnNodeDrag,
  type NodeProps,
  type OnSelectionChangeFunc,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Cloud,
  CloudOff,
  Flag,
  Link2,
  LoaderCircle,
  Trash2,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  GRAPH_NODE_DIMENSIONS,
  layoutProjectHierarchy,
  type GraphLayoutDirection,
} from '@/lib/graph/layout';
import { getConnectedFocus, getSelectionFocus } from '@/lib/graph/focus';
import type {
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphNodeStatus,
  ProjectSubgraph,
} from '@/lib/graph/types';
import '@xyflow/react/dist/style.css';
import styles from './ProjectStructureGraph.module.css';
import {
  announceTaskRelationshipsChanged,
  TASK_RELATIONSHIPS_CHANGED_EVENT,
  type TaskRelationshipsChangedDetail,
} from '@/lib/task-relationships-events';

interface ProjectStructureGraphProps {
  projectId: string;
  refreshKey?: string;
  selectedTaskId?: string | null;
  onTaskSelect: (taskId: string | null) => void;
  onPhaseDependencyRemoved?: (phaseId: string) => void;
}

const GRAPH_FIT_VIEW_OPTIONS = { padding: 0.12, minZoom: 0.45, maxZoom: 0.9 } as const;
const RESIZE_FIT_DELAY_MS = 140;

interface FlowNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
  direction: GraphLayoutDirection;
  canCollapse: boolean;
  isCollapsed: boolean;
  onSelect: (node: GraphNode) => void;
  focusState?: 'emphasized' | 'dimmed';
  onToggleCollapse: (phaseId: string) => void;
}

type FlowNode = Node<FlowNodeData, GraphNodeKind>;
type FlowEdge = Edge<{
  relationshipType: GraphEdge['type'];
  syncStatus?: GraphEdge['syncStatus'];
  syncAction?: GraphEdge['syncAction'];
  syncError?: GraphEdge['syncError'];
}>;
type GraphLineStyle = 'orthogonal' | 'curved';
type NodeKindVisibility = Record<GraphNodeKind, boolean>;
type GraphLoadingStage = 'fetching' | 'layout';
interface GraphLoadingState {
  projectId: string;
  stage: GraphLoadingStage;
}

interface GraphDisplayOptions {
  direction: GraphLayoutDirection;
  lineStyle: GraphLineStyle;
  showDependencies: boolean;
  visibleKinds: NodeKindVisibility;
  collapsedPhaseIds: Set<string>;
}

interface DependencyRemovalTarget {
  edgeId: string;
  targetEntityId: string;
  targetKind: GraphNodeKind;
}

const STATUS_STYLES: Record<GraphNodeStatus, {
  color: string;
  label: string;
}> = {
  todo: {
    color: '#94a3b8',
    label: 'To do',
  },
  in_progress: {
    color: '#60a5fa',
    label: 'In progress',
  },
  done: {
    color: '#34d399',
    label: 'Done',
  },
  blocked: {
    color: '#f87171',
    label: 'Blocked',
  },
};

const EDGE_SYNC_LABELS = {
  local: 'Local only',
  pending: 'Sync pending',
  synced: 'Synced with source',
  failed: 'Source sync failed',
} as const;

// React Flow renders active connection lines at z-index 1001.
const GRAPH_MENU_CLASS = 'z-[1100]';

interface StatusNodeStyle extends CSSProperties {
  '--node-status-color': string;
}

export function StructureNode({ data, selected }: NodeProps<FlowNode>) {
  const {
    focusState,
    graphNode,
    direction,
    canCollapse,
    isCollapsed,
    onSelect,
    onToggleCollapse,
  } = data;
  const status = STATUS_STYLES[graphNode.status];
  const targetPosition = direction === 'horizontal' ? Position.Left : Position.Top;
  const sourcePosition = direction === 'horizontal' ? Position.Right : Position.Bottom;
  const nodeStyle: StatusNodeStyle = {
    '--node-status-color': status.color,
    width: GRAPH_NODE_DIMENSIONS[graphNode.kind].width,
  };
  const isTask = graphNode.kind === 'task';
  const Icon = graphNode.kind === 'project'
    ? Boxes
    : graphNode.kind === 'phase'
      ? Flag
      : graphNode.status === 'done'
        ? CheckCircle2
        : graphNode.status === 'in_progress'
          ? CircleDot
          : Circle;

  return (
    <div
      className={cn(
        styles.node,
        'relative rounded-xl border transition-[border-color,box-shadow,opacity,transform] duration-150',
        selected && 'ring-2 ring-[var(--accent-400)]/50',
        !selected && focusState === 'emphasized' && 'ring-1 ring-[var(--accent-400)]/30',
        focusState === 'dimmed' && 'opacity-25',
      )}
      style={nodeStyle}
      data-status={graphNode.status}
    >
      <Handle
        type="target"
        position={targetPosition}
        isConnectable={isTask}
        isConnectableStart={false}
        isConnectableEnd={isTask}
        aria-label={isTask ? `Dependency input for ${graphNode.label}` : undefined}
        title={isTask ? 'Dependency input: finish a connection here' : undefined}
        className={cn(
          '!h-3 !w-3 !border-2',
          isTask
            ? '!border-[var(--accent-400)] !bg-[var(--surface-1)]'
            : '!border-[var(--surface-1)] !bg-[var(--border-strong)]',
        )}
      />
      <button
        type="button"
        onClick={() => onSelect(graphNode)}
        className={cn(
          styles.nodeButton,
          'flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-400)]',
          graphNode.kind === 'phase' && 'pr-10',
        )}
        aria-label={`Open ${graphNode.kind} ${graphNode.label}`}
      >
        <span
          className={cn(
            styles.statusIcon,
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          )}
          style={graphNode.color ? { color: graphNode.color } : undefined}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">
            {graphNode.label}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            <span className={cn(styles.statusDot, 'h-2.5 w-2.5 rounded-full')} aria-hidden="true" />
            {status.label}
            {graphNode.taskCount !== undefined ? (
              <span>· {graphNode.taskCount} task{graphNode.taskCount === 1 ? '' : 's'}</span>
            ) : null}
          </span>
        </span>
      </button>
      {graphNode.kind === 'phase' && canCollapse ? (
        <button
          type="button"
          onClick={() => onToggleCollapse(graphNode.id)}
          className="nodrag absolute right-2 top-2 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} tasks under ${graphNode.label}`}
          title={`${isCollapsed ? 'Show' : 'Hide'} phase tasks`}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : null}
      <Handle
        type="source"
        position={sourcePosition}
        isConnectable={isTask}
        isConnectableStart={isTask}
        isConnectableEnd={false}
        aria-label={isTask ? `Dependency output for ${graphNode.label}` : undefined}
        title={isTask ? 'Dependency output: start a connection here' : undefined}
        className={cn(
          '!h-3 !w-3 !border-2 !border-[var(--surface-1)]',
          isTask
            ? '!bg-[var(--accent-400)]'
            : '!bg-[var(--border-strong)]',
        )}
      />
    </div>
  );
}

const nodeTypes = {
  project: StructureNode,
  phase: StructureNode,
  task: StructureNode,
};

export function layoutGraph(
  graph: ProjectSubgraph,
  onSelect: (node: GraphNode) => void,
  onToggleCollapse: (phaseId: string) => void,
  options: GraphDisplayOptions,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
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
      .filter((edge) => (
        edge.type === 'contains'
        && taskNodeIds.has(edge.target)
      ))
      .map((edge) => edge.source),
  );
  const layoutNodes = graph.nodes.filter((node) => (
    node.kind !== 'task'
    || (options.visibleKinds.task && !collapsedTaskIds.has(node.id))
  ));
  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const layoutGraphData: ProjectSubgraph = {
    ...graph,
    nodes: layoutNodes,
    edges: graph.edges.filter((edge) => (
      layoutNodeIds.has(edge.source) && layoutNodeIds.has(edge.target)
    )),
  };
  const positions = layoutProjectHierarchy(layoutGraphData, options.direction);
  const visibleNodes = layoutNodes.filter((node) => options.visibleKinds[node.kind]);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const nodeLabels = new Map(layoutNodes.map((node) => [node.id, node.label]));

  const nodes = visibleNodes.map<FlowNode>((node) => {
    return {
      id: node.id,
      type: node.kind,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        graphNode: node,
        direction: options.direction,
        canCollapse: options.visibleKinds.task && phasesWithTasks.has(node.id),
        isCollapsed: options.collapsedPhaseIds.has(node.id),
        onSelect,
        onToggleCollapse,
      },
    };
  });

  return {
    nodes,
    edges: layoutGraphData.edges
      .filter((edge) => (
        visibleNodeIds.has(edge.source)
        && visibleNodeIds.has(edge.target)
        && (edge.type === 'contains' || options.showDependencies)
      ))
      .map((edge) => toFlowEdge(edge, options.lineStyle, nodeLabels)),
  };
}

function toFlowEdge(
  edge: GraphEdge,
  lineStyle: GraphLineStyle,
  nodeLabels: ReadonlyMap<string, string>,
): FlowEdge {
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
      ? {
          type: MarkerType.ArrowClosed,
          color: dependencyStroke,
        }
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

function GraphLoadingState({ stage }: { stage: GraphLoadingStage }) {
  const message = stage === 'fetching' ? 'Loading project data...' : 'Arranging project graph...';

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-0)]"
      aria-busy="true"
    >
      <div className="absolute inset-0 animate-pulse p-10 opacity-45 motion-reduce:animate-none" aria-hidden="true">
        <div className="mx-auto mt-14 h-16 w-44 rounded-xl bg-[var(--surface-2)]" />
        <div className="mx-auto mt-14 flex max-w-3xl justify-around gap-10">
          <div className="h-20 w-52 rounded-xl bg-[var(--surface-2)]" />
          <div className="h-20 w-52 rounded-xl bg-[var(--surface-2)]" />
          <div className="h-20 w-52 rounded-xl bg-[var(--surface-2)]" />
        </div>
        <div className="mx-auto mt-14 flex max-w-4xl justify-around gap-6">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-16 w-36 rounded-xl bg-[var(--surface-1)]" />
          ))}
        </div>
      </div>

      <div className="absolute inset-x-0 top-1/2 mx-auto w-72 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--surface-1)]/95 p-5 shadow-lg">
        <div className="flex items-center gap-3 text-sm font-medium text-[var(--text-primary)]">
          <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent-400)] motion-reduce:animate-none" aria-hidden="true" />
          <span role="status">{message}</span>
        </div>
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]"
          role="progressbar"
          aria-label="Project graph loading progress"
        >
          <div className={cn(styles.loadingProgress, 'h-full w-2/5 rounded-full bg-[var(--accent-400)]')} />
        </div>
      </div>
    </div>
  );
}

export default function ProjectStructureGraph({
  projectId,
  refreshKey,
  selectedTaskId,
  onTaskSelect,
  onPhaseDependencyRemoved,
}: ProjectStructureGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const relationshipEventSource = useId();
  const [relationshipRefreshKey, setRelationshipRefreshKey] = useState(0);
  const [loadingState, setLoadingState] = useState<GraphLoadingState | null>({
    projectId,
    stage: 'fetching',
  });
  const [renderedProjectId, setRenderedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<{ projectId: string; message: string } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [graph, setGraph] = useState<ProjectSubgraph | null>(null);
  const [graphProjectId, setGraphProjectId] = useState<string | null>(null);
  const [direction, setDirection] = useState<GraphLayoutDirection>('horizontal');
  const [lineStyle, setLineStyle] = useState<GraphLineStyle>('orthogonal');
  const [showDependencies, setShowDependencies] = useState(true);
  const [visibleKinds, setVisibleKinds] = useState<NodeKindVisibility>({
    project: true,
    phase: true,
    task: true,
  });
  const [collapsedPhaseIds, setCollapsedPhaseIds] = useState<Set<string>>(() => new Set());
  const [dependencyCreatorOpen, setDependencyCreatorOpen] = useState(false);
  const [dependencyType, setDependencyType] = useState<'blocks' | 'related'>('blocks');
  const [keyboardSourceId, setKeyboardSourceId] = useState('');
  const [keyboardTargetId, setKeyboardTargetId] = useState('');
  const [selectedPhase, setSelectedPhase] = useState<GraphNode | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedDependencyId, setSelectedDependencyId] = useState<string | null>(null);
  const [dependencyToRemove, setDependencyToRemove] = useState<DependencyRemovalTarget | null>(null);
  const [removingDependency, setRemovingDependency] = useState(false);
  const draggedPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const isAutoFittingViewportRef = useRef(false);
  const resizeFitFrameRef = useRef<number | null>(null);
  const resizeFitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userAdjustedViewportRef = useRef(false);
  const viewportControlInteractionRef = useRef(false);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const selectedDependencyIdRef = useRef(selectedDependencyId);
  focusedNodeIdRef.current = focusedNodeId;
  selectedDependencyIdRef.current = selectedDependencyId;

  const cancelPendingResizeFit = useCallback(() => {
    if (resizeFitTimeoutRef.current !== null) {
      clearTimeout(resizeFitTimeoutRef.current);
      resizeFitTimeoutRef.current = null;
    }
    if (resizeFitFrameRef.current !== null) {
      cancelAnimationFrame(resizeFitFrameRef.current);
      resizeFitFrameRef.current = null;
    }
  }, []);

  const fitGraphView = useCallback(() => {
    const instance = flowInstanceRef.current;
    if (!instance) return;

    isAutoFittingViewportRef.current = true;
    void Promise.resolve(instance.fitView(GRAPH_FIT_VIEW_OPTIONS)).finally(() => {
      isAutoFittingViewportRef.current = false;
    });
  }, []);

  const markViewportControlInteraction = useCallback((target: EventTarget | null) => {
    viewportControlInteractionRef.current = target instanceof Element
      && Boolean(target.closest('.react-flow__controls-button'));
  }, []);

  const handleSelect = useCallback((node: GraphNode) => {
    const isSelected = focusedNodeIdRef.current === node.id;
    const nextFocusedNodeId = isSelected ? null : node.id;

    focusedNodeIdRef.current = nextFocusedNodeId;
    selectedDependencyIdRef.current = null;
    setFocusedNodeId(nextFocusedNodeId);
    setHoveredNodeId(null);
    setSelectedDependencyId(null);
    setSelectedPhase(!isSelected && node.kind === 'phase' ? node : null);
    onTaskSelect(!isSelected && node.kind === 'task' ? node.entityId : null);
    setNodes((current) => current.map((candidate) => {
      const selected = !isSelected && candidate.id === node.id;
      return candidate.selected === selected ? candidate : { ...candidate, selected };
    }));
    setEdges((current) => current.map((edge) => (
      edge.selected ? { ...edge, selected: false } : edge
    )));
  }, [onTaskSelect, setEdges, setNodes]);

  const handleToggleCollapse = useCallback((phaseId: string) => {
    cancelPendingResizeFit();
    userAdjustedViewportRef.current = false;
    draggedPositionsRef.current.clear();
    setCollapsedPhaseIds((current) => {
      const next = new Set(current);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  }, [cancelPendingResizeFit]);

  useEffect(() => {
    const refreshRelationships = (event: Event) => {
      const detail = (event as CustomEvent<TaskRelationshipsChangedDetail>).detail;
      if (detail.source === relationshipEventSource) return;
      setRelationshipRefreshKey((current) => current + 1);
    };
    window.addEventListener(TASK_RELATIONSHIPS_CHANGED_EVENT, refreshRelationships);
    return () => window.removeEventListener(TASK_RELATIONSHIPS_CHANGED_EVENT, refreshRelationships);
  }, [relationshipEventSource]);

  useEffect(() => {
    cancelPendingResizeFit();
    draggedPositionsRef.current.clear();
    userAdjustedViewportRef.current = false;
  }, [cancelPendingResizeFit, projectId]);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/projects/${projectId}/graph`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { graph?: ProjectSubgraph; error?: string };
        if (!response.ok || !payload.graph) {
          throw new Error(payload.error || 'Failed to load project graph');
        }
        if (controller.signal.aborted) return;
        setError(null);
        setLoadingState({ projectId, stage: 'layout' });
        setGraph(payload.graph);
        setGraphProjectId(projectId);
        setTruncated(payload.graph.truncated);
        const currentNodeIds = new Set(payload.graph.nodes.map((node) => node.id));
        setFocusedNodeId((current) => {
          const nextFocusedNodeId = current && currentNodeIds.has(current) ? current : null;
          focusedNodeIdRef.current = nextFocusedNodeId;
          return nextFocusedNodeId;
        });
        setHoveredNodeId((current) => current && currentNodeIds.has(current) ? current : null);
        setSelectedPhase((current) => {
          if (!current) return null;
          return payload.graph?.nodes.find((node) => node.id === current.id && node.kind === 'phase') ?? null;
        });
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setError({
          projectId,
          message: caughtError instanceof Error ? caughtError.message : 'Failed to load project graph',
        });
        setLoadingState(null);
      });

    return () => controller.abort();
  }, [projectId, refreshKey, relationshipRefreshKey]);

  useEffect(() => {
    if (selectedTaskId === undefined || !graph) return;

    const currentFocusedNode = graph.nodes.find((node) => node.id === focusedNodeIdRef.current);
    const selectedTaskNode = selectedTaskId === null
      ? null
      : graph.nodes.find((node) => node.kind === 'task' && node.entityId === selectedTaskId) ?? null;

    if (selectedTaskNode?.id === currentFocusedNode?.id) return;
    if (!selectedTaskNode && currentFocusedNode?.kind !== 'task') return;

    const nextFocusedNodeId = selectedTaskNode?.id ?? null;
    focusedNodeIdRef.current = nextFocusedNodeId;
    selectedDependencyIdRef.current = null;
    setFocusedNodeId(nextFocusedNodeId);
    setHoveredNodeId(null);
    setSelectedPhase(null);
    setSelectedDependencyId(null);
    setNodes((current) => current.map((node) => {
      const selected = node.id === nextFocusedNodeId;
      return node.selected === selected ? node : { ...node, selected };
    }));
    setEdges((current) => current.map((edge) => (
      edge.selected ? { ...edge, selected: false } : edge
    )));
  }, [graph, selectedTaskId, setEdges, setNodes]);

  useEffect(() => {
    if (!graph || graphProjectId !== projectId) return;
    let fitViewFrame: number | null = null;
    const layoutFrame = requestAnimationFrame(() => {
      const flow = layoutGraph(graph, handleSelect, handleToggleCollapse, {
        direction,
        lineStyle,
        showDependencies,
        visibleKinds,
        collapsedPhaseIds,
      });
      const currentNodeIds = new Set(flow.nodes.map((node) => node.id));
      for (const nodeId of draggedPositionsRef.current.keys()) {
        if (!currentNodeIds.has(nodeId)) draggedPositionsRef.current.delete(nodeId);
      }
      setNodes(flow.nodes.map((node) => ({
        ...node,
        position: draggedPositionsRef.current.get(node.id) ?? node.position,
        selected: node.id === focusedNodeIdRef.current,
      })));
      setEdges(flow.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedDependencyIdRef.current,
      })));
      setRenderedProjectId(projectId);
      setLoadingState((current) => current?.projectId === projectId ? null : current);

      fitViewFrame = requestAnimationFrame(() => {
        if (userAdjustedViewportRef.current) return;
        cancelPendingResizeFit();
        fitGraphView();
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      if (fitViewFrame !== null) cancelAnimationFrame(fitViewFrame);
    };
  }, [
    collapsedPhaseIds,
    cancelPendingResizeFit,
    direction,
    fitGraphView,
    graph,
    graphProjectId,
    handleSelect,
    handleToggleCollapse,
    lineStyle,
    projectId,
    setEdges,
    setNodes,
    showDependencies,
    visibleKinds,
  ]);

  useEffect(() => {
    const container = graphContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let lastSize: { width: number; height: number } | null = null;

    const handleResize = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      if (!lastSize) {
        lastSize = { width, height };
        return;
      }
      if (lastSize.width === width && lastSize.height === height) return;
      lastSize = { width, height };
      if (userAdjustedViewportRef.current) return;

      cancelPendingResizeFit();
      resizeFitTimeoutRef.current = setTimeout(() => {
        resizeFitTimeoutRef.current = null;
        if (userAdjustedViewportRef.current) return;
        resizeFitFrameRef.current = requestAnimationFrame(() => {
          resizeFitFrameRef.current = null;
          if (!userAdjustedViewportRef.current) fitGraphView();
        });
      }, RESIZE_FIT_DELAY_MS);
    };

    const observer = new ResizeObserver(([entry]) => {
      if (entry) handleResize(entry.contentRect.width, entry.contentRect.height);
    });
    const handleWindowResize = () => {
      const bounds = container.getBoundingClientRect();
      handleResize(bounds.width, bounds.height);
    };

    observer.observe(container);
    window.addEventListener('resize', handleWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      cancelPendingResizeFit();
    };
  }, [cancelPendingResizeFit, fitGraphView, projectId, renderedProjectId]);

  const createDependency = useCallback(async (source: string, target: string) => {
    if (source === target) {
      toast.error('Choose two different tasks for the dependency');
      return;
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/task-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTaskId: source.slice('task:'.length),
          targetTaskId: target.slice('task:'.length),
          type: dependencyType,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        dependency?: {
          id: string;
          syncStatus: GraphEdge['syncStatus'];
          syncAction: GraphEdge['syncAction'];
          syncError: string | null;
        };
        error?: string;
      } | null;

      if (!response.ok || !payload?.dependency) {
        toast.error(payload?.error || 'Failed to create dependency');
        return;
      }

      const graphEdge: GraphEdge = {
        id: `dependency:${payload.dependency.id}`,
        source,
        target,
        type: dependencyType,
        provenance: 'explicit',
        syncStatus: payload.dependency.syncStatus,
        syncAction: payload.dependency.syncAction,
        syncError: payload.dependency.syncError,
      };
      setGraph((current) => current
        ? { ...current, edges: [...current.edges, graphEdge] }
        : current);
      setKeyboardSourceId('');
      setKeyboardTargetId('');
      announceTaskRelationshipsChanged([
        source.slice('task:'.length),
        target.slice('task:'.length),
      ], relationshipEventSource);
      if (payload.dependency.syncStatus === 'failed') {
        toast.warning('Dependency saved locally, but source sync failed');
      } else if (payload.dependency.syncStatus === 'synced') {
        toast.success('Blocking dependency created and synced');
      } else {
        toast.success(dependencyType === 'blocks' ? 'Local blocking dependency created' : 'Related tasks connected');
      }
    } catch {
      toast.error('Failed to create dependency');
    }
  }, [dependencyType, projectId, relationshipEventSource]);

  const onConnect = useCallback(async (connection: Connection) => {
    if (
      !connection.source.startsWith('task:')
      || !connection.target.startsWith('task:')
    ) {
      toast.error('Dependencies can only connect task nodes');
      return;
    }
    await createDependency(connection.source, connection.target);
  }, [createDependency]);

  const isValidConnection = useCallback<IsValidConnection>((connection) => (
    connection.source.startsWith('task:')
    && connection.target.startsWith('task:')
    && connection.source !== connection.target
  ), []);

  const handleConnectEnd = useCallback<OnConnectEnd>((_event, connectionState) => {
    if (connectionState.isValid !== false || !connectionState.toHandle) return;

    if (connectionState.fromHandle.nodeId === connectionState.toHandle.nodeId) {
      toast.error('Choose a different task for the dependency');
      return;
    }

    toast.error(direction === 'horizontal'
      ? "Start on the predecessor's right handle and finish on the successor's left handle"
      : "Start on the predecessor's bottom handle and finish on the successor's top handle");
  }, [direction]);

  const taskNodes = useMemo(
    () => nodes.filter((node) => node.data.graphNode.kind === 'task'),
    [nodes],
  );
  const selectedDependency = useMemo(() => {
    if (!selectedDependencyId) return null;
    const edge = edges.find((candidate) => candidate.id === selectedDependencyId);
    if (
      !edge
      || (edge.data?.relationshipType !== 'blocks' && edge.data?.relationshipType !== 'related')
    ) return null;

    const source = nodes.find((node) => node.id === edge.source)?.data.graphNode;
    const target = nodes.find((node) => node.id === edge.target)?.data.graphNode;
    if (!source || !target) return null;

    return {
      edge,
      source,
      target,
      type: edge.data?.relationshipType,
    };
  }, [edges, nodes, selectedDependencyId]);

  const removeDependency = useCallback(async () => {
    if (!dependencyToRemove) return;

    setRemovingDependency(true);
    try {
      const response = dependencyToRemove.targetKind === 'phase'
        ? await fetch(`/api/project-phases/${encodeURIComponent(dependencyToRemove.targetEntityId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startAfterPhaseId: null }),
          })
        : await fetch(
            `/api/projects/${projectId}/task-dependencies/${encodeURIComponent(
              dependencyToRemove.edgeId.slice('dependency:'.length),
            )}`,
            { method: 'DELETE' },
          );
      const payload = await response.json().catch(() => null) as { error?: string } | null;

      if (!response.ok) {
        toast.error(payload?.error || 'Failed to remove dependency');
        if (dependencyToRemove.targetKind === 'task' && selectedDependency) {
          announceTaskRelationshipsChanged([
            selectedDependency.source.entityId,
            selectedDependency.target.entityId,
          ]);
        }
        return;
      }

      setGraph((current) => current
        ? {
            ...current,
            edges: current.edges.filter((edge) => edge.id !== dependencyToRemove.edgeId),
          }
        : current);
      setSelectedDependencyId(null);
      setDependencyToRemove(null);
      if (dependencyToRemove.targetKind === 'phase') {
        onPhaseDependencyRemoved?.(dependencyToRemove.targetEntityId);
      } else if (selectedDependency) {
        announceTaskRelationshipsChanged([
          selectedDependency.source.entityId,
          selectedDependency.target.entityId,
        ], relationshipEventSource);
      }
      toast.success('Dependency removed');
    } catch {
      toast.error('Failed to remove dependency');
    } finally {
      setRemovingDependency(false);
    }
  }, [
    dependencyToRemove,
    onPhaseDependencyRemoved,
    projectId,
    relationshipEventSource,
    selectedDependency,
  ]);
  const handleNodeDragStop = useCallback<OnNodeDrag<FlowNode>>((_event, node) => {
    draggedPositionsRef.current.set(node.id, node.position);
  }, []);
  const clearFocus = useCallback(() => {
    focusedNodeIdRef.current = null;
    selectedDependencyIdRef.current = null;
    setFocusedNodeId(null);
    setHoveredNodeId(null);
    setSelectedPhase(null);
    setSelectedDependencyId(null);
    onTaskSelect(null);
    setNodes((current) => current.map((node) => (
      node.selected ? { ...node, selected: false } : node
    )));
    setEdges((current) => current.map((edge) => (
      edge.selected ? { ...edge, selected: false } : edge
    )));
  }, [onTaskSelect, setEdges, setNodes]);

  const selectDependency = useCallback((edge: FlowEdge) => {
    if (edge.data?.relationshipType !== 'blocks' && edge.data?.relationshipType !== 'related') return;
    clearFocus();
    selectedDependencyIdRef.current = edge.id;
    setSelectedDependencyId(edge.id);
    setEdges((current) => current.map((candidate) => {
      const selected = candidate.id === edge.id;
      return candidate.selected === selected ? candidate : { ...candidate, selected };
    }));
  }, [clearFocus, setEdges]);

  const handleDependencyEdgeClick = useCallback<EdgeMouseHandler<FlowEdge>>((_event, edge) => {
    if (selectedDependencyIdRef.current === edge.id) {
      clearFocus();
      return;
    }
    selectDependency(edge);
  }, [clearFocus, selectDependency]);

  const handleSelectionChange = useCallback<OnSelectionChangeFunc<FlowNode, FlowEdge>>(({
    edges: selectedEdges,
  }) => {
    const dependency = selectedEdges.find((edge) => (
      edge.data?.relationshipType === 'blocks' || edge.data?.relationshipType === 'related'
    ));
    if (dependency) {
      if (selectedDependencyIdRef.current !== dependency.id) {
        selectDependency(dependency);
      }
      return;
    }

    selectedDependencyIdRef.current = null;
    setSelectedDependencyId(null);
  }, [selectDependency]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearFocus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearFocus]);

  const graphEdges = useMemo<Pick<GraphEdge, 'id' | 'source' | 'target' | 'type'>[]>(
    () => edges.flatMap((edge) => {
      const type = edge.data?.relationshipType;
      if (type !== 'contains' && type !== 'blocks' && type !== 'related') return [];
      return [{ id: edge.id, source: edge.source, target: edge.target, type }];
    }),
    [edges],
  );
  const focus = useMemo(() => {
    const visibleNodeIds = new Set(nodes.map((node) => node.id));
    if (focusedNodeId && visibleNodeIds.has(focusedNodeId)) {
      return getSelectionFocus(focusedNodeId, graphEdges);
    }
    if (hoveredNodeId && visibleNodeIds.has(hoveredNodeId)) {
      return getConnectedFocus(hoveredNodeId, graphEdges);
    }
    return null;
  }, [focusedNodeId, graphEdges, hoveredNodeId, nodes]);
  const displayedNodes = useMemo<FlowNode[]>(() => {
    if (!focus) return nodes;
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        focusState: focus.nodeIds.has(node.id) ? 'emphasized' : 'dimmed',
      },
    }));
  }, [focus, nodes]);
  const displayedEdges = useMemo(() => {
    if (!focus) return edges;
    return edges.map((edge) => {
      const emphasized = focus.edgeIds.has(edge.id);
      const strokeWidth = typeof edge.style?.strokeWidth === 'number' ? edge.style.strokeWidth : 1;
      return {
        ...edge,
        animated: emphasized && edge.animated,
        style: {
          ...edge.style,
          opacity: emphasized ? 1 : 0.12,
          strokeWidth: emphasized ? Math.max(strokeWidth, 2.5) : strokeWidth,
        },
      };
    });
  }, [edges, focus]);
  const changeDirection = useCallback((nextDirection: GraphLayoutDirection) => {
    cancelPendingResizeFit();
    userAdjustedViewportRef.current = false;
    draggedPositionsRef.current.clear();
    setDirection(nextDirection);
  }, [cancelPendingResizeFit]);
  const toggleNodeKind = useCallback((kind: GraphNodeKind) => {
    cancelPendingResizeFit();
    userAdjustedViewportRef.current = false;
    draggedPositionsRef.current.clear();
    setVisibleKinds((current) => ({ ...current, [kind]: !current[kind] }));
    if (kind === 'phase') setSelectedPhase(null);
  }, [cancelPendingResizeFit]);

  const minimapColor = useCallback((node: Node) => {
    const status = (node.data as FlowNodeData).graphNode.status;
    return STATUS_STYLES[status].color;
  }, []);

  const graphAriaLabel = useMemo(
    () => `Project structure graph with ${nodes.length} nodes and ${edges.length} edges`,
    [edges.length, nodes.length],
  );
  const currentError = error?.projectId === projectId ? error.message : null;
  const loadingStage = loadingState?.projectId === projectId
    ? loadingState.stage
    : renderedProjectId === projectId
      ? null
      : 'fetching';

  if (currentError) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-xl bg-[var(--surface-0)] p-6 text-sm text-[var(--danger)]">
        {currentError}
      </div>
    );
  }

  if (loadingStage && renderedProjectId !== projectId) {
    return <GraphLoadingState stage={loadingStage} />;
  }

  return (
    <div
      ref={graphContainerRef}
      className={cn(styles.graph, 'relative h-full min-h-0 overflow-hidden rounded-xl bg-[var(--surface-0)]')}
      role="region"
      aria-label={graphAriaLabel}
      onPointerDownCapture={(event) => markViewportControlInteraction(event.target)}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          markViewportControlInteraction(event.target);
        }
      }}
    >
      <ReactFlow
        nodes={displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={(_event, node) => {
          setHoveredNodeId((current) => current === node.id ? null : current);
        }}
        onPaneClick={clearFocus}
        onMoveStart={(event) => {
          if (!isAutoFittingViewportRef.current && (event || viewportControlInteractionRef.current)) {
            userAdjustedViewportRef.current = true;
            cancelPendingResizeFit();
          }
          viewportControlInteractionRef.current = false;
        }}
        onConnect={(connection) => void onConnect(connection)}
        onEdgeClick={handleDependencyEdgeClick}
        onSelectionChange={handleSelectionChange}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        connectOnClick={false}
        onInit={(instance) => {
          flowInstanceRef.current = instance;
        }}
        fitView
        fitViewOptions={GRAPH_FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={1.75}
        colorMode="dark"
        connectionLineStyle={{ stroke: 'var(--accent-400)', strokeWidth: 2 }}
        defaultEdgeOptions={{ type: lineStyle === 'curved' ? 'bezier' : 'smoothstep' }}
        deleteKeyCode={null}
      >
        <Background gap={22} size={1.25} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          nodeColor={minimapColor}
          pannable
          zoomable
          ariaLabel="Project graph minimap"
        />
      </ReactFlow>

      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 p-1.5 shadow-[var(--shadow-md)]">
        <button
          type="button"
          aria-expanded={dependencyCreatorOpen}
          aria-controls="graph-dependency-creator"
          onClick={() => setDependencyCreatorOpen((current) => !current)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
        >
          <Link2 size={12} />
          {dependencyCreatorOpen ? 'Hide dependency controls' : 'Add dependency'}
          <ChevronDown
            size={12}
            className={cn('transition-transform', dependencyCreatorOpen && 'rotate-180')}
          />
        </button>
        {!dependencyCreatorOpen ? (
          <span className="pr-1 text-xs text-[var(--text-tertiary)]">
            Select a dependency line to manage it.
          </span>
        ) : null}
        {dependencyCreatorOpen ? (
          <div id="graph-dependency-creator" className="flex max-w-full flex-wrap items-center gap-2">
            <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
            <label htmlFor="graph-dependency-type" className="pl-1 text-xs text-[var(--text-secondary)]">
              Connect as
            </label>
            <Select
              value={dependencyType}
              onValueChange={(value) => setDependencyType(value as 'blocks' | 'related')}
            >
              <SelectTrigger
                id="graph-dependency-type"
                variant="inline"
                className="h-7 min-w-20 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={GRAPH_MENU_CLASS}>
                <SelectItem value="blocks">Blocks</SelectItem>
                <SelectItem value="related">Related</SelectItem>
              </SelectContent>
            </Select>
            <label htmlFor="graph-source-task" className="sr-only">Dependency source task</label>
            <Select
              value={keyboardSourceId}
              onValueChange={setKeyboardSourceId}
            >
              <SelectTrigger
                id="graph-source-task"
                variant="inline"
                className="h-7 w-40 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"
              >
                <SelectValue placeholder="From task…" />
              </SelectTrigger>
              <SelectContent className={GRAPH_MENU_CLASS}>
                {taskNodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>{node.data.graphNode.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label htmlFor="graph-target-task" className="sr-only">Dependency target task</label>
            <Select
              value={keyboardTargetId}
              onValueChange={setKeyboardTargetId}
            >
              <SelectTrigger
                id="graph-target-task"
                variant="inline"
                className="h-7 w-40 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"
              >
                <SelectValue placeholder="To task…" />
              </SelectTrigger>
              <SelectContent className={GRAPH_MENU_CLASS}>
                {taskNodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>{node.data.graphNode.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              disabled={
                !keyboardSourceId
                || !keyboardTargetId
                || keyboardSourceId === keyboardTargetId
              }
              onClick={() => void createDependency(keyboardSourceId, keyboardTargetId)}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--accent-600)] px-2 text-xs font-medium text-white hover:bg-[var(--accent-500)] disabled:pointer-events-none disabled:opacity-40"
            >
              <Link2 size={12} />
              Connect
            </button>
            <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
            <span className="px-1 text-xs text-[var(--text-secondary)]">
              {dependencyType === 'blocks'
                ? direction === 'horizontal'
                  ? "Drag from the predecessor's right handle to the successor's left handle."
                  : "Drag from the predecessor's bottom handle to the successor's top handle."
                : direction === 'horizontal'
                  ? "Drag a right handle to another task's left handle."
                  : "Drag a bottom handle to another task's top handle."}
              {' '}Select a dependency line to manage it.
            </span>
          </div>
        ) : null}
      </div>

      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 p-1.5 shadow-[var(--shadow-md)]">
        <span
          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-secondary)]"
          title="Dragging a node only adjusts this temporary graph layout. Reorder phases and tasks in Plan list or assign view."
        >
          Node drag: layout only
        </span>
        <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
        <label htmlFor="graph-layout-direction" className="sr-only">Graph layout direction</label>
        <Select
          value={direction}
          onValueChange={(value) => changeDirection(value as GraphLayoutDirection)}
        >
          <SelectTrigger
            id="graph-layout-direction"
            variant="inline"
            className="h-7 min-w-24 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"
            title="Graph layout direction"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={GRAPH_MENU_CLASS}>
            <SelectItem value="horizontal">Horizontal</SelectItem>
            <SelectItem value="vertical">Vertical</SelectItem>
          </SelectContent>
        </Select>
        <label htmlFor="graph-line-style" className="sr-only">Connection line style</label>
        <Select
          value={lineStyle}
          onValueChange={(value) => setLineStyle(value as GraphLineStyle)}
        >
          <SelectTrigger
            id="graph-line-style"
            variant="inline"
            className="h-7 min-w-28 border-[var(--border)] bg-[var(--surface-2)] px-2 text-[var(--text-primary)]"
            title="Connection line style"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={GRAPH_MENU_CLASS}>
            <SelectItem value="orthogonal">Elbow lines</SelectItem>
            <SelectItem value="curved">Curved lines</SelectItem>
          </SelectContent>
        </Select>
        <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />
        <button
          type="button"
          aria-pressed={showDependencies}
          onClick={() => setShowDependencies((current) => !current)}
          className={cn(
            'h-7 rounded-md border px-2 text-xs font-medium transition-colors',
            showDependencies
              ? 'border-[var(--accent-400)]/60 bg-[var(--accent-500)]/15 text-[var(--accent-300)]'
              : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-tertiary)]',
          )}
          title="Show or hide blocking and related-task lines"
        >
          Dependencies
        </button>
        {(['project', 'phase', 'task'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={visibleKinds[kind]}
            onClick={() => toggleNodeKind(kind)}
            className={cn(
              'h-7 rounded-md border px-2 text-xs font-medium capitalize transition-colors',
              visibleKinds[kind]
                ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through',
            )}
            title={`${visibleKinds[kind] ? 'Hide' : 'Show'} ${kind} nodes`}
          >
            {kind}
          </button>
        ))}
      </div>
      </div>

      {selectedPhase ? (
        <aside className="pointer-events-auto relative ml-auto w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-lg)]">
          <button
            type="button"
            onClick={clearFocus}
            className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label="Close phase details"
          >
            <X size={14} />
          </button>
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Phase</p>
          <h3 className="mt-1 pr-7 text-base font-semibold text-[var(--text-primary)]">{selectedPhase.label}</h3>
          {selectedPhase.description ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{selectedPhase.description}</p>
          ) : null}

          <p className="mt-3 text-xs text-[var(--text-tertiary)]">
            {selectedPhase.taskCount ?? 0} task{selectedPhase.taskCount === 1 ? '' : 's'} · {STATUS_STYLES[selectedPhase.status].label}
          </p>
        </aside>
      ) : null}
      {selectedDependency ? (
        <aside className="pointer-events-auto relative ml-auto w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-lg)]">
          <button
            type="button"
            onClick={clearFocus}
            className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label="Close dependency details"
          >
            <X size={14} />
          </button>
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">Dependency</p>
          <h3 className="mt-1 pr-7 text-base font-semibold text-[var(--text-primary)]">
            {selectedDependency.type === 'blocks' ? 'Blocks' : 'Related tasks'}
          </h3>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-xs text-[var(--text-tertiary)]">
                {selectedDependency.type === 'blocks'
                  ? `Blocking ${selectedDependency.source.kind}`
                  : selectedDependency.source.kind === 'phase' ? 'Phase' : 'Task'}
              </dt>
              <dd className="mt-0.5 text-[var(--text-primary)]">{selectedDependency.source.label}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-tertiary)]">
                {selectedDependency.type === 'blocks'
                  ? `Blocked ${selectedDependency.target.kind}`
                  : 'Related to'}
              </dt>
              <dd className="mt-0.5 text-[var(--text-primary)]">{selectedDependency.target.label}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          {selectedDependency.edge.data?.syncStatus === 'synced' ? <Cloud size={15} /> : null}
          {selectedDependency.edge.data?.syncStatus === 'local' ? <CloudOff size={15} /> : null}
          {selectedDependency.edge.data?.syncStatus === 'pending' ? <LoaderCircle size={15} className="animate-spin" /> : null}
          {selectedDependency.edge.data?.syncStatus === 'failed' ? <AlertTriangle size={15} className="text-[var(--danger)]" /> : null}
          {EDGE_SYNC_LABELS[selectedDependency.edge.data?.syncStatus ?? 'local']}
          </div>
          {selectedDependency.edge.data?.syncError ? (
          <p className="mt-2 text-xs text-[var(--danger)]">{selectedDependency.edge.data.syncError}</p>
          ) : null}
          <button
            type="button"
            disabled={removingDependency}
            onClick={() => setDependencyToRemove({
              edgeId: selectedDependency.edge.id,
              targetEntityId: selectedDependency.target.entityId,
              targetKind: selectedDependency.target.kind,
            })}
            className="mt-4 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-red-500/40 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-50"
          >
            <Trash2 size={13} />
            Remove dependency
          </button>
        </aside>
      ) : null}
      </div>

      {truncated ? (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--warning)]/40 bg-[var(--surface-1)] px-3 py-1 text-xs text-[var(--warning)]">
          Graph limited to 500 nodes
        </div>
      ) : null}

      <ConfirmDialog
        open={dependencyToRemove !== null}
        title="Remove dependency?"
        message={dependencyToRemove?.targetKind === 'phase'
          ? 'This disconnects the phases but does not delete either phase.'
          : 'This disconnects the tasks but does not delete either task.'}
        confirmLabel={removingDependency ? 'Removing…' : 'Remove dependency'}
        confirmVariant="danger"
        onConfirm={() => void removeDependency()}
        onCancel={() => {
          if (!removingDependency) setDependencyToRemove(null);
        }}
      />
    </div>
  );
}
