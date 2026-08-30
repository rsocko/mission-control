import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccessibleUniverseList,
  DimensionToggles,
  NeighborLayerToggles,
} from '@/components/graph/universe/UniverseGraphPresenters';
import { useUniverseGraphStore } from '@/lib/stores/universeGraphStore';
import type { UniverseSubgraph } from '@/lib/graph/universe-types';

const graph: UniverseSubgraph = {
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
      taskCount: 1,
    },
  ],
  edges: [
    { id: 'e1', source: 'task:1', target: 'tag:x', type: 'has-tag', provenance: 'derived' },
    {
      id: 'semantic:task:1:task:2',
      source: 'task:1',
      target: 'task:2',
      type: 'semantic-similarity',
      provenance: 'embedding',
      score: 0.82,
      explanation: 'These tasks are close in the active embedding space.',
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        indexId: 'idx-active',
        targetEmbeddedAt: '2030-01-01T00:00:00.000Z',
      },
    },
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

beforeEach(() => {
  useUniverseGraphStore.setState({
    dimensions: ['priority', 'source', 'tags'],
    neighborLayers: ['explicit', 'derived'],
    selectedNodeIds: [],
  });
});

describe('Universe graph presenters', () => {
  it('toggles neighborhood layers independently and explains a disabled semantic gate', () => {
    render(<NeighborLayerToggles semanticEnabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(useUniverseGraphStore.getState().neighborLayers).toEqual(['derived']);
    expect(screen.getByRole('button', { name: 'Semantic' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attributes' })).toHaveAttribute('aria-pressed', 'true');
  });

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
    expect(screen.getAllByText(/82% related/)).not.toHaveLength(0);
    expect(screen.getAllByText(/openai \/ text-embedding-3-small/)).not.toHaveLength(0);
  });
});
