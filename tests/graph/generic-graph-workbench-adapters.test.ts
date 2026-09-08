import { describe, expect, it, vi } from 'vitest';
import {
  createIdeationWorkbenchHost,
  createProjectGraphWorkbenchHost,
  graphDocumentToIdeationNodes,
  ideationNodesToGraphDocument,
  projectSubgraphToGraphDocument,
} from '@/lib/graph-workbench/adapters';
import type { IdeationNode } from '@/lib/graph/ideation-types';
import type { ProjectSubgraph } from '@/lib/graph/types';

describe('generic graph workbench adapters', () => {
  it('round-trips Ideation domain metadata losslessly through a shared document', () => {
    const nodes: IdeationNode[] = [
      {
        id: 'root',
        label: 'Launch',
        kind: 'idea',
        parentId: null,
        sortOrder: 0,
        properties: {},
      },
      {
        id: 'task',
        label: 'Ship',
        kind: 'task',
        parentId: 'root',
        sortOrder: 0,
        properties: {
          priority: { key: 'priority', rawValue: 'high', value: 'high' },
          tags: { key: 'tags', rawValue: 'graph, ui', value: ['graph', 'ui'] },
        },
      },
    ];

    const document = ideationNodesToGraphDocument(nodes, 'workspace-1');

    expect(document.document).toMatchObject({
      id: 'workspace-1',
      profile: 'mind-map',
    });
    expect(document.relationships).toEqual([
      expect.objectContaining({ type: 'contains', source: 'root', target: 'task' }),
    ]);
    expect(graphDocumentToIdeationNodes(document)).toEqual(nodes);
    expect(Object.keys(graphDocumentToIdeationNodes(document)[1].properties)).toEqual([
      'priority',
      'tags',
    ]);
  });

  it('keeps valid Mission Control root labels beyond the shared title limit', () => {
    const label = 'L'.repeat(500);
    const nodes: IdeationNode[] = [{
      id: 'root',
      label,
      kind: 'idea',
      parentId: null,
      sortOrder: 0,
      properties: {},
    }];

    expect(graphDocumentToIdeationNodes(ideationNodesToGraphDocument(nodes))[0].label).toBe(label);
  });

  it('rejects malformed or unknown Mission Control extension properties', () => {
    const document = ideationNodesToGraphDocument([{
      id: 'root',
      label: 'Root',
      kind: 'idea',
      parentId: null,
      sortOrder: 0,
      properties: {},
    }]);
    const extension = document.nodes[0].extensions?.missionControlIdeation;
    if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
      throw new Error('Expected Mission Control Ideation extension');
    }
    extension.properties = {
      priority: { key: 'priority', rawValue: 'high', value: false },
    };

    expect(() => graphDocumentToIdeationNodes(document)).toThrow(/malformed property priority/);
  });

  it('adapts a live Project Graph without leaking its sync metadata into shared fields', () => {
    const graph: ProjectSubgraph = {
      nodes: [
        { id: 'project:1', entityId: '1', kind: 'project', label: 'Project', status: 'todo' },
        { id: 'task:1', entityId: '1', kind: 'task', label: 'Task', status: 'blocked' },
      ],
      edges: [{
        id: 'related:1',
        source: 'project:1',
        target: 'task:1',
        type: 'related',
        provenance: 'explicit',
        syncStatus: 'failed',
        syncAction: 'create',
        syncError: 'offline',
      }],
      truncated: false,
    };

    const document = projectSubgraphToGraphDocument(graph);

    expect(document.document.profile).toBe('roadmap-map');
    expect(document.relationships[0]).toMatchObject({
      type: 'depends-on',
      extensions: {
        missionControlProjectEdge: {
          type: 'related',
          syncStatus: 'failed',
          syncError: 'offline',
        },
      },
    });
  });

  it('declares authored and projection data boundaries with real host ports', () => {
    const diagnostics = { report: vi.fn() };
    const ideation = createIdeationWorkbenchHost({
      load: vi.fn(),
      save: vi.fn(),
    }, diagnostics);
    const project = createProjectGraphWorkbenchHost({
      load: vi.fn(),
    }, {
      apply: vi.fn(),
    }, diagnostics);

    expect(ideation.data.kind).toBe('authored-document');
    expect(project.data.kind).toBe('domain-projection');
    expect(ideation.capabilities.supported).toContain('outline');
    expect(project.capabilities.supported).toContain('connect');
  });
});
