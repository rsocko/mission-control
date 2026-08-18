import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStructureGraphData } from '@/components/graph/useProjectStructureGraphData';
import type { ProjectSubgraph } from '@/lib/graph/types';

const graph: ProjectSubgraph = {
  nodes: [],
  edges: [],
  truncated: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useProjectStructureGraphData', () => {
  it('loads project graph data and exposes the layout transition', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ graph }),
    }));

    const { result } = renderHook(() => useProjectStructureGraphData('project-1'));
    await waitFor(() => expect(result.current.graph).toBe(graph));

    expect(result.current.loadingStage).toBe('layout');
    expect(result.current.truncated).toBe(true);
    act(() => result.current.completeLayout('project-1'));
    expect(result.current.loadingStage).toBeNull();
  });

  it('aborts the previous request when the project changes', () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise(() => undefined);
    }));

    const { rerender, unmount } = renderHook(
      ({ projectId }) => useProjectStructureGraphData(projectId),
      { initialProps: { projectId: 'project-1' } },
    );
    rerender({ projectId: 'project-2' });

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    unmount();
    expect(signals[1].aborted).toBe(true);
  });
});
