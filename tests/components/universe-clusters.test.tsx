import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UniverseClusterControls,
  UniverseClusterReviewPanel,
} from '@/components/graph/universe/UniverseClusters';
import { clusterUniverseGraph } from '@/lib/graph/universe-clusters';
import type { UniverseSubgraph } from '@/lib/graph/universe-types';

const graph: UniverseSubgraph = {
  nodes: [
    { id: 'task:1', entityId: '1', kind: 'task', label: 'Release checklist', status: 'todo', color: 'var(--text-primary)' },
    { id: 'task:2', entityId: '2', kind: 'task', label: 'Release notes', status: 'todo', color: 'var(--text-primary)' },
  ],
  edges: [{
    id: 'semantic:1:2',
    source: 'task:1',
    target: 'task:2',
    type: 'semantic-similarity',
    provenance: 'embedding',
    score: 0.9,
    explanation: 'fixture',
    embedding: {
      provider: 'fixture',
      model: 'fixture',
      indexId: 'fixture',
      targetEmbeddedAt: '2030-01-01T00:00:00.000Z',
    },
  }],
  stats: { taskCount: 2, filteredTaskCount: 2, attributeCount: 0 },
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
const projection = clusterUniverseGraph(graph);
const cluster = projection.clusters[0];

describe('Universe transient cluster UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes feature gating and filters through accessible controls', async () => {
    const onToggle = vi.fn();
    const onFilterChange = vi.fn();
    render(
      <UniverseClusterControls
        enabled
        available
        projection={projection}
        filter="all"
        onToggle={onToggle}
        onFilterChange={onFilterChange}
      />,
    );

    expect(screen.getByRole('button', { name: 'Transient groups on' }))
      .toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter transient clusters' }));
    fireEvent.click(await screen.findByRole('option', { name: /Release.*\(2\)/ }));
    expect(onFilterChange).toHaveBeenCalledWith(cluster.id);
  });

  it('cancels review without mutation and requires explicit confirmation', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onClose = vi.fn();
    render(
      <UniverseClusterReviewPanel
        cluster={cluster}
        graph={graph}
        projectionFingerprint={projection.fingerprint}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Review before saving' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel cluster save' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces partial failures while keeping the reviewed panel open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'partial',
      savedTaskIds: ['1'],
      failures: [{ taskId: '2', message: 'Source rejected tag' }],
    }), {
      status: 207,
      headers: { 'content-type': 'application/json' },
    }));
    const onClose = vi.fn();
    render(
      <UniverseClusterReviewPanel
        cluster={cluster}
        graph={graph}
        projectionFingerprint={projection.fingerprint}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText(/I reviewed these 2 members/));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      '1 task saved; 1 failed. Source rejected tag',
    ));
    expect(onClose).not.toHaveBeenCalled();
  });
});
