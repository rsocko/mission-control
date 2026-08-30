'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { forceCollide, forceX, forceY } from 'd3-force';
import {
  ArrowLeft,
  LoaderCircle,
  LocateFixed,
  Search,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import {
  UNIVERSE_DIMENSION_COLORS,
  type UniverseDimension,
  type UniverseEdge,
  type UniverseLod,
  type UniverseNode,
  type UniverseSubgraph,
} from '@/lib/graph/universe-types';
import {
  universeCollisionRadius,
  universeNodeIcon,
  universePillScreenSize,
  universeTaskRadius,
} from '@/lib/graph/universe-visuals';
import { useUniverseGraphStore } from '@/lib/stores/universeGraphStore';
import { useTaskFilterContext } from '@/lib/hooks/useTaskFilterContext';
import {
  countTaskFilters,
  migrateLegacyUniverseFilters,
} from '@/lib/task-filter-context';
import { buildUniverseGraphSearchParams } from '@/lib/graph/universe-filter-query';
import {
  emphasizedUniverseNodeIds,
  matchingUniverseNodeIds,
  releaseUniverseNodePins,
  universeEndpointId,
  universeFitTransform,
  universeLodForZoom,
  universeNeighborhood,
  universeTooltipPosition,
  visibleUniverseGraph,
} from '@/lib/graph/universe-geometry';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import {
  UniverseFilterPanel,
  useUniverseFilterOptions,
} from './UniverseTaskFilters';
import { UniverseSidebarFilters } from './UniverseSidebarFilters';
import {
  AccessibleUniverseList,
  DimensionToggles,
  GraphLegend,
  NeighborLayerToggles,
  NodeDetail,
  SelectionToolbar,
  SemanticNeighborhoodStatus,
  TaskHoverCard,
} from './UniverseGraphPresenters';
import { UniverseSeedSearch } from './UniverseSeedSearch';
import { useUniverseGraphData } from './useUniverseGraphData';
import {
  clusterUniverseGraph,
  filterUniverseGraphToCluster,
} from '@/lib/graph/universe-clusters';
import { universeClusterHull } from '@/lib/graph/universe-cluster-geometry';
import type { UniverseCluster } from '@/lib/graph/universe-types';
import {
  UniverseClusterControls,
  UniverseClusterReviewPanel,
  UniverseClusterSummary,
  type UniverseClusterFilter,
} from './UniverseClusters';

const MAX_UNIVERSE_NODES = 500;
const INITIAL_OVERVIEW_NODES = 180;
const OVERVIEW_NODE_STEP = 120;
const GRAPH_WARMUP_TICKS = 80;
const GRAPH_COOLDOWN_TICKS = 100;
const NODE_DETAIL_PANEL_WIDTH = 340;
const TASK_DETAIL_PANEL_WIDTH = 390;
const TOOLTIP_WIDTH = 288;
const TOOLTIP_HEIGHT = 176;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_OFFSET = 14;

function useCanvasSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({
      width: Math.max(element.clientWidth, 320),
      height: Math.max(element.clientHeight, 420),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}

export default function UniverseGraph() {
  const dimensions = useUniverseGraphStore((state) => state.dimensions);
  const neighborLayers = useUniverseGraphStore((state) => state.neighborLayers);
  const legacyFilters = useUniverseGraphStore((state) => state.legacyFilters);
  const clearLegacyFilters = useUniverseGraphStore((state) => state.clearLegacyFilters);
  const selectedNodeIds = useUniverseGraphStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useUniverseGraphStore((state) => state.setSelectedNodeIds);
  const resetScene = useUniverseGraphStore((state) => state.resetScene);
  const reconcileSelection = useUniverseGraphStore((state) => state.reconcileSelection);
  const taskFilters = useTaskFilterContext();
  const filterOptions = useUniverseFilterOptions();
  const { sidebarMode, setSidebarMode } = useSidebarExpanded();
  const [exploreAll, setExploreAll] = useState(false);
  const [seedTaskIds, setSeedTaskIds] = useState<string[]>([]);
  const [overviewNodeLimit, setOverviewNodeLimit] = useState(INITIAL_OVERVIEW_NODES);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sceneSearch, setSceneSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [detailSuppressed, setDetailSuppressed] = useState(false);
  const [focusActive, setFocusActive] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [lod, setLod] = useState<UniverseLod>('medium');
  const [resetFitRequest, setResetFitRequest] = useState(0);
  const [clusterGrouping, setClusterGrouping] = useState(false);
  const [clusterFilter, setClusterFilter] = useState<UniverseClusterFilter>('all');
  const [reviewClusterId, setReviewClusterId] = useState<string | null>(null);
  const graphRef = useRef<ForceGraphMethods<
    NodeObject<UniverseNode>,
    LinkObject<UniverseNode, UniverseEdge>
  > | undefined>(undefined);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hasInitialFitRef = useRef(false);
  const forcesConfiguredRef = useRef(false);
  const consumedResetFitRequestRef = useRef(0);
  const userOwnsViewportRef = useRef(false);
  const pointerViewportGestureRef = useRef(false);
  const { ref: canvasRef, width, height } = useCanvasSize();
  const hasFilters = taskFilters.activeFilterCount > 0;
  const shouldLoad = exploreAll || hasFilters || seedTaskIds.length > 0;
  const isProgressiveOverview = exploreAll && !hasFilters;
  const requestedNodeLimit = isProgressiveOverview ? overviewNodeLimit : MAX_UNIVERSE_NODES;
  const canonicalQuery = useMemo(
    () => buildUniverseGraphSearchParams(
      taskFilters.context,
      dimensions,
      requestedNodeLimit,
      seedTaskIds,
    ).toString(),
    [dimensions, requestedNodeLimit, seedTaskIds, taskFilters.context],
  );
  const handleCanonicalLoad = useCallback(() => {
    hasInitialFitRef.current = false;
    forcesConfiguredRef.current = false;
    resetScene();
    setSelectedTaskId(null);
    setDetailSuppressed(false);
    setFocusActive(false);
    setHoveredNodeId(null);
    userOwnsViewportRef.current = false;
  }, [resetScene, setSelectedTaskId]);
  const {
    graph: unfilteredGraph,
    loading,
    error,
    expanding,
    explorationMessage,
    explorationError,
    semanticOutcomes,
    nodeHops,
    expansionPinnedNodesRef,
    expandSelection,
    rememberPositions,
    setExplorationMessage,
    setExplorationError,
  } = useUniverseGraphData({
    shouldLoad,
    canonicalQuery,
    reloadKey,
    dimensions,
    neighborLayers,
    onCanonicalLoad: handleCanonicalLoad,
  });
  const graph = useMemo(() => {
    if (!unfilteredGraph) return null;
    const enabledProvenance = new Set(
      neighborLayers.map((layer) => (
        layer === 'semantic' ? 'embedding' : layer
      )),
    );
    const edges = unfilteredGraph.edges.filter((edge) =>
      enabledProvenance.has(edge.provenance));
    const visibleNodeIds = new Set(
      unfilteredGraph.nodes
        .filter((node) => node.kind === 'task' && (nodeHops[node.id] ?? 0) === 0)
        .map((node) => node.id),
    );
    for (const edge of edges) {
      visibleNodeIds.add(universeEndpointId(edge.source));
      visibleNodeIds.add(universeEndpointId(edge.target));
    }
    return {
      ...unfilteredGraph,
      nodes: unfilteredGraph.nodes.filter((node) => visibleNodeIds.has(node.id)),
      edges,
      pageInfo: {
        ...unfilteredGraph.pageInfo,
        returnedNodes: visibleNodeIds.size,
        returnedEdges: edges.length,
      },
    };
  }, [neighborLayers, nodeHops, unfilteredGraph]);
  const graphData = useMemo(() => ({
    nodes: graph?.nodes ?? [],
    links: graph?.edges ?? [],
  }), [graph]);
  const clusterProjection = useMemo(
    () => clusterGrouping && graph ? clusterUniverseGraph(graph) : null,
    [clusterGrouping, graph],
  );
  const clusterByNodeId = useMemo(() => {
    if (!clusterProjection) return new Map<string, UniverseCluster>();
    return new Map(clusterProjection.clusters.flatMap((cluster) =>
      cluster.memberNodeIds.map((nodeId) => [nodeId, cluster] as const)));
  }, [clusterProjection]);
  const clusteredNodes = useMemo(() => {
    const result = new Map<string, UniverseNode[]>();
    if (!clusterProjection || !graph) return result;
    for (const node of graph.nodes) {
      const clusterId = clusterProjection.membershipByNodeId[node.id];
      if (!clusterId) continue;
      result.set(clusterId, [...(result.get(clusterId) ?? []), node]);
    }
    return result;
  }, [clusterProjection, graph]);
  const reviewCluster = reviewClusterId
    ? clusterProjection?.clusters.find((cluster) => cluster.id === reviewClusterId) ?? null
    : null;
  const effectiveClusterFilter = clusterProjection
    && (
      clusterFilter === 'all'
      || clusterFilter === 'outliers'
      || clusterProjection.clusters.some((cluster) => cluster.id === clusterFilter)
    )
    ? clusterFilter
    : 'all';

  useEffect(() => {
    if (!legacyFilters) return;
    const migrated = migrateLegacyUniverseFilters(legacyFilters);
    if (
      taskFilters.source === 'empty'
      && taskFilters.issues.length === 0
      && countTaskFilters(migrated.context) > 0
    ) {
      taskFilters.setContext(migrated.context, 'replace');
    }
    clearLegacyFilters();
  }, [clearLegacyFilters, legacyFilters, taskFilters]);


  useEffect(() => {
    if (!graph?.nodes.length) {
      forcesConfiguredRef.current = false;
      return;
    }
    if (forcesConfiguredRef.current && !clusterGrouping) return;
    const collision = forceCollide<NodeObject<UniverseNode>>()
      .radius((node) => universeCollisionRadius(node))
      .strength(0.72)
      .iterations(2);
    graphRef.current?.d3Force('collision', collision);
    const clusterIndex = new Map(
      (clusterProjection?.clusters ?? []).map((cluster, index) => [cluster.id, index]),
    );
    const clusterCount = Math.max(clusterIndex.size, 1);
    graphRef.current?.d3Force(
      'cluster-x',
      forceX<NodeObject<UniverseNode>>((node) => {
        const clusterId = clusterProjection?.membershipByNodeId[node.id];
        const index = clusterId ? clusterIndex.get(clusterId) ?? 0 : clusterCount;
        return clusterId ? ((index % 3) - 1) * 140 : 0;
      }).strength((node) => clusterProjection?.membershipByNodeId[node.id] ? 0.08 : 0),
    );
    graphRef.current?.d3Force(
      'cluster-y',
      forceY<NodeObject<UniverseNode>>((node) => {
        const clusterId = clusterProjection?.membershipByNodeId[node.id];
        const index = clusterId ? clusterIndex.get(clusterId) ?? 0 : clusterCount;
        return clusterId ? (Math.floor(index / 3) - Math.floor(clusterCount / 6)) * 120 : 0;
      }).strength((node) => clusterProjection?.membershipByNodeId[node.id] ? 0.08 : 0),
    );
    graphRef.current?.d3ReheatSimulation();
    forcesConfiguredRef.current = true;
  }, [clusterGrouping, clusterProjection, graph]);

  const selectedNodes = useMemo(
    () => graph?.nodes.filter((node) => selectedNodeIds.includes(node.id)) ?? [],
    [graph, selectedNodeIds],
  );
  const selectedNode = selectedNodes.at(-1) ?? null;
  const selectedNeighborhood = useMemo(
    () => universeNeighborhood(graph, selectedNodeIds),
    [graph, selectedNodeIds],
  );
  const sceneGraph = useMemo(() => {
    if (!graph) return graph;
    let visible: UniverseSubgraph = graph;
    if (focusActive) {
      const hiddenNodeIds = graph.nodes
        .filter((node) => !selectedNeighborhood.has(node.id))
        .map((node) => node.id);
      visible = visibleUniverseGraph(graph, hiddenNodeIds) ?? graph;
    }
    if (!clusterProjection || effectiveClusterFilter === 'all') return visible;
    const visibleClusterNodeIds = effectiveClusterFilter === 'outliers'
      ? new Set(clusterProjection.outlierNodeIds)
      : new Set(
          clusterProjection.clusters.find((cluster) => cluster.id === effectiveClusterFilter)
            ?.memberNodeIds ?? [],
        );
    return filterUniverseGraphToCluster(visible, visibleClusterNodeIds);
  }, [clusterProjection, effectiveClusterFilter, focusActive, graph, selectedNeighborhood]);
  const visibleNodeIdSet = useMemo(
    () => new Set(sceneGraph?.nodes.map((node) => node.id) ?? []),
    [sceneGraph],
  );
  const hoveredNode = sceneGraph?.nodes.find((node) => node.id === hoveredNodeId) ?? null;
  const unselectedRelatedNodeIds = [...selectedNeighborhood]
    .filter((nodeId) => !selectedNodeIds.includes(nodeId));

  useEffect(() => {
    reconcileSelection(graph?.nodes.map((node) => node.id) ?? []);
  }, [graph, reconcileSelection]);

  const detailPanelWidth = selectedTaskId
    ? (width < 640 ? width : Math.min(TASK_DETAIL_PANEL_WIDTH, width))
    : selectedNodeIds.length === 1
      && selectedNode
      && selectedNode.kind !== 'task'
      && !detailSuppressed
      ? (width < 640 ? width : Math.min(NODE_DETAIL_PANEL_WIDTH, width))
      : 0;
  const graphViewportWidth = Math.max(width - detailPanelWidth, 1);
  const sceneMatches = useMemo(
    () => matchingUniverseNodeIds(sceneGraph, sceneSearch),
    [sceneGraph, sceneSearch],
  );
  const emphasized = useMemo(
    () => emphasizedUniverseNodeIds(sceneGraph, selectedNodeIds, hoveredNodeId),
    [hoveredNodeId, sceneGraph, selectedNodeIds],
  );

  const updateTooltipPosition = useCallback(() => {
    const tooltip = tooltipRef.current;
    if (
      !tooltip
      || hoveredNode?.kind !== 'task'
      || hoveredNode.x === undefined
      || hoveredNode.y === undefined
    ) {
      return;
    }

    const screenPosition = graphRef.current?.graph2ScreenCoords(hoveredNode.x, hoveredNode.y);
    if (!screenPosition) return;

    const availableTooltipWidth = Math.min(
      TOOLTIP_WIDTH,
      Math.max(graphViewportWidth - 2 * TOOLTIP_MARGIN, 0),
    );
    tooltip.style.width = `${availableTooltipWidth}px`;
    const tooltipWidth = tooltip.offsetWidth
      ? Math.min(tooltip.offsetWidth, availableTooltipWidth)
      : availableTooltipWidth;
    const tooltipHeight = tooltip.offsetHeight || TOOLTIP_HEIGHT;
    const position = universeTooltipPosition({
      anchor: screenPosition,
      viewportWidth: graphViewportWidth,
      viewportHeight: height,
      tooltipWidth,
      tooltipHeight,
      margin: TOOLTIP_MARGIN,
      offset: TOOLTIP_OFFSET,
    });
    tooltip.style.left = `${position.x}px`;
    tooltip.style.top = `${position.y}px`;
  }, [graphViewportWidth, height, hoveredNode]);

  useEffect(() => {
    updateTooltipPosition();
  }, [updateTooltipPosition]);

  useEffect(() => {
    if (
      detailPanelWidth === 0
      || !selectedNode
      || selectedNode.x === undefined
      || selectedNode.y === undefined
    ) {
      return;
    }
    graphRef.current?.centerAt(selectedNode.x, selectedNode.y, 300);
  }, [detailPanelWidth, selectedNode]);

  useEffect(() => {
    if (
      resetFitRequest === consumedResetFitRequestRef.current
      || detailPanelWidth !== 0
    ) {
      return;
    }
    consumedResetFitRequestRef.current = resetFitRequest;
    graphRef.current?.zoomToFit(300, 56);
  }, [detailPanelWidth, resetFitRequest]);

  const drawNode = useCallback((
    rawNode: NodeObject<UniverseNode>,
    context: CanvasRenderingContext2D,
    scale: number,
  ) => {
    const node = rawNode;
    if (node.x === undefined || node.y === undefined) return;
    const dimmed = Boolean(
      (emphasized && !emphasized.has(node.id))
      || (sceneMatches && !sceneMatches.has(node.id)),
    );
    const isSelected = selectedNodeIds.includes(node.id);
    const isHovered = hoveredNodeId === node.id;
    context.save();

    if (node.kind === 'task') {
      const radius = universeTaskRadius(lod) / scale;
      context.globalAlpha = dimmed ? 0.12 : 1;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fillStyle = '#0f172a';
      context.fill();
      context.strokeStyle = isSelected
        ? '#818cf8'
        : clusterByNodeId.get(node.id)?.color ?? node.color;
      context.lineWidth = (isSelected ? 2.8 : 1.3) / scale;
      context.stroke();

      const showSearchLabel = Boolean(sceneMatches?.has(node.id));
      if (isSelected || isHovered || showSearchLabel) {
        const label = node.label.length > 34 ? `${node.label.slice(0, 34)}…` : node.label;
        context.font = `600 ${10 / scale}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'bottom';
        context.lineJoin = 'round';
        context.lineWidth = 3 / scale;
        context.strokeStyle = '#020617';
        context.strokeText(label, node.x, node.y - radius - 4 / scale);
        context.fillStyle = '#f8fafc';
        context.fillText(label, node.x, node.y - radius - 4 / scale);
      }

      if (isHovered && !isSelected) {
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(node.x, node.y, radius + 3 / scale, 0, Math.PI * 2);
        context.setLineDash([3 / scale, 2 / scale]);
        context.strokeStyle = '#f8fafc';
        context.lineWidth = 1.5 / scale;
        context.stroke();
      }
    } else {
      const { width: screenWidth, height: screenHeight } = universePillScreenSize(node);
      const pillWidth = screenWidth / scale;
      const pillHeight = screenHeight / scale;
      const left = node.x - pillWidth / 2;
      const top = node.y - pillHeight / 2;
      const label = node.label.length > 23 ? `${node.label.slice(0, 23)}…` : node.label;

      context.globalAlpha = dimmed ? 0.04 : 0.16;
      context.beginPath();
      context.roundRect(left, top, pillWidth, pillHeight, pillHeight / 2);
      context.fillStyle = node.color;
      context.fill();

      context.globalAlpha = dimmed ? 0.12 : 1;
      context.strokeStyle = node.color;
      context.lineWidth = (isSelected ? 2.8 : 1.4) / scale;
      context.stroke();

      context.textBaseline = 'middle';
      context.textAlign = 'left';
      context.font = `700 ${10 / scale}px sans-serif`;
      context.fillStyle = node.color;
      context.fillText(universeNodeIcon(node), left + 10 / scale, node.y);

      context.font = `600 ${10 / scale}px sans-serif`;
      context.fillStyle = '#e2e8f0';
      context.fillText(label, left + 25 / scale, node.y);

      if (lod !== 'far') {
        context.font = `${9 / scale}px sans-serif`;
        context.textAlign = 'right';
        context.fillStyle = node.color;
        context.fillText(String(node.taskCount ?? 0), left + pillWidth - 9 / scale, node.y);
      }

      if (isHovered && !isSelected) {
        context.globalAlpha = 1;
        context.beginPath();
        context.roundRect(
          left - 3 / scale,
          top - 3 / scale,
          pillWidth + 6 / scale,
          pillHeight + 6 / scale,
          (pillHeight + 6 / scale) / 2,
        );
        context.setLineDash([3 / scale, 2 / scale]);
        context.strokeStyle = '#f8fafc';
        context.lineWidth = 1.5 / scale;
        context.stroke();
      }
    }
    context.restore();
  }, [clusterByNodeId, emphasized, hoveredNodeId, lod, sceneMatches, selectedNodeIds]);

  const drawClusterHulls = useCallback((
    context: CanvasRenderingContext2D,
    scale: number,
  ) => {
    if (!clusterProjection) return;
    for (const cluster of clusterProjection.clusters) {
      const members = (clusteredNodes.get(cluster.id) ?? []).filter((node) =>
        visibleNodeIdSet.has(node.id) && node.x !== undefined && node.y !== undefined);
      const hull = universeClusterHull(
        members.map((node) => ({ x: node.x!, y: node.y! })),
        22 / scale,
      );
      if (!hull.length) continue;
      context.save();
      context.beginPath();
      context.moveTo(hull[0].x, hull[0].y);
      for (const point of hull.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fillStyle = `${cluster.color}12`;
      context.strokeStyle = `${cluster.color}70`;
      context.lineWidth = 1.2 / scale;
      context.setLineDash([5 / scale, 4 / scale]);
      context.fill();
      context.stroke();
      context.restore();
    }
  }, [clusterProjection, clusteredNodes, visibleNodeIdSet]);

  const fitSelection = useCallback(() => {
    if (!selectedNodeIds.length) return;
    const methods = graphRef.current;
    const bounds = methods?.getGraphBbox((node) => selectedNodeIds.includes(String(node.id)));
    if (!methods || !bounds) return;
    const closeOverlay = detailPanelWidth > 0 && graphViewportWidth < 160;
    if (closeOverlay) {
      setSelectedTaskId(null);
      setDetailSuppressed(true);
      setExplorationMessage('Details closed to fit the selection in the available viewport.');
    }
    const usableWidth = closeOverlay ? width : graphViewportWidth;
    const transform = universeFitTransform({
      bounds,
      viewportWidth: usableWidth,
      viewportHeight: height,
    });
    methods.zoom(transform.zoom, 300);
    methods.centerAt(transform.x, transform.y, 300);
  }, [
    detailPanelWidth,
    graphViewportWidth,
    height,
    selectedNodeIds,
    setExplorationMessage,
    setSelectedTaskId,
    width,
  ]);


  return (
    <div className="flex h-full min-h-[620px] overflow-hidden bg-[#020617]">
      <UniverseSidebarFilters
        context={taskFilters.context}
        update={taskFilters.update}
        setContext={taskFilters.setContext}
        options={filterOptions}
        filteredTaskCount={graph?.stats.filteredTaskCount ?? null}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="space-y-2 border-b border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
          <div className="flex min-w-0 items-start gap-2">
            {taskFilters.origin ? (
              <Link
                href={taskFilters.origin.href}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
              >
                <ArrowLeft size={13} aria-hidden="true" />
                <span className="max-w-40 truncate">Back to {taskFilters.origin.label}</span>
              </Link>
            ) : null}
            <TaskKeywordFilter
              filteredCount={graph?.stats.filteredTaskCount ?? 0}
              sources={filterOptions.sources}
              sourceLists={filterOptions.sourceLists}
              tags={filterOptions.tags}
              assignees={filterOptions.assignees}
              projects={filterOptions.projects}
              listGroups={filterOptions.listGroups}
              controller={{
                context: taskFilters.context,
                setContext: taskFilters.setContext,
                clear: taskFilters.clear,
              }}
              onOpenFilters={() => {
                if (window.matchMedia('(min-width: 640px)').matches) {
                  setSidebarMode(sidebarMode === 'collapsed' ? 'normal' : 'collapsed');
                } else {
                  setFiltersOpen(true);
                }
              }}
              filtersButtonLabel="Toggle task filters"
              secondaryContent={(
                <label className="relative hidden min-w-[180px] flex-1 lg:block lg:max-w-[240px]">
                  <span className="sr-only">Find within rendered graph</span>
                  <Search
                    size={13}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                  />
                  <input
                    value={sceneSearch}
                    onChange={(event) => setSceneSearch(event.target.value)}
                    placeholder="Find rendered nodes"
                    title="Highlights nodes already rendered; does not change the task universe"
                    className="h-full min-h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-8 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
                  />
                  {sceneSearch ? (
                    <button
                      type="button"
                      onClick={() => setSceneSearch('')}
                      aria-label="Clear rendered-node search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </label>
              )}
              placeholder="Filter task universe…"
              className="min-w-0 flex-1"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DimensionToggles />
            <NeighborLayerToggles semanticEnabled={graph?.capabilities?.semanticNeighbors ?? false} />
            <UniverseClusterControls
              enabled={clusterGrouping}
              available={graph?.capabilities?.clusters ?? false}
              projection={clusterProjection}
              filter={effectiveClusterFilter}
              onToggle={() => {
                setClusterGrouping((enabled) => !enabled);
                setClusterFilter('all');
                setReviewClusterId(null);
                forcesConfiguredRef.current = false;
              }}
              onFilterChange={setClusterFilter}
            />
            <span className="hidden h-5 w-px bg-[var(--border)] lg:block" />
            <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-[var(--text-tertiary)]">
              <span className="rounded-full border border-[var(--border)] px-2 py-1 capitalize">{lod} detail</span>
              {sceneGraph ? <span>{sceneGraph.stats.taskCount} tasks · {sceneGraph.stats.attributeCount} attributes</span> : null}
            </div>
          </div>
        </header>
        {taskFilters.issues.length ? (
          <div role="status" className="border-b border-amber-500/30 bg-amber-950/70 px-3 py-2 text-xs text-amber-200">
            Some transferred filters could not be applied: {taskFilters.issues.join('; ')}
          </div>
        ) : null}
        <div
          ref={canvasRef}
          data-testid="universe-canvas"
          className="relative min-h-0 flex-1"
          onPointerDownCapture={() => {
            pointerViewportGestureRef.current = true;
          }}
          onPointerUpCapture={() => {
            pointerViewportGestureRef.current = false;
          }}
          onPointerCancelCapture={() => {
            pointerViewportGestureRef.current = false;
          }}
          onWheelCapture={() => {
            userOwnsViewportRef.current = true;
          }}
          onDoubleClickCapture={() => {
            userOwnsViewportRef.current = true;
          }}
        >
        <p className="sr-only">
          Interactive Universe property graph. Tasks are circular nodes and attributes are labeled pills.
          Use the accessible graph list below for keyboard navigation.
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {selectedNodeIds.length} node{selectedNodeIds.length === 1 ? '' : 's'} selected.
          {' '}{sceneGraph?.nodes.length ?? 0} node{sceneGraph?.nodes.length === 1 ? '' : 's'} visible.
        </p>
        {selectedNodeIds.length > 0 && sceneGraph ? (
          <SelectionToolbar
            selectionCount={selectedNodeIds.length}
            relatedCount={unselectedRelatedNodeIds.length}
            expandableCount={selectedNodes.length}
            expanding={expanding}
            focusActive={focusActive}
            onClearSelection={() => {
              setSelectedNodeIds([]);
              setSelectedTaskId(null);
              setDetailSuppressed(false);
              setFocusActive(false);
              setExplorationMessage(null);
            }}
            onSelectRelated={() => {
              setSelectedNodeIds([...selectedNodeIds, ...unselectedRelatedNodeIds]);
              setSelectedTaskId(null);
              setDetailSuppressed(true);
              setExplorationMessage(
                `${unselectedRelatedNodeIds.length} visible neighbor${unselectedRelatedNodeIds.length === 1 ? '' : 's'} added to the selection.`,
              );
            }}
            onToggleFocus={() => {
              const nextFocusActive = !focusActive;
              setFocusActive(nextFocusActive);
              setHoveredNodeId(null);
              setExplorationMessage(nextFocusActive
                ? 'Focus on: showing the selection and its direct connections.'
                : 'Focus off: all graph nodes are visible again.');
            }}
            onExpand={() => void expandSelection(selectedNodes)}
            onFit={fitSelection}
          />
        ) : null}
        {explorationError ? (
          <div role="alert" className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-lg border border-red-500/30 bg-red-950/90 px-3 py-2 text-xs text-red-200">
            {explorationError}
          </div>
        ) : explorationMessage ? (
          <div role="status" className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/95 px-3 py-2 text-xs text-[var(--text-secondary)] shadow-lg">
            {explorationMessage}
          </div>
        ) : null}
        {!shouldLoad ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
            <UniverseSeedSearch
              onExplore={(taskIds) => {
                setSeedTaskIds(taskIds);
                setExploreAll(false);
              }}
              onExploreAll={() => {
                setSeedTaskIds([]);
                setExploreAll(true);
              }}
            />
          </div>
        ) : null}
        {shouldLoad && loading ? (
          <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            <LoaderCircle size={14} className="animate-spin" /> Building property graph
          </div>
        ) : null}
        {shouldLoad && error ? (
          <div role="alert" className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-red-500/30 bg-red-950/90 px-4 py-2 text-xs text-red-200">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="font-semibold underline">
              Retry
            </button>
          </div>
        ) : null}
        {shouldLoad && graph?.truncated ? (
          <div className="absolute bottom-14 left-3 z-10 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/90 px-3 py-2 text-xs text-amber-200">
            <span>
              {isProgressiveOverview && overviewNodeLimit < MAX_UNIVERSE_NODES
                ? `Showing an initial ${overviewNodeLimit}-node overview.`
                : `Too many results to render (${graph.stats.filteredTaskCount} matching). Refine task filters.`}
            </span>
            {isProgressiveOverview && overviewNodeLimit < MAX_UNIVERSE_NODES ? (
              <button
                type="button"
                onClick={() => setOverviewNodeLimit((limit) =>
                  Math.min(limit + OVERVIEW_NODE_STEP, MAX_UNIVERSE_NODES))}
                className="rounded border border-amber-400/50 px-2 py-1 font-semibold hover:bg-amber-400/10"
              >
                Reveal more
              </button>
            ) : null}
          </div>
        ) : null}
        {shouldLoad && graph && graph.nodes.length === 0 && !loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-tertiary)]">No tasks match these filters.</div>
        ) : null}
        {shouldLoad && graph?.nodes.length ? (
          <div aria-hidden="true">
            <ForceGraph2D<UniverseNode, UniverseEdge>
              ref={graphRef}
              width={graphViewportWidth}
              height={height}
              graphData={graphData}
              nodeVisibility={(node) => visibleNodeIdSet.has(node.id)}
              nodeId="id"
              linkSource="source"
              linkTarget="target"
              backgroundColor="#020617"
              nodeCanvasObjectMode={() => 'replace'}
              nodeCanvasObject={drawNode}
              onRenderFramePre={drawClusterHulls}
              nodePointerAreaPaint={(node, color, context, scale) => {
                if (node.x === undefined || node.y === undefined) return;
                context.fillStyle = color;
                context.beginPath();
                if (node.kind === 'task') {
                  context.arc(node.x, node.y, 10 / scale, 0, Math.PI * 2);
                } else {
                  const pill = universePillScreenSize(node);
                  context.roundRect(
                    node.x - pill.width / scale / 2,
                    node.y - pill.height / scale / 2,
                    pill.width / scale,
                    pill.height / scale,
                    pill.height / scale / 2,
                  );
                }
                context.fill();
              }}
              linkColor={(link: LinkObject<UniverseNode, UniverseEdge>) => {
                if (link.type === 'semantic-similarity') {
                  const alpha = Math.round((0.25 + (link.score * 0.65)) * 255)
                    .toString(16)
                    .padStart(2, '0');
                  return `#a78bfa${alpha}`;
                }
                const color = UNIVERSE_DIMENSION_COLORS[link.dimension as UniverseDimension] ?? '#334155';
                const selected = selectedNodeIds.includes(universeEndpointId(link.source))
                  || selectedNodeIds.includes(universeEndpointId(link.target));
                const hovered = hoveredNodeId && (
                  universeEndpointId(link.source) === hoveredNodeId || universeEndpointId(link.target) === hoveredNodeId
                );
                return `${color}${selected ? 'cc' : hovered ? '80' : '24'}`;
              }}
              linkWidth={(link: LinkObject<UniverseNode, UniverseEdge>) => {
                if (link.type === 'semantic-similarity') return 0.6 + link.score;
                const selected = selectedNodeIds.includes(universeEndpointId(link.source))
                  || selectedNodeIds.includes(universeEndpointId(link.target));
                if (selected) return 1.8;
                const hovered = hoveredNodeId && (
                  universeEndpointId(link.source) === hoveredNodeId || universeEndpointId(link.target) === hoveredNodeId
                );
                return hovered ? 1.1 : 0.45;
              }}
              linkLineDash={(link: LinkObject<UniverseNode, UniverseEdge>) =>
                link.type === 'semantic-similarity' ? [4, 4] : null}
              linkVisibility={(link: LinkObject<UniverseNode, UniverseEdge>) => {
                const source = universeEndpointId(link.source);
                const target = universeEndpointId(link.target);
                if (!visibleNodeIdSet.has(source) || !visibleNodeIdSet.has(target)) return false;
                return lod !== 'far'
                  || selectedNodeIds.includes(source)
                  || selectedNodeIds.includes(target)
                  || source === hoveredNodeId
                  || target === hoveredNodeId;
              }}
              onNodeHover={(node) => setHoveredNodeId(node?.id ?? null)}
              onNodeClick={(node) => {
                setSelectedNodeIds([node.id]);
                setHoveredNodeId(null);
                setSelectedTaskId(node.kind === 'task' ? node.entityId : null);
                setDetailSuppressed(false);
                setExplorationError(null);
                setExplorationMessage(null);
              }}
              onNodeDragEnd={(node) => {
                if (node.x !== undefined && node.y !== undefined) {
                  rememberPositions([node]);
                }
              }}
              onBackgroundClick={() => {
                setSelectedNodeIds([]);
                setHoveredNodeId(null);
                setSelectedTaskId(null);
                setFocusActive(false);
                setExplorationError(null);
                setExplorationMessage(null);
              }}
              onZoom={({ k }) => {
                if (pointerViewportGestureRef.current) {
                  userOwnsViewportRef.current = true;
                }
                setLod(universeLodForZoom(k));
                updateTooltipPosition();
              }}
              onEngineTick={updateTooltipPosition}
              onEngineStop={() => {
                rememberPositions(graph.nodes);
                if (expansionPinnedNodesRef.current.length) {
                  releaseUniverseNodePins(expansionPinnedNodesRef.current);
                  expansionPinnedNodesRef.current = [];
                }
                updateTooltipPosition();
                if (!hasInitialFitRef.current && !userOwnsViewportRef.current) {
                  hasInitialFitRef.current = true;
                  graphRef.current?.zoomToFit(300, 56);
                }
              }}
              d3AlphaDecay={0.04}
              d3VelocityDecay={0.5}
              warmupTicks={GRAPH_WARMUP_TICKS}
              cooldownTicks={GRAPH_COOLDOWN_TICKS}
              minZoom={0.1}
              maxZoom={5}
            />
          </div>
        ) : null}
        {hoveredNode?.kind === 'task' && sceneGraph ? (
          <TaskHoverCard node={hoveredNode} graph={sceneGraph} tooltipRef={tooltipRef} />
        ) : null}
        <SemanticNeighborhoodStatus outcomes={semanticOutcomes} />
        {clusterProjection && sceneGraph ? (
          <UniverseClusterSummary
            projection={clusterProjection}
            graph={sceneGraph}
            onFilter={setClusterFilter}
            onSave={(cluster) => setReviewClusterId(cluster.id)}
          />
        ) : null}
        <UniverseFilterPanel
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          context={taskFilters.context}
          activeFilterCount={taskFilters.activeFilterCount}
          filteredTaskCount={graph?.stats.filteredTaskCount ?? null}
          update={taskFilters.update}
          setContext={taskFilters.setContext}
          clear={taskFilters.clear}
          options={filterOptions}
        />
        {selectedNodeIds.length === 1 && selectedNode && selectedNode.kind !== 'task' && sceneGraph && !selectedTaskId && !detailSuppressed ? (
          <NodeDetail
            key={selectedNode.id}
            node={selectedNode}
            graph={sceneGraph}
            onClose={() => setSelectedNodeIds([])}
            onTaskSelect={(taskId) => {
              setHoveredNodeId(null);
              setSelectedTaskId(taskId);
              setDetailSuppressed(false);
            }}
            width={detailPanelWidth}
          />
        ) : null}
        {selectedTaskId ? (
          <div
            className="absolute inset-y-0 right-0 z-30 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
            style={{ width: detailPanelWidth }}
          >
            <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} mode="panel" />
          </div>
        ) : null}
        {reviewCluster && graph && clusterProjection ? (
          <UniverseClusterReviewPanel
            key={reviewCluster.id}
            cluster={reviewCluster}
            graph={graph}
            projectionFingerprint={clusterProjection.fingerprint}
            onClose={() => setReviewClusterId(null)}
            onSaved={setExplorationMessage}
          />
        ) : null}
        {sceneGraph?.nodes.length ? (
          <button
            type="button"
            onClick={() => {
              setSelectedNodeIds([]);
              setHoveredNodeId(null);
              setSelectedTaskId(null);
              setFocusActive(false);
              setLod('medium');
              hasInitialFitRef.current = true;
              setResetFitRequest((request) => request + 1);
            }}
            className="absolute bottom-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] shadow-lg hover:bg-[var(--surface-2)]"
            style={{ right: detailPanelWidth + 12 }}
            aria-label="Reset graph focus"
            title="Reset graph focus"
          >
            <LocateFixed size={15} />
          </button>
        ) : null}
        {sceneGraph?.nodes.length ? <GraphLegend /> : null}
        </div>
        {sceneGraph?.nodes.length ? (
          <AccessibleUniverseList
            graph={sceneGraph}
            clusterProjection={clusterProjection}
            selectedNodeIds={selectedNodeIds}
            onNodeSelect={(nodeId) => {
              setSelectedNodeIds([nodeId]);
              setHoveredNodeId(null);
              setSelectedTaskId(null);
              setDetailSuppressed(false);
            }}
            onTaskActivate={(taskId, nodeId) => {
              setSelectedNodeIds([nodeId]);
              setHoveredNodeId(null);
              setSelectedTaskId(taskId);
              setDetailSuppressed(false);
            }}
            onClusterSelect={setClusterFilter}
            onClusterSave={(cluster) => setReviewClusterId(cluster.id)}
          />
        ) : null}
      </div>
    </div>
  );
}
