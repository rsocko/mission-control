'use client';

import { useState, type RefObject } from 'react';
import { CircleDot, Eye, Expand, HelpCircle, LoaderCircle, Maximize2, Network, Tag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  UNIVERSE_DIMENSION_COLORS,
  UNIVERSE_DIMENSION_ICONS,
  UNIVERSE_DIMENSION_LABELS,
  UNIVERSE_DIMENSIONS,
  type UniverseDimension,
  type UniverseNode,
  type UniverseSubgraph,
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

export function GraphLegend() {
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

export function AccessibleUniverseList({
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
