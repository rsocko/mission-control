import { describe, expect, it } from 'vitest';
import {
  collectUniversePositions,
  connectedUniverseNodes,
  emphasizedUniverseNodeIds,
  matchingUniverseNodeIds,
  pinPositionedUniverseNodes,
  positionUniverseGraph,
  universeEndpointId,
  universeFitTransform,
  universeLodForZoom,
  universeNeighborhood,
  universeTooltipPosition,
  visibleUniverseGraph,
} from '@/lib/graph/universe-geometry';
import type { UniverseSubgraph } from '@/lib/graph/universe-types';

function graph(): UniverseSubgraph {
  return {
    nodes: [
      { id: 'task:1', entityId: '1', kind: 'task', label: 'Alpha task', status: 'todo', color: 'var(--text-primary)' },
      { id: 'task:2', entityId: '2', kind: 'task', label: 'Beta task', status: 'todo', color: 'var(--text-primary)' },
      {
        id: 'tag:x',
        entityId: 'x',
        kind: 'tag',
        dimension: 'tags',
        value: 'x',
        label: 'Graph',
        color: 'var(--accent-500)',
        taskCount: 2,
      },
    ],
    edges: [
      { id: 'e1', source: 'task:1', target: 'tag:x', type: 'has-tag', provenance: 'derived' },
      { id: 'e2', source: 'task:2', target: 'tag:x', type: 'has-tag', provenance: 'derived' },
    ],
    stats: { taskCount: 2, filteredTaskCount: 2, attributeCount: 1 },
    facets: { priorities: [], statuses: [], sources: [], lists: [] },
    pageInfo: {
      nodeLimit: 10,
      edgeLimit: 10,
      returnedNodes: 3,
      returnedEdges: 2,
      truncated: false,
      truncationReasons: [],
    },
    truncated: false,
  };
}

describe('universe graph geometry', () => {
  it('normalizes force-graph endpoints and finds direct connections', () => {
    const input = graph();
    input.edges[0].target = { id: 'tag:x' } as never;

    expect(universeEndpointId(input.edges[0].target)).toBe('tag:x');
    expect(connectedUniverseNodes(input, 'task:1').map((node) => node.id)).toEqual(['tag:x']);
    expect([...universeNeighborhood(input, ['tag:x'])]).toEqual([
      'tag:x',
      'task:1',
      'task:2',
    ]);
  });

  it('positions copies from cached or deterministic coordinates and pins positioned nodes', () => {
    const input = graph();
    input.nodes[0].x = 12;
    input.nodes[0].y = 24;
    const positions = collectUniversePositions(input.nodes);
    const positioned = positionUniverseGraph(graph(), positions);
    const pinned = pinPositionedUniverseNodes(positioned.nodes);

    expect(positioned).not.toBe(input);
    expect(positioned.nodes[0]).toMatchObject({ x: 12, y: 24 });
    expect(positioned.nodes[1].x).toEqual(expect.any(Number));
    expect(pinned[0]).toMatchObject({ fx: 12, fy: 24 });
  });

  it('filters nodes and dangling edges while updating visible counts', () => {
    const visible = visibleUniverseGraph(graph(), ['task:2']);

    expect(visible?.nodes.map((node) => node.id)).toEqual(['task:1', 'tag:x']);
    expect(visible?.edges.map((edge) => edge.id)).toEqual(['e1']);
    expect(visible?.stats).toMatchObject({ taskCount: 1, attributeCount: 1 });
    expect(visible?.pageInfo).toMatchObject({ returnedNodes: 2, returnedEdges: 1 });
  });

  it('derives search and neighborhood emphasis sets', () => {
    const input = graph();
    expect([...matchingUniverseNodeIds(input, ' beta ')!]).toEqual(['task:2']);
    expect([...emphasizedUniverseNodeIds(input, ['task:1'], null)!]).toEqual([
      'task:1',
      'tag:x',
    ]);
  });

  it('keeps tooltips inside the viewport and flips them left near the right edge', () => {
    expect(universeTooltipPosition({
      anchor: { x: 290, y: 5 },
      viewportWidth: 320,
      viewportHeight: 200,
      tooltipWidth: 100,
      tooltipHeight: 80,
    })).toEqual({ x: 176, y: 8 });
  });

  it('derives bounded camera transforms and level of detail', () => {
    expect(universeFitTransform({
      bounds: { x: [20, 80], y: [30, 70] },
      viewportWidth: 400,
      viewportHeight: 300,
    })).toEqual({ x: 50, y: 50, zoom: 4.7 });
    expect(universeLodForZoom(0.4)).toBe('far');
    expect(universeLodForZoom(0.8)).toBe('medium');
    expect(universeLodForZoom(2)).toBe('close');
  });
});
