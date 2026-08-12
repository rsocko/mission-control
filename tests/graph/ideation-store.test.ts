import { beforeEach, describe, expect, it } from 'vitest';
import { useIdeationStore } from '@/lib/stores/ideationStore';

describe('useIdeationStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useIdeationStore.getState().clear();
  });

  it('keeps one hierarchy for outline and mind-map consumers', () => {
    const root = useIdeationStore.getState().nodes[0];
    const phaseId = useIdeationStore.getState().addNode(root.id, 'phase', 'Build');
    const taskId = useIdeationStore.getState().addNode(phaseId, 'task', 'Implement');

    expect(useIdeationStore.getState().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: phaseId, parentId: root.id, kind: 'phase' }),
      expect.objectContaining({ id: taskId, parentId: phaseId, kind: 'task' }),
    ]));
  });

  it('reparents and reorders nodes without allowing cycles', () => {
    const root = useIdeationStore.getState().nodes[0];
    const first = useIdeationStore.getState().addNode(root.id, 'idea', 'First');
    const second = useIdeationStore.getState().addNode(root.id, 'idea', 'Second');
    const child = useIdeationStore.getState().addNode(first, 'task', 'Child');

    useIdeationStore.getState().moveNode(second, first, 0);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === second)?.parentId).toBe(first);

    useIdeationStore.getState().moveNode(first, child, 0);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === first)?.parentId).toBe(root.id);

    const historyLength = useIdeationStore.getState().past.length;
    useIdeationStore.getState().moveNode(second, 'missing-parent', 0);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === second)?.parentId).toBe(first);
    expect(useIdeationStore.getState().past).toHaveLength(historyLength);
  });

  it('inserts a node at a requested sibling position in one history step', () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().addNode(root.id, 'idea', 'First');
    useIdeationStore.getState().addNode(root.id, 'idea', 'Last');
    const historyLength = useIdeationStore.getState().past.length;

    useIdeationStore.getState().addNode(root.id, 'idea', 'Middle', 1);

    expect(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === root.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((node) => ({ label: node.label, order: node.sortOrder })),
    ).toEqual([
      { label: 'First', order: 0 },
      { label: 'Middle', order: 1 },
      { label: 'Last', order: 2 },
    ]);
    expect(useIdeationStore.getState().past).toHaveLength(historyLength + 1);
  });

  it('does not add undo history when title input is committed twice', () => {
    const root = useIdeationStore.getState().nodes[0];
    const taskId = useIdeationStore.getState().addNode(root.id, 'task', 'Original');

    useIdeationStore.getState().applyTitleInput(taskId, 'Edited !high #keyboard');
    const historyLength = useIdeationStore.getState().past.length;
    useIdeationStore.getState().applyTitleInput(taskId, 'Edited !high #keyboard');

    expect(useIdeationStore.getState().past).toHaveLength(historyLength);
  });

  it('applies a text outline as one undoable graph update', () => {
    const root = useIdeationStore.getState().nodes[0];
    const historyLength = useIdeationStore.getState().past.length;

    useIdeationStore.getState().applyTextOutline([
      root.label,
      '  [phase] Discovery',
      '    [task] Interview users !high',
    ].join('\n'));

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
    expect(useIdeationStore.getState().past).toHaveLength(historyLength + 1);
    useIdeationStore.getState().undo();
    expect(useIdeationStore.getState().nodes).toHaveLength(1);
  });

  it('supports indent, outdent, branch deletion, and undo', () => {
    const root = useIdeationStore.getState().nodes[0];
    const first = useIdeationStore.getState().addNode(root.id, 'idea', 'First');
    const second = useIdeationStore.getState().addNode(root.id, 'task', 'Second');

    useIdeationStore.getState().indentNode(second);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === second)?.parentId).toBe(first);
    useIdeationStore.getState().outdentNode(second);
    expect(useIdeationStore.getState().nodes.find((node) => node.id === second)?.parentId).toBe(root.id);

    useIdeationStore.getState().deleteNode(first);
    expect(useIdeationStore.getState().nodes.some((node) => node.id === first)).toBe(false);
    useIdeationStore.getState().undo();
    expect(useIdeationStore.getState().nodes.some((node) => node.id === first)).toBe(true);
  });

  it('promotes nodes and stores parsed properties', () => {
    const root = useIdeationStore.getState().nodes[0];
    const nodeId = useIdeationStore.getState().addNode(root.id);
    useIdeationStore.getState().updateKind(nodeId, 'task');
    useIdeationStore.getState().setProperty(nodeId, {
      key: 'priority',
      rawValue: 'high',
      value: 'high',
    });

    expect(useIdeationStore.getState().nodes.find((node) => node.id === nodeId)).toEqual(
      expect.objectContaining({
        kind: 'task',
        properties: {
          priority: expect.objectContaining({ value: 'high' }),
        },
      }),
    );
  });

  it('commits title accelerators and their properties in one undo step', () => {
    const root = useIdeationStore.getState().nodes[0];
    const nodeId = useIdeationStore.getState().addNode(root.id, 'task', 'Draft task');
    const historyBefore = useIdeationStore.getState().past.length;

    useIdeationStore.getState().applyTitleInput(nodeId, 'Fix auth !high #backend');
    const node = useIdeationStore.getState().nodes.find((candidate) => candidate.id === nodeId);

    expect(node).toEqual(expect.objectContaining({
      label: 'Fix auth',
      properties: expect.objectContaining({
        priority: expect.objectContaining({ value: 'high' }),
        tags: expect.objectContaining({ value: ['backend'] }),
      }),
    }));
    expect(useIdeationStore.getState().past).toHaveLength(historyBefore + 1);
    useIdeationStore.getState().undo();
    expect(useIdeationStore.getState().nodes.find((candidate) => candidate.id === nodeId)?.label).toBe('Draft task');
  });

  it('accepts proposals atomically, ignores duplicates, and undoes the whole batch', () => {
    const root = useIdeationStore.getState().nodes[0];
    useIdeationStore.getState().addNode(root.id, 'idea', 'Existing');
    const historyBeforeAccept = useIdeationStore.getState().past.length;

    const added = useIdeationStore.getState().acceptProposals(root.id, [
      { label: 'First proposal' },
      { label: ' first   proposal ' },
      { label: 'Existing' },
      { label: 'Second proposal' },
    ]);

    expect(added).toHaveLength(2);
    expect(useIdeationStore.getState().past).toHaveLength(historyBeforeAccept + 1);
    expect(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === root.id)
        .map((node) => ({ label: node.label, kind: node.kind, order: node.sortOrder })),
    ).toEqual([
      { label: 'Existing', kind: 'idea', order: 0 },
      { label: 'First proposal', kind: 'idea', order: 1 },
      { label: 'Second proposal', kind: 'idea', order: 2 },
    ]);

    useIdeationStore.getState().undo();
    expect(useIdeationStore.getState().nodes.some((node) => added.includes(node.id))).toBe(false);
  });
});
