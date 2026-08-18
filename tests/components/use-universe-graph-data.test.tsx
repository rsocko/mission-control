import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUniverseGraphData } from '@/components/graph/universe/useUniverseGraphData';
import type { UniverseSubgraph } from '@/lib/graph/universe-types';

function canonicalGraph(): UniverseSubgraph {
  return {
    nodes: [
      { id: 'task:1', entityId: '1', kind: 'task', label: 'One', status: 'todo', color: 'var(--text-primary)' },
    ],
    edges: [],
    stats: { taskCount: 1, filteredTaskCount: 1, attributeCount: 0 },
    facets: { priorities: [], statuses: [], sources: [], lists: [] },
    pageInfo: {
      nodeLimit: 500,
      edgeLimit: 2_000,
      returnedNodes: 1,
      returnedEdges: 0,
      truncated: false,
      truncationReasons: [],
    },
    truncated: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useUniverseGraphData', () => {
  it('loads the canonical graph and reports failures', async () => {
    const onCanonicalLoad = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ graph: canonicalGraph() }),
    }));
    const { result } = renderHook(() => useUniverseGraphData({
      shouldLoad: true,
      canonicalQuery: 'maxNodes=500',
      reloadKey: 0,
      dimensions: ['tags'],
      onCanonicalLoad,
      debounceMs: 0,
    }));

    await waitFor(() => expect(result.current.graph?.nodes).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(
      '/api/graph/universe?maxNodes=500',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onCanonicalLoad).toHaveBeenCalledOnce();
    expect(result.current.loading).toBe(false);
  });

  it('aborts stale canonical requests when the query changes', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise(() => {});
    }));
    const { rerender } = renderHook(
      ({ query }) => useUniverseGraphData({
        shouldLoad: true,
        canonicalQuery: query,
        reloadKey: 0,
        dimensions: ['tags'],
        onCanonicalLoad: vi.fn(),
        debounceMs: 0,
      }),
      { initialProps: { query: 'first' } },
    );
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ query: 'second' });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('merges neighborhood expansion and exposes an outcome message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ graph: canonicalGraph() }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          graph: {
            nodes: [
              { id: 'task:2', entityId: '2', kind: 'task', label: 'Two', status: 'todo' },
            ],
            edges: [],
            pageInfo: {
              nodeLimit: 80,
              edgeLimit: 240,
              returnedNodes: 1,
              returnedEdges: 0,
              truncated: false,
              truncationReasons: [],
            },
            truncated: false,
          },
        }),
      }));
    const { result } = renderHook(() => useUniverseGraphData({
      shouldLoad: true,
      canonicalQuery: 'maxNodes=500',
      reloadKey: 0,
      dimensions: ['tags'],
      onCanonicalLoad: vi.fn(),
      debounceMs: 0,
    }));
    await waitFor(() => expect(result.current.graph?.nodes).toHaveLength(1));

    await act(async () => {
      await result.current.expandSelection(result.current.graph!.nodes);
    });

    expect(result.current.graph?.nodes.map((node) => node.id)).toEqual(['task:1', 'task:2']);
    expect(result.current.explorationMessage).toContain('Added 1 node');
    expect(result.current.expanding).toBe(false);
  });
});
