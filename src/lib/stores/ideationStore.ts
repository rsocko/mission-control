import { create } from 'zustand';
import {
  isIdeationDescendant,
  type IdeationNode,
  type IdeationNodeKind,
  type IdeationProperty,
} from '@/lib/graph/ideation-types';
import { parseIdeationTitleTokens } from '@/lib/ideation/property-parser';
import { reconcileIdeationOutline } from '@/lib/ideation/text-outline';

const HISTORY_LIMIT = 30;

function createInitialNodes(): IdeationNode[] {
  const rootId = crypto.randomUUID();
  return [
    {
      id: rootId,
      label: 'New Project',
      kind: 'idea',
      parentId: null,
      sortOrder: 0,
      properties: {},
    },
  ];
}

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
  past: IdeationNode[][];
  addNode: (
    parentId: string | null,
    kind?: IdeationNodeKind,
    label?: string,
    index?: number,
  ) => string;
  acceptProposals: (
    parentId: string,
    proposals: Array<{ label: string; kind?: IdeationNodeKind }>,
  ) => string[];
  updateLabel: (id: string, label: string) => void;
  applyTitleInput: (id: string, input: string) => void;
  applyTextOutline: (input: string) => void;
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
}

function withHistory(state: IdeationState): Pick<IdeationState, 'past'> {
  return {
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.nodes],
  };
}

export const useIdeationStore = create<IdeationState>()(
    (set, get) => ({
      nodes: createInitialNodes(),
      selectedNodeId: null,
      workspaceId: null,
      workspaceRevision: null,
      flushWorkspace: null,
      past: [],
      addNode: (parentId, kind = 'idea', label = 'Untitled', index) => {
        const id = crypto.randomUUID();
        set((state) => {
          const siblings = state.nodes
            .filter((node) => node.parentId === parentId)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const sortOrder = index === undefined
            ? siblings.length
            : Math.max(0, Math.min(index, siblings.length));
          return {
            ...withHistory(state),
            nodes: [
              ...state.nodes.map((node) => (
                node.parentId === parentId && node.sortOrder >= sortOrder
                  ? { ...node, sortOrder: node.sortOrder + 1 }
                  : node
              )),
              { id, label, kind, parentId, sortOrder, properties: {} },
            ],
            selectedNodeId: id,
          };
        });
        return id;
      },
      acceptProposals: (parentId, proposals) => {
        const addedIds: string[] = [];
        set((state) => {
          if (!state.nodes.some((node) => node.id === parentId)) return state;

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
            const id = crypto.randomUUID();
            addedIds.push(id);
            return [{
              id,
              label,
              kind: proposal.kind ?? 'idea',
              parentId,
              properties: {},
            }];
          });
          if (!accepted.length) return state;

          const sortOrder = state.nodes.filter((node) => node.parentId === parentId).length;
          return {
            ...withHistory(state),
            nodes: [
              ...state.nodes,
              ...accepted.map((node, index) => ({ ...node, sortOrder: sortOrder + index })),
            ],
            selectedNodeId: state.selectedNodeId,
          };
        });
        return addedIds;
      },
      updateLabel: (id, label) => set((state) => ({
        ...withHistory(state),
        nodes: state.nodes.map((node) => node.id === id ? { ...node, label } : node),
      })),
      applyTitleInput: (id, input) => set((state) => {
        const parsed = parseIdeationTitleTokens(input);
        let changed = false;
        const nodes = state.nodes.map((node) => {
          if (node.id !== id) return node;
          const properties = { ...node.properties };
          for (const property of parsed.properties) {
            let mergedProperty = property;
            if (property.key === 'tags' && properties.tags) {
              const existing = Array.isArray(properties.tags.value) ? properties.tags.value : [];
              const incoming = Array.isArray(property.value) ? property.value : [];
              mergedProperty = {
                ...property,
                value: [...new Set([...existing, ...incoming])],
              };
            }
            if (!propertiesEqual(properties[property.key], mergedProperty)) {
              properties[property.key] = mergedProperty;
              changed = true;
            }
          }
          if (node.label !== parsed.label) changed = true;
          return changed ? { ...node, label: parsed.label, properties } : node;
        });
        if (!changed) return state;
        return {
          ...withHistory(state),
          nodes,
        };
      }),
      applyTextOutline: (input) => set((state) => {
        const nodes = reconcileIdeationOutline(state.nodes, input);
        if (nodes === state.nodes) return state;
        return {
          ...withHistory(state),
          nodes,
          selectedNodeId: nodes.some((node) => node.id === state.selectedNodeId)
            ? state.selectedNodeId
            : nodes[0]?.id ?? null,
        };
      }),
      updateKind: (id, kind) => set((state) => ({
        ...withHistory(state),
        nodes: state.nodes.map((node) => node.id === id ? { ...node, kind } : node),
      })),
      setProperty: (id, property) => set((state) => ({
        ...withHistory(state),
        nodes: state.nodes.map((node) => node.id === id
          ? { ...node, properties: { ...node.properties, [property.key]: property } }
          : node),
      })),
      removeProperty: (id, key) => set((state) => ({
        ...withHistory(state),
        nodes: state.nodes.map((node) => {
          if (node.id !== id) return node;
          const properties = { ...node.properties };
          delete properties[key];
          return { ...node, properties };
        }),
      })),
      moveNode: (id, parentId, index) => set((state) => {
        const moving = state.nodes.find((node) => node.id === id);
        if (
          !moving
          || id === parentId
          || (parentId !== null && !state.nodes.some((node) => node.id === parentId))
          || (parentId && isIdeationDescendant(state.nodes, parentId, id))
        ) {
          return state;
        }

        const oldParentId = moving.parentId;
        const destination = state.nodes
          .filter((node) => node.parentId === parentId && node.id !== id)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const boundedIndex = Math.max(0, Math.min(index, destination.length));
        destination.splice(boundedIndex, 0, { ...moving, parentId });
        const destinationOrder = new Map(destination.map((node, order) => [node.id, order]));
        let nodes = state.nodes.map((node) => {
          if (node.id === id) {
            return { ...node, parentId, sortOrder: destinationOrder.get(id) ?? boundedIndex };
          }
          if (node.parentId === parentId) {
            return { ...node, sortOrder: destinationOrder.get(node.id) ?? node.sortOrder };
          }
          return node;
        });
        nodes = normalizeSiblingOrder(nodes, oldParentId);

        return { ...withHistory(state), nodes, selectedNodeId: id };
      }),
      indentNode: (id) => {
        const state = get();
        const node = state.nodes.find((candidate) => candidate.id === id);
        if (!node) return;
        const siblings = state.nodes
          .filter((candidate) => candidate.parentId === node.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const index = siblings.findIndex((candidate) => candidate.id === id);
        const previous = siblings[index - 1];
        if (!previous) return;
        get().moveNode(id, previous.id, state.nodes.filter((candidate) => candidate.parentId === previous.id).length);
      },
      outdentNode: (id) => {
        const state = get();
        const node = state.nodes.find((candidate) => candidate.id === id);
        if (!node?.parentId) return;
        const parent = state.nodes.find((candidate) => candidate.id === node.parentId);
        if (!parent) return;
        get().moveNode(id, parent.parentId, parent.sortOrder + 1);
      },
      deleteNode: (id) => set((state) => {
        const root = state.nodes.find((node) => node.parentId === null);
        if (root?.id === id) return state;
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
        return {
          ...withHistory(state),
          nodes,
          selectedNodeId: deleteIds.has(state.selectedNodeId ?? '') ? null : state.selectedNodeId,
        };
      }),
      selectNode: (selectedNodeId) => set({ selectedNodeId }),
      setWorkspaceContext: (workspaceId, workspaceRevision) => set({
        workspaceId,
        workspaceRevision,
      }),
      setWorkspaceFlusher: (flushWorkspace) => set({ flushWorkspace }),
      replaceNodes: (nodes) => set({
        nodes,
        selectedNodeId: null,
        past: [],
      }),
      clear: () => set({
        nodes: createInitialNodes(),
        selectedNodeId: null,
        past: [],
      }),
      undo: () => set((state) => {
        const previous = state.past.at(-1);
        if (!previous) return state;
        return {
          nodes: previous,
          past: state.past.slice(0, -1),
          selectedNodeId: previous.some((node) => node.id === state.selectedNodeId)
            ? state.selectedNodeId
            : null,
        };
      }),
    }),
);
