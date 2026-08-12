import { describe, expect, it } from 'vitest';
import {
  GRAPH_NODE_DIMENSIONS,
  layoutProjectHierarchy,
} from '@/lib/graph/layout';
import type { ProjectSubgraph } from '@/lib/graph/types';

const graph: ProjectSubgraph = {
  nodes: [
    { id: 'project:p', entityId: 'p', kind: 'project', label: 'Project', status: 'todo' },
    { id: 'phase:a', entityId: 'a', kind: 'phase', label: 'Phase A', status: 'todo' },
    { id: 'phase:b', entityId: 'b', kind: 'phase', label: 'Phase B', status: 'todo' },
    { id: 'task:1', entityId: '1', kind: 'task', label: 'Task 1', status: 'todo' },
    { id: 'task:2', entityId: '2', kind: 'task', label: 'Task 2', status: 'todo' },
    { id: 'task:3', entityId: '3', kind: 'task', label: 'Unassigned task', status: 'todo' },
  ],
  edges: [
    { id: 'pa', source: 'project:p', target: 'phase:a', type: 'contains', provenance: 'derived' },
    { id: 'pb', source: 'project:p', target: 'phase:b', type: 'contains', provenance: 'derived' },
    { id: 'a1', source: 'phase:a', target: 'task:1', type: 'contains', provenance: 'derived' },
    { id: 'b2', source: 'phase:b', target: 'task:2', type: 'contains', provenance: 'derived' },
    { id: 'p3', source: 'project:p', target: 'task:3', type: 'contains', provenance: 'derived' },
    { id: 'phase-dependency', source: 'phase:a', target: 'phase:b', type: 'blocks', provenance: 'explicit' },
    { id: 'task-dependency', source: 'task:1', target: 'task:2', type: 'related', provenance: 'explicit' },
  ],
  truncated: false,
};

describe('layoutProjectHierarchy', () => {
  it('keeps horizontal hierarchy kinds in columns without overlapping peers', () => {
    const positions = layoutProjectHierarchy(graph);
    const project = positions.get('project:p')!;
    const phaseA = positions.get('phase:a')!;
    const phaseB = positions.get('phase:b')!;
    const task1 = positions.get('task:1')!;
    const task2 = positions.get('task:2')!;
    const task3 = positions.get('task:3')!;

    expect(phaseA.x).toBe(phaseB.x);
    expect(task1.x).toBe(task2.x);
    expect(task2.x).toBe(task3.x);
    expect(project.x).toBeLessThan(phaseA.x);
    expect(phaseA.x).toBeLessThan(task1.x);
    expect(Math.abs(phaseA.y - phaseB.y)).toBeGreaterThanOrEqual(
      GRAPH_NODE_DIMENSIONS.phase.height,
    );
    expect(Math.abs(task1.y - task2.y)).toBeGreaterThanOrEqual(
      GRAPH_NODE_DIMENSIONS.task.height,
    );
  });

  it('keeps vertical hierarchy kinds in rows without overlapping peers', () => {
    const positions = layoutProjectHierarchy(graph, 'vertical');
    const project = positions.get('project:p')!;
    const phaseA = positions.get('phase:a')!;
    const phaseB = positions.get('phase:b')!;
    const task1 = positions.get('task:1')!;
    const task2 = positions.get('task:2')!;

    expect(phaseA.y).toBe(phaseB.y);
    expect(task1.y).toBe(task2.y);
    expect(project.y).toBeLessThan(phaseA.y);
    expect(phaseA.y).toBeLessThan(task1.y);
    expect(Math.abs(phaseA.x - phaseB.x)).toBeGreaterThanOrEqual(
      GRAPH_NODE_DIMENSIONS.phase.width,
    );
  });

  it('packs dense phase tasks into a maximum of three columns', () => {
    const denseGraph: ProjectSubgraph = {
      nodes: [
        graph.nodes[0],
        graph.nodes[1],
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `task:${index}`,
          entityId: String(index),
          kind: 'task' as const,
          label: `Task ${index}`,
          status: 'todo' as const,
        })),
      ],
      edges: [
        graph.edges[0],
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `contains:${index}`,
          source: 'phase:a',
          target: `task:${index}`,
          type: 'contains' as const,
          provenance: 'derived' as const,
        })),
      ],
      truncated: false,
    };

    for (const direction of ['horizontal', 'vertical'] as const) {
      const positions = layoutProjectHierarchy(denseGraph, direction);
      const taskPositions = denseGraph.nodes
        .filter((node) => node.kind === 'task')
        .map((node) => positions.get(node.id)!);

      expect(new Set(taskPositions.map((position) => position.x)).size).toBe(3);
      expect(new Set(taskPositions.map((position) => position.y)).size).toBe(4);
    }
  });

  it('is deterministic and ignores relationship edges when positioning nodes', () => {
    const hierarchyOnly = {
      ...graph,
      edges: graph.edges.filter((edge) => edge.type === 'contains'),
    };

    for (const direction of ['horizontal', 'vertical'] as const) {
      expect(layoutProjectHierarchy(graph, direction)).toEqual(
        layoutProjectHierarchy(hierarchyOnly, direction),
      );
      expect(layoutProjectHierarchy(graph, direction)).toEqual(
        layoutProjectHierarchy(graph, direction),
      );
    }
  });
});
