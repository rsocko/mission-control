import type { IdeationNodeKind } from './ideation-types';
import {
  createLayeredHierarchyLayout,
} from '@rsocko/generic-graph-canvas-shared-workbench/layout';
import type { Placement } from '@rsocko/generic-graph-canvas-shared-workbench/core';
import { ideationNodesToGraphDocument } from '@/lib/graph-workbench/adapters';

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

const NODE_WIDTH = 176;
const NODE_HEIGHT = 72;

export function layoutIdeationMindMap(nodes: readonly IdeationLayoutNode[]): IdeationMindMapLayout {
  const ordered = [...nodes].sort((left, right) =>
    left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const document = ideationNodesToGraphDocument(ordered.map((node) => ({
    ...node,
    label: node.id,
    properties: {},
  })));
  const currentPlacements = new Map<string, Placement>(
    ordered.map((node) => [node.id, {
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }]),
  );
  const placements = createLayeredHierarchyLayout(document, currentPlacements, {
    rootId: ordered.find((node) => node.parentId === null)?.id,
    orientation: 'horizontal',
    siblingGap: 32,
    levelGap: 74,
  });
  const positions = new Map(
    [...placements].map(([id, placement]) => [
      id,
      { x: placement.x + 30, y: placement.y + 30 },
    ]),
  );

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
