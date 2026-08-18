import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdeationNode } from '@/lib/graph/ideation-types';
import { useIdeationStore } from '@/lib/stores/ideationStore';
import { useIdeationExpansion } from '@/components/ideation/useIdeationExpansion';

const nodes: IdeationNode[] = [
  {
    id: 'root',
    label: 'Launch',
    kind: 'idea',
    parentId: null,
    sortOrder: 0,
    properties: {},
  },
];

describe('useIdeationExpansion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useIdeationStore.setState({
      nodes,
      selectedNodeId: 'root',
      past: [],
    });
  });

  it('loads suggestions independently from the canvas renderer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        contextVersion: string;
        selectedNode: { id: string };
      };
      return new Response(JSON.stringify({
        proposals: [
          { id: 'one', label: 'Research', rationale: 'Learn first.' },
          { id: 'two', label: 'Prototype', rationale: 'Test quickly.' },
          { id: 'three', label: 'Measure', rationale: 'Verify impact.' },
        ],
        contextVersion: request.contextVersion,
        selectedNodeId: request.selectedNode.id,
      }), { status: 200 });
    });

    const { result } = renderHook(() => useIdeationExpansion(nodes, nodes[0]));
    await act(() => result.current.expandSelected());

    expect(result.current.expansion.status).toBe('ready');
    expect(result.current.expansion.proposals.map((proposal) => proposal.label)).toEqual([
      'Research',
      'Prototype',
      'Measure',
    ]);
  });

  it('aborts in-flight expansion when cleared', async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const { result } = renderHook(() => useIdeationExpansion(nodes, nodes[0]));
    act(() => {
      void result.current.expandSelected();
    });
    await waitFor(() => expect(signal).toBeDefined());

    act(() => result.current.clearExpansion());

    expect(signal?.aborted).toBe(true);
    expect(result.current.expansion.status).toBe('idle');
  });
});
