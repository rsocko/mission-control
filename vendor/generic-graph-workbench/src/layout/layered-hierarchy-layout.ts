import {
  getProfile,
  hierarchyNodeIds,
  type GraphDocument,
  type Placement
} from "../core/index.js";

export interface LayeredHierarchyLayoutOptions {
  rootId?: string;
  /** Gap between sibling subtrees along the spread axis. */
  siblingGap?: number;
  /** Gap between successive depth ranks along the depth axis. */
  levelGap?: number;
  /** Gap between separate trees when a document has more than one root. */
  componentGap?: number;
  /**
   * Which node dimension the caller will ultimately treat as the "spread"
   * (sibling) axis vs. the "depth" (rank) axis once it applies its own
   * top-down/left-to-right orientation transform. `"horizontal"` (the
   * default) assumes siblings stay spread along y (sized by node height)
   * and depth advances along x (sized by node width) — correct for
   * left-to-right/right-to-left output. `"vertical"` assumes the caller
   * will swap x/y afterwards (top-down/bottom-up), so siblings must be
   * spread using node width and depth ranks sized using node height,
   * otherwise sibling boxes overlap once rotated.
   */
  orientation?: "horizontal" | "vertical";
}

interface NodeBox {
  width: number;
  height: number;
}

interface LayoutTree {
  rootId: string;
  nodeIds: Set<string>;
}

const DEFAULT_SIBLING_GAP = 32;
const DEFAULT_LEVEL_GAP = 96;
const DEFAULT_COMPONENT_GAP = 140;
const DEFAULT_SIZE: NodeBox = { width: 220, height: 104 };

/**
 * Produces a strict layered ("Sugiyama-style") tree layout for hierarchy
 * profiles (e.g. Work Breakdown Structure / roadmap-map), where every node
 * is assigned a rank/depth equal to its distance from the root along the
 * profile's hierarchy relationship (e.g. `contains`), and siblings within a
 * rank are spread along the perpendicular axis with enough space that
 * sibling subtrees never overlap. Unlike `createRadialHierarchyLayout`,
 * this produces clean depth-aligned rows/columns with no crossing
 * parent/child edges for a simple tree.
 *
 * The result is always produced in a canonical "left-to-right" orientation
 * (root at x = 0, depth increasing along +x, siblings spread along y,
 * centered near y = 0). Callers that need "top-down", "bottom-up", or
 * "right-to-left" orientations should apply the same axis transform they
 * already use for the generic layered layout (see `orientLayout` in
 * `graph-layout.ts`).
 */
export function createLayeredHierarchyLayout(
  document: GraphDocument,
  currentPlacements: ReadonlyMap<string, Placement> = new Map(),
  options: LayeredHierarchyLayoutOptions = {}
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
  if (trees.length === 0) return new Map();

  const siblingGap = options.siblingGap ?? DEFAULT_SIBLING_GAP;
  const levelGap = options.levelGap ?? DEFAULT_LEVEL_GAP;
  const componentGap = options.componentGap ?? DEFAULT_COMPONENT_GAP;
  const orientation = options.orientation ?? "horizontal";
  const sizeOf = (nodeId: string): NodeBox => {
    const placement = currentPlacements.get(nodeId);
    return placement
      ? { width: placement.width, height: placement.height }
      : DEFAULT_SIZE;
  };

  const result = new Map<string, Placement>();
  let previousBottom: number | undefined;

  trees.forEach((tree) => {
    const component = layoutTree(
      tree,
      childrenByNode,
      sizeOf,
      siblingGap,
      levelGap,
      orientation
    );
    const bounds = spreadBounds(component.values(), orientation);
    const translateY =
      previousBottom === undefined
        ? -((bounds.top + bounds.bottom) / 2)
        : previousBottom + componentGap - bounds.top;
    for (const [nodeId, placement] of component) {
      result.set(nodeId, { ...placement, y: placement.y + translateY });
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

/** Lays out a single tree in canonical left-to-right local coordinates. */
function layoutTree(
  tree: LayoutTree,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  sizeOf: (id: string) => NodeBox,
  siblingGap: number,
  levelGap: number,
  orientation: "horizontal" | "vertical"
): Map<string, Placement> {
  // "horizontal" output (left-to-right/right-to-left) spreads siblings
  // along y (sized by height) and advances depth along x (sized by
  // width). "vertical" output (top-down/bottom-up) swaps x/y afterwards,
  // so the roles of width/height must swap here too, or sibling boxes
  // sized wider than they are tall would overlap once rotated.
  const spreadSize = (id: string): number =>
    orientation === "vertical" ? sizeOf(id).width : sizeOf(id).height;
  const depthSize = (id: string): number =>
    orientation === "vertical" ? sizeOf(id).height : sizeOf(id).width;

  const depths = computeDepths(tree, childrenByNode);
  const spans = computeSpans(tree, childrenByNode, spreadSize, siblingGap);
  const centers = assignSpreadCenters(tree, childrenByNode, spans, siblingGap);
  const columnX = computeColumnPositions(tree, depths, depthSize, levelGap);

  const result = new Map<string, Placement>();
  for (const nodeId of tree.nodeIds) {
    const size = sizeOf(nodeId);
    const level = depths.get(nodeId) ?? 0;
    const x = columnX.get(level) ?? 0;
    const halfSpread = spreadSize(nodeId) / 2;
    const centerY = centers.get(nodeId) ?? halfSpread;
    result.set(nodeId, {
      x,
      y: centerY - halfSpread,
      width: size.width,
      height: size.height
    });
  }
  return result;
}

/** Breadth-first rank (distance from the root) for every node in the tree. */
function computeDepths(
  tree: LayoutTree,
  childrenByNode: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const depths = new Map<string, number>([[tree.rootId, 0]]);
  const pending = [tree.rootId];
  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    const depth = depths.get(nodeId)!;
    for (const childId of childrenByNode.get(nodeId) ?? []) {
      if (!tree.nodeIds.has(childId) || depths.has(childId)) continue;
      depths.set(childId, depth + 1);
      pending.push(childId);
    }
  }
  return depths;
}

/**
 * The spread-axis space a node's whole subtree needs: at least its own
 * size, and at least enough to fit all of its children's subtrees laid out
 * side by side with a gap between them.
 */
function computeSpans(
  tree: LayoutTree,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  crossSize: (id: string) => number,
  gap: number
): Map<string, number> {
  const spans = new Map<string, number>();
  const visit = (nodeId: string, path: ReadonlySet<string>): number => {
    const cached = spans.get(nodeId);
    if (cached !== undefined) return cached;
    const own = crossSize(nodeId);
    if (path.has(nodeId)) {
      // Defensive guard against malformed cyclic hierarchy data.
      spans.set(nodeId, own);
      return own;
    }
    const children = (childrenByNode.get(nodeId) ?? []).filter((childId) =>
      tree.nodeIds.has(childId)
    );
    if (children.length === 0) {
      spans.set(nodeId, own);
      return own;
    }
    const nextPath = new Set(path).add(nodeId);
    const childSpans = children.map((childId) => visit(childId, nextPath));
    const childrenTotal =
      childSpans.reduce((total, span) => total + span, 0) +
      gap * (children.length - 1);
    const span = Math.max(own, childrenTotal);
    spans.set(nodeId, span);
    return span;
  };
  visit(tree.rootId, new Set());
  return spans;
}

/**
 * Assigns each node a center position along the spread axis, laying out
 * each node's children within its own allocated span (centered so the
 * parent sits above/before the visual midpoint of its children) so that
 * sibling subtrees never overlap and a node's edges never cross a
 * sibling's subtree.
 */
function assignSpreadCenters(
  tree: LayoutTree,
  childrenByNode: ReadonlyMap<string, readonly string[]>,
  spans: ReadonlyMap<string, number>,
  gap: number
): Map<string, number> {
  const centers = new Map<string, number>();
  const place = (nodeId: string, start: number): void => {
    if (centers.has(nodeId)) return;
    const span = spans.get(nodeId) ?? 0;
    centers.set(nodeId, start + span / 2);
    const children = (childrenByNode.get(nodeId) ?? []).filter(
      (childId) => tree.nodeIds.has(childId) && !centers.has(childId)
    );
    if (children.length === 0) return;
    const childrenTotal =
      children.reduce((total, childId) => total + (spans.get(childId) ?? 0), 0) +
      gap * (children.length - 1);
    let cursor = start + (span - childrenTotal) / 2;
    for (const childId of children) {
      const childSpan = spans.get(childId) ?? 0;
      place(childId, cursor);
      cursor += childSpan + gap;
    }
  };
  place(tree.rootId, 0);
  return centers;
}

/** The x offset (depth-axis position) for each rank, left to right. */
function computeColumnPositions(
  tree: LayoutTree,
  depths: ReadonlyMap<string, number>,
  columnSize: (id: string) => number,
  gap: number
): Map<number, number> {
  const maxSizeByLevel = new Map<number, number>();
  for (const nodeId of tree.nodeIds) {
    const level = depths.get(nodeId) ?? 0;
    const size = columnSize(nodeId);
    maxSizeByLevel.set(level, Math.max(maxSizeByLevel.get(level) ?? 0, size));
  }
  const levels = [...maxSizeByLevel.keys()].sort((left, right) => left - right);
  const positions = new Map<number, number>();
  let cursor = 0;
  for (const level of levels) {
    positions.set(level, cursor);
    cursor += (maxSizeByLevel.get(level) ?? 0) + gap;
  }
  return positions;
}

function spreadBounds(
  placements: Iterable<Placement>,
  orientation: "horizontal" | "vertical"
): {
  top: number;
  bottom: number;
} {
  const values = [...placements];
  const spreadExtent = (placement: Placement): number =>
    orientation === "vertical" ? placement.width : placement.height;
  return {
    top: Math.min(...values.map((placement) => placement.y)),
    bottom: Math.max(
      ...values.map((placement) => placement.y + spreadExtent(placement))
    )
  };
}
