'use client';

import { useState, type RefObject } from 'react';
import { CircleDot, Eye, Expand, HelpCircle, LoaderCircle, Maximize2, Network, Sparkles, Tag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  UNIVERSE_DIMENSION_COLORS,
  UNIVERSE_DIMENSION_ICONS,
  UNIVERSE_DIMENSION_LABELS,
  UNIVERSE_DIMENSIONS,
} from '@/lib/graph/universe-types';
import type { SemanticSimilarityGraphEdge } from '@/lib/graph/types';
import type {
  UniverseCluster,
  UniverseClusterProjection,
  UniverseDimension,
  UniverseNeighborLayer,
  UniverseNode,
  UniverseSemanticState,
  UniverseSubgraph,
} from '@/lib/graph/universe-types';
import { universeNodeDimension, universeNodeIcon } from '@/lib/graph/universe-visuals';
import { connectedUniverseNodes, universeEndpointId } from '@/lib/graph/universe-geometry';
import { useUniverseGraphStore } from '@/lib/stores/universeGraphStore';

export function DimensionToggles() {
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
              'rounded-full border px-2.5 py-1 text-xs font-semibold transition-opacity',
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

const NEIGHBOR_LAYER_LABELS: Record<UniverseNeighborLayer, string> = {
  explicit: 'Dependencies',
  derived: 'Attributes',
  semantic: 'Semantic',
};

function SemanticConnectionDetails({
  edge,
  graph,
  nodeId,
}: {
  edge: SemanticSimilarityGraphEdge;
  graph: UniverseSubgraph;
  nodeId: string;
}) {
  const otherNodeId = universeEndpointId(edge.source) === nodeId
    ? universeEndpointId(edge.target)
    : universeEndpointId(edge.source);
  const otherNode = graph.nodes.find((node) => node.id === otherNodeId);
  const timestampDetails = [
    edge.embedding.sourceUpdatedAt ? `source revised ${new Date(edge.embedding.sourceUpdatedAt).toLocaleDateString()}` : null,
    edge.embedding.sourceEmbeddedAt ? `source embedded ${new Date(edge.embedding.sourceEmbeddedAt).toLocaleDateString()}` : null,
    edge.embedding.targetUpdatedAt ? `neighbor revised ${new Date(edge.embedding.targetUpdatedAt).toLocaleDateString()}` : null,
    edge.embedding.targetEmbeddedAt ? `neighbor embedded ${new Date(edge.embedding.targetEmbeddedAt).toLocaleDateString()}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mt-1 rounded-md bg-violet-500/10 px-2 py-1.5 text-xs text-violet-100">
      <span className="font-semibold">
        {Math.round(edge.score * 100)}% related{otherNode ? ` to ${otherNode.label}` : ''}.
      </span>
      {' '}{edge.explanation}
      <span className="mt-1 block text-[var(--text-tertiary)]">
        {edge.embedding.provider ?? 'Unknown provider'} / {edge.embedding.model ?? 'unknown model'}
        {edge.embedding.indexId ? ` · index ${edge.embedding.indexId}` : ''}
        {edge.embedding.projectionVersion !== undefined
          ? ` · projection ${edge.embedding.projectionVersion}`
          : ''}
      </span>
      {timestampDetails ? (
        <span className="mt-1 block text-[var(--text-tertiary)]">{timestampDetails}</span>
      ) : null}
      <span className="mt-1 block font-medium text-violet-200">Transient suggestion · not saved</span>
    </div>
  );
}

export function NeighborLayerToggles({
  semanticEnabled,
}: {
  semanticEnabled: boolean;
}) {
  const layers = useUniverseGraphStore((state) => state.neighborLayers);
  const toggleLayer = useUniverseGraphStore((state) => state.toggleNeighborLayer);

  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Neighborhood layers">
      {(['explicit', 'derived', 'semantic'] as const).map((layer) => {
        const unavailable = layer === 'semantic' && !semanticEnabled;
        return (
          <button
            key={layer}
            type="button"
            aria-pressed={layers.includes(layer)}
            disabled={unavailable}
            title={unavailable ? 'Semantic neighborhoods are disabled by the feature gate' : undefined}
            onClick={() => toggleLayer(layer)}
            className={cn(
              'min-h-8 rounded-full border border-[var(--border)] px-2.5 text-xs font-semibold',
              layers.includes(layer)
                ? 'bg-[var(--surface-3)] text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]',
              unavailable && 'cursor-not-allowed opacity-40',
            )}
          >
            {layer === 'semantic' ? <Sparkles size={11} className="mr-1 inline" aria-hidden="true" /> : null}
            {NEIGHBOR_LAYER_LABELS[layer]}
          </button>
        );
      })}
    </div>
  );
}

export function SemanticNeighborhoodStatus({
  outcomes,
}: {
  outcomes: Array<{ nodeId: string; status: UniverseSemanticState; note?: string }>;
}) {
  if (!outcomes.length) return null;
  const priority: UniverseSemanticState[] = [
    'denied',
    'unavailable',
    'incompatible',
    'stale',
    'missing',
    'partial',
    'available',
    'not-requested',
  ];
  const outcome = [...outcomes].sort(
    (left, right) => priority.indexOf(left.status) - priority.indexOf(right.status),
  )[0];
  return (
    <div
      role="status"
      className={cn(
        'absolute bottom-14 right-3 z-10 max-w-sm rounded-lg border px-3 py-2 text-xs shadow-lg',
        outcome.status === 'available'
          ? 'border-emerald-500/30 bg-emerald-950/90 text-emerald-100'
          : outcome.status === 'partial'
            ? 'border-amber-500/30 bg-amber-950/90 text-amber-100'
            : 'border-slate-500/40 bg-slate-900/95 text-slate-200',
      )}
    >
      <span className="font-semibold capitalize">Semantic {outcome.status.replace('-', ' ')}</span>
      {outcome.note ? <span>: {outcome.note}</span> : null}
    </div>
  );
}

export function NodeDetail({
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
        const source = universeEndpointId(edge.source);
        const target = universeEndpointId(edge.target);
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
          <p className="mt-0.5 text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
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
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
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

export function TaskHoverCard({
  node,
  graph,
  tooltipRef,
}: {
  node: UniverseNode;
  graph: UniverseSubgraph;
  tooltipRef: RefObject<HTMLDivElement | null>;
}) {
  if (node.kind !== 'task') return null;
  const attributes = connectedUniverseNodes(graph, node.id)
    .filter((candidate) => candidate.kind !== 'task')
    .slice(0, 8);
  const semanticEdges = graph.edges
    .filter((edge): edge is SemanticSimilarityGraphEdge => (
      edge.type === 'semantic-similarity'
      && (universeEndpointId(edge.source) === node.id
        || universeEndpointId(edge.target) === node.id)
    ))
    .slice(0, 2);
  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-0 z-30 w-72 max-w-[calc(100%-16px)] rounded-lg border border-slate-600 bg-slate-800/95 p-3 text-left shadow-2xl backdrop-blur"
    >
      <p className="truncate text-xs font-semibold text-slate-50">{node.label}</p>
      <p className="mt-1 text-xs capitalize text-slate-400">
        {node.status.replaceAll('_', ' ')}
      </p>
      {attributes.length ? (
        <>
          <p className="mt-2 text-xs text-slate-400">Connected to:</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {attributes.map((attribute) => (
              <span
                key={attribute.id}
                className="rounded-full border px-1.5 py-0.5 text-xs"
                style={{ color: attribute.color, borderColor: attribute.color }}
              >
                {universeNodeIcon(attribute)} {attribute.label}
              </span>
            ))}
          </div>
        </>
      ) : null}
      {semanticEdges.map((edge) => (
        <SemanticConnectionDetails key={edge.id} edge={edge} graph={graph} nodeId={node.id} />
      ))}
      <p className="mt-2 text-xs font-medium text-sky-400">Click to open task details</p>
    </div>
  );
}

export function GraphLegend() {
  const legendDimensions: UniverseDimension[] = ['priority', 'source', 'tags', 'status', 'project'];
  return (
    <div className="absolute bottom-3 left-3 z-10 hidden max-w-[calc(100%-72px)] items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]/90 px-2.5 py-2 text-xs text-[var(--text-tertiary)] shadow-lg backdrop-blur md:flex">
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

export function SelectionToolbar({
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
  const actionClass = 'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40';
  const groupClass = 'flex items-center gap-1 rounded-md bg-[var(--surface-2)]/60 p-1';
  return (
    <div
      role="toolbar"
      aria-label={`Neighborhood actions for ${selectionCount} selected node${selectionCount === 1 ? '' : 's'}`}
      className="absolute left-1/2 top-3 z-40 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)]/95 p-1.5 shadow-xl backdrop-blur"
    >
      <div className={groupClass} role="group" aria-label="Selection">
        <span className="px-1.5 text-xs font-semibold text-[var(--text-primary)]">
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
        <span className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Grow</span>
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
        <span className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">View</span>
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

export function AccessibleUniverseList({
  graph,
  clusterProjection,
  selectedNodeIds,
  onNodeSelect,
  onTaskActivate,
  onClusterSelect,
  onClusterSave,
}: {
  graph: UniverseSubgraph;
  clusterProjection?: UniverseClusterProjection | null;
  selectedNodeIds: string[];
  onNodeSelect: (nodeId: string) => void;
  onTaskActivate: (taskId: string, nodeId: string) => void;
  onClusterSelect?: (clusterId: string) => void;
  onClusterSave?: (cluster: UniverseCluster) => void;
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
        {clusterProjection ? (
          <section className="lg:col-span-2" aria-labelledby="accessible-clusters-heading">
            <h2 id="accessible-clusters-heading" className="text-xs font-semibold uppercase tracking-wide text-[var(--text-primary)]">
              Computed transient groups
            </h2>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Not saved domain state. {clusterProjection.settings.algorithm};
              {' '}resolution {clusterProjection.settings.resolution};
              {' '}minimum {clusterProjection.settings.minimumSize};
              {' '}outlier threshold {clusterProjection.settings.outlierThreshold};
              {' '}seed {clusterProjection.settings.seed}.
            </p>
            <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {clusterProjection.clusters.map((cluster) => (
                <li key={cluster.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: cluster.color }}
                      aria-hidden="true"
                    />
                    <h3 className="text-xs font-semibold text-[var(--text-primary)]">{cluster.label}</h3>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                    {cluster.explanation} Confidence {Math.round(cluster.confidence * 100)}%.
                  </p>
                  <div className="mt-2 flex gap-2">
                    {onClusterSelect ? (
                      <button
                        type="button"
                        onClick={() => onClusterSelect(cluster.id)}
                        className="text-xs font-semibold text-[var(--accent-400)] underline underline-offset-4"
                      >
                        Isolate {cluster.taskIds.length} tasks
                      </button>
                    ) : null}
                    {onClusterSave ? (
                      <button
                        type="button"
                        onClick={() => onClusterSave(cluster)}
                        className="text-xs font-semibold text-[var(--accent-400)] underline underline-offset-4"
                      >
                        Review & save
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
              <li className="rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
                {clusterProjection.outlierNodeIds.length} ungrouped task
                {clusterProjection.outlierNodeIds.length === 1 ? '' : 's'}
              </li>
            </ol>
          </section>
        ) : null}
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
                  <span className="mt-0.5 block capitalize text-xs text-[var(--text-tertiary)]">
                    {task.status.replaceAll('_', ' ')}
                  </span>
                </button>
                {graph.edges
                  .filter((edge): edge is SemanticSimilarityGraphEdge => (
                    edge.type === 'semantic-similarity'
                    && (universeEndpointId(edge.source) === task.id
                      || universeEndpointId(edge.target) === task.id)
                  ))
                  .map((edge) => (
                    <SemanticConnectionDetails
                      key={edge.id}
                      edge={edge}
                      graph={graph}
                      nodeId={task.id}
                    />
                  ))}
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
