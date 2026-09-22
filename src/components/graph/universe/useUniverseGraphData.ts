'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collectUniversePositions,
  pinPositionedUniverseNodes,
  positionUniverseGraph,
  type UniversePosition,
} from '@/lib/graph/universe-geometry';
import { mergeUniverseSubgraph } from '@/lib/graph/universe-subgraph';
import type {
  UniverseDimension,
  UniverseNeighborLayer,
  UniverseNode,
  UniverseSemanticState,
  UniverseSubgraph,
} from '@/lib/graph/universe-types';
import type { GraphSubgraph } from '@/lib/graph/types';

const MAX_UNIVERSE_NODES = 500;
const MAX_EXPANSION_NODES = 10;
export const MAX_UNIVERSE_EXPANSION_HOPS = 2;
const universePositionCache = new Map<string, UniversePosition>();

type UseUniverseGraphDataOptions = {
  shouldLoad: boolean;
  canonicalQuery: string;
  reloadKey: number;
  dimensions: UniverseDimension[];
  neighborLayers: UniverseNeighborLayer[];
  onCanonicalLoad: () => void;
  debounceMs?: number;
};

export function useUniverseGraphData({
  shouldLoad,
  canonicalQuery,
  reloadKey,
  dimensions,
  neighborLayers = ['explicit', 'derived'],
  onCanonicalLoad,
  debounceMs = 250,
}: UseUniverseGraphDataOptions) {
  const [graph, setGraph] = useState<UniverseSubgraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [explorationMessage, setExplorationMessage] = useState<string | null>(null);
  const [explorationError, setExplorationError] = useState<string | null>(null);
  const [semanticOutcomes, setSemanticOutcomes] = useState<Array<{
    nodeId: string;
    status: UniverseSemanticState;
    note?: string;
  }>>([]);
  const [nodeHops, setNodeHops] = useState<Record<string, number>>({});
  const canonicalGenerationRef = useRef(0);
  const expansionControllerRef = useRef<AbortController | null>(null);
  const expansionPinnedNodesRef = useRef<UniverseNode[]>([]);
  const onCanonicalLoadRef = useRef(onCanonicalLoad);

  useEffect(() => {
    onCanonicalLoadRef.current = onCanonicalLoad;
  }, [onCanonicalLoad]);

  useEffect(() => {
    canonicalGenerationRef.current += 1;
    expansionControllerRef.current?.abort();
    if (!shouldLoad) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/graph/universe?${canonicalQuery}`,
          { signal: controller.signal },
        );
        const result: { graph?: UniverseSubgraph; error?: string } = await response.json();
        if (!response.ok || !result.graph) {
          throw new Error(result.error ?? 'Failed to load graph');
        }
        expansionPinnedNodesRef.current = [];
        onCanonicalLoadRef.current();
        setExplorationMessage(null);
        setExplorationError(null);
        setSemanticOutcomes([]);
        setNodeHops(Object.fromEntries(result.graph.nodes.map((node) => [node.id, 0])));
        setGraph(positionUniverseGraph(result.graph, universePositionCache));
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load graph');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canonicalQuery, debounceMs, reloadKey, shouldLoad]);

  useEffect(() => () => expansionControllerRef.current?.abort(), []);

  const rememberPositions = useCallback((nodes: UniverseNode[]) => {
    collectUniversePositions(nodes, universePositionCache);
  }, []);

  const expandSelection = useCallback(async (selectedNodes: UniverseNode[]) => {
    if (!graph || expanding) return;
    if (!neighborLayers.length) {
      setExplorationMessage('Choose at least one neighbor layer before expanding.');
      return;
    }
    const expandableNodes = selectedNodes.filter(
      (node) => (nodeHops[node.id] ?? 0) < MAX_UNIVERSE_EXPANSION_HOPS,
    );
    const allNodeIds = expandableNodes.map((node) => node.id);
    const nodeIds = allNodeIds.slice(0, MAX_EXPANSION_NODES);
    if (!nodeIds.length) {
      setExplorationMessage(`The selected nodes reached the ${MAX_UNIVERSE_EXPANSION_HOPS}-hop limit.`);
      return;
    }
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
          include: neighborLayers.join(','),
          maxNodes: '80',
          maxEdges: '240',
          semanticTopK: '10',
        });
        const response = await fetch(
          `/api/graph/nodes/${encodeURIComponent(nodeId)}/neighbors?${params}`,
          { signal: controller.signal },
        );
        const result: {
          graph?: GraphSubgraph & {
            centerNodeId?: string;
            semantic?: {
              requested: boolean;
              status: UniverseSemanticState;
              note?: string;
            };
          };
          error?: string;
        } = await response.json();
        if (!response.ok || !result.graph) {
          throw new Error(result.error ?? `Failed to expand ${nodeId}`);
        }
        return { nodeId, graph: result.graph };
      }));
      if (
        controller.signal.aborted
        || generation !== canonicalGenerationRef.current
        || expansionControllerRef.current !== controller
      ) return;
      rememberPositions(graph.nodes);
      const responses = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []);
      const failedCount = results.length - responses.length;
      if (!responses.length) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        throw firstFailure?.status === 'rejected' && firstFailure.reason instanceof Error
          ? firstFailure.reason
          : new Error('Failed to expand selected nodes');
      }
      let merged = { ...graph, nodes: pinPositionedUniverseNodes(graph.nodes) };
      let droppedNodes = 0;
      let droppedEdges = 0;
      const nextHops = { ...nodeHops };
      for (const response of responses) {
        const sourceHop = nodeHops[response.nodeId] ?? 0;
        for (const node of response.graph.nodes) {
          if (node.id !== response.nodeId) {
            nextHops[node.id] = Math.min(
              nextHops[node.id] ?? Number.POSITIVE_INFINITY,
              sourceHop + 1,
            );
          }
        }
        const result = mergeUniverseSubgraph(merged, response.graph, {
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
        const positioned = positionUniverseGraph(merged, universePositionCache);
        expansionPinnedNodesRef.current = positioned.nodes.filter((node) =>
          existingNodeIds.has(node.id));
        setGraph(positioned);
      }
      setNodeHops(nextHops);
      setSemanticOutcomes(responses.flatMap(({ nodeId, graph: responseGraph }) =>
        responseGraph.semantic?.requested
          ? [{
              nodeId,
              status: responseGraph.semantic.status,
              ...(responseGraph.semantic.note ? { note: responseGraph.semantic.note } : {}),
            }]
          : []));
      const truncated = responses.some(({ graph: responseGraph }) => responseGraph.truncated);
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
  }, [dimensions, expanding, graph, neighborLayers, nodeHops, rememberPositions]);

  return {
    graph,
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
  };
}
