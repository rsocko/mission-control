import { describe, expect, it } from 'vitest';
import {
  buildProjectSubgraph,
  hasDuplicateDependency,
  wouldCreateBlockingCycle,
} from '@/lib/graph/project-subgraph';
import type { ProjectGraphRecords } from '@/lib/graph/types';

function createRecords(): ProjectGraphRecords {
  return {
    project: {
      id: 'project-1',
      name: 'Graph project',
      description: 'A project',
      status: 'active',
      color: '#3b82f6',
    },
    phases: [
      {
        id: 'phase-1',
        name: 'Plan',
        description: null,
        status: 'completed',
        color: null,
        startAfterPhaseId: null,
      },
      {
        id: 'phase-2',
        name: 'Build',
        description: null,
        status: 'in_progress',
        color: null,
        startAfterPhaseId: 'phase-1',
      },
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Design',
        description: null,
        status: 'done',
        microStatus: null,
      },
      {
        id: 'task-2',
        title: 'Implement',
        description: null,
        status: 'todo',
        microStatus: 'blocked_external',
      },
      {
        id: 'task-3',
        title: 'Unassigned',
        description: null,
        status: 'todo',
        microStatus: null,
      },
    ],
    phaseItems: [
      { phaseId: 'phase-1', taskId: 'task-1' },
      { phaseId: 'phase-2', taskId: 'task-2' },
    ],
    taskDependencies: [
      {
        id: 'dependency-1',
        taskId: 'task-2',
        dependsOnTaskId: 'task-1',
        type: 'blocks',
        syncStatus: 'synced',
        syncAction: null,
        syncError: null,
        lastSyncedAt: '2030-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('buildProjectSubgraph', () => {
  it('projects hierarchy, phase dependencies, and task dependencies', () => {
    const graph = buildProjectSubgraph(createRecords());

    expect(graph.nodes).toHaveLength(6);
    expect(graph.nodes.find((node) => node.id === 'task:task-2')?.status).toBe('blocked');
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'project:project-1',
        target: 'phase:phase-1',
        type: 'contains',
      }),
      expect.objectContaining({
        source: 'phase:phase-1',
        target: 'phase:phase-2',
        type: 'blocks',
      }),
      expect.objectContaining({
        source: 'task:task-1',
        target: 'task:task-2',
        type: 'blocks',
        syncStatus: 'synced',
        lastSyncedAt: '2030-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        source: 'project:project-1',
        target: 'task:task-3',
        type: 'contains',
      }),
    ]));
  });

  it('bounds nodes and removes edges to omitted nodes', () => {
    const graph = buildProjectSubgraph(createRecords(), 2);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.truncated).toBe(true);
    expect(graph.edges.every((edge) =>
      graph.nodes.some((node) => node.id === edge.source)
      && graph.nodes.some((node) => node.id === edge.target))).toBe(true);
  });
});

describe('wouldCreateBlockingCycle', () => {
  it('detects a new edge that closes a blocking cycle', () => {
    expect(wouldCreateBlockingCycle([
      { dependsOnTaskId: 'a', taskId: 'b', type: 'blocks' },
      { dependsOnTaskId: 'b', taskId: 'c', type: 'blocks' },
    ], 'c', 'a')).toBe(true);
  });

  it('ignores related edges when checking blocking cycles', () => {
    expect(wouldCreateBlockingCycle([
      { dependsOnTaskId: 'a', taskId: 'b', type: 'related' },
    ], 'b', 'a')).toBe(false);
  });
});

describe('hasDuplicateDependency', () => {
  const dependencies = [
    { dependsOnTaskId: 'a', taskId: 'b', type: 'blocks' },
    { dependsOnTaskId: 'c', taskId: 'd', type: 'related' },
  ];

  it('keeps blocking dependencies directional', () => {
    expect(hasDuplicateDependency(dependencies, 'b', 'a', 'blocks')).toBe(false);
  });

  it('treats related dependencies as symmetric', () => {
    expect(hasDuplicateDependency(dependencies, 'd', 'c', 'related')).toBe(true);
  });
});
