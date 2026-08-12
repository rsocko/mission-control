import type { IdeationNode } from './ideation-types';

export const IDEATION_EXPAND_MIN_PROPOSALS = 3;
export const IDEATION_EXPAND_MAX_PROPOSALS = 5;
export const IDEATION_EXPAND_MAX_CONTEXT_NODES = 30;

export interface IdeationExpansionProposal {
  id: string;
  label: string;
  rationale: string;
}

export interface IdeationExpansionRequest {
  selectedNode: Pick<IdeationNode, 'id' | 'label' | 'kind' | 'parentId'>;
  contextNodes: Array<Pick<IdeationNode, 'id' | 'label' | 'kind' | 'parentId' | 'sortOrder'>>;
  contextVersion: string;
}

export function normalizeIdeationLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function getIdeationContextVersion(nodes: IdeationNode[], selectedNodeId: string): string {
  const serialized = JSON.stringify(
    getBoundedIdeationContext(nodes, selectedNodeId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, label, kind, parentId, sortOrder }) => [id, label, kind, parentId, sortOrder]),
  ) + `:${selectedNodeId}`;
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(36)}`;
}

export function getBoundedIdeationContext(
  nodes: IdeationNode[],
  selectedNodeId: string,
): IdeationExpansionRequest['contextNodes'] {
  const selected = nodes.find((node) => node.id === selectedNodeId);
  if (!selected) return [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const prioritized: IdeationNode[] = [selected];
  const seen = new Set([selected.id]);
  const add = (node: IdeationNode | undefined) => {
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      prioritized.push(node);
    }
  };

  nodes
    .filter((node) => node.parentId === selected.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach(add);

  let ancestor = selected.parentId ? byId.get(selected.parentId) : undefined;
  while (ancestor) {
    add(ancestor);
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
  }

  nodes
    .filter((node) => node.parentId === selected.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach(add);
  [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).forEach(add);

  return prioritized.slice(0, IDEATION_EXPAND_MAX_CONTEXT_NODES).map(
    ({ id, label, kind, parentId, sortOrder }) => ({ id, label, kind, parentId, sortOrder }),
  );
}
