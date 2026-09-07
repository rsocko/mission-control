import {
  getProfile,
  hierarchyNodeIds,
  type GraphDocument,
  type Placement
} from "../core/index.js";

export interface RadialHierarchyLayoutOptions {
  rootCenter?: { x: number; y: number };
  rootId?: string;
  horizontalGap?: number;
  verticalGap?: number;
  componentGap?: number;
}

interface NodeSize {
  width: number;
  height: number;
}

interface LayoutTree {
  rootId: string;
  nodeIds: Set<string>;
}

const DEFAULT_ROOT_CENTER = { x: 450, y: 325 };
const DEFAULT_HORIZONTAL_GAP = 92;
const DEFAULT_VERTICAL_GAP = 24;
const DEFAULT_COMPONENT_GAP = 140;

export function createRadialHierarchyLayout(
  document: GraphDocument,
  currentPlacements: ReadonlyMap<string, Placement> = new Map(),
  options: RadialHierarchyLayoutOptions = {}
): Map<string, Placement> {
  const profile = getProfile(document);
  const hierarchyType = profile.hierarchyRelationship;
  if (!hierarchyType || document.nodes.length === 0) return new Map();

  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const parentByNode = new Map<string, string>();
  const childrenByNode = new Map<string, string[]>();
  for (const relationship of document.relationships) {
    const { parentId, childId } = hierarchyNodeIds(profile, relationship);
    if (
      relationship.type !== hierarchyType ||
      !nodesById.has(relationship.source) ||
      !nodesById.has(relationship.target) ||
      parentByNode.has(childId)
    ) {
      continue;
    }
    parentByNode.set(childId, parentId);
  }
  for (const node of document.nodes) {
    const parentId = parentByNode.get(node.id);
    if (!parentId) continue;
    const children = childrenByNode.get(parentId) ?? [];
    children.push(node.id);
    childrenByNode.set(parentId, children);
  }

  const trees = collectTrees(
    document.nodes.map((node) => node.id),
    parentByNode,
    childrenByNode,
    options.rootId
  );
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP;
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP;
  const componentGap = options.componentGap ?? DEFAULT_COMPONENT_GAP;
  const firstRootPlacement = currentPlacements.get(trees[0]!.rootId);
  const anchor = firstRootPlacement
    ? {
        x: firstRootPlacement.x + firstRootPlacement.width / 2,
        y: firstRootPlacement.y + firstRootPlacement.height / 2
      }
    : (options.rootCenter ?? DEFAULT_ROOT_CENTER);
  const result = new Map<string, Placement>();
  let previousBottom: number | undefined;

  trees.forEach((tree, index) => {
    const component = layoutTree(
      tree,
      childrenByNode,
      anchor,
      horizontalGap,
      verticalGap
    );
    const bounds = placementBounds(component.values());
    const translateY =
      index === 0 || previousBottom === undefined
        ? 0
        : previousBottom + componentGap - bounds.top;
    for (const [nodeId, placement] of component) {
      result.set(nodeId, {
        ...placement,
        y: placement.y + translateY
      });
    }
    previousBottom = bounds.bottom + translateY;
  });

  return result;
}

function collectTrees(
  orderedNodeIds: readonly string[],
  parentByNode: ReadonlyMap<string, string>,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  preferredRootId?: string
): LayoutTree[] {
  const visited = new Set<string>();
  const trees: LayoutTree[] = [];
  const roots = [
    ...orderedNodeIds.filter((nodeId) => !parentByNode.has(nodeId)),
    ...orderedNodeIds.filter((nodeId) => parentByNode.has(nodeId))
  ];
  if (preferredRootId && !parentByNode.has(preferredRootId)) {
    roots.sort((left, right) =>
      left === preferredRootId
        ? -1
        : right === preferredRootId
          ? 1
          : compareIds(left, right)
    );
  }
  for (const rootId of roots) {
    if (visited.has(rootId)) continue;
    const nodeIds = new Set<string>();
    const pending = [rootId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      nodeIds.add(nodeId);
      for (const childId of childrenByNode.get(nodeId) ?? []) {
        if (!visited.has(childId)) pending.push(childId);
      }
    }
    trees.push({ rootId, nodeIds });
  }
  return trees;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function layoutTree(
  tree: LayoutTree,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  rootCenter: { x: number; y: number },
  horizontalGap: number,
  verticalGap: number
): Map<string, Placement> {
  const result = new Map<string, Placement>();
  const rootSize = sizeForDepth(0);
  const rootPlacement: Placement = {
    x: rootCenter.x - rootSize.width / 2,
    y: rootCenter.y - rootSize.height / 2,
    ...rootSize
  };
  result.set(tree.rootId, rootPlacement);

  const spans = new Map<string, number>();
  const branchSpan = (
    nodeId: string,
    depth: number,
    path: ReadonlySet<string>
  ): number => {
    const cached = spans.get(nodeId);
    if (cached !== undefined) return cached;
    const size = sizeForDepth(depth);
    if (path.has(nodeId)) return size.height;
    const nextPath = new Set(path).add(nodeId);
    const childSpans = (childrenByNode.get(nodeId) ?? [])
      .filter((childId) => tree.nodeIds.has(childId))
      .map((childId) => branchSpan(childId, depth + 1, nextPath));
    const descendants =
      childSpans.reduce((total, span) => total + span, 0) +
      Math.max(0, childSpans.length - 1) * verticalGap;
    const span = Math.max(size.height, descendants);
    spans.set(nodeId, span);
    return span;
  };

  const left: string[] = [];
  const right: string[] = [];
  let leftSpan = 0;
  let rightSpan = 0;
  for (const childId of childrenByNode.get(tree.rootId) ?? []) {
    if (!tree.nodeIds.has(childId)) continue;
    const span = branchSpan(childId, 1, new Set([tree.rootId]));
    if (rightSpan <= leftSpan) {
      right.push(childId);
      rightSpan += span + verticalGap;
    } else {
      left.push(childId);
      leftSpan += span + verticalGap;
    }
  }

  layoutChildren(
    left,
    rootPlacement,
    -1,
    1,
    childrenByNode,
    tree.nodeIds,
    spans,
    result,
    horizontalGap,
    verticalGap
  );
  layoutChildren(
    right,
    rootPlacement,
    1,
    1,
    childrenByNode,
    tree.nodeIds,
    spans,
    result,
    horizontalGap,
    verticalGap
  );
  return result;
}

function layoutChildren(
  nodeIds: readonly string[],
  parent: Placement,
  direction: -1 | 1,
  depth: number,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  componentNodeIds: ReadonlySet<string>,
  spans: ReadonlyMap<string, number>,
  result: Map<string, Placement>,
  horizontalGap: number,
  verticalGap: number
): void {
  const unplacedNodeIds = nodeIds.filter((nodeId) => !result.has(nodeId));
  if (unplacedNodeIds.length === 0) return;
  const totalSpan =
    unplacedNodeIds.reduce(
      (total, nodeId) => total + (spans.get(nodeId) ?? 0),
      0
    ) +
    (unplacedNodeIds.length - 1) * verticalGap;
  let cursor = parent.y + parent.height / 2 - totalSpan / 2;

  for (const nodeId of unplacedNodeIds) {
    const span = spans.get(nodeId) ?? sizeForDepth(depth).height;
    const size = sizeForDepth(depth);
    const placement: Placement = {
      x:
        direction === 1
          ? parent.x + parent.width + horizontalGap
          : parent.x - horizontalGap - size.width,
      y: cursor + span / 2 - size.height / 2,
      ...size
    };
    result.set(nodeId, placement);
    const children = (childrenByNode.get(nodeId) ?? []).filter((childId) =>
      componentNodeIds.has(childId)
    );
    layoutChildren(
      children,
      placement,
      direction,
      depth + 1,
      childrenByNode,
      componentNodeIds,
      spans,
      result,
      horizontalGap,
      verticalGap
    );
    cursor += span + verticalGap;
  }
}

function sizeForDepth(depth: number): NodeSize {
  if (depth === 0) return { width: 220, height: 84 };
  if (depth === 1) return { width: 190, height: 72 };
  return { width: 168, height: 64 };
}

function placementBounds(placements: Iterable<Placement>): {
  top: number;
  bottom: number;
} {
  const values = [...placements];
  return {
    top: Math.min(...values.map((placement) => placement.y)),
    bottom: Math.max(
      ...values.map((placement) => placement.y + placement.height)
    )
  };
}
