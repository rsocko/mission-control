import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TagGalaxy from '@/components/tag-insights/TagGalaxy';
import type { TagInsights } from '@/lib/tag-insights/types';

const graphMocks = vi.hoisted(() => ({
  forceCalls: [] as Array<{ name: string; replacesForce: boolean }>,
  forces: [] as string[],
  linkDistance: vi.fn(),
  linkStrength: vi.fn(),
  reheat: vi.fn(),
  widths: [] as number[],
  zoomToFit: vi.fn(),
}));

vi.mock('react-force-graph-2d', async () => {
  const React = await import('react');
  return {
    default: React.forwardRef(function MockForceGraph(
      {
        onEngineStop,
        onNodeClick,
        onNodeHover,
        width,
      }: {
        onEngineStop?: () => void;
        onNodeClick?: (node: { id: string }) => void;
        onNodeHover?: (node: { id: string } | null) => void;
        width: number;
      },
      ref: React.ForwardedRef<{
        d3Force: (name: string, force?: unknown) => unknown;
        d3ReheatSimulation: typeof graphMocks.reheat;
        zoomToFit: typeof graphMocks.zoomToFit;
      }>,
    ) {
      graphMocks.widths.push(width);
      const linkForce = {
        distance: graphMocks.linkDistance,
        strength: graphMocks.linkStrength,
      };
      graphMocks.linkDistance.mockReturnValue(linkForce);
      graphMocks.linkStrength.mockReturnValue(linkForce);
      React.useImperativeHandle(ref, () => ({
        d3Force: (name: string, force?: unknown) => {
          graphMocks.forces.push(name);
          graphMocks.forceCalls.push({ name, replacesForce: force !== undefined });
          return name === 'link' && force === undefined ? linkForce : undefined;
        },
        d3ReheatSimulation: graphMocks.reheat,
        zoomToFit: graphMocks.zoomToFit,
      }));
      return (
        <div>
          Canvas renderer
          <button type="button" onClick={onEngineStop}>
            Stop mock engine
          </button>
          <button type="button" onClick={() => onNodeClick?.({ id: 'api' })}>
            Mock canvas API node
          </button>
          <button
            type="button"
            onMouseEnter={() => onNodeHover?.({ id: 'api' })}
            onMouseLeave={() => onNodeHover?.(null)}
          >
            Mock canvas hover
          </button>
        </div>
      );
    }),
  };
});

const insights: TagInsights = {
  tags: [
    { id: 'api', name: 'API', color: null, taskCount: 1, taskIds: ['1'] },
    { id: 'backend', name: 'Backend', color: null, taskCount: 1, taskIds: ['1'] },
  ],
  pairs: [{
    key: '["api","backend"]',
    sourceTagId: 'api',
    targetTagId: 'backend',
    count: 1,
    taskIds: ['1'],
  }],
  tasks: {
    '1': { id: '1', title: 'Build endpoint', status: 'in_progress' },
  },
  meta: {
    topN: 15,
    minCooccurrence: 1,
    taskLimit: 2000,
    processedTaskCount: 1,
    truncated: false,
  },
};

describe('TagGalaxy accessibility', () => {
  beforeEach(() => {
    graphMocks.forceCalls.length = 0;
    graphMocks.forces.length = 0;
    graphMocks.linkDistance.mockReset();
    graphMocks.linkStrength.mockReset();
    graphMocks.reheat.mockReset();
    graphMocks.widths.length = 0;
    graphMocks.zoomToFit.mockReset();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers keyboard-accessible relationships and exact task provenance at detail LOD', () => {
    render(<TagGalaxy data={insights} />);

    fireEvent.click(screen.getByRole('button', { name: 'API + Backend 1 shared task' }));
    expect(screen.getByRole('heading', { name: 'Shared tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build endpoint/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open exact task' })).toHaveAttribute(
      'href',
      '/?taskId=1',
    );
  });

  it('shows exact tasks from a canvas selection without requiring detail zoom', () => {
    render(<TagGalaxy data={insights} />);

    fireEvent.click(screen.getByText('Mock canvas API node'));

    expect(screen.getByRole('heading', { name: 'Tagged tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build endpoint/ })).toBeInTheDocument();
  });

  it('reveals large task sets progressively', () => {
    const taskIds = Array.from({ length: 51 }, (_, index) => String(index + 1));
    const tasks = Object.fromEntries(taskIds.map((id) => [
      id,
      { id, title: `Task ${id}`, status: 'todo' },
    ]));
    render(<TagGalaxy data={{
      ...insights,
      tags: [{ ...insights.tags[0], taskCount: taskIds.length, taskIds }],
      pairs: [],
      tasks,
    }} />);

    fireEvent.click(screen.getByText('Mock canvas API node'));

    expect(screen.getByRole('button', { name: /Task 50/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Task 51/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show next 1 tasks' }));
    expect(screen.getByRole('button', { name: /Task 51/ })).toBeInTheDocument();
  });

  it('offers tag provenance without the canvas, fits narrow containers, and resets the viewport', () => {
    render(<TagGalaxy data={insights} />);

    expect(graphMocks.widths).toContain(280);
    expect(graphMocks.forces).toEqual(expect.arrayContaining(['link', 'charge', 'collision', 'x', 'y']));
    expect(graphMocks.forceCalls).toContainEqual({ name: 'link', replacesForce: false });
    expect(graphMocks.linkDistance).toHaveBeenCalledWith(112);
    expect(graphMocks.linkStrength).toHaveBeenCalledWith(0.45);
    expect(graphMocks.reheat).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'API 1 tagged task' }));
    expect(screen.getByRole('heading', { name: 'Tagged tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build endpoint/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset galaxy focus' }));
    expect(graphMocks.zoomToFit).toHaveBeenCalledWith(300, 40);
  });

  it('does not auto-fit again when refreshed graph data arrives', () => {
    const { rerender } = render(<TagGalaxy data={insights} layoutKey="15:2:" />);

    fireEvent.click(screen.getByText('Stop mock engine'));
    expect(graphMocks.zoomToFit).toHaveBeenCalledTimes(1);
    expect(graphMocks.zoomToFit).toHaveBeenLastCalledWith(300, 56);

    rerender(
      <TagGalaxy
        data={{
          ...insights,
          tags: insights.tags.map((tag) => (
            tag.id === 'api' ? { ...tag, taskCount: 2 } : tag
          )),
        }}
        layoutKey="15:2:"
      />,
    );
    fireEvent.click(screen.getByText('Stop mock engine'));

    expect(graphMocks.zoomToFit).toHaveBeenCalledTimes(1);
  });

  it('auto-fits after an explicit graph filter change', () => {
    const { rerender } = render(<TagGalaxy data={insights} layoutKey="15:2:" />);

    fireEvent.click(screen.getByText('Stop mock engine'));
    expect(graphMocks.zoomToFit).toHaveBeenCalledTimes(1);

    rerender(<TagGalaxy data={insights} layoutKey="30:2:" />);
    fireEvent.click(screen.getByText('Stop mock engine'));

    expect(graphMocks.zoomToFit).toHaveBeenCalledTimes(2);
  });
});
