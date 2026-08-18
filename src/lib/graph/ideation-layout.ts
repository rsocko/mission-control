import type { IdeationNodeKind } from './ideation-types';

export interface IdeationLayoutNode {
  id: string;
  parentId: string | null;
  sortOrder: number;
  kind: IdeationNodeKind;
  proposal?: boolean;
}

export interface IdeationLayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: IdeationNodeKind;
  proposal: boolean;
}

export interface IdeationMindMapLayout {
  positions: Map<string, { x: number; y: number }>;
  orderedNodeIds: string[];
  edges: IdeationLayoutEdge[];
}

const HORIZONTAL_SPACING = 250;
const VERTICAL_SPACING = 104;
const ORIGIN_OFFSET = 30;

export function layoutIdeationMindMap(nodes: readonly IdeationLayoutNode[]): IdeationMindMapLayout {
  const ordered = [...nodes].sort((left, right) =>
    left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const byParent = new Map<string | null, IdeationLayoutNode[]>();
  for (const node of ordered) {
    byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const visiting = new Set<string>();
  let leafIndex = 0;
  const place = (node: IdeationLayoutNode, depth: number): number => {
    if (visiting.has(node.id)) {
      const y = leafIndex++ * VERTICAL_SPACING;
      positions.set(node.id, {
        x: depth * HORIZONTAL_SPACING + ORIGIN_OFFSET,
        y: y + ORIGIN_OFFSET,
      });
      return y;
    }
    visiting.add(node.id);
    const children = (byParent.get(node.id) ?? []).filter((child) => !positions.has(child.id));
    const childYs = children.map((child) => place(child, depth + 1));
    visiting.delete(node.id);
    const y = childYs.length
      ? (Math.min(...childYs) + Math.max(...childYs)) / 2
      : leafIndex++ * VERTICAL_SPACING;
    positions.set(node.id, {
      x: depth * HORIZONTAL_SPACING + ORIGIN_OFFSET,
      y: y + ORIGIN_OFFSET,
    });
    return y;
  };

  for (const root of byParent.get(null) ?? []) place(root, 0);
  for (const node of ordered) {
    if (!positions.has(node.id)) place(node, 0);
  }

  return {
    positions,
    orderedNodeIds: ordered.map((node) => node.id),
    edges: ordered.flatMap((node) => node.parentId ? [{
      id: `hierarchy:${node.parentId}:${node.id}`,
      source: node.parentId,
      target: node.id,
      kind: node.kind,
      proposal: Boolean(node.proposal),
    }] : []),
  };
}
