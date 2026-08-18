import { describe, expect, it } from 'vitest';
import {
  createProjectStructureFlowModel,
  toProjectStructureFlowEdge,
} from '@/lib/graph/project-structure-layout';
import type { ProjectSubgraph } from '@/lib/graph/types';

const graph: ProjectSubgraph = {
  nodes: [
    { id: 'project:p', entityId: 'p', kind: 'project', label: 'Project', status: 'todo' },
    { id: 'phase:a', entityId: 'a', kind: 'phase', label: 'Phase', status: 'todo' },
    { id: 'task:1', entityId: '1', kind: 'task', label: 'First', status: 'todo' },
    { id: 'task:2', entityId: '2', kind: 'task', label: 'Second', status: 'todo' },
  ],
  edges: [
    { id: 'p-a', source: 'project:p', target: 'phase:a', type: 'contains', provenance: 'derived' },
    { id: 'a-1', source: 'phase:a', target: 'task:1', type: 'contains', provenance: 'derived' },
    { id: 'dep', source: 'task:1', target: 'task:2', type: 'blocks', provenance: 'explicit', syncStatus: 'failed' },
  ],
  truncated: false,
};

describe('project structure layout transformations', () => {
  it('filters collapsed tasks and dangling edges before layout', () => {
    const result = createProjectStructureFlowModel(graph, {
      direction: 'horizontal',
      lineStyle: 'orthogonal',
      showDependencies: true,
      visibleKinds: { project: true, phase: true, task: true },
      collapsedPhaseIds: new Set(['phase:a']),
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['project:p', 'phase:a', 'task:2']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['p-a']);
    expect(result.nodes.find((node) => node.id === 'phase:a')).toMatchObject({
      canCollapse: true,
      isCollapsed: true,
    });
  });

  it('creates accessible failed dependency geometry without browser APIs', () => {
    const edge = toProjectStructureFlowEdge(
      graph.edges[2],
      'curved',
      new Map([['task:1', 'First'], ['task:2', 'Second']]),
    );

    expect(edge).toMatchObject({
      type: 'bezier',
      animated: false,
      markerEnd: { color: 'var(--danger)' },
      ariaLabel: 'First blocks Second, Source sync failed',
      style: { stroke: 'var(--danger)', strokeWidth: 2 },
    });
  });
});
