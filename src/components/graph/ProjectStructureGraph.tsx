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
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Flag,
} from 'lucide-react';

import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { GRAPH_NODE_DIMENSIONS, type GraphLayoutDirection } from '@/lib/graph/layout';
import {
  createProjectStructureFlowModel,
  type ProjectGraphDisplayOptions,
  type ProjectGraphLineStyle,
  type ProjectGraphNodeVisibility,
} from '@/lib/graph/project-structure-layout';
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
import {
  GraphLoadingState,
  ProjectGraphDependencyCreator,
  ProjectGraphDependencyDetails,
  ProjectGraphDisplayControls,
  ProjectGraphPhaseDetails,
  ProjectGraphRemovalDialog,
} from './ProjectStructureGraphParts';
import { useProjectStructureGraphData } from './useProjectStructureGraphData';

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
type GraphLineStyle = ProjectGraphLineStyle;
type NodeKindVisibility = ProjectGraphNodeVisibility;
type GraphDisplayOptions = ProjectGraphDisplayOptions;

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
  const model = createProjectStructureFlowModel(graph, options);
  return {
    nodes: model.nodes.map<FlowNode>((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: {
        graphNode: node.graphNode,
        direction: options.direction,
        canCollapse: node.canCollapse,
        isCollapsed: node.isCollapsed,
        onSelect,
        onToggleCollapse,
      },
    })),
    edges: model.edges.map((edge) => ({
      ...edge,
      markerEnd: edge.markerEnd
        ? { ...edge.markerEnd, type: MarkerType.ArrowClosed }
        : undefined,
    })),
  };
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
  const [renderedProjectId, setRenderedProjectId] = useState<string | null>(null);
  const {
    graph,
    graphProjectId,
    loadingStage: dataLoadingStage,
    error: currentError,
    truncated,
    setGraph,
    completeLayout,
  } = useProjectStructureGraphData(projectId, `${refreshKey ?? ''}:${relationshipRefreshKey}`);
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
    if (!graph || graphProjectId !== projectId) return;
    const currentNodeIds = new Set(graph.nodes.map((node) => node.id));
    setFocusedNodeId((current) => {
      const nextFocusedNodeId = current && currentNodeIds.has(current) ? current : null;
      focusedNodeIdRef.current = nextFocusedNodeId;
      return nextFocusedNodeId;
    });
    setHoveredNodeId((current) => current && currentNodeIds.has(current) ? current : null);
    setSelectedPhase((current) => {
      if (!current) return null;
      return graph.nodes.find((node) => node.id === current.id && node.kind === 'phase') ?? null;
    });
  }, [graph, graphProjectId, projectId]);

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
      completeLayout(projectId);

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
    completeLayout,
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
  const loadingStage = dataLoadingStage
    ? dataLoadingStage
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
      <ProjectGraphDependencyCreator
        open={dependencyCreatorOpen}
        type={dependencyType}
        direction={direction}
        sourceId={keyboardSourceId}
        targetId={keyboardTargetId}
        tasks={taskNodes.map((node) => ({ id: node.id, label: node.data.graphNode.label }))}
        onOpenChange={setDependencyCreatorOpen}
        onTypeChange={setDependencyType}
        onSourceChange={setKeyboardSourceId}
        onTargetChange={setKeyboardTargetId}
        onCreate={() => void createDependency(keyboardSourceId, keyboardTargetId)}
      />

      <ProjectGraphDisplayControls
        direction={direction}
        lineStyle={lineStyle}
        showDependencies={showDependencies}
        visibleKinds={visibleKinds}
        onDirectionChange={changeDirection}
        onLineStyleChange={setLineStyle}
        onToggleDependencies={() => setShowDependencies((current) => !current)}
        onToggleNodeKind={toggleNodeKind}
      />
      </div>

      {selectedPhase ? (
        <ProjectGraphPhaseDetails
          phase={selectedPhase}
          statusLabel={STATUS_STYLES[selectedPhase.status].label}
          onClose={clearFocus}
        />
      ) : null}
      {selectedDependency ? (
        <ProjectGraphDependencyDetails
          dependency={selectedDependency}
          removing={removingDependency}
          onClose={clearFocus}
          onRemove={() => setDependencyToRemove({
            edgeId: selectedDependency.edge.id,
            targetEntityId: selectedDependency.target.entityId,
            targetKind: selectedDependency.target.kind,
          })}
        />
      ) : null}
      </div>

      {truncated ? (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--warning)]/40 bg-[var(--surface-1)] px-3 py-1 text-xs text-[var(--warning)]">
          Graph limited to 500 nodes
        </div>
      ) : null}

      <ProjectGraphRemovalDialog
        open={dependencyToRemove !== null}
        targetKind={dependencyToRemove?.targetKind}
        removing={removingDependency}
        onConfirm={() => void removeDependency()}
        onCancel={() => {
          if (!removingDependency) setDependencyToRemove(null);
        }}
      />
    </div>
  );
}
