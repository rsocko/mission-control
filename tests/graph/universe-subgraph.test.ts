import { describe, expect, it } from 'vitest';
import {
  buildUniverseSubgraph,
  mergeUniverseSubgraph,
} from '@/lib/graph/universe-subgraph';
import type { UniverseTaskRecord } from '@/lib/graph/universe-types';

const tasks: UniverseTaskRecord[] = [
  {
    id: 'task-1',
    title: 'First task',
    priority: 'high',
    status: 'todo',
    connectorType: 'github-issues',
    connectorInstanceId: 'github',
    sourceListId: 'repo-1',
    sourceListName: 'Mission Control',
    effort: 3,
  },
  {
    id: 'task-2',
    title: 'Second task',
    priority: 'high',
    status: 'in_progress',
    connectorType: 'local',
    connectorInstanceId: 'local',
    sourceListId: null,
    sourceListName: null,
    effort: null,
  },
];

describe('buildUniverseSubgraph', () => {
  it('creates shared attribute nodes and typed edges', () => {
    const graph = buildUniverseSubgraph({
      tasks,
      tags: [
        { taskId: 'task-1', id: 'tag-graph', name: 'Graph', color: '#22c55e' },
        { taskId: 'task-2', id: 'tag-graph', name: 'Graph', color: '#22c55e' },
      ],
      projects: [],
      dimensions: ['priority', 'tags'],
      maxNodes: 20,
    });

    expect(graph.stats).toEqual({
      taskCount: 2,
      filteredTaskCount: 2,
      attributeCount: 2,
    });
    expect(graph.nodes.find((node) => node.id === 'property:priority:high')?.taskCount).toBe(2);
    expect(graph.nodes.find((node) => node.id === 'tag:tag-graph')?.taskCount).toBe(2);
    expect(graph.edges).toHaveLength(4);
  });

  it('only projects active dimensions', () => {
    const graph = buildUniverseSubgraph({
      tasks,
      tags: [],
      projects: [],
      dimensions: ['status'],
      maxNodes: 20,
    });

    expect(graph.nodes.some((node) =>
      node.kind === 'property' && node.dimension === 'priority')).toBe(false);
    expect(graph.nodes.filter((node) =>
      node.kind === 'property' && node.dimension === 'status')).toHaveLength(2);
  });

  it('uses provider-specific source colors', () => {
    const graph = buildUniverseSubgraph({
      tasks,
      tags: [],
      projects: [],
      dimensions: ['source'],
      maxNodes: 20,
    });

    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'property:source:github-issues',
      color: '#c084fc',
    }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'property:source:local',
      color: '#94a3b8',
    }));
  });

  it('uses canonical project identities and containment semantics', () => {
    const graph = buildUniverseSubgraph({
      tasks: [tasks[0]],
      tags: [],
      projects: [{
        taskId: 'task-1',
        id: 'project-1',
        name: 'Mission Control',
        color: '#3b82f6',
        status: 'active',
      }],
      dimensions: ['project'],
      maxNodes: 20,
    });

    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'project:project-1',
      kind: 'project',
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: 'project:project-1',
      target: 'task:task-1',
      type: 'contains',
      provenance: 'derived',
      dimension: 'project',
    }));
  });

  it('enforces a total node budget and removes dangling edges', () => {
    const graph = buildUniverseSubgraph({
      tasks,
      tags: [],
      projects: [],
      dimensions: ['priority', 'status', 'source', 'list', 'effort'],
      maxNodes: 4,
    });

    expect(graph.nodes.length).toBeLessThanOrEqual(4);
    expect(graph.truncated).toBe(true);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) =>
      nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true);
  });

  it('admits tasks atomically under the edge budget', () => {
    const graph = buildUniverseSubgraph({
      tasks,
      tags: [],
      projects: [],
      dimensions: ['priority', 'status'],
      maxNodes: 20,
      maxEdges: 2,
    });

    const taskNodes = graph.nodes.filter((node) => node.kind === 'task');
    expect(taskNodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(2);
    expect(graph.pageInfo.truncationReasons).toContain('edge-limit');
    expect(graph.edges.every((edge) =>
      edge.source === taskNodes[0].id || edge.target === taskNodes[0].id)).toBe(true);
  });

  it('projects effort zero with the canonical property label', () => {
    const graph = buildUniverseSubgraph({
      tasks: [{ ...tasks[0], effort: 0 }],
      tags: [],
      projects: [],
      dimensions: ['effort'],
      maxNodes: 20,
    });

    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'property:effort:0',
      label: 'Effort 0',
    }));
  });

  it('budgets an effort-zero task and property atomically', () => {
    const graph = buildUniverseSubgraph({
      tasks: [{ ...tasks[0], effort: 0 }],
      tags: [],
      projects: [],
      dimensions: ['effort'],
      maxNodes: 1,
    });

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.stats).toMatchObject({ taskCount: 0, attributeCount: 0 });
    expect(graph.pageInfo.truncationReasons).toContain('node-limit');
  });
});

describe('mergeUniverseSubgraph', () => {
  it('merges supported neighbors by stable ID without replacing positioned nodes', () => {
    const current = buildUniverseSubgraph({
      tasks: [tasks[0]],
      tags: [],
      projects: [],
      dimensions: ['priority'],
      maxNodes: 20,
    });
    current.nodes[0].x = 123;
    current.nodes[0].y = 456;

    const { graph: merged } = mergeUniverseSubgraph(current, {
      nodes: [
        {
          id: 'task:task-1',
          entityId: 'task-1',
          kind: 'task',
          label: 'Changed title must not replace canonical data',
          status: 'todo',
        },
        {
          id: 'task:task-2',
          entityId: 'task-2',
          kind: 'task',
          label: 'Second task',
          status: 'in_progress',
        },
        {
          id: 'phase:ignored',
          entityId: 'ignored',
          kind: 'phase',
          label: 'Unsupported phase',
          status: 'todo',
        },
      ],
      edges: [
        {
          id: 'dependency:related',
          source: 'task:task-1',
          target: 'task:task-2',
          type: 'related',
          provenance: 'explicit',
        },
        {
          id: 'contains:ignored',
          source: 'phase:ignored',
          target: 'task:task-1',
          type: 'contains',
          provenance: 'derived',
        },
      ],
      pageInfo: {
        nodeLimit: 40,
        edgeLimit: 80,
        returnedNodes: 3,
        returnedEdges: 2,
        truncated: false,
        truncationReasons: [],
      },
      truncated: false,
    }, { dimensions: ['priority'], maxNodes: 20, maxEdges: 40 });

    expect(merged.nodes.find((node) => node.id === 'task:task-1')).toBe(current.nodes[0]);
    expect(merged.nodes.find((node) => node.id === 'task:task-1')).toMatchObject({
      x: 123,
      y: 456,
    });
    expect(merged.nodes).toContainEqual(expect.objectContaining({
      id: 'task:task-2',
      color: '#e2e8f0',
    }));
    expect(merged.nodes.some((node) => node.id === 'phase:ignored')).toBe(false);
    expect(merged.edges).toContainEqual(expect.objectContaining({
      id: 'dependency:related',
      type: 'related',
    }));
    expect(merged.edges.some((edge) => edge.id === 'contains:ignored')).toBe(false);
  });

  it('deduplicates expansion without promoting neighbor truncation to the canonical graph', () => {
    const current = buildUniverseSubgraph({
      tasks: [tasks[0]],
      tags: [],
      projects: [],
      dimensions: ['tags'],
      maxNodes: 20,
    });
    const incoming = {
      nodes: [{
        id: 'tag:tag-graph',
        entityId: 'tag-graph',
        kind: 'tag' as const,
        label: 'Graph',
      }],
      edges: [{
        id: 'has-tag:task:task-1:tag:tag-graph',
        source: 'task:task-1',
        target: 'tag:tag-graph',
        type: 'has-tag' as const,
        provenance: 'derived' as const,
      }],
      pageInfo: {
        nodeLimit: 1,
        edgeLimit: 1,
        returnedNodes: 1,
        returnedEdges: 1,
        truncated: true,
        truncationReasons: ['node-limit' as const],
      },
      truncated: true,
    };

    const once = mergeUniverseSubgraph(current, incoming, { dimensions: ['tags'] }).graph;
    const twice = mergeUniverseSubgraph(once, incoming, { dimensions: ['tags'] }).graph;
    expect(twice.nodes).toHaveLength(once.nodes.length);
    expect(twice.edges).toHaveLength(once.edges.length);
    expect(twice.nodes.find((node) => node.id === 'tag:tag-graph')?.taskCount).toBe(1);
    expect(twice.pageInfo.truncationReasons).not.toContain('node-limit');
    expect(twice.truncated).toBe(false);
  });

  it('honors active dimensions and aggregate node budgets', () => {
    const current = buildUniverseSubgraph({
      tasks: [tasks[0]],
      tags: [],
      projects: [],
      dimensions: ['priority'],
      maxNodes: 20,
    });
    const { graph: merged, droppedNodes } = mergeUniverseSubgraph(current, {
      nodes: [
        {
          id: 'tag:disabled',
          entityId: 'disabled',
          kind: 'tag',
          label: 'Disabled tag',
        },
        {
          id: 'task:task-2',
          entityId: 'task-2',
          kind: 'task',
          label: 'Second task',
          status: 'todo',
        },
        {
          id: 'task:task-3',
          entityId: 'task-3',
          kind: 'task',
          label: 'Budgeted out',
          status: 'todo',
        },
      ],
      edges: [],
      pageInfo: {
        nodeLimit: 80,
        edgeLimit: 240,
        returnedNodes: 3,
        returnedEdges: 0,
        truncated: false,
        truncationReasons: [],
      },
      truncated: false,
    }, {
      dimensions: ['priority'],
      maxNodes: current.nodes.length + 1,
      maxEdges: 20,
    });

    expect(merged.nodes.some((node) => node.id === 'tag:disabled')).toBe(false);
    expect(merged.nodes.some((node) => node.id === 'task:task-2')).toBe(true);
    expect(merged.nodes.some((node) => node.id === 'task:task-3')).toBe(false);
    expect(droppedNodes).toBe(1);
  });
});
