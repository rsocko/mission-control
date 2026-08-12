import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdeationStore } from '@/lib/stores/ideationStore';

const { closedTreeIds, flowNodes, treeProps, treeDragId } = vi.hoisted(() => ({
  closedTreeIds: new Set<string>(),
  flowNodes: { current: [] as Array<Record<string, unknown>> },
  treeProps: { current: null as Record<string, unknown> | null },
  treeDragId: { current: null as string | null },
}));

interface TreeDatum {
  id: string;
  label: string;
  children: TreeDatum[];
  proposal?: { id: string };
}

interface FakeTreeNode {
  id: string;
  data: TreeDatum;
  level: number;
  parent: FakeTreeNode | null;
  children: FakeTreeNode[] | null;
  nextSibling: FakeTreeNode | null;
  isRoot: boolean;
  isSelected: boolean;
  isOpen: boolean;
  isInternal: boolean;
  isDragging: boolean;
  isAncestorOf: (node: FakeTreeNode) => boolean;
  toggle: () => void;
  open: () => void;
  next: FakeTreeNode | null;
  prev: FakeTreeNode | null;
  tree: { scrollTo: ReturnType<typeof vi.fn> };
}

interface FakeTreeApi {
  dragNodes: FakeTreeNode[];
  selectedNodes: FakeTreeNode[];
}

vi.mock('react-arborist', () => ({
  Tree: (props: {
    data: TreeDatum[];
    selection?: string;
    selectionFollowsFocus?: boolean;
    onActivate?: (node: FakeTreeNode) => void;
    onFocus?: (node: FakeTreeNode) => void;
    children: React.ComponentType<{
      node: FakeTreeNode;
      style: React.CSSProperties;
      dragHandle: React.Ref<HTMLDivElement>;
      tree: FakeTreeApi;
    }>;
  }) => {
    treeProps.current = props as Record<string, unknown>;
    const { data, children: Row, selection } = props;
    const parentById = new Map<string, string | null>();
    const datumById = new Map<string, TreeDatum>();
    const levelById = new Map<string, number>();
    const indexNode = (datum: TreeDatum, parentId: string | null, level: number) => {
      parentById.set(datum.id, parentId);
      datumById.set(datum.id, datum);
      levelById.set(datum.id, level);
      datum.children.forEach((child) => indexNode(child, datum.id, level + 1));
    };
    data.forEach((datum) => indexNode(datum, null, 0));
    const nodeById = new Map<string, FakeTreeNode>();
    const makeNode = (datum: TreeDatum): FakeTreeNode => {
      const existing = nodeById.get(datum.id);
      if (existing) return existing;

      const parentId = parentById.get(datum.id) ?? null;
      const parentDatum = parentId ? datumById.get(parentId) : null;
      const siblings = parentDatum?.children ?? data;
      const siblingIndex = siblings.findIndex((sibling) => sibling.id === datum.id);
      const nextSibling = siblings[siblingIndex + 1];

      const node: FakeTreeNode = {
        id: datum.id,
        data: datum,
        level: levelById.get(datum.id) ?? 0,
        parent: null,
        children: null,
        nextSibling: null,
        isRoot: false,
        isSelected: datum.id === selection,
        isOpen: true,
        // Arborist treats a supplied children array as internal, even when it is empty.
        isInternal: true,
        isDragging: datum.id === treeDragId.current,
        isAncestorOf: (candidate) => {
          if (candidate.id === datum.id) return true;
          let candidateParentId = parentById.get(candidate.id) ?? null;
          while (candidateParentId) {
            if (candidateParentId === datum.id) return true;
            candidateParentId = parentById.get(candidateParentId) ?? null;
          }
          return false;
        },
        toggle: vi.fn(),
        open: () => closedTreeIds.delete(datum.id),
        next: null,
        prev: null,
        tree: { scrollTo: vi.fn() },
      };

      nodeById.set(datum.id, node);
      node.parent = parentDatum ? makeNode(parentDatum) : null;
      node.children = datum.children.length ? datum.children.map(makeNode) : null;
      node.nextSibling = nextSibling ? makeNode(nextSibling) : null;
      return node;
    };
    const flattened: TreeDatum[] = [];
    const flatten = (datum: TreeDatum) => {
      flattened.push(datum);
      if (!closedTreeIds.has(datum.id)) datum.children.forEach(flatten);
    };
    data.forEach(flatten);
    const scrollTo = vi.fn();
    const nodes = flattened.map(makeNode);
    nodes.forEach((node, index) => {
      node.prev = nodes[index - 1] ?? null;
      node.next = nodes[index + 1] ?? null;
      node.isOpen = !closedTreeIds.has(node.id);
      node.open = () => closedTreeIds.delete(node.id);
      node.tree = { scrollTo };
    });
    const draggedNode = treeDragId.current
      ? nodeById.get(treeDragId.current) ?? null
      : null;
    const selectedNode = selection ? nodeById.get(selection) ?? null : null;
    const tree = {
      dragNodes: draggedNode ? [draggedNode] : [],
      selectedNodes: selectedNode ? [selectedNode] : [],
    };
    return <div role="tree" tabIndex={0}>{nodes.map((node) => (
      <React.Fragment key={node.id}>
        <Row
          node={node}
          style={{}}
          dragHandle={null}
          tree={tree}
        />
      </React.Fragment>
    ))}</div>;
  },
}));

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  ReactFlow: ({
    nodes,
    nodeTypes,
  }: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    nodeTypes: Record<string, React.ComponentType<{
      data: Record<string, unknown>;
      selected: boolean;
    }>>;
  }) => (
    <div ref={() => { flowNodes.current = nodes; }}>
      {nodes.map((node) => {
        const Card = nodeTypes[node.type];
        return <Card key={node.id} data={node.data} selected={false} />;
      })}
    </div>
  ),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import IdeationCanvas from '@/components/ideation/IdeationCanvas';

const realAcceptProposals = useIdeationStore.getState().acceptProposals;

const proposals = [
  { id: 'p1', label: 'Research users', rationale: 'Understand needs.' },
  { id: 'p2', label: 'Map constraints', rationale: 'Find boundaries.' },
  { id: 'p3', label: 'Prototype flow', rationale: 'Test the approach.' },
];

function mockExpansionResponse() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      contextVersion: string;
      selectedNode: { id: string };
    };
    return new Response(JSON.stringify({
      proposals,
      contextVersion: body.contextVersion,
      selectedNodeId: body.selectedNode.id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('IdeationCanvas AI expansion', () => {
  beforeEach(() => {
    localStorage.clear();
    closedTreeIds.clear();
    useIdeationStore.getState().clear();
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().selectNode(root.id);
    useIdeationStore.setState({ acceptProposals: realAcceptProposals });
    treeDragId.current = null;
    vi.restoreAllMocks();
  });

  it('shows the same ghost proposal in outline and mind map, then accepts all atomically', async () => {
    mockExpansionResponse();

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));

    await waitFor(() => {
      expect(screen.getAllByLabelText('AI suggestion: Research users')).toHaveLength(2);
    });

    const outlineProps = treeProps.current as {
      disableSelect: (node: TreeDatum) => boolean;
      disableDrop: (args: { parentNode: { data: TreeDatum } }) => boolean;
    };
    const ghost = {
      id: 'ai:p1',
      label: 'Research users',
      children: [],
      proposal: { id: 'p1' },
    };
    expect(outlineProps.disableSelect(ghost)).toBe(true);
    expect(outlineProps.disableDrop({ parentNode: { data: ghost } })).toBe(true);
    expect(flowNodes.current.find((node) => node.id === 'ai:p1')).toEqual(
      expect.objectContaining({ draggable: false, selectable: false }),
    );
    const proposalRow = document.querySelector('[data-outline-node-id="ai:p1"]');
    expect(proposalRow).toHaveClass('h-full');
    expect(proposalRow?.querySelector('[data-guide="elbow"]')).toBeInTheDocument();
    expect(proposalRow?.querySelector('[data-outline-marker="dot"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all (3)' }));

    expect(useIdeationStore.getState().nodes).toHaveLength(4);
    expect(useIdeationStore.getState().past).toHaveLength(1);
  });

  it('shows leaf-safe disclosure controls with continuous curved depth guides', () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Plan launch');
    useIdeationStore.getState().addNode(root.id, 'phase', 'Ship launch');
    const childId = useIdeationStore.getState().addNode(parentId, 'task', 'Write brief');
    useIdeationStore.getState().selectNode(childId);

    render(<IdeationCanvas />);

    const rootRow = document.querySelector(`[data-outline-node-id="${root.id}"]`);
    const parentRow = document.querySelector(`[data-outline-node-id="${parentId}"]`);
    const childRow = document.querySelector(`[data-outline-node-id="${childId}"]`);

    expect(rootRow).toHaveClass('h-full');
    expect(parentRow).toHaveClass('h-full');
    expect(childRow).toHaveClass('h-full');
    expect(rootRow?.querySelector('[data-guide="children"]')).toBeInTheDocument();
    expect(parentRow?.querySelector('[data-guide="current"]')).toHaveStyle({ top: '18px', bottom: '-1px' });
    expect(parentRow?.querySelector('[data-guide="elbow"]')).toHaveStyle({
      left: '12px',
      width: '18px',
      height: '19px',
    });
    expect(parentRow?.querySelector('[data-guide="children"]')).toHaveStyle({
      top: '18px',
      bottom: '-1px',
    });
    expect(screen.getByRole('button', { name: `Collapse ${root.label}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Plan launch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse Write brief' })).not.toBeInTheDocument();
    expect(childRow?.querySelector('[data-guide="continuation"]')).toHaveStyle({ left: '12px' });
    expect(childRow?.querySelector('[data-guide="elbow"]')).toHaveStyle({
      left: '30px',
      width: '18px',
      height: '19px',
    });
    expect(childRow?.querySelector('[data-guide="current"]')).not.toBeInTheDocument();
    expect(parentRow?.querySelector('[data-outline-marker="dot"]')).toBeInTheDocument();
    expect(parentRow?.querySelector('[data-outline-marker="chevron"]')).toBeInTheDocument();
    expect(childRow?.querySelector('[data-outline-marker="dot"]')).toBeInTheDocument();
    expect(childRow?.querySelector('[data-outline-marker="chevron"]')).not.toBeInTheDocument();
    expect(childRow?.querySelector('[data-outline-guides]')).toHaveAttribute('data-active', 'true');
  });

  it('preserves outline Enter/Tab semantics and exposes a real slash command menu', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Keyboard task');
    useIdeationStore.getState().selectNode(taskId);
    render(<IdeationCanvas />);
    const title = screen.getByRole('textbox', { name: 'Task title' });

    fireEvent.change(title, { target: { value: 'Keyboard task !high #keyboard' } });
    fireEvent.keyDown(title, { key: 'Tab' });
    expect(useIdeationStore.getState().nodes.find((node) => node.id === taskId)).toEqual(
      expect.objectContaining({
        label: 'Keyboard task',
        parentId: root.id,
        properties: expect.objectContaining({
          priority: expect.objectContaining({ value: 'high' }),
          tags: expect.objectContaining({ value: ['keyboard'] }),
        }),
      }),
    );

    fireEvent.keyDown(title, { key: 'Enter' });
    expect(useIdeationStore.getState().nodes.filter((node) => node.parentId === root.id)).toHaveLength(2);

    const propertyToggle = screen.getByRole('button', { name: 'Add property to Keyboard task' });
    fireEvent.click(propertyToggle);
    expect(screen.getAllByLabelText('Inline property')).toHaveLength(2);
    fireEvent.click(propertyToggle);
    expect(screen.getAllByLabelText('Inline property')).toHaveLength(1);

    fireEvent.keyDown(document.body, { key: 'a' });
    expect(screen.getByText('assignee shortcut')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Inline property')).toHaveTextContent('assignee::');
    });

    fireEvent.change(title, { target: { value: '' } });
    fireEvent.blur(title);
    expect(title).toHaveValue('Keyboard task');
    fireEvent.change(title, { target: { value: '/' } });
    const slashMenu = screen.getByRole('menu', { name: 'Ideation commands' });
    const firstSlashAction = screen.getByRole('menuitem', { name: 'Clear node type' });
    expect(slashMenu).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-activedescendant', firstSlashAction.id);
    fireEvent.keyDown(title, { key: 'ArrowDown' });
    fireEvent.keyDown(title, { key: 'Tab' });
    expect(useIdeationStore.getState().nodes.find((node) => node.id === taskId)?.kind).toBe('phase');
    expect(useIdeationStore.getState().nodes.find((node) => node.id === taskId)?.label).toBe('Keyboard task');
  });

  it('creates a child instead of an invalid second root when Enter is pressed on the project root', () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().selectNode(root.id);
    render(<IdeationCanvas />);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Idea title' }), { key: 'Enter' });

    const nodes = useIdeationStore.getState().nodes;
    expect(nodes.filter((node) => node.parentId === null)).toEqual([expect.objectContaining({ id: root.id })]);
    expect(nodes.some((node) => node.parentId === root.id)).toBe(true);
  });

  it('moves focus between visible outline lines and preserves the cursor column', async () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    useIdeationStore.getState().addNode(root.id, 'task', 'Second task');
    render(<IdeationCanvas />);
    const taskTitles = screen.getAllByRole(
      'textbox',
      { name: 'Task title' },
    ) as HTMLInputElement[];
    const first = taskTitles[0];
    const second = taskTitles[1];
    first.focus();
    first.setSelectionRange(3, 3);

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second.selectionStart).toBe(3);

    fireEvent.keyDown(second, { key: 'ArrowUp' });
    await waitFor(() => expect(first).toHaveFocus());
  });

  it('enters title editing from tree keyboard focus with Enter or F2', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Keyboard task');
    useIdeationStore.getState().selectNode(taskId);
    render(<IdeationCanvas />);
    const outlineProps = treeProps.current as {
      onFocus: (node: FakeTreeNode) => void;
      selectionFollowsFocus: boolean;
    };
    const tree = screen.getByRole('tree');
    const title = screen.getByRole('textbox', { name: 'Task title' });
    const focusedNode = {
      id: taskId,
    } as FakeTreeNode;

    expect(outlineProps.selectionFollowsFocus).toBe(true);
    outlineProps.onFocus(focusedNode);
    tree.focus();
    fireEvent.keyDown(tree, { key: 'Enter' });
    await waitFor(() => expect(title).toHaveFocus());

    tree.focus();
    fireEvent.keyDown(tree, { key: 'F2' });
    await waitFor(() => expect(title).toHaveFocus());
  });

  it('does not steal Enter from outline buttons or activate proposal titles', () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().selectNode(root.id);
    render(<IdeationCanvas />);
    const title = screen.getByRole('textbox', { name: 'Idea title' });
    const propertyButton = screen.getByRole('button', { name: `Add property to ${root.label}` });
    const outlineProps = treeProps.current as {
      onActivate: (node: { id: string; data: TreeDatum }) => void;
    };

    propertyButton.focus();
    fireEvent.keyDown(propertyButton, { key: 'Enter' });
    expect(title).not.toHaveFocus();

    outlineProps.onActivate({
      id: 'ai:proposal',
      data: {
        id: 'ai:proposal',
        label: 'Proposal',
        children: [],
        proposal: { id: 'proposal' },
      },
    });
    expect(useIdeationStore.getState().selectedNodeId).toBe(root.id);
  });

  it('switches to a true text outline and syncs edited lines into graph nodes', async () => {
    const root = useIdeationStore.getState().nodes[0];
    render(<IdeationCanvas />);

    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    const editor = screen.getByRole('textbox', { name: 'Text outline' });
    expect(editor).toHaveValue(root.label);

    fireEvent.change(editor, {
      target: {
        value: `${root.label}\n  [phase] Discovery\n    [task] Interview users !high`,
      },
    });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(useIdeationStore.getState().nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'Discovery', kind: 'phase', parentId: root.id }),
        expect.objectContaining({
          label: 'Interview users',
          kind: 'task',
          properties: expect.objectContaining({
            priority: expect.objectContaining({ value: 'high' }),
          }),
        }),
      ]));
    });
    fireEvent.click(screen.getByRole('button', { name: 'visual' }));
    expect(screen.queryByRole('textbox', { name: 'Text outline' })).not.toBeInTheDocument();
  });

  it('does not autosave a transient blank line while replacing a title', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Original task');
    useIdeationStore.getState().setProperty(taskId, {
      key: 'notes',
      rawValue: 'Keep this note',
      value: 'Keep this note',
    });
    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    const editor = screen.getByRole('textbox', { name: 'Text outline' });

    fireEvent.change(editor, { target: { value: `${root.label}\n  ` } });
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    expect(useIdeationStore.getState().nodes.some((node) => node.id === taskId)).toBe(true);

    fireEvent.change(editor, { target: { value: `${root.label}\n  [task] Renamed task` } });
    fireEvent.blur(editor);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === taskId)).toEqual(
      expect.objectContaining({
        label: 'Renamed task',
        properties: expect.objectContaining({
          notes: expect.objectContaining({ value: 'Keep this note' }),
        }),
      }),
    );
  });

  it('commits an edited title once when ArrowDown moves to the next line', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const firstId = useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    useIdeationStore.getState().addNode(root.id, 'task', 'Second task');
    render(<IdeationCanvas />);
    const taskTitles = screen.getAllByRole('textbox', { name: 'Task title' });
    const historyLength = useIdeationStore.getState().past.length;

    fireEvent.change(taskTitles[0], { target: { value: 'Edited task' } });
    fireEvent.keyDown(taskTitles[0], { key: 'ArrowDown' });

    await waitFor(() => expect(taskTitles[1]).toHaveFocus());
    expect(useIdeationStore.getState().past).toHaveLength(historyLength + 1);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === firstId)?.label).toBe('Edited task');
  });

  it('deletes an empty line with Backspace and focuses the previous line', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const firstId = useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    const secondId = useIdeationStore.getState().addNode(root.id, 'task', 'Second task');
    render(<IdeationCanvas />);
    const taskTitles = screen.getAllByRole('textbox', { name: 'Task title' });

    fireEvent.change(taskTitles[1], { target: { value: '' } });
    fireEvent.keyDown(taskTitles[1], { key: 'Backspace' });

    expect(useIdeationStore.getState().nodes.some((node) => node.id === secondId)).toBe(false);
    await waitFor(() => expect(taskTitles[0]).toHaveFocus());
    expect(useIdeationStore.getState().selectedNodeId).toBe(firstId);
  });

  it('does not delete a branch when Backspace is pressed on its empty title', () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Parent');
    const childId = useIdeationStore.getState().addNode(parentId, 'task', 'Child');
    render(<IdeationCanvas />);
    const parent = screen.getByRole('textbox', { name: 'Phase title' });

    fireEvent.change(parent, { target: { value: '' } });
    fireEvent.keyDown(parent, { key: 'Backspace' });

    expect(useIdeationStore.getState().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: parentId }),
      expect.objectContaining({ id: childId }),
    ]));
  });

  it('does not delete a branch when Delete is pressed on its empty title', () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Parent');
    const childId = useIdeationStore.getState().addNode(parentId, 'task', 'Child');
    render(<IdeationCanvas />);
    const parent = screen.getByRole('textbox', { name: 'Phase title' });

    fireEvent.change(parent, { target: { value: '' } });
    fireEvent.keyDown(parent, { key: 'Delete' });

    expect(useIdeationStore.getState().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: parentId }),
      expect.objectContaining({ id: childId }),
    ]));
  });

  it('lets keyboard users exit the text outline with Escape', () => {
    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    const editor = screen.getByRole('textbox', { name: 'Text outline' });
    editor.focus();

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(editor).not.toHaveFocus();
  });

  it('inserts a sibling after the current line and creates a child with Ctrl+Enter', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const firstId = useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    useIdeationStore.getState().addNode(root.id, 'task', 'Last task');
    useIdeationStore.getState().selectNode(firstId);
    render(<IdeationCanvas />);
    const first = screen.getAllByRole('textbox', { name: 'Task title' })[0];

    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toHaveValue('Untitled'));
    expect(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === root.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((node) => node.label),
    ).toEqual(['First task', 'Untitled', 'Last task']);

    const insertedId = useIdeationStore.getState().selectedNodeId;
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toHaveValue('Untitled'));
    expect(useIdeationStore.getState().nodes).toContainEqual(
      expect.objectContaining({ parentId: insertedId }),
    );
  });

  it('expands a collapsed node before creating and focusing a keyboard child', async () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Collapsed parent');
    useIdeationStore.getState().addNode(parentId, 'task', 'Existing child');
    useIdeationStore.getState().selectNode(parentId);
    closedTreeIds.add(parentId);
    render(<IdeationCanvas />);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Phase title' }), {
      key: 'Enter',
      ctrlKey: true,
    });

    await waitFor(() => expect(document.activeElement).toHaveValue('Untitled'));
    expect(closedTreeIds.has(parentId)).toBe(false);
    expect(useIdeationStore.getState().nodes).toContainEqual(
      expect.objectContaining({ parentId, label: 'Untitled' }),
    );
  });

  it('reorders siblings with Ctrl+Arrow keys while keeping focus on the moved line', async () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    useIdeationStore.getState().addNode(root.id, 'task', 'Second task');
    render(<IdeationCanvas />);
    const second = screen.getAllByRole('textbox', { name: 'Task title' })[1];

    fireEvent.keyDown(second, { key: 'ArrowUp', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toHaveValue('Second task'));
    expect(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === root.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((node) => node.label),
    ).toEqual(['Second task', 'First task']);
  });

  it('shows the full subtree in the outline drag preview', () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Plan launch');
    const childId = useIdeationStore.getState().addNode(parentId, 'task', 'Write brief');
    useIdeationStore.getState().addNode(childId, 'task', 'Review brief');
    render(<IdeationCanvas />);

    const Preview = (treeProps.current as {
      renderDragPreview: React.ComponentType<{
        id: string;
        offset: { x: number; y: number };
        mouse: null;
        dragIds: string[];
        isDragging: boolean;
      }>;
    }).renderDragPreview;
    render(
      <Preview
        id={parentId}
        offset={{ x: 20, y: 30 }}
        mouse={null}
        dragIds={[parentId]}
        isDragging
      />,
    );

    expect(screen.getByText('Moving 3 nodes')).toBeInTheDocument();
    expect(screen.getByText('2 descendants included')).toBeInTheDocument();
  });

  it('marks the dragged outline branch without changing selection', () => {
    const root = useIdeationStore.getState().nodes[0];
    const parentId = useIdeationStore.getState().addNode(root.id, 'phase', 'Plan launch');
    useIdeationStore.getState().addNode(parentId, 'task', 'Write brief');
    useIdeationStore.getState().selectNode(root.id);
    treeDragId.current = parentId;
    render(<IdeationCanvas />);

    expect(screen.getByDisplayValue('Plan launch').closest('[data-drag-state]')).toHaveAttribute(
      'data-drag-state',
      'root',
    );
    expect(screen.getByDisplayValue('Write brief').closest('[data-drag-state]')).toHaveAttribute(
      'data-drag-state',
      'descendant',
    );
    expect(useIdeationStore.getState().selectedNodeId).toBe(root.id);
  });

  it('closes an outline property popover when focus tabs outside it', () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Property task');
    useIdeationStore.getState().selectNode(taskId);
    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'Add property to Property task' }));
    const editors = screen.getAllByLabelText('Inline property');
    expect(editors).toHaveLength(2);

    fireEvent.blur(editors[0], { relatedTarget: document.body });

    expect(screen.getAllByLabelText('Inline property')).toHaveLength(1);
  });

  it('resets inline property drafts when selection changes', () => {
    const root = useIdeationStore.getState().nodes[0];
    const firstId = useIdeationStore.getState().addNode(root.id, 'task', 'First task');
    const secondId = useIdeationStore.getState().addNode(root.id, 'task', 'Second task');
    useIdeationStore.getState().selectNode(firstId);
    render(<IdeationCanvas />);
    const editor = screen.getByLabelText('Inline property');
    editor.textContent = 'priority:: high';
    fireEvent.input(editor);

    act(() => useIdeationStore.getState().selectNode(secondId));

    expect(screen.getByLabelText('Inline property')).toHaveTextContent('');
  });

  it('leaves native text undo inside the inline editor instead of undoing graph state', () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Editable task');
    useIdeationStore.getState().selectNode(taskId);
    render(<IdeationCanvas />);
    const pastLength = useIdeationStore.getState().past.length;

    fireEvent.keyDown(screen.getByLabelText('Inline property'), { key: 'z', ctrlKey: true });

    expect(useIdeationStore.getState().past).toHaveLength(pastLength);
    expect(useIdeationStore.getState().nodes.some((node) => node.id === taskId)).toBe(true);
  });

  it('keeps remaining ghosts synchronized after accepting one proposal', async () => {
    mockExpansionResponse();
    const rootId = useIdeationStore.getState().selectedNodeId;

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Accept suggestion Research users in outline' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Accept suggestion Research users in mind map' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept suggestion Research users in outline' }));

    expect(useIdeationStore.getState().selectedNodeId).toBe(rootId);
    expect(screen.getByRole('button', { name: 'Accept all (2)' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('AI suggestion: Map constraints')).toHaveLength(2);
  });

  it('discards a response when the selected context changes while loading', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));
    const root = useIdeationStore.getState().nodes[0];
    act(() => useIdeationStore.getState().updateLabel(root.id, 'Changed context'));
    resolveResponse(new Response(JSON.stringify({
      proposals,
      contextVersion: 'stale',
      selectedNodeId: root.id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await waitFor(() => {
      expect(screen.queryByLabelText('AI suggestion: Research users')).not.toBeInTheDocument();
    });
  });

  it('bounds long labels before sending expansion context', async () => {
    mockExpansionResponse();
    const root = useIdeationStore.getState().nodes[0];
    act(() => useIdeationStore.getState().updateLabel(root.id, 'x'.repeat(240)));

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const body = JSON.parse(String(init?.body)) as {
      selectedNode: { label: string };
      contextNodes: Array<{ label: string }>;
    };
    expect(body.selectedNode.label).toHaveLength(160);
    expect(body.contextNodes[0].label).toHaveLength(160);
  });

  it('dismisses a rejected single accept and announces one error', async () => {
    mockExpansionResponse();
    useIdeationStore.setState({ acceptProposals: vi.fn(() => []) });

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Accept suggestion Research users in outline' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept suggestion Research users in outline' }));

    expect(screen.queryByLabelText('AI suggestion: Research users')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That suggestion already exists and was dismissed.',
    );
  });

  it('aborts the in-flight UI request when expansion is cancelled', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    });

    render(<IdeationCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Expand' }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel expansion' }));

    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'AI Expand' })).toBeInTheDocument();
  });
});
