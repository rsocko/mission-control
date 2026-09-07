import React, { type MouseEvent, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import type { ProjectSubgraph } from '@/lib/graph/types';

interface MockReactFlowProps {
  nodes: Node[];
  edges: Edge[];
  onNodeMouseEnter?: (event: MouseEvent, node: Node) => void;
  onNodeMouseLeave?: (event: MouseEvent, node: Node) => void;
  onNodesChange?: (changes: NodeChange<Node>[]) => void;
  onPaneClick?: () => void;
  onInit?: (instance: {
    fitView: () => Promise<boolean>;
    getViewport: () => { x: number; y: number; zoom: number };
    setViewport: (viewport: { x: number; y: number; zoom: number }) => Promise<boolean>;
  }) => void;
  children?: ReactNode;
}

const setViewport = vi.fn(async () => true);

vi.mock('@xyflow/react', async () => {
  const ReactLib = await import('react');

  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    MiniMap: () => null,
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
    ReactFlow: ({
      children,
      edges,
      nodes,
      onNodeMouseEnter,
      onNodeMouseLeave,
      onNodesChange,
      onPaneClick,
      onInit,
    }: MockReactFlowProps) => {
      onInit?.({
        fitView: async () => true,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        setViewport,
      });
      return (
        <div data-testid="graph-pane" onClick={onPaneClick}>
        {nodes.map((node) => (
          <React.Fragment key={node.id}>
            <button
              type="button"
              data-testid={`graph-node-${node.id}`}
              data-focus={node.data.focusState}
              data-selected={node.selected}
              onClick={(event) => {
                event.stopPropagation();
                onNodesChange?.([{ id: node.id, type: 'select', selected: true }]);
                const data = node.data as {
                  graphNode: ProjectSubgraph['nodes'][number];
                  onSelect: (selectedNode: ProjectSubgraph['nodes'][number]) => void;
                };
                data.onSelect(data.graphNode);
              }}
              onMouseEnter={(event) => onNodeMouseEnter?.(event, node)}
              onMouseLeave={(event) => onNodeMouseLeave?.(event, node)}
            >
              {(node.data.graphNode as ProjectSubgraph['nodes'][number]).label}
            </button>
            {node.data.canCollapse ? (
              <button
                type="button"
                aria-label={`${node.data.isCollapsed ? 'Expand' : 'Collapse'} tasks under ${
                  (node.data.graphNode as ProjectSubgraph['nodes'][number]).label
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  (node.data.onToggleCollapse as (nodeId: string) => void)(node.id);
                }}
              />
            ) : null}
          </React.Fragment>
        ))}
        {edges.map((edge) => (
          <span
            key={edge.id}
            data-testid={`graph-edge-${edge.id}`}
            data-opacity={edge.style?.opacity}
          />
        ))}
        {children}
        </div>
      );
    },
    useEdgesState: <T extends Edge>(initial: T[]) => {
      const [edges, setEdges] = ReactLib.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
    useNodesState: <T extends Node>(initial: T[]) => {
      const [nodes, setNodes] = ReactLib.useState(initial);
      const onNodesChange = (changes: NodeChange<T>[]) => {
        setNodes((current) => current.map((node) => {
          const selection = changes.find((change) => change.type === 'select' && change.id === node.id);
          return selection && selection.type === 'select'
            ? { ...node, selected: selection.selected }
            : node;
        }));
      };
      return [nodes, setNodes, onNodesChange];
    },
  };
});

import ProjectStructureGraph from '@/components/graph/ProjectStructureGraph';

const graph: ProjectSubgraph = {
  nodes: [
    { id: 'project:1', entityId: '1', kind: 'project', label: 'Project', status: 'todo' },
    { id: 'phase:1', entityId: '1', kind: 'phase', label: 'Phase one', status: 'todo' },
    { id: 'task:1', entityId: '1', kind: 'task', label: 'Task one', status: 'todo' },
    { id: 'phase:2', entityId: '2', kind: 'phase', label: 'Phase two', status: 'todo' },
    { id: 'task:2', entityId: '2', kind: 'task', label: 'Task two', status: 'todo' },
  ],
  edges: [
    { id: 'project-phase-1', source: 'project:1', target: 'phase:1', type: 'contains', provenance: 'derived' },
    { id: 'phase-1-task-1', source: 'phase:1', target: 'task:1', type: 'contains', provenance: 'derived' },
    { id: 'project-phase-2', source: 'project:1', target: 'phase:2', type: 'contains', provenance: 'derived' },
    { id: 'phase-2-task-2', source: 'phase:2', target: 'task:2', type: 'contains', provenance: 'derived' },
  ],
  truncated: false,
};

describe('ProjectStructureGraph focus interactions', () => {
  beforeEach(() => {
    setViewport.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ graph }),
    }));
  });

  it('previews connections on hover and locks descendants plus direct relations on click', async () => {
    render(<ProjectStructureGraph projectId="1" onTaskSelect={vi.fn()} />);

    const phaseOne = await screen.findByTestId('graph-node-phase:1');
    expect(document.querySelector('[data-workbench-capability="canvas"]')).toBeInTheDocument();
    const project = screen.getByTestId('graph-node-project:1');
    const taskOne = screen.getByTestId('graph-node-task:1');
    const phaseTwo = screen.getByTestId('graph-node-phase:2');

    fireEvent.mouseEnter(phaseOne);
    expect(project).toHaveAttribute('data-focus', 'emphasized');
    expect(taskOne).toHaveAttribute('data-focus', 'emphasized');
    expect(phaseTwo).toHaveAttribute('data-focus', 'dimmed');

    fireEvent.mouseLeave(phaseOne);
    expect(phaseTwo).not.toHaveAttribute('data-focus');

    fireEvent.click(phaseOne);
    expect(phaseOne).toHaveAttribute('data-focus', 'emphasized');
    expect(phaseOne).toHaveAttribute('data-selected', 'true');
    expect(taskOne).toHaveAttribute('data-focus', 'emphasized');
    expect(project).toHaveAttribute('data-focus', 'emphasized');
    expect(screen.getByTestId('graph-edge-project-phase-1')).toHaveAttribute('data-opacity', '1');
    expect(screen.getByTestId('graph-edge-phase-1-task-1')).toHaveAttribute('data-opacity', '1');
    expect(screen.getByTestId('graph-edge-project-phase-2')).toHaveAttribute('data-opacity', '0.12');
    expect(screen.getByRole('heading', { name: 'Phase one' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(project).not.toHaveAttribute('data-focus'));
    expect(phaseOne).not.toHaveAttribute('data-selected', 'true');
    expect(screen.queryByRole('heading', { name: 'Phase one' })).not.toBeInTheDocument();

    fireEvent.click(phaseOne);
    fireEvent.click(screen.getByTestId('graph-pane'));
    await waitFor(() => expect(taskOne).not.toHaveAttribute('data-focus'));
  });

  it('closes task details and clears selection when the selected task is clicked again', async () => {
    function GraphWithTaskDetails() {
      const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
      return (
        <>
          <ProjectStructureGraph
            projectId="1"
            selectedTaskId={selectedTaskId}
            onTaskSelect={setSelectedTaskId}
          />
          {selectedTaskId ? (
            <aside>
              Task details for {selectedTaskId}
              <button type="button" onClick={() => setSelectedTaskId(null)}>
                Close task details
              </button>
            </aside>
          ) : null}
        </>
      );
    }

    render(<GraphWithTaskDetails />);

    const taskOne = await screen.findByTestId('graph-node-task:1');
    fireEvent.click(taskOne);
    expect(screen.getByText('Task details for 1')).toBeInTheDocument();
    expect(taskOne).toHaveAttribute('data-focus', 'emphasized');
    expect(taskOne).toHaveAttribute('data-selected', 'true');

    fireEvent.click(taskOne);
    expect(screen.queryByText('Task details for 1')).not.toBeInTheDocument();
    expect(taskOne).not.toHaveAttribute('data-focus');
    expect(taskOne).not.toHaveAttribute('data-selected', 'true');
  });

  it('clears stale graph focus when task details close outside the graph', async () => {
    function GraphWithTaskDetails() {
      const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
      return (
        <>
          <ProjectStructureGraph
            projectId="1"
            selectedTaskId={selectedTaskId}
            onTaskSelect={setSelectedTaskId}
          />
          {selectedTaskId ? (
            <button type="button" onClick={() => setSelectedTaskId(null)}>
              Close task details
            </button>
          ) : null}
        </>
      );
    }

    render(<GraphWithTaskDetails />);

    const taskOne = await screen.findByTestId('graph-node-task:1');
    fireEvent.click(taskOne);
    fireEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    await waitFor(() => expect(taskOne).not.toHaveAttribute('data-selected', 'true'));
    expect(taskOne).not.toHaveAttribute('data-focus');

    fireEvent.click(taskOne);
    expect(screen.getByRole('button', { name: 'Close task details' })).toBeInTheDocument();
  });

  it('toggles phase focus and switches directly between selected nodes', async () => {
    const onTaskSelect = vi.fn();
    render(<ProjectStructureGraph projectId="1" onTaskSelect={onTaskSelect} />);

    const phaseOne = await screen.findByTestId('graph-node-phase:1');
    const taskOne = screen.getByTestId('graph-node-task:1');
    const taskTwo = screen.getByTestId('graph-node-task:2');

    fireEvent.click(phaseOne);
    expect(screen.getByRole('heading', { name: 'Phase one' })).toBeInTheDocument();
    expect(phaseOne).toHaveAttribute('data-selected', 'true');

    fireEvent.click(phaseOne);
    expect(screen.queryByRole('heading', { name: 'Phase one' })).not.toBeInTheDocument();
    expect(phaseOne).not.toHaveAttribute('data-focus');
    expect(phaseOne).not.toHaveAttribute('data-selected', 'true');

    fireEvent.click(taskOne);
    fireEvent.click(taskTwo);
    expect(taskOne).toHaveAttribute('data-focus', 'dimmed');
    expect(taskOne).not.toHaveAttribute('data-selected', 'true');
    expect(taskTwo).toHaveAttribute('data-focus', 'emphasized');
    expect(taskTwo).toHaveAttribute('data-selected', 'true');
    expect(onTaskSelect).toHaveBeenLastCalledWith('2');
  });

  it('navigates backward through shared graph focus history', async () => {
    render(<ProjectStructureGraph projectId="1" onTaskSelect={vi.fn()} />);

    const phaseOne = await screen.findByTestId('graph-node-phase:1');
    const taskTwo = screen.getByTestId('graph-node-task:2');
    fireEvent.click(phaseOne);
    fireEvent.click(taskTwo);

    const previous = screen.getByRole('button', { name: 'Previous graph focus' });
    expect(previous).toBeEnabled();
    fireEvent.click(previous);

    await waitFor(() => expect(phaseOne).toHaveAttribute('data-selected', 'true'));
    expect(taskTwo).not.toHaveAttribute('data-selected', 'true');
    expect(setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 });
  });

  it('retargets hidden task selection to its collapsed phase', async () => {
    const onTaskSelect = vi.fn();
    render(<ProjectStructureGraph projectId="1" onTaskSelect={onTaskSelect} />);

    const taskOne = await screen.findByTestId('graph-node-task:1');
    fireEvent.click(taskOne);
    expect(onTaskSelect).toHaveBeenLastCalledWith('1');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse tasks under Phase one' }));

    await screen.findByTestId('graph-node-phase:1');
    expect(screen.getByRole('heading', { name: 'Phase one' })).toBeInTheDocument();
    expect(screen.queryByTestId('graph-node-task:1')).not.toBeInTheDocument();
    expect(onTaskSelect).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: 'Next graph focus' })).toBeDisabled();
  });
});
