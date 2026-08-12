import { describe, expect, it, vi } from 'vitest';
import { layoutGraph } from '@/components/graph/ProjectStructureGraph';
import type { ProjectSubgraph } from '@/lib/graph/types';

const graph: ProjectSubgraph = {
  nodes: [
    { id: 'project:p', entityId: 'p', kind: 'project', label: 'Project', status: 'todo' },
    { id: 'phase:a', entityId: 'a', kind: 'phase', label: 'Phase A', status: 'todo' },
    { id: 'phase:b', entityId: 'b', kind: 'phase', label: 'Phase B', status: 'todo' },
    { id: 'task:1', entityId: '1', kind: 'task', label: 'Task 1', status: 'todo' },
    { id: 'task:2', entityId: '2', kind: 'task', label: 'Task 2', status: 'todo' },
  ],
  edges: [
    { id: 'pa', source: 'project:p', target: 'phase:a', type: 'contains', provenance: 'derived' },
    { id: 'pb', source: 'project:p', target: 'phase:b', type: 'contains', provenance: 'derived' },
    { id: 'a1', source: 'phase:a', target: 'task:1', type: 'contains', provenance: 'derived' },
    { id: 'b2', source: 'phase:b', target: 'task:2', type: 'contains', provenance: 'derived' },
    { id: 'dependency', source: 'task:1', target: 'task:2', type: 'blocks', provenance: 'explicit' },
  ],
  truncated: false,
};

const allKinds = { project: true, phase: true, task: true };

describe('project graph display states', () => {
  it('collapses only the tasks belonging to the selected phase', () => {
    const result = layoutGraph(graph, vi.fn(), vi.fn(), {
      direction: 'horizontal',
      lineStyle: 'orthogonal',
      showDependencies: true,
      visibleKinds: allKinds,
      collapsedPhaseIds: new Set(['phase:a']),
    });

    expect(result.nodes.map((node) => node.id)).not.toContain('task:1');
    expect(result.nodes.map((node) => node.id)).toContain('task:2');
    expect(result.edges.some((edge) => edge.id === 'dependency')).toBe(false);
    expect(result.nodes.find((node) => node.id === 'phase:a')?.data.isCollapsed).toBe(true);
  });

  it('filters node kinds and dependency lines independently', () => {
    const result = layoutGraph(graph, vi.fn(), vi.fn(), {
      direction: 'vertical',
      lineStyle: 'curved',
      showDependencies: false,
      visibleKinds: { ...allKinds, project: false },
      collapsedPhaseIds: new Set(),
    });

    expect(result.nodes.map((node) => node.id)).not.toContain('project:p');
    expect(result.nodes).toHaveLength(4);
    expect(result.edges.map((edge) => edge.id)).toEqual(['a1', 'b2']);
    expect(result.edges.every((edge) => edge.type === 'bezier')).toBe(true);
  });
});
