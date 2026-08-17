'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import {
  CircleDot,
  ArrowLeft,
  Eye,
  Expand,
  HelpCircle,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Network,
  Search,
  SlidersHorizontal,
  Tag,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';
import { TaskKeywordFilter } from '@/components/filters/TaskKeywordFilter';
import { cn } from '@/lib/utils';
import {
  UNIVERSE_DIMENSION_COLORS,
  UNIVERSE_DIMENSION_ICONS,
  UNIVERSE_DIMENSION_LABELS,
  UNIVERSE_DIMENSIONS,
  type UniverseDimension,
  type UniverseEdge,
  type UniverseLod,
  type UniverseNode,
  type UniverseSubgraph,
} from '@/lib/graph/universe-types';
import {
  deterministicUniversePosition,
  universeCollisionRadius,
  universeNodeDimension,
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
import { mergeUniverseSubgraph } from '@/lib/graph/universe-subgraph';
import type { GraphSubgraph } from '@/lib/graph/types';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import {
  UniverseFilterPanel,
  useUniverseFilterOptions,
} from './UniverseTaskFilters';
import { UniverseSidebarFilters } from './UniverseSidebarFilters';

const MAX_UNIVERSE_NODES = 500;
const INITIAL_OVERVIEW_NODES = 180;
const OVERVIEW_NODE_STEP = 120;
const GRAPH_WARMUP_TICKS = 80;
const GRAPH_COOLDOWN_TICKS = 100;
const MAX_EXPANSION_NODES = 10;
const NODE_DETAIL_PANEL_WIDTH = 340;
const TASK_DETAIL_PANEL_WIDTH = 390;
const TOOLTIP_WIDTH = 288;
const TOOLTIP_HEIGHT = 176;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_OFFSET = 14;
const universePositionCache = new Map<string, { x: number; y: number }>();

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

function endpointId(endpoint: UniverseEdge['source'] | NodeObject<UniverseNode> | undefined): string {
  if (typeof endpoint === 'string') return endpoint;
  return endpoint?.id ? String(endpoint.id) : '';
}

function connectedNodes(graph: UniverseSubgraph, nodeId: string): UniverseNode[] {
  const connectedIds = new Set<string>();
  for (const edge of graph.edges) {
    const source = endpointId(edge.source);
    const target = endpointId(edge.target);
    if (source === nodeId) connectedIds.add(target);
    if (target === nodeId) connectedIds.add(source);
  }
  return graph.nodes.filter((node) => connectedIds.has(node.id));
}

function rememberGraphPositions(nodes: UniverseNode[]) {
  for (const node of nodes) {
    if (node.x !== undefined && node.y !== undefined) {
      universePositionCache.set(node.id, { x: node.x, y: node.y });
    }
  }
}

function releasePinnedPositions(nodes: UniverseNode[]) {
  for (const node of nodes) {
    delete node.fx;
    delete node.fy;
  }
}

function positionGraph(graph: UniverseSubgraph): UniverseSubgraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const position = universePositionCache.get(node.id) ?? deterministicUniversePosition(node.id);
      return { ...node, ...position };
    }),
  };
}

function visibleUniverseGraph(
  graph: UniverseSubgraph | null,
  hiddenNodeIds: string[],
): UniverseSubgraph | null {
  if (!graph || !hiddenNodeIds.length) return graph;
  const hidden = new Set(hiddenNodeIds);
  const nodes = graph.nodes.filter((node) => !hidden.has(node.id));
  const visible = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) =>
    visible.has(endpointId(edge.source)) && visible.has(endpointId(edge.target)));
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

function DimensionToggles() {
  const dimensions = useUniverseGraphStore((state) => state.dimensions);
  const toggleDimension = useUniverseGraphStore((state) => state.toggleDimension);

  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Universe dimensions">
      {UNIVERSE_DIMENSIONS.map((dimension) => {
        const active = dimensions.includes(dimension);
        const color = UNIVERSE_DIMENSION_COLORS[dimension];
        return (
          <button
            key={dimension}
            type="button"
            aria-pressed={active}
            onClick={() => toggleDimension(dimension)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-opacity',
              active ? 'opacity-100' : 'opacity-40 hover:opacity-70',
            )}
            style={{ color: active ? color : 'var(--text-tertiary)', borderColor: active ? color : 'var(--border)' }}
          >
            {UNIVERSE_DIMENSION_LABELS[dimension]}
          </button>
        );
      })}
    </div>
  );
}

function NodeDetail({
  node,
  graph,
  onClose,
  onTaskSelect,
  width,
}: {
  node: UniverseNode;
  graph: UniverseSubgraph;
  onClose: () => void;
  onTaskSelect: (taskId: string) => void;
  width: number;
}) {
  const [taskSearch, setTaskSearch] = useState('');
  const connectedTaskIds = new Set(
    graph.edges
      .flatMap((edge) => {
        const source = endpointId(edge.source);
        const target = endpointId(edge.target);
        if (source === node.id) return [target];
        if (target === node.id) return [source];
        return [];
      }),
  );
  const connectedTasks = graph.nodes
    .filter((candidate) => candidate.kind === 'task' && connectedTaskIds.has(candidate.id))
    .sort((left, right) => left.label.localeCompare(right.label));
  const visibleTasks = connectedTasks.filter((task) =>
    task.label.toLowerCase().includes(taskSearch.trim().toLowerCase()));
  const dimension = universeNodeDimension(node);

  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-2xl"
      style={{ width }}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full border text-xs font-bold"
          style={{ color: node.color, borderColor: node.color }}
          aria-hidden="true"
        >
          {universeNodeIcon(node)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">{node.label}</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
            {node.kind === 'task'
              ? 'Task'
              : node.kind === 'project'
                ? 'Project'
                : `${UNIVERSE_DIMENSION_LABELS[dimension ?? 'tags']} attribute`}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close node details" className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]">
          <X size={14} />
        </button>
      </div>
      {node.kind !== 'task' ? (
        <div className="mt-5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {connectedTasks.length} connected task{connectedTasks.length === 1 ? '' : 's'}
          </p>
          {connectedTasks.length > 8 ? (
            <label className="mb-2 block">
              <span className="sr-only">Filter connected tasks</span>
              <input
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder="Filter connected tasks..."
                className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs outline-none focus:border-[var(--accent-500)]"
              />
            </label>
          ) : null}
          <div className="space-y-1.5">
            {visibleTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => onTaskSelect(task.entityId)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-left text-xs text-[var(--text-secondary)] hover:border-[var(--accent-500)] hover:text-[var(--text-primary)]"
              >
                {task.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Button className="mt-5 w-full" onClick={() => onTaskSelect(node.entityId)}>Open task details</Button>
      )}
    </aside>
  );
}

function TaskHoverCard({
  node,
  graph,
  tooltipRef,
}: {
  node: UniverseNode;
  graph: UniverseSubgraph;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (node.kind !== 'task') return null;
  const attributes = connectedNodes(graph, node.id)
    .filter((candidate) => candidate.kind !== 'task')
    .slice(0, 8);
  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-0 z-30 w-72 max-w-[calc(100%-16px)] rounded-lg border border-slate-600 bg-slate-800/95 p-3 text-left shadow-2xl backdrop-blur"
    >
      <p className="truncate text-xs font-semibold text-slate-50">{node.label}</p>
      <p className="mt-1 text-[10px] capitalize text-slate-400">
        {node.status.replaceAll('_', ' ')}
      </p>
      {attributes.length ? (
        <>
          <p className="mt-2 text-[10px] text-slate-400">Connected to:</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {attributes.map((attribute) => (
              <span
                key={attribute.id}
                className="rounded-full border px-1.5 py-0.5 text-[10px]"
                style={{ color: attribute.color, borderColor: attribute.color }}
              >
                {universeNodeIcon(attribute)} {attribute.label}
              </span>
            ))}
          </div>
        </>
      ) : null}
      <p className="mt-2 text-[10px] font-medium text-sky-400">Click to open task details</p>
    </div>
  );
}

function GraphLegend() {
  const legendDimensions: UniverseDimension[] = ['priority', 'source', 'tags', 'status', 'project'];
  return (
    <div className="absolute bottom-3 left-3 z-10 hidden max-w-[calc(100%-72px)] items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/90 px-2.5 py-2 text-[9px] text-[var(--text-tertiary)] shadow-lg backdrop-blur md:flex">
      <span className="flex items-center gap-1"><CircleDot size={11} /> Task</span>
      {legendDimensions.map((dimension) => (
        <span
          key={dimension}
          className="flex items-center gap-1 rounded-full border px-1.5 py-0.5"
          style={{
            color: UNIVERSE_DIMENSION_COLORS[dimension],
            borderColor: UNIVERSE_DIMENSION_COLORS[dimension],
          }}
        >
          {dimension === 'tags' ? <Tag size={9} /> : UNIVERSE_DIMENSION_ICONS[dimension]}
          {UNIVERSE_DIMENSION_LABELS[dimension]}
        </span>
      ))}
      <span>Hover reveals context</span>
    </div>
  );
}

function SelectionToolbar({
  selectionCount,
  relatedCount,
  expandableCount,
  expanding,
  focusActive,
  onClearSelection,
  onSelectRelated,
  onToggleFocus,
  onExpand,
  onFit,
}: {
  selectionCount: number;
  relatedCount: number;
  expandableCount: number;
  expanding: boolean;
  focusActive: boolean;
  onClearSelection: () => void;
  onSelectRelated: () => void;
  onToggleFocus: () => void;
  onExpand: () => void;
  onFit: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const selectRelatedDisabled = relatedCount === 0;
  const expandDisabled = expandableCount === 0 || expanding;
  const actionClass = 'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[10px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40';
  const groupClass = 'flex items-center gap-1 rounded-md bg-[var(--surface-2)]/60 p-1';
  return (
    <div
      role="toolbar"
      aria-label={`Neighborhood actions for ${selectionCount} selected node${selectionCount === 1 ? '' : 's'}`}
      className="absolute left-1/2 top-3 z-40 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)]/95 p-1.5 shadow-xl backdrop-blur"
    >
      <div className={groupClass} role="group" aria-label="Selection">
        <span className="px-1.5 text-[10px] font-semibold text-[var(--text-primary)]">
          {selectionCount} selected
        </span>
        <button type="button" className={actionClass} onClick={onClearSelection}>
          Clear
        </button>
      </div>
      <span id="select-related-help" className="sr-only">
        {relatedCount === 0
          ? 'There are no unselected visible neighbors.'
          : 'Adds visible direct neighbors to the selection without loading new graph data.'}
      </span>
      <div className={groupClass} role="group" aria-label="Grow graph">
        <span className="px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Grow</span>
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            if (!selectRelatedDisabled) onSelectRelated();
          }}
          aria-disabled={selectRelatedDisabled}
          aria-describedby="select-related-help"
        >
          <Network size={12} aria-hidden="true" /> Add connected
        </button>
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            if (!expandDisabled) onExpand();
          }}
          aria-disabled={expandDisabled}
          aria-label={expanding
            ? 'Load neighbors: loading in progress'
            : expandableCount === 0
              ? 'Load neighbors: selected nodes cannot be expanded'
              : 'Load neighbors'}
        >
          {expanding
            ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
            : <Expand size={12} aria-hidden="true" />}
          Load neighbors
        </button>
      </div>
      <div className={groupClass} role="group" aria-label="Change view">
        <span className="px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">View</span>
        <button
          type="button"
          className={cn(
            actionClass,
            focusActive && 'border-[var(--accent-500)] bg-[var(--accent-500)]/15 text-[var(--text-primary)]',
          )}
          onClick={onToggleFocus}
          aria-pressed={focusActive}
          title="Temporarily show only the selection and its direct connections"
        >
          <Eye size={12} aria-hidden="true" /> {focusActive ? 'Exit focus' : 'Focus'}
        </button>
        <button type="button" className={actionClass} onClick={onFit} title="Move the camera without hiding or loading nodes">
          <Maximize2 size={12} aria-hidden="true" /> Fit
        </button>
      </div>
      <div className="relative">
        <button
          type="button"
          className={actionClass}
          aria-label="How neighborhood actions work"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          <HelpCircle size={12} aria-hidden="true" />
        </button>
        {helpOpen ? (
          <div className="absolute right-0 top-10 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-left text-[11px] leading-5 text-[var(--text-secondary)] shadow-xl">
            <p><strong className="text-[var(--text-primary)]">Add connected</strong> selects neighbors already on screen.</p>
            <p><strong className="text-[var(--text-primary)]">Load neighbors</strong> fetches more graph data around the selection.</p>
            <p><strong className="text-[var(--text-primary)]">Focus</strong> temporarily hides unrelated nodes. Click Exit focus to restore them.</p>
            <p><strong className="text-[var(--text-primary)]">Fit</strong> only moves the camera.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AccessibleUniverseList({
  graph,
  selectedNodeIds,
  onNodeSelect,
  onTaskActivate,
}: {
  graph: UniverseSubgraph;
  selectedNodeIds: string[];
  onNodeSelect: (nodeId: string) => void;
  onTaskActivate: (taskId: string, nodeId: string) => void;
}) {
  const tasks = graph.nodes.filter((node) => node.kind === 'task');
  const attributes = graph.nodes
    .filter((node) => node.kind !== 'task')
    .sort((left, right) => left.label.localeCompare(right.label));
  return (
    <details className="shrink-0 border-t border-[var(--border)] bg-[var(--surface-0)]">
      <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-[var(--text-secondary)]">
        Accessible graph list ({tasks.length} tasks, {attributes.length} attributes)
      </summary>
      <div className="grid max-h-[40vh] gap-5 overflow-y-auto px-4 pb-4 pt-2 lg:grid-cols-2">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Tasks</h2>
          <ol className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onTaskActivate(task.entityId, task.id)}
                  aria-current={selectedNodeIds.includes(task.id) ? 'true' : undefined}
                  aria-label={`Open task ${task.label}`}
                  title="Open task details"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-xs hover:border-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                >
                  <span className="block truncate font-medium">{task.label}</span>
                  <span className="mt-0.5 block capitalize text-[10px] text-[var(--text-tertiary)]">
                    {task.status.replaceAll('_', ' ')}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Attributes</h2>
          <ol className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {attributes.map((attribute) => (
              <li key={attribute.id}>
                <button
                  type="button"
                  onClick={() => onNodeSelect(attribute.id)}
                  aria-pressed={selectedNodeIds.includes(attribute.id)}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-xs hover:border-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                >
                  <span className="font-semibold" style={{ color: attribute.color }}>
                    {universeNodeIcon(attribute)} {attribute.label}
                  </span>
                  <span className="ml-2 text-[var(--text-tertiary)]">
                    {attribute.taskCount ?? 0} connected
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </details>
  );
}

export default function UniverseGraph() {
  const dimensions = useUniverseGraphStore((state) => state.dimensions);
  const legacyFilters = useUniverseGraphStore((state) => state.legacyFilters);
  const clearLegacyFilters = useUniverseGraphStore((state) => state.clearLegacyFilters);
  const selectedNodeIds = useUniverseGraphStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useUniverseGraphStore((state) => state.setSelectedNodeIds);
  const resetScene = useUniverseGraphStore((state) => state.resetScene);
  const reconcileSelection = useUniverseGraphStore((state) => state.reconcileSelection);
  const taskFilters = useTaskFilterContext();
  const filterOptions = useUniverseFilterOptions();
  const { sidebarMode, setSidebarMode } = useSidebarExpanded();
  const [graph, setGraph] = useState<UniverseSubgraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exploreAll, setExploreAll] = useState(false);
  const [overviewNodeLimit, setOverviewNodeLimit] = useState(INITIAL_OVERVIEW_NODES);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sceneSearch, setSceneSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [detailSuppressed, setDetailSuppressed] = useState(false);
  const [focusActive, setFocusActive] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [explorationMessage, setExplorationMessage] = useState<string | null>(null);
  const [explorationError, setExplorationError] = useState<string | null>(null);
  const [lod, setLod] = useState<UniverseLod>('medium');
  const [resetFitRequest, setResetFitRequest] = useState(0);
  const graphRef = useRef<ForceGraphMethods<
    NodeObject<UniverseNode>,
    LinkObject<UniverseNode, UniverseEdge>
  > | undefined>(undefined);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hasInitialFitRef = useRef(false);
  const forcesConfiguredRef = useRef(false);
  const expansionPinnedNodesRef = useRef<UniverseNode[]>([]);
  const canonicalGenerationRef = useRef(0);
  const expansionControllerRef = useRef<AbortController | null>(null);
  const consumedResetFitRequestRef = useRef(0);
  const userOwnsViewportRef = useRef(false);
  const pointerViewportGestureRef = useRef(false);
  const { ref: canvasRef, width, height } = useCanvasSize();
  const hasFilters = taskFilters.activeFilterCount > 0;
  const shouldLoad = exploreAll || hasFilters;
  const isProgressiveOverview = exploreAll && !hasFilters;
  const requestedNodeLimit = isProgressiveOverview ? overviewNodeLimit : MAX_UNIVERSE_NODES;
  const canonicalQuery = useMemo(
    () => buildUniverseGraphSearchParams(
      taskFilters.context,
      dimensions,
      requestedNodeLimit,
    ).toString(),
    [dimensions, requestedNodeLimit, taskFilters.context],
  );
  const graphData = useMemo(() => ({
    nodes: graph?.nodes ?? [],
    links: graph?.edges ?? [],
  }), [graph]);

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
    canonicalGenerationRef.current += 1;
    expansionControllerRef.current?.abort();
    if (!shouldLoad) {
      forcesConfiguredRef.current = false;
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/graph/universe?${canonicalQuery}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Failed to load graph');
        hasInitialFitRef.current = false;
        expansionPinnedNodesRef.current = [];
        resetScene();
        setSelectedTaskId(null);
        setDetailSuppressed(false);
        setFocusActive(false);
        setHoveredNodeId(null);
        setExplorationMessage(null);
        setExplorationError(null);
        userOwnsViewportRef.current = false;
        setGraph(positionGraph(result.graph));
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load graph');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    canonicalQuery,
    reloadKey,
    resetScene,
    shouldLoad,
  ]);

  useEffect(() => () => expansionControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!graph?.nodes.length) {
      forcesConfiguredRef.current = false;
      return;
    }
    if (forcesConfiguredRef.current) return;
    const collision = forceCollide<NodeObject<UniverseNode>>()
      .radius((node) => universeCollisionRadius(node))
      .strength(0.72)
      .iterations(2);
    graphRef.current?.d3Force('collision', collision);
    graphRef.current?.d3ReheatSimulation();
    forcesConfiguredRef.current = true;
  }, [graph]);

  const selectedNodes = useMemo(
    () => graph?.nodes.filter((node) => selectedNodeIds.includes(node.id)) ?? [],
    [graph, selectedNodeIds],
  );
  const selectedNode = selectedNodes.at(-1) ?? null;
  const selectedNeighborhood = useMemo(() => {
    const selected = new Set(selectedNodeIds);
    const neighborhood = new Set(selectedNodeIds);
    if (!graph) return neighborhood;
    for (const edge of graph.edges) {
      const source = endpointId(edge.source);
      const target = endpointId(edge.target);
      if (selected.has(source)) neighborhood.add(target);
      if (selected.has(target)) neighborhood.add(source);
    }
    return neighborhood;
  }, [graph, selectedNodeIds]);
  const sceneGraph = useMemo(() => {
    if (!focusActive || !graph) return graph;
    const hiddenNodeIds = graph.nodes
      .filter((node) => !selectedNeighborhood.has(node.id))
      .map((node) => node.id);
    return visibleUniverseGraph(graph, hiddenNodeIds);
  }, [focusActive, graph, selectedNeighborhood]);
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
  const sceneMatches = useMemo(() => {
    const query = sceneSearch.trim().toLowerCase();
    if (!sceneGraph || !query) return null;
    return new Set(
      sceneGraph.nodes
        .filter((node) => node.label.toLowerCase().includes(query))
        .map((node) => node.id),
    );
  }, [sceneGraph, sceneSearch]);
  const emphasized = useMemo(() => {
    if (!sceneGraph || (!selectedNodeIds.length && !hoveredNodeId)) return null;
    const contextIds = selectedNodeIds.length
      ? new Set(selectedNodeIds)
      : new Set([hoveredNodeId as string]);
    const ids = new Set(contextIds);
    for (const edge of sceneGraph.edges) {
      const source = endpointId(edge.source);
      const target = endpointId(edge.target);
      if (contextIds.has(source)) ids.add(target);
      if (contextIds.has(target)) ids.add(source);
    }
    return ids;
  }, [hoveredNodeId, sceneGraph, selectedNodeIds]);

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
    const maxX = Math.max(graphViewportWidth - tooltipWidth - TOOLTIP_MARGIN, TOOLTIP_MARGIN);
    const maxY = Math.max(height - tooltipHeight - TOOLTIP_MARGIN, TOOLTIP_MARGIN);
    const preferredX = screenPosition.x + TOOLTIP_OFFSET + tooltipWidth <= graphViewportWidth
      ? screenPosition.x + TOOLTIP_OFFSET
      : screenPosition.x - tooltipWidth - TOOLTIP_OFFSET;

    tooltip.style.left = `${Math.round(Math.min(Math.max(preferredX, TOOLTIP_MARGIN), maxX))}px`;
    tooltip.style.top = `${Math.round(Math.min(Math.max(screenPosition.y - TOOLTIP_OFFSET, TOOLTIP_MARGIN), maxY))}px`;
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
      context.strokeStyle = isSelected ? '#818cf8' : node.color;
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
  }, [emphasized, hoveredNodeId, lod, sceneMatches, selectedNodeIds]);

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
    const graphWidth = Math.max(bounds.x[1] - bounds.x[0], 24);
    const graphHeight = Math.max(bounds.y[1] - bounds.y[0], 24);
    const zoom = Math.max(0.1, Math.min(
      5,
      (usableWidth - 112) / graphWidth,
      (height - 112) / graphHeight,
    ));
    const centerX = (bounds.x[0] + bounds.x[1]) / 2;
    const centerY = (bounds.y[0] + bounds.y[1]) / 2;
    methods.zoom(zoom, 300);
    methods.centerAt(centerX, centerY, 300);
  }, [detailPanelWidth, graphViewportWidth, height, selectedNodeIds, width]);

  const expandSelection = useCallback(async () => {
    if (!graph || expanding) return;
    const allNodeIds = selectedNodes.map((node) => node.id);
    const nodeIds = allNodeIds.slice(0, MAX_EXPANSION_NODES);
    if (!nodeIds.length) return;
    const generation = canonicalGenerationRef.current;
    const controller = new AbortController();
    expansionControllerRef.current?.abort();
    expansionControllerRef.current = controller;
    setExpanding(true);
    setExplorationError(null);
    setExplorationMessage(null);
    try {
      const results = await Promise.allSettled(nodeIds.map(async (nodeId) => {
        const params = new URLSearchParams({
          include: 'explicit,derived',
          maxNodes: '80',
          maxEdges: '240',
        });
        const response = await fetch(
          `/api/graph/nodes/${encodeURIComponent(nodeId)}/neighbors?${params}`,
          { signal: controller.signal },
        );
        const result: { graph?: GraphSubgraph; error?: string } = await response.json();
        if (!response.ok || !result.graph) {
          throw new Error(result.error ?? `Failed to expand ${nodeId}`);
        }
        return result.graph;
      }));
      if (
        controller.signal.aborted
        || generation !== canonicalGenerationRef.current
        || expansionControllerRef.current !== controller
      ) return;
      rememberGraphPositions(graph.nodes);
      const responses = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []);
      const failedCount = results.length - responses.length;
      if (!responses.length) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        throw firstFailure?.status === 'rejected' && firstFailure.reason instanceof Error
          ? firstFailure.reason
          : new Error('Failed to expand selected nodes');
      }
      let merged = {
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          ...(node.x !== undefined && node.y !== undefined
            ? { fx: node.x, fy: node.y }
            : {}),
        })),
      };
      let droppedNodes = 0;
      let droppedEdges = 0;
      for (const responseGraph of responses) {
        const result = mergeUniverseSubgraph(merged, responseGraph, {
          dimensions,
          maxNodes: MAX_UNIVERSE_NODES,
          maxEdges: MAX_UNIVERSE_NODES * 4,
        });
        merged = result.graph;
        droppedNodes += result.droppedNodes;
        droppedEdges += result.droppedEdges;
      }
      const addedNodes = merged.nodes.length - graph.nodes.length;
      const addedEdges = merged.edges.length - graph.edges.length;
      if (addedNodes || addedEdges) {
        const existingNodeIds = new Set(graph.nodes.map((node) => node.id));
        const positioned = positionGraph(merged);
        expansionPinnedNodesRef.current = positioned.nodes.filter((node) =>
          existingNodeIds.has(node.id));
        setGraph(positioned);
      }
      const truncated = responses.some((responseGraph) => responseGraph.truncated);
      const selectionLimited = allNodeIds.length > nodeIds.length;
      const suffix = [
        truncated ? 'the neighborhood was bounded' : null,
        droppedNodes || droppedEdges
          ? `${droppedNodes} node${droppedNodes === 1 ? '' : 's'} and ${droppedEdges} connection${droppedEdges === 1 ? '' : 's'} were omitted at scene capacity`
          : null,
        failedCount ? `${failedCount} selected node${failedCount === 1 ? '' : 's'} failed to expand` : null,
        selectionLimited ? `expansion was limited to ${MAX_EXPANSION_NODES} selected nodes` : null,
      ].filter(Boolean).join('; ');
      setExplorationMessage(addedNodes || addedEdges
        ? `Added ${addedNodes} node${addedNodes === 1 ? '' : 's'} and ${addedEdges} connection${addedEdges === 1 ? '' : 's'}${suffix ? `; ${suffix}` : ''}.`
        : `No additional neighbors were found${suffix ? `; ${suffix}` : ''}.`);
    } catch (expandError) {
      if (expandError instanceof DOMException && expandError.name === 'AbortError') return;
      setExplorationError(
        expandError instanceof Error ? expandError.message : 'Failed to expand neighborhood',
      );
    } finally {
      if (expansionControllerRef.current === controller) {
        expansionControllerRef.current = null;
        setExpanding(false);
      }
    }
  }, [dimensions, expanding, graph, selectedNodes]);

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
            <span className="hidden h-5 w-px bg-[var(--border)] lg:block" />
            <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
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
            onExpand={() => void expandSelection()}
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
            <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface-1)]/95 p-6 text-center shadow-2xl backdrop-blur">
              <SlidersHorizontal size={28} className="mx-auto text-[var(--accent-400)]" />
              <h2 className="mt-3 text-base font-semibold text-[var(--text-primary)]">Choose a task universe</h2>
              <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                Filter tasks above, or explore all open tasks.
              </p>
              <Button variant="secondary" className="mt-4" onClick={() => setExploreAll(true)}>
                Explore all tasks
              </Button>
            </div>
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
          <div className="absolute bottom-14 left-3 z-10 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/90 px-3 py-2 text-[10px] text-amber-200">
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
                const color = UNIVERSE_DIMENSION_COLORS[link.dimension as UniverseDimension] ?? '#334155';
                const selected = selectedNodeIds.includes(endpointId(link.source))
                  || selectedNodeIds.includes(endpointId(link.target));
                const hovered = hoveredNodeId && (
                  endpointId(link.source) === hoveredNodeId || endpointId(link.target) === hoveredNodeId
                );
                return `${color}${selected ? 'cc' : hovered ? '80' : '24'}`;
              }}
              linkWidth={(link: LinkObject<UniverseNode, UniverseEdge>) => {
                const selected = selectedNodeIds.includes(endpointId(link.source))
                  || selectedNodeIds.includes(endpointId(link.target));
                if (selected) return 1.8;
                const hovered = hoveredNodeId && (
                  endpointId(link.source) === hoveredNodeId || endpointId(link.target) === hoveredNodeId
                );
                return hovered ? 1.1 : 0.45;
              }}
              linkVisibility={(link: LinkObject<UniverseNode, UniverseEdge>) => {
                const source = endpointId(link.source);
                const target = endpointId(link.target);
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
                  universePositionCache.set(node.id, { x: node.x, y: node.y });
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
                setLod(k < 0.45 ? 'far' : k < 1.2 ? 'medium' : 'close');
                updateTooltipPosition();
              }}
              onEngineTick={updateTooltipPosition}
              onEngineStop={() => {
                rememberGraphPositions(graph.nodes);
                if (expansionPinnedNodesRef.current.length) {
                  releasePinnedPositions(expansionPinnedNodesRef.current);
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
          />
        ) : null}
      </div>
    </div>
  );
}
