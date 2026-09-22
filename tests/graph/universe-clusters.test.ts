import { describe, expect, it } from 'vitest';
import {
  clusterUniverseGraph,
  DEFAULT_UNIVERSE_CLUSTER_SETTINGS,
  filterUniverseGraphToCluster,
} from '@/lib/graph/universe-clusters';
import type { UniverseEdge, UniverseNode } from '@/lib/graph/universe-types';

function task(id: string, label: string): UniverseNode {
  return {
    id: `task:${id}`,
    entityId: id,
    kind: 'task',
    label,
    color: 'var(--text-primary)',
    status: 'todo',
  };
}

function semantic(left: string, right: string, score: number): UniverseEdge {
  return {
    id: `semantic:${left}:${right}`,
    source: `task:${left}`,
    target: `task:${right}`,
    type: 'semantic-similarity',
    provenance: 'embedding',
    score,
    explanation: 'fixture',
    embedding: {
      provider: 'fixture',
      model: 'fixture',
      indexId: 'fixture',
      targetEmbeddedAt: '2030-01-01T00:00:00.000Z',
    },
  };
}

const nodes = [
  task('a', 'Release deployment checklist'),
  task('b', 'Deployment release notes'),
  task('c', 'Refactor authentication middleware'),
  task('d', 'Authentication audit logging'),
  task('e', 'Buy printer filament'),
];
const edges = [
  semantic('a', 'b', 0.91),
  semantic('c', 'd', 0.84),
  semantic('b', 'c', 0.55),
];

describe('clusterUniverseGraph', () => {
  it('produces fixed memberships, labels, confidence, and IDs for fixed inputs and settings', () => {
    const first = clusterUniverseGraph({ nodes, edges });
    const second = clusterUniverseGraph({
      nodes: nodes.slice().reverse(),
      edges: edges.slice().reverse(),
    });

    expect(second).toEqual(first);
    expect(first.clusters.map((cluster) => cluster.taskIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(first.clusters[0]).toMatchObject({
      label: 'Release + Deployment',
      confidence: 0.91,
    });
    expect(first.outlierNodeIds).toEqual(['task:e']);
    expect(first.settings).toEqual(DEFAULT_UNIVERSE_CLUSTER_SETTINGS);
  });

  it('handles empty, small, and low-confidence projections as outliers', () => {
    expect(clusterUniverseGraph({ nodes: [], edges: [] })).toMatchObject({
      clusters: [],
      outlierNodeIds: [],
    });

    expect(clusterUniverseGraph({
      nodes: [task('solo', 'Solo')],
      edges: [],
    })).toMatchObject({
      clusters: [],
      outlierNodeIds: ['task:solo'],
    });
    expect(clusterUniverseGraph({
      nodes: [task('a', 'Alpha'), task('b', 'Beta')],
      edges: [semantic('a', 'b', 0.7)],
    }, { resolution: 0.6, outlierThreshold: 0.8 })).toMatchObject({
      clusters: [],
      outlierNodeIds: ['task:a', 'task:b'],
    });
  });

  it('falls back to a representative label when members share no title terms', () => {
    const projection = clusterUniverseGraph({
      nodes: [task('alpha', 'Prepare launch'), task('beta', 'Review invoices')],
      edges: [semantic('alpha', 'beta', 0.9)],
    });

    expect(projection.clusters[0]?.terms).toEqual([]);
    expect(projection.clusters[0]?.explanation).not.toContain('Shared terms');
  });

  it('does not mutate canonical graph state and can recompute without changing a saved snapshot', () => {
    const graph = { nodes, edges };
    const before = structuredClone(graph);
    const initial = clusterUniverseGraph(graph);
    const savedMembership = initial.clusters[0].taskIds.slice();
    const recomputed = clusterUniverseGraph({
      nodes,
      edges: edges.map((edge) =>
        edge.id === 'semantic:a:b' ? semantic('a', 'b', 0.4) : edge),
    });

    expect(graph).toEqual(before);
    expect(recomputed.clusters.map((cluster) => cluster.taskIds)).not.toContainEqual(savedMembership);
    expect(savedMembership).toEqual(['a', 'b']);
  });

  it('rejects invalid declared settings', () => {
    expect(() => clusterUniverseGraph({ nodes, edges }, { resolution: 2 }))
      .toThrow('resolution');
    expect(() => clusterUniverseGraph({ nodes, edges }, { minimumSize: 1 }))
      .toThrow('minimum size');
  });

  it('isolates cluster tasks with only their connected authorized attributes', () => {
    const graph = {
      nodes: [
        ...nodes,
        {
          id: 'tag:release',
          entityId: 'release',
          kind: 'tag' as const,
          dimension: 'tags' as const,
          value: 'release',
          label: 'Release',
          color: 'var(--accent-500)',
          taskCount: 2,
        },
        {
          id: 'tag:personal',
          entityId: 'personal',
          kind: 'tag' as const,
          dimension: 'tags' as const,
          value: 'personal',
          label: 'Personal',
          color: 'var(--accent-500)',
          taskCount: 1,
        },
      ],
      edges: [
        ...edges,
        {
          id: 'tag-a',
          source: 'task:a',
          target: 'tag:release',
          type: 'has-tag' as const,
          provenance: 'derived' as const,
        },
        {
          id: 'tag-e',
          source: 'task:e',
          target: 'tag:personal',
          type: 'has-tag' as const,
          provenance: 'derived' as const,
        },
      ],
      stats: { taskCount: 5, filteredTaskCount: 5, attributeCount: 2 },
      facets: { priorities: [], statuses: [], sources: [], lists: [] },
      pageInfo: {
        nodeLimit: 10,
        edgeLimit: 10,
        returnedNodes: 7,
        returnedEdges: 5,
        truncated: false,
        truncationReasons: [],
      },
      truncated: false,
    };

    expect(filterUniverseGraphToCluster(graph, ['task:a', 'task:b']).nodes.map((node) => node.id))
      .toEqual(['task:a', 'task:b', 'tag:release']);
  });
});
