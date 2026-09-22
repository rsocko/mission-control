import { create } from 'zustand';
import { toast } from 'sonner';
import {
  GraphDocumentController,
} from '@rsocko/generic-graph-canvas-shared-workbench/controllers';
import {
  isIdeationDescendant,
  type IdeationNode,
  type IdeationNodeKind,
  type IdeationProperty,
} from '@/lib/graph/ideation-types';
import {
  graphDocumentToIdeationNodes,
  ideationNodesToGraphDocument,
  validateIdeationNodes,
} from '@/lib/graph-workbench/adapters';
import { parseIdeationTitleTokens } from '@/lib/ideation/property-parser';
import { reconcileIdeationOutline } from '@/lib/ideation/text-outline';

function createInitialNodes(): IdeationNode[] {
  return [{
    id: crypto.randomUUID(),
    label: 'New Project',
    kind: 'idea',
    parentId: null,
    sortOrder: 0,
    properties: {},
  }];
}

function createController(nodes: readonly IdeationNode[]) {
  return new GraphDocumentController(ideationNodesToGraphDocument(nodes));
}

let controller = createController(createInitialNodes());
const HISTORY_LIMIT = 30;
const undoStack: IdeationNode[][] = [];
const redoStack: IdeationNode[][] = [];

function normalizeSiblingOrder(nodes: IdeationNode[], parentId: string | null): IdeationNode[] {
  const siblings = nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const orderById = new Map(siblings.map((node, index) => [node.id, index]));
  return nodes.map((node) => (
    node.parentId === parentId
      ? { ...node, sortOrder: orderById.get(node.id) ?? node.sortOrder }
      : node
  ));
}

function propertyValuesEqual(
  first: IdeationProperty['value'],
  second: IdeationProperty['value'],
): boolean {
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
  }
  return first === second;
}

function propertiesEqual(first: IdeationProperty | undefined, second: IdeationProperty): boolean {
  return Boolean(
    first
    && first.rawValue === second.rawValue
    && propertyValuesEqual(first.value, second.value),
  );
}

interface IdeationState {
  nodes: IdeationNode[];
  selectedNodeId: string | null;
  workspaceId: string | null;
  workspaceRevision: number | null;
  flushWorkspace: (() => Promise<boolean>) | null;
  canUndo: boolean;
  canRedo: boolean;
  addNode: (
    parentId: string | null,
    kind?: IdeationNodeKind,
    label?: string,
    index?: number,
  ) => string;
  acceptProposals: (
    parentId: string,
    proposals: Array<{ label: string; kind?: IdeationNodeKind }>,
  ) => string[] | null;
  updateLabel: (id: string, label: string) => void;
  applyTitleInput: (id: string, input: string) => void;
  applyTextOutline: (input: string) => boolean;
  updateKind: (id: string, kind: IdeationNodeKind) => void;
  setProperty: (id: string, property: IdeationProperty) => void;
  removeProperty: (id: string, key: IdeationProperty['key']) => void;
  moveNode: (id: string, parentId: string | null, index: number) => void;
  indentNode: (id: string) => void;
  outdentNode: (id: string) => void;
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  setWorkspaceContext: (id: string | null, revision: number | null) => void;
  setWorkspaceFlusher: (flush: (() => Promise<boolean>) | null) => void;
  replaceNodes: (nodes: IdeationNode[]) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}

function controllerProjection() {
  const snapshot = controller.getSnapshot();
  return {
    nodes: graphDocumentToIdeationNodes(snapshot.document),
    selectedNodeId: snapshot.selection?.kind === 'node' ? snapshot.selection.id : null,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

function nodesEqual(first: readonly IdeationNode[], second: readonly IdeationNode[]) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function commitNodes(
  nodes: IdeationNode[],
  set: (patch: Partial<IdeationState>) => void,
  selectedNodeId?: string | null,
): boolean {
  const snapshot = controller.getSnapshot();
  const current = graphDocumentToIdeationNodes(snapshot.document);
  if (nodesEqual(current, nodes)) return false;
  const validation = validateIdeationNodes(nodes);
  if (!validation.valid) {
    toast.error(validation.message);
    return false;
  }
  const executed = controller.execute([{
    type: 'replace-document',
    document: ideationNodesToGraphDocument(validation.nodes),
  }]);
  if (!executed) {
    toast.error(
      controller.getSnapshot().lastError
      ?? 'Unable to apply that graph change. Review the selected nodes and try again.',
    );
    return false;
  }
  undoStack.push(current);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  const previousSelectedNodeId = snapshot.selection?.kind === 'node'
    ? snapshot.selection.id
    : null;
  const nextSelectedNodeId = selectedNodeId === undefined
    ? previousSelectedNodeId
    : selectedNodeId;
  controller = createController(validation.nodes);
  controller.select(
    nextSelectedNodeId && validation.nodes.some((node) => node.id === nextSelectedNodeId)
      ? { kind: 'node', id: nextSelectedNodeId }
      : undefined,
  );
  set(controllerProjection());
  return true;
}

const initialProjection = controllerProjection();

export const useIdeationStore = create<IdeationState>()((set, get) => ({
  ...initialProjection,
  workspaceId: null,
  workspaceRevision: null,
  flushWorkspace: null,
  addNode: (parentId, kind = 'idea', label = 'Untitled', index) => {
    const id = crypto.randomUUID();
    const state = get();
    const siblings = state.nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const sortOrder = index === undefined
      ? siblings.length
      : Math.max(0, Math.min(index, siblings.length));
    const nodes = [
      ...state.nodes.map((node) => (
        node.parentId === parentId && node.sortOrder >= sortOrder
          ? { ...node, sortOrder: node.sortOrder + 1 }
          : node
      )),
      { id, label, kind, parentId, sortOrder, properties: {} },
    ];
    return commitNodes(nodes, set, id) ? id : '';
  },
  acceptProposals: (parentId, proposals) => {
    const state = get();
    if (!state.nodes.some((node) => node.id === parentId)) return [];
    const usedLabels = new Set(
      state.nodes
        .filter((node) => node.parentId === parentId)
        .map((node) => node.label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()),
    );
    const accepted = proposals.slice(0, 5).flatMap((proposal) => {
      const label = proposal.label.trim().replace(/\s+/g, ' ');
      const normalized = label.toLocaleLowerCase();
      if (!normalized || usedLabels.has(normalized)) return [];
      usedLabels.add(normalized);
      return [{
        id: crypto.randomUUID(),
        label,
        kind: proposal.kind ?? 'idea',
        parentId,
        properties: {},
      }];
    });
    if (!accepted.length) return [];
    const sortOrder = state.nodes.filter((node) => node.parentId === parentId).length;
    const nodes = [
      ...state.nodes,
      ...accepted.map((node, proposalIndex) => ({
        ...node,
        sortOrder: sortOrder + proposalIndex,
      })),
    ];
    return commitNodes(nodes, set) ? accepted.map((node) => node.id) : null;
  },
  updateLabel: (id, label) => {
    commitNodes(
      get().nodes.map((node) => node.id === id ? { ...node, label } : node),
      set,
    );
  },
  applyTitleInput: (id, input) => {
    const parsed = parseIdeationTitleTokens(input);
    const nodes = get().nodes.map((node) => {
      if (node.id !== id) return node;
      let changed = node.label !== parsed.label;
      const properties = { ...node.properties };
      for (const property of parsed.properties) {
        let mergedProperty = property;
        if (property.key === 'tags' && properties.tags) {
          const existing = Array.isArray(properties.tags.value) ? properties.tags.value : [];
          const incoming = Array.isArray(property.value) ? property.value : [];
          mergedProperty = { ...property, value: [...new Set([...existing, ...incoming])] };
        }
        if (!propertiesEqual(properties[property.key], mergedProperty)) {
          properties[property.key] = mergedProperty;
          changed = true;
        }
      }
      return changed ? { ...node, label: parsed.label, properties } : node;
    });
    commitNodes(nodes, set);
  },
  applyTextOutline: (input) => {
    const current = get().nodes;
    const reconciled = reconcileIdeationOutline(current, input);
    return nodesEqual(current, reconciled) || commitNodes(reconciled, set);
  },
  updateKind: (id, kind) => {
    commitNodes(
      get().nodes.map((node) => node.id === id ? { ...node, kind } : node),
      set,
    );
  },
  setProperty: (id, property) => {
    commitNodes(
      get().nodes.map((node) => node.id === id
        ? { ...node, properties: { ...node.properties, [property.key]: property } }
        : node),
      set,
    );
  },
  removeProperty: (id, key) => {
    commitNodes(
      get().nodes.map((node) => {
        if (node.id !== id || !node.properties[key]) return node;
        const properties = { ...node.properties };
        delete properties[key];
        return { ...node, properties };
      }),
      set,
    );
  },
  moveNode: (id, parentId, index) => {
    const state = get();
    const moving = state.nodes.find((node) => node.id === id);
    if (moving?.parentId !== null && parentId === null) {
      toast.error('Keep one project root. Move items under the project instead.');
      return;
    }
    if (
      !moving
      || id === parentId
      || (parentId !== null && !state.nodes.some((node) => node.id === parentId))
      || (parentId && isIdeationDescendant(state.nodes, parentId, id))
    ) return;
    const oldParentId = moving.parentId;
    const destination = state.nodes
      .filter((node) => node.parentId === parentId && node.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const boundedIndex = Math.max(0, Math.min(index, destination.length));
    destination.splice(boundedIndex, 0, { ...moving, parentId });
    const destinationOrder = new Map(destination.map((node, order) => [node.id, order]));
    let nodes = state.nodes.map((node) => {
      if (node.id === id) return { ...node, parentId, sortOrder: boundedIndex };
      if (node.parentId === parentId) {
        return { ...node, sortOrder: destinationOrder.get(node.id) ?? node.sortOrder };
      }
      return node;
    });
    nodes = normalizeSiblingOrder(nodes, oldParentId);
    commitNodes(nodes, set, id);
  },
  indentNode: (id) => {
    const state = get();
    const node = state.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    const siblings = state.nodes
      .filter((candidate) => candidate.parentId === node.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const previous = siblings[siblings.findIndex((candidate) => candidate.id === id) - 1];
    if (previous) {
      get().moveNode(
        id,
        previous.id,
        state.nodes.filter((candidate) => candidate.parentId === previous.id).length,
      );
    }
  },
  outdentNode: (id) => {
    const state = get();
    const node = state.nodes.find((candidate) => candidate.id === id);
    if (!node?.parentId) return;
    const parent = state.nodes.find((candidate) => candidate.id === node.parentId);
    if (!parent) return;
    if (parent.parentId === null) {
      toast.error('Keep one project root. Top-level items cannot be outdented.');
      return;
    }
    get().moveNode(id, parent.parentId, parent.sortOrder + 1);
  },
  deleteNode: (id) => {
    const state = get();
    const root = state.nodes.find((node) => node.parentId === null);
    if (root?.id === id) return;
    const deleteIds = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of state.nodes) {
        if (node.parentId && deleteIds.has(node.parentId) && !deleteIds.has(node.id)) {
          deleteIds.add(node.id);
          changed = true;
        }
      }
    }
    const deleted = state.nodes.find((node) => node.id === id);
    const nodes = normalizeSiblingOrder(
      state.nodes.filter((node) => !deleteIds.has(node.id)),
      deleted?.parentId ?? null,
    );
    commitNodes(nodes, set);
  },
  selectNode: (selectedNodeId) => {
    controller.select(selectedNodeId ? { kind: 'node', id: selectedNodeId } : undefined);
    set(controllerProjection());
  },
  setWorkspaceContext: (workspaceId, workspaceRevision) => set({
    workspaceId,
    workspaceRevision,
  }),
  setWorkspaceFlusher: (flushWorkspace) => set({ flushWorkspace }),
  replaceNodes: (nodes) => {
    const validation = validateIdeationNodes(nodes);
    if (!validation.valid) throw new Error(validation.message);
    controller = createController(validation.nodes);
    undoStack.length = 0;
    redoStack.length = 0;
    set(controllerProjection());
  },
  clear: () => {
    controller = createController(createInitialNodes());
    undoStack.length = 0;
    redoStack.length = 0;
    set(controllerProjection());
  },
  undo: () => {
    const previous = undoStack.pop();
    if (!previous) return;
    const snapshot = controller.getSnapshot();
    const current = graphDocumentToIdeationNodes(snapshot.document);
    const selectedNodeId = snapshot.selection?.kind === 'node' ? snapshot.selection.id : null;
    redoStack.push(current);
    controller = createController(previous);
    if (selectedNodeId && previous.some((node) => node.id === selectedNodeId)) {
      controller.select({ kind: 'node', id: selectedNodeId });
    }
    set(controllerProjection());
  },
  redo: () => {
    const next = redoStack.pop();
    if (!next) return;
    const snapshot = controller.getSnapshot();
    const current = graphDocumentToIdeationNodes(snapshot.document);
    const selectedNodeId = snapshot.selection?.kind === 'node' ? snapshot.selection.id : null;
    undoStack.push(current);
    controller = createController(next);
    if (selectedNodeId && next.some((node) => node.id === selectedNodeId)) {
      controller.select({ kind: 'node', id: selectedNodeId });
    }
    set(controllerProjection());
  },
}));
