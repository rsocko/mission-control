import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccessibleUniverseList,
  DimensionToggles,
} from '@/components/graph/universe/UniverseGraphPresenters';
import { useUniverseGraphStore } from '@/lib/stores/universeGraphStore';
import type { UniverseSubgraph } from '@/lib/graph/universe-types';

const graph: UniverseSubgraph = {
  nodes: [
    { id: 'task:1', entityId: '1', kind: 'task', label: 'Alpha task', status: 'todo', color: 'var(--text-primary)' },
    {
      id: 'tag:x',
      entityId: 'x',
      kind: 'tag',
      dimension: 'tags',
      value: 'x',
      label: 'Graph',
      color: 'var(--accent-500)',
      taskCount: 1,
    },
  ],
  edges: [
    { id: 'e1', source: 'task:1', target: 'tag:x', type: 'has-tag', provenance: 'derived' },
  ],
  stats: { taskCount: 1, filteredTaskCount: 1, attributeCount: 1 },
  facets: { priorities: [], statuses: [], sources: [], lists: [] },
  pageInfo: {
    nodeLimit: 10,
    edgeLimit: 10,
    returnedNodes: 2,
    returnedEdges: 1,
    truncated: false,
    truncationReasons: [],
  },
  truncated: false,
};

beforeEach(() => {
  useUniverseGraphStore.setState({
    dimensions: ['priority', 'source', 'tags'],
    selectedNodeIds: [],
  });
});

describe('Universe graph presenters', () => {
  it('exports dimension controls backed by the graph store', () => {
    render(<DimensionToggles />);
    const tags = screen.getByRole('button', { name: 'Tags' });

    expect(tags).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tags);
    expect(useUniverseGraphStore.getState().dimensions).toEqual(['priority', 'source']);
  });

  it('reflects canvas selection and routes list activation through callbacks', () => {
    const onNodeSelect = vi.fn();
    const onTaskActivate = vi.fn();
    render(
      <AccessibleUniverseList
        graph={graph}
        selectedNodeIds={['tag:x']}
        onNodeSelect={onNodeSelect}
        onTaskActivate={onTaskActivate}
      />,
    );

    expect(screen.getByRole('button', { name: /Graph/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Open task Alpha task' }));
    expect(onTaskActivate).toHaveBeenCalledWith('1', 'task:1');
  });
});
