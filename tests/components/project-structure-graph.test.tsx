import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNodeStatus, ProjectSubgraph } from '@/lib/graph/types';

const {
  fitView,
  flowProps,
  resizeObserverCallbacks,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  fitView: vi.fn(),
  flowProps: { current: null as Record<string, unknown> | null },
  resizeObserverCallbacks: [] as ResizeObserverCallback[],
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  }) => open ? <button onClick={onConfirm}>{confirmLabel}</button> : null,
}));

vi.mock('lucide-react', () => {
  const Icon = () => <span />;
  return {
    Boxes: Icon,
    AlertTriangle: Icon,
    CheckCircle2: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    ChevronUp: Icon,
    Circle: Icon,
    CircleDot: Icon,
    Cloud: Icon,
    CloudOff: Icon,
    Flag: Icon,
    Link2: Icon,
    LoaderCircle: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

vi.mock('@xyflow/react', async () => {
  const ReactLib = await import('react');

  function useFlowState<T>(initial: T[]) {
    const [items, setItems] = ReactLib.useState(initial);
    return [items, setItems, vi.fn()] as const;
  }

  return {
    Background: () => null,
    Controls: () => <button className="react-flow__controls-button">Zoom in</button>,
    MiniMap: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
    Handle: ({
      type,
      isConnectable,
      isConnectableStart,
      isConnectableEnd,
      ...props
    }: React.ComponentPropsWithoutRef<'div'> & {
      type: string;
      isConnectable?: boolean;
      isConnectableStart?: boolean;
      isConnectableEnd?: boolean;
    }) => (
      <div
        {...props}
        data-handle-type={type}
        data-connectable={String(isConnectable)}
        data-connectable-start={String(isConnectableStart)}
        data-connectable-end={String(isConnectableEnd)}
      />
    ),
    ReactFlow: ({
      nodes,
      edges,
      nodeTypes,
      onEdgeClick,
      onInit,
      onSelectionChange,
      children,
      ...props
    }: {
      nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      edges: Array<{ id: string; selected?: boolean; ariaLabel?: string }>;
      nodeTypes: Record<string, React.ComponentType<Record<string, unknown>>>;
      onEdgeClick: (event: React.MouseEvent, edge: { id: string }) => void;
      onInit?: (instance: { fitView: typeof fitView }) => void;
      onSelectionChange: (selection: { edges: Array<{ id: string }> }) => void;
      children: React.ReactNode;
    }) => {
      onInit?.({ fitView });
      flowProps.current = { ...props, onEdgeClick, onSelectionChange, onInit };
      return (
        <div data-testid="project-react-flow">
          {nodes.map((node) => {
            const NodeComponent = nodeTypes[node.type];
            return (
              <NodeComponent
                key={node.id}
                id={node.id}
                data={node.data}
                selected={false}
              />
            );
          })}
          {edges.map((edge) => (
            <button
              key={edge.id}
              aria-label={edge.ariaLabel}
              data-testid={`flow-edge-${edge.id}`}
              data-selected={edge.selected}
              onClick={(event) => onEdgeClick(event, edge)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  onSelectionChange({ edges: [edge] });
                }
              }}
            >
              Select {edge.id}
            </button>
          ))}
          {children}
        </div>
      );
    },
    useEdgesState: useFlowState,
    useNodesState: useFlowState,
  };
});

import ProjectStructureGraph, { StructureNode } from '@/components/graph/ProjectStructureGraph';
import { announceTaskRelationshipsChanged } from '@/lib/task-relationships-events';

const graph: ProjectSubgraph = {
  nodes: [
    {
      id: 'project:project-1',
      entityId: 'project-1',
      kind: 'project',
      label: 'Project',
      status: 'in_progress',
    },
    {
      id: 'task:task-1',
      entityId: 'task-1',
      kind: 'task',
      label: 'First task',
      status: 'todo',
    },
    {
      id: 'task:task-2',
      entityId: 'task-2',
      kind: 'task',
      label: 'Second task',
      status: 'todo',
    },
  ],
  edges: [
    {
      id: 'dependency:dependency-1',
      source: 'task:task-1',
      target: 'task:task-2',
      type: 'blocks',
      provenance: 'explicit',
      syncStatus: 'synced',
      syncAction: null,
      syncError: null,
    },
  ],
  truncated: false,
};

const phaseDependencyGraph: ProjectSubgraph = {
  nodes: [
    {
      id: 'project:project-1',
      entityId: 'project-1',
      kind: 'project',
      label: 'Project',
      status: 'in_progress',
    },
    {
      id: 'phase:phase-1',
      entityId: 'phase-1',
      kind: 'phase',
      label: 'Planning',
      status: 'done',
    },
    {
      id: 'phase:phase-2',
      entityId: 'phase-2',
      kind: 'phase',
      label: 'Implementation',
      status: 'in_progress',
    },
  ],
  edges: [
    {
      id: 'contains:project:project-1:phase:phase-1',
      source: 'project:project-1',
      target: 'phase:phase-1',
      type: 'contains',
      provenance: 'derived',
    },
    {
      id: 'contains:project:project-1:phase:phase-2',
      source: 'project:project-1',
      target: 'phase:phase-2',
      type: 'contains',
      provenance: 'derived',
    },
    {
      id: 'blocks:phase:phase-1:phase:phase-2',
      source: 'phase:phase-1',
      target: 'phase:phase-2',
      type: 'blocks',
      provenance: 'explicit',
    },
  ],
  truncated: false,
};

describe('ProjectStructureGraph connections', () => {
  beforeEach(() => {
    fitView.mockReset();
    flowProps.current = null;
    resizeObserverCallbacks.length = 0;
    toastError.mockReset();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ graph }),
    }) as unknown as typeof fetch;
  });

  it('shows an accessible loading skeleton while fetching the graph', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Loading project data...')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Project graph loading progress' })).toBeInTheDocument();
    expect(screen.getByText('Loading project data...').closest('[aria-busy="true"]')).toHaveClass(
      'h-full',
      'min-h-0',
    );
  });

  it('fills its parent and refits on resize until the user moves the viewport', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    const region = await screen.findByRole('region', {
      name: /Project structure graph with \d+ nodes and \d+ edges/,
    });
    expect(region).toHaveClass('h-full', 'min-h-0');
    expect(region.className).not.toContain('h-[620px]');
    await waitFor(() => expect(resizeObserverCallbacks).toHaveLength(1));

    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    vi.useFakeTimers();

    try {
      const notifyResize = (width: number, height: number) => {
        resizeObserverCallbacks[0](
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      };

      const initialFitCount = fitView.mock.calls.length;
      await act(async () => {
        notifyResize(900, 600);
        const onMoveStart = flowProps.current?.onMoveStart as (
          event: MouseEvent | TouchEvent | null,
          viewport: { x: number; y: number; zoom: number },
        ) => void;
        onMoveStart(null, { x: 0, y: 0, zoom: 1 });
        notifyResize(1100, 700);
        vi.advanceTimersByTime(140);
        await Promise.resolve();
      });
      const resizedFitCount = fitView.mock.calls.length;
      expect(resizedFitCount).toBeGreaterThan(initialFitCount);

      const onMoveStart = flowProps.current?.onMoveStart as (
        event: MouseEvent | TouchEvent | null,
        viewport: { x: number; y: number; zoom: number },
      ) => void;
      act(() => {
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom in' }));
        onMoveStart(null, { x: 0, y: 0, zoom: 1 });
        notifyResize(1200, 760);
        vi.advanceTimersByTime(140);
      });
      expect(fitView).toHaveBeenCalledTimes(resizedFitCount);

      act(() => {
        notifyResize(1300, 800);
        onMoveStart(new MouseEvent('mousedown'), { x: 0, y: 0, zoom: 1 });
        vi.advanceTimersByTime(140);
      });
      expect(fitView).toHaveBeenCalledTimes(resizedFitCount);
    } finally {
      vi.useRealTimers();
      requestAnimationFrame.mockRestore();
    }
  });

  it('uses window dimensions and cancels a pending resize fit on unmount', async () => {
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const { unmount } = render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );
    const region = await screen.findByRole('region', {
      name: /Project structure graph with \d+ nodes and \d+ edges/,
    });
    await waitFor(() => expect(resizeObserverCallbacks).toHaveLength(1));

    const bounds = { width: 900, height: 600 };
    vi.spyOn(region, 'getBoundingClientRect').mockImplementation(() => ({
      ...bounds,
      bottom: bounds.height,
      left: 0,
      right: bounds.width,
      top: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    vi.useFakeTimers();

    try {
      const initialFitCount = fitView.mock.calls.length;
      act(() => window.dispatchEvent(new Event('resize')));
      expect(fitView).toHaveBeenCalledTimes(initialFitCount);

      bounds.width = 1100;
      act(() => window.dispatchEvent(new Event('resize')));
      unmount();
      act(() => vi.advanceTimersByTime(140));
      expect(fitView).toHaveBeenCalledTimes(initialFitCount);
    } finally {
      vi.useRealTimers();
      requestAnimationFrame.mockRestore();
    }
  });

  it('preserves a user-adjusted viewport when refreshed graph data arrives', async () => {
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    try {
      const onTaskSelect = vi.fn();
      const { rerender } = render(
        <ProjectStructureGraph
          projectId="project-1"
          refreshKey="before-sync"
          onTaskSelect={onTaskSelect}
        />,
      );
      await screen.findByText('First task');
      const onMoveStart = flowProps.current?.onMoveStart as (
        event: MouseEvent | TouchEvent | null,
        viewport: { x: number; y: number; zoom: number },
      ) => void;
      act(() => {
        onMoveStart(new MouseEvent('mousedown'), { x: 120, y: 80, zoom: 1.25 });
      });
      const fitCount = fitView.mock.calls.length;

      rerender(
        <ProjectStructureGraph
          projectId="project-1"
          refreshKey="after-sync"
          onTaskSelect={onTaskSelect}
        />,
      );

      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await act(async () => {
        await Promise.resolve();
      });
      expect(fitView).toHaveBeenCalledTimes(fitCount);
    } finally {
      requestAnimationFrame.mockRestore();
    }
  });

  it('keeps the progress UI visible while arranging the graph', async () => {
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText('Arranging project graph...')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Project graph loading progress' })).toBeInTheDocument();
    animationFrame.mockRestore();
  });

  it('ignores an aborted graph response after switching projects', async () => {
    let resolveFirst: (response: Response) => void = () => {};
    let resolveSecond: (response: Response) => void = () => {};
    let firstSignal: AbortSignal | undefined;
    vi.mocked(fetch)
      .mockImplementationOnce((_input, init) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      }));

    const { rerender } = render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );
    rerender(
      <ProjectStructureGraph
        projectId="project-2"
        onTaskSelect={vi.fn()}
      />,
    );

    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ graph }), { status: 200 }));
    });
    expect(screen.getByText('Loading project data...')).toBeInTheDocument();
    expect(screen.queryByText('Arranging project graph...')).not.toBeInTheDocument();

    await act(async () => {
      resolveSecond(new Response(JSON.stringify({ graph }), { status: 200 }));
    });
    expect(await screen.findByText('First task')).toBeInTheDocument();
  });

  it('explains and enforces right-to-left dependency creation', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    const addDependencyButton = await screen.findByRole('button', { name: 'Add dependency' });
    expect(addDependencyButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Dependency source task')).not.toBeInTheDocument();
    fireEvent.click(addDependencyButton);
    expect(screen.getByRole('button', { name: 'Hide dependency controls' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    expect(await screen.findByText((content) => content.includes(
      "Drag from the predecessor's right handle to the successor's left handle.",
    ))).toBeInTheDocument();

    const source = await screen.findByLabelText('Dependency output for First task');
    expect(source).toHaveAttribute('data-connectable-start', 'true');
    expect(source).toHaveAttribute('data-connectable-end', 'false');

    const target = await screen.findByLabelText('Dependency input for First task');
    expect(target).toHaveAttribute('data-connectable-start', 'false');
    expect(target).toHaveAttribute('data-connectable-end', 'true');

    const disabledHandles = document.querySelectorAll('[data-connectable="false"]');
    expect(disabledHandles).toHaveLength(2);
    expect(flowProps.current?.connectOnClick).toBe(false);

    fireEvent.keyDown(screen.getByLabelText('Graph layout direction'), { key: 'Enter' });
    expect(screen.getByRole('option', { name: 'Horizontal' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('option', { name: 'Vertical' })).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(screen.getByRole('option', { name: 'Vertical' }));
    expect(await screen.findByText((content) => content.includes(
      "Drag from the predecessor's bottom handle to the successor's top handle.",
    ))).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Dependency output for First task')).toHaveAttribute(
        'position',
        'bottom',
      );
      expect(screen.getByLabelText('Dependency input for First task')).toHaveAttribute(
        'position',
        'top',
      );
    });
  });

  it('rejects self-connections and explains invalid handle drops', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(flowProps.current).not.toBeNull());

    const isValidConnection = flowProps.current?.isValidConnection as (
      connection: { source: string; target: string }
    ) => boolean;
    expect(isValidConnection({ source: 'task:task-1', target: 'task:task-2' })).toBe(true);
    expect(isValidConnection({ source: 'task:task-1', target: 'task:task-1' })).toBe(false);

    const onConnectEnd = flowProps.current?.onConnectEnd as (
      event: MouseEvent,
      state: Record<string, unknown>
    ) => void;
    act(() => {
      onConnectEnd(new MouseEvent('mouseup'), {
        isValid: false,
        fromHandle: { nodeId: 'task:task-1' },
        toHandle: { nodeId: 'task:task-2' },
      });
    });

    expect(toastError).toHaveBeenCalledWith(
      "Start on the predecessor's right handle and finish on the successor's left handle",
    );
  });

  it('prevents the selector controls from connecting a task to itself', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add dependency' }));
    const sourceSelect = await screen.findByLabelText('Dependency source task');
    const targetSelect = screen.getByLabelText('Dependency target task');
    const connectButton = screen.getByRole('button', { name: 'Connect' });

    fireEvent.keyDown(sourceSelect, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'First task' }));
    fireEvent.keyDown(targetSelect, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'First task' }));

    expect(connectButton).toBeDisabled();

    fireEvent.keyDown(targetSelect, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'Second task' }));
    expect(connectButton).toBeEnabled();
  });

  it('refreshes when task relationships change in another open view', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );
    await screen.findByText('First task');
    const renderedFlow = screen.getByTestId('project-react-flow');
    expect(fetch).toHaveBeenCalledTimes(1);

    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    act(() => announceTaskRelationshipsChanged(['task-1', 'task-2']));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('project-react-flow')).toBe(renderedFlow));
    expect(screen.queryByText('Arranging project graph...')).not.toBeInTheDocument();
    animationFrame.mockRestore();
  });
});

describe('ProjectStructureGraph dependencies', () => {
  beforeEach(() => {
    flowProps.current = null;
    toastError.mockReset();
    toastSuccess.mockReset();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ graph }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 })));
  });

  it('shows dependency details and removes the selected dependency', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    const dependencyEdge = await screen.findByTestId('flow-edge-dependency:dependency-1');
    expect(dependencyEdge).toHaveAccessibleName(
      'First task blocks Second task, Synced with source',
    );
    const edgeClickHandler = flowProps.current?.onEdgeClick;
    const selectionChangeHandler = flowProps.current?.onSelectionChange;
    fireEvent.click(dependencyEdge);

    const details = screen.getByRole('heading', { name: 'Blocks' }).closest('aside');
    expect(details).not.toBeNull();
    expect(within(details!).getByText('First task')).toBeInTheDocument();
    expect(within(details!).getByText('Second task')).toBeInTheDocument();
    expect(flowProps.current?.onEdgeClick).toBe(edgeClickHandler);
    expect(flowProps.current?.onSelectionChange).toBe(selectionChangeHandler);

    fireEvent.click(screen.getByRole('button', { name: 'Remove dependency' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove dependency' })[1]);

    await waitFor(() => {
      expect(fetch).toHaveBeenLastCalledWith(
        '/api/projects/project-1/task-dependencies/dependency-1',
        { method: 'DELETE' },
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Blocks' })).not.toBeInTheDocument();
    });
    expect(toastSuccess).toHaveBeenCalledWith('Dependency removed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('opens dependency details when a focused edge is selected with the keyboard', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    const dependencyEdge = await screen.findByTestId('flow-edge-dependency:dependency-1');
    dependencyEdge.focus();
    fireEvent.keyDown(dependencyEdge, { key: 'Enter' });

    expect(screen.getByRole('heading', { name: 'Blocks' })).toBeInTheDocument();
  });

  it('closes dependency details when the selected edge is clicked again', async () => {
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
      />,
    );

    const dependencyEdge = await screen.findByTestId('flow-edge-dependency:dependency-1');
    fireEvent.click(dependencyEdge);
    expect(screen.getByRole('heading', { name: 'Blocks' })).toBeInTheDocument();
    expect(dependencyEdge).toHaveAttribute('data-selected', 'true');

    fireEvent.click(dependencyEdge);
    expect(screen.queryByRole('heading', { name: 'Blocks' })).not.toBeInTheDocument();
    expect(dependencyEdge).not.toHaveAttribute('data-selected', 'true');
  });

  it('opens and removes phase dependency details from the phase edge', async () => {
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ graph: phaseDependencyGraph }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ phase: {} }), { status: 200 }));

    const onPhaseDependencyRemoved = vi.fn();
    render(
      <ProjectStructureGraph
        projectId="project-1"
        onTaskSelect={vi.fn()}
        onPhaseDependencyRemoved={onPhaseDependencyRemoved}
      />,
    );

    const dependencyEdge = await screen.findByTestId(
      'flow-edge-blocks:phase:phase-1:phase:phase-2',
    );
    expect(dependencyEdge).toHaveAccessibleName(
      'Planning blocks Implementation, Local only',
    );
    fireEvent.click(dependencyEdge);

    const details = screen.getByRole('heading', { name: 'Blocks' }).closest('aside');
    expect(details).not.toBeNull();
    expect(within(details!).getByText('Blocking phase')).toBeInTheDocument();
    expect(within(details!).getByText('Planning')).toBeInTheDocument();
    expect(within(details!).getByText('Blocked phase')).toBeInTheDocument();
    expect(within(details!).getByText('Implementation')).toBeInTheDocument();
    expect(dependencyEdge).toHaveAttribute('data-selected', 'true');
    expect(screen.queryByLabelText('Manage existing dependency')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove dependency' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove dependency' })[1]);

    await waitFor(() => {
      expect(fetch).toHaveBeenLastCalledWith('/api/project-phases/phase-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startAfterPhaseId: null }),
      });
    });
    expect(onPhaseDependencyRemoved).toHaveBeenCalledWith('phase-2');
    expect(toastSuccess).toHaveBeenCalledWith('Dependency removed');
  });
});

const statusCases: Array<[GraphNodeStatus, string, string]> = [
  ['todo', 'To do', '#94a3b8'],
  ['in_progress', 'In progress', '#60a5fa'],
  ['done', 'Done', '#34d399'],
  ['blocked', 'Blocked', '#f87171'],
];

describe('ProjectStructureGraph status treatment', () => {
  it.each(statusCases)('gives %s nodes a filled status treatment', (status, label, color) => {
    render(
      <StructureNode
        id={`task-${status}`}
        type="task"
        data={{
          graphNode: {
            id: `task-${status}`,
            entityId: `task-${status}`,
            kind: 'task',
            label: `${label} task`,
            status,
          },
          direction: 'horizontal',
          canCollapse: false,
          isCollapsed: false,
          onSelect: vi.fn(),
          onToggleCollapse: vi.fn(),
        }}
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        draggable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />,
    );

    const node = screen.getByRole('button', { name: `Open task ${label} task` }).parentElement;
    const marker = screen.getByText(label).firstElementChild;

    expect(node).toHaveAttribute('data-status', status);
    expect(node).toHaveStyle({ '--node-status-color': color });
    expect(marker).toHaveClass('h-2.5', 'w-2.5');
  });
});
