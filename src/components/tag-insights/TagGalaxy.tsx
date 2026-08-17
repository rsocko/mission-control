'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import {
  forceCollide,
  forceManyBody,
  forceX,
  forceY,
  type ForceLink,
} from 'd3-force';
import { LocateFixed, X } from 'lucide-react';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import {
  buildTagGalaxyData,
  fitTagGalaxyDisplayName,
  getTagGalaxyCollisionRadius,
  getTagGalaxyColor,
  getTagGalaxyLod,
  getTagGalaxyNodeRadius,
  TAG_GALAXY_LINK_DISTANCE,
  type TagGalaxyLink,
  type TagGalaxyLod,
  type TagGalaxyNode,
} from '@/lib/tag-insights/galaxy';
import type { TagInsights } from '@/lib/tag-insights/types';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';

const TASK_PAGE_SIZE = 50;

function endpointId(endpoint: TagGalaxyLink['source'] | NodeObject<TagGalaxyNode> | undefined): string {
  if (typeof endpoint === 'string') return endpoint;
  return endpoint?.id ? String(endpoint.id) : '';
}

function useCanvasSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 480 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({
      width: Math.max(element.clientWidth, 1),
      height: Math.max(element.clientHeight, 480),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}

function taskIdsForSelection(
  node: TagGalaxyNode | null,
  link: TagGalaxyLink | null,
): string[] {
  return link?.taskIds ?? node?.taskIds ?? [];
}

export default function TagGalaxy({
  data,
  layoutKey,
}: {
  data: TagInsights;
  layoutKey?: string;
}) {
  const graph = useMemo(() => buildTagGalaxyData(data), [data]);
  const [lod, setLod] = useState<TagGalaxyLod>('labels');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLinkKey, setSelectedLinkKey] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [visibleTaskCount, setVisibleTaskCount] = useState(TASK_PAGE_SIZE);
  const hasInitialFitRef = useRef(false);
  const graphRef = useRef<ForceGraphMethods<
    NodeObject<TagGalaxyNode>,
    LinkObject<TagGalaxyNode, TagGalaxyLink>
  > | undefined>(undefined);
  const { ref: canvasRef, width, height } = useCanvasSize();
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedLink = graph.links.find((link) => link.key === selectedLinkKey) ?? null;
  const focusedNodeId = hoveredNodeId ?? selectedNodeId;
  const selectedTaskIds = taskIdsForSelection(selectedNode, selectedLink);
  const visibleTaskIds = selectedTaskIds.slice(0, visibleTaskCount);
  const selectedTagNames = selectedLink
    ? [selectedLink.sourceTagId, selectedLink.targetTagId]
        .map((id) => data.tags.find((tag) => tag.id === id)?.name)
        .filter(Boolean)
        .join(' + ')
    : selectedNode?.name ?? '';
  const emphasized = (() => {
    if (focusedNodeId) {
      const ids = new Set([focusedNodeId]);
      for (const link of graph.links) {
        if (endpointId(link.source) === focusedNodeId) ids.add(endpointId(link.target));
        if (endpointId(link.target) === focusedNodeId) ids.add(endpointId(link.source));
      }
      return ids;
    }
    if (selectedLink) return new Set([selectedLink.sourceTagId, selectedLink.targetTagId]);
    return null;
  })();

  useEffect(() => {
    hasInitialFitRef.current = false;
  }, [layoutKey]);

  useEffect(() => {
    const linkForce = graphRef.current?.d3Force('link') as
      | ForceLink<TagGalaxyNode, TagGalaxyLink>
      | undefined;
    linkForce?.distance(TAG_GALAXY_LINK_DISTANCE).strength(0.45);
    const collisionForce = forceCollide<TagGalaxyNode>()
      .radius(getTagGalaxyCollisionRadius)
      .strength(0.9)
      .iterations(2);

    graphRef.current?.d3Force(
      'charge',
      forceManyBody<TagGalaxyNode>().strength(-85).distanceMax(360),
    );
    graphRef.current?.d3Force('collision', collisionForce);
    graphRef.current?.d3Force('x', forceX<TagGalaxyNode>(0).strength(0.025));
    graphRef.current?.d3Force('y', forceY<TagGalaxyNode>(0).strength(0.025));
    graphRef.current?.d3ReheatSimulation();
  }, [graph]);

  const drawNode = (
    rawNode: NodeObject<TagGalaxyNode>,
    context: CanvasRenderingContext2D,
    scale: number,
  ) => {
    const node = rawNode;
    if (node.x === undefined || node.y === undefined) return;
    const color = getTagGalaxyColor(node);
    const radius = getTagGalaxyNodeRadius(node.taskCount);
    const dimmed = emphasized && !emphasized.has(node.id);
    context.save();
    context.globalAlpha = dimmed ? 0.16 : 1;
    context.beginPath();
    context.arc(node.x, node.y, radius + 7, 0, Math.PI * 2);
    context.fillStyle = `${color}18`;
    context.fill();
    context.beginPath();
    context.arc(node.x, node.y, radius, 0, Math.PI * 2);
    context.fillStyle = '#0f172a';
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = (selectedNodeId === node.id ? 3 : 1.5) / scale;
    context.stroke();
    if (lod !== 'overview' || node.taskCount === graph.nodes[0]?.taskCount) {
      context.fillStyle = color;
      context.font = `600 ${Math.max(9 / scale, 4)}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(
        fitTagGalaxyDisplayName(
          node.name,
          Math.max(radius * 2 - 4, 1),
          (label) => context.measureText(label).width,
        ),
        node.x,
        node.y - (lod === 'detail' ? 5 / scale : 0),
      );
    }
    if (lod === 'detail') {
      context.fillStyle = '#cbd5e1';
      context.font = `${Math.max(8 / scale, 3)}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(`${node.taskCount} tasks`, node.x, node.y + 8 / scale);
    }
    context.restore();
  };

  return (
    <div className="grid min-h-[34rem] lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div ref={canvasRef} className="relative min-h-[34rem] overflow-hidden bg-[#020617]">
        <p className="sr-only">
          Interactive tag galaxy with {graph.nodes.length} tags and {graph.links.length} relationships.
          Use the relationship list below for a keyboard-accessible alternative.
        </p>
        <div className="absolute left-3 top-3 z-10 rounded-full border border-[var(--border)] bg-[var(--surface-1)]/90 px-2 py-1 text-[10px] capitalize text-[var(--text-tertiary)]">
          {lod} detail
        </div>
        <div aria-hidden="true">
          <ForceGraph2D<TagGalaxyNode, TagGalaxyLink>
            ref={graphRef}
            width={width}
            height={height}
            graphData={graph}
            nodeId="id"
            linkSource="source"
            linkTarget="target"
            backgroundColor="#020617"
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={(node, color, context) => {
              if (node.x === undefined || node.y === undefined) return;
              context.fillStyle = color;
              context.beginPath();
              context.arc(node.x, node.y, Math.min(14 + Math.sqrt(node.taskCount) * 3, 38), 0, Math.PI * 2);
              context.fill();
            }}
            linkColor={(link: LinkObject<TagGalaxyNode, TagGalaxyLink>) => (
              selectedLinkKey === link.key
                ? '#f8fafc'
                : focusedNodeId && (
                    endpointId(link.source) === focusedNodeId
                    || endpointId(link.target) === focusedNodeId
                  )
                  ? '#60a5fa'
                  : '#94a3b8'
            )}
            linkWidth={(link: LinkObject<TagGalaxyNode, TagGalaxyLink>) => (
              selectedLinkKey === link.key ? 3 : Math.min(1.2 + Math.sqrt(link.count) * 0.55, 4)
            )}
            linkVisibility={(link: LinkObject<TagGalaxyNode, TagGalaxyLink>) => (
              lod !== 'overview'
              || !emphasized
              || emphasized.has(endpointId(link.source))
              || emphasized.has(endpointId(link.target))
            )}
            onNodeClick={(node) => {
              setSelectedNodeId(node.id);
              setSelectedLinkKey(null);
              setVisibleTaskCount(TASK_PAGE_SIZE);
            }}
            onNodeHover={(node) => setHoveredNodeId(node?.id ?? null)}
            onLinkClick={(link) => {
              setSelectedLinkKey(link.key);
              setSelectedNodeId(null);
              setVisibleTaskCount(TASK_PAGE_SIZE);
            }}
            onBackgroundClick={() => {
              setSelectedNodeId(null);
              setSelectedLinkKey(null);
            }}
            onZoom={({ k }) => setLod(getTagGalaxyLod(k))}
            onEngineStop={() => {
              if (!hasInitialFitRef.current) {
                hasInitialFitRef.current = true;
                graphRef.current?.zoomToFit(300, 56);
              }
            }}
            nodeLabel={(node) => `${node.name}: ${node.taskCount} tasks · click to inspect`}
            linkLabel={(link) => `${link.count} shared tasks`}
            d3AlphaDecay={0.025}
            d3VelocityDecay={0.32}
            cooldownTicks={180}
            minZoom={0.1}
            maxZoom={5}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setSelectedNodeId(null);
            setSelectedLinkKey(null);
            setLod('labels');
            graphRef.current?.zoomToFit(300, 40);
          }}
          className="absolute bottom-3 right-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] shadow-lg hover:bg-[var(--surface-2)]"
          aria-label="Reset galaxy focus"
          title="Reset galaxy focus"
        >
          <LocateFixed size={15} />
        </button>
      </div>

      <aside className="border-t border-[var(--border)] bg-[var(--surface-0)] p-4 lg:border-l lg:border-t-0" aria-live="polite">
        {selectedNode || selectedLink ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{selectedLink ? 'Shared tasks' : 'Tagged tasks'}</h2>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">{selectedTagNames}</p>
              </div>
              <button
                type="button"
                aria-label="Close galaxy selection"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedLinkKey(null);
                }}
                className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {selectedTaskIds.length} matching {selectedTaskIds.length === 1 ? 'task' : 'tasks'}
            </p>
            <ol className="mt-2 space-y-2">
              {visibleTaskIds.map((taskId) => {
                const task = data.tasks[taskId];
                if (!task) return null;
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-left hover:border-[var(--accent-500)]"
                    >
                      <span className="block text-sm font-medium">{task.title}</span>
                      <span className="mt-1 block text-xs capitalize text-[var(--text-muted)]">
                        {task.status.replaceAll('_', ' ')}
                      </span>
                    </button>
                    <a
                      href={`/?taskId=${encodeURIComponent(task.id)}`}
                      className="mt-1 inline-block text-xs text-[var(--accent-300)] hover:underline"
                    >
                      Open exact task
                    </a>
                  </li>
                );
              })}
            </ol>
            {visibleTaskIds.length < selectedTaskIds.length ? (
              <button
                type="button"
                onClick={() => setVisibleTaskCount((count) => count + TASK_PAGE_SIZE)}
                className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:border-[var(--accent-500)] hover:text-[var(--text-primary)]"
              >
                Show next {Math.min(TASK_PAGE_SIZE, selectedTaskIds.length - visibleTaskIds.length)} tasks
              </button>
            ) : null}
          </>
        ) : (
          <div className="flex h-full min-h-36 flex-col items-center justify-center text-center">
            <p className="text-sm font-medium">Explore tag relationships</p>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Hover to highlight a cluster. Select a tag or edge to reveal exact tasks.
            </p>
          </div>
        )}
      </aside>

      {selectedTaskId ? (
        <div className="fixed inset-y-0 right-0 z-50 w-[min(390px,95%)] overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-1)] shadow-2xl">
          <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} mode="panel" />
        </div>
      ) : null}

      <details className="border-t border-[var(--border)] bg-[var(--surface-0)] p-4 lg:col-span-2">
        <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)]">
          Accessible tags and relationships ({graph.nodes.length} tags, {graph.links.length} relationships)
        </summary>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Tags
        </h3>
        <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {graph.nodes.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedNodeId(node.id);
                  setSelectedLinkKey(null);
                  setLod('detail');
                  setVisibleTaskCount(TASK_PAGE_SIZE);
                }}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-xs hover:border-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
              >
                <span className="font-medium">{node.name}</span>
                <span className="ml-2 text-[var(--text-tertiary)]">
                  {node.taskCount} tagged {node.taskCount === 1 ? 'task' : 'tasks'}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Relationships
        </h3>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {graph.links.map((link) => {
            const source = data.tags.find((tag) => tag.id === link.sourceTagId);
            const target = data.tags.find((tag) => tag.id === link.targetTagId);
            return (
              <li key={link.key}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLinkKey(link.key);
                    setSelectedNodeId(null);
                    setLod('detail');
                    setVisibleTaskCount(TASK_PAGE_SIZE);
                  }}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left text-xs hover:border-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]"
                >
                  <span className="font-medium">{source?.name} + {target?.name}</span>
                  <span className="ml-2 text-[var(--text-tertiary)]">
                    {link.count} shared {link.count === 1 ? 'task' : 'tasks'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}
