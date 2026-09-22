import {
  getProfile,
  hierarchyNodeIds,
  type GraphDocument,
  type GraphNode,
  type GraphRelationship
} from "../core/index.js";

export interface HierarchyEntry {
  node: GraphNode;
  level: number;
  parentId: string | null;
}

export interface HierarchyProjection {
  hierarchyType: string | undefined;
  entries: readonly HierarchyEntry[];
  visibleNodes: readonly GraphNode[];
  visibleNodeIds: ReadonlySet<string>;
  visibleRelationships: readonly GraphRelationship[];
  parentByNode: ReadonlyMap<string, string>;
  directChildCountByNode: ReadonlyMap<string, number>;
  descendantCountByNode: ReadonlyMap<string, number>;
  hiddenByCollapsedNode: ReadonlyMap<string, string>;
  crossBoundaryRelationshipCountByNode: ReadonlyMap<string, number>;
}

export function createHierarchyProjection(
  document: GraphDocument,
  collapsedNodeIds: readonly string[]
): HierarchyProjection {
  const profile = getProfile(document);
  const hierarchyType = profile.hierarchyRelationship;
  if (!hierarchyType) {
    const visibleNodeIds = new Set(document.nodes.map((node) => node.id));
    return {
      hierarchyType,
      entries: document.nodes.map((node) => ({
        node,
        level: 1,
        parentId: null
      })),
      visibleNodes: document.nodes,
      visibleNodeIds,
      visibleRelationships: document.relationships,
      parentByNode: new Map(),
      directChildCountByNode: new Map(),
      descendantCountByNode: new Map(),
      hiddenByCollapsedNode: new Map(),
      crossBoundaryRelationshipCountByNode: new Map()
    };
  }

  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const parentByNode = new Map<string, string>();
  for (const relationship of document.relationships) {
    if (
      relationship.type === hierarchyType &&
      nodesById.has(relationship.source) &&
      nodesById.has(relationship.target)
    ) {
      const { parentId, childId } = hierarchyNodeIds(profile, relationship);
      parentByNode.set(childId, parentId);
    }
  }

  const childrenByNode = new Map<string, GraphNode[]>();
  for (const node of document.nodes) {
    const parentId = parentByNode.get(node.id);
    if (!parentId) continue;
    const children = childrenByNode.get(parentId) ?? [];
    children.push(node);
    childrenByNode.set(parentId, children);
  }

  const descendantCountByNode = new Map<string, number>();
  function countDescendants(nodeId: string, path: ReadonlySet<string>): number {
    const cached = descendantCountByNode.get(nodeId);
    if (cached !== undefined) return cached;
    if (path.has(nodeId)) return 0;
    const nextPath = new Set(path).add(nodeId);
    const count = (childrenByNode.get(nodeId) ?? []).reduce(
      (total, child) =>
        total + 1 + countDescendants(child.id, nextPath),
      0
    );
    descendantCountByNode.set(nodeId, count);
    return count;
  }
  document.nodes.forEach((node) => countDescendants(node.id, new Set()));

  const collapsibleIds = new Set(
    document.nodes
      .filter((node) => (descendantCountByNode.get(node.id) ?? 0) > 0)
      .map((node) => node.id)
  );
  const collapsedIds = new Set(
    collapsedNodeIds.filter((nodeId) => collapsibleIds.has(nodeId))
  );
  const entries: HierarchyEntry[] = [];
  const visibleNodeIds = new Set<string>();
  const hiddenByCollapsedNode = new Map<string, string>();
  const visited = new Set<string>();

  function hideDescendants(nodeId: string, collapsedAncestorId: string): void {
    for (const child of childrenByNode.get(nodeId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      hiddenByCollapsedNode.set(child.id, collapsedAncestorId);
      hideDescendants(child.id, collapsedAncestorId);
    }
  }

  function visit(node: GraphNode, level: number, parentId: string | null): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    visibleNodeIds.add(node.id);
    entries.push({ node, level, parentId });
    if (collapsedIds.has(node.id)) {
      hideDescendants(node.id, node.id);
      return;
    }
    for (const child of childrenByNode.get(node.id) ?? []) {
      visit(child, level + 1, node.id);
    }
  }

  document.nodes
    .filter((node) => !parentByNode.has(node.id))
    .forEach((node) => visit(node, 1, null));
  document.nodes
    .filter((node) => !visited.has(node.id))
    .forEach((node) => visit(node, 1, null));

  const visibleRelationships = document.relationships.filter(
    (relationship) =>
      visibleNodeIds.has(relationship.source) &&
      visibleNodeIds.has(relationship.target)
  );
  const visibleRelationshipIds = new Set(
    visibleRelationships.map((relationship) => relationship.id)
  );
  const crossBoundaryRelationshipCountByNode = new Map<string, number>();
  for (const relationship of document.relationships) {
    if (
      relationship.type === hierarchyType ||
      visibleRelationshipIds.has(relationship.id)
    ) {
      continue;
    }
    const hiddenSourceBoundary = hiddenByCollapsedNode.get(
      relationship.source
    );
    const hiddenTargetBoundary = hiddenByCollapsedNode.get(
      relationship.target
    );
    const projectedSource = hiddenSourceBoundary ?? relationship.source;
    const projectedTarget = hiddenTargetBoundary ?? relationship.target;
    if (projectedSource === projectedTarget) continue;
    for (const boundaryId of new Set(
      [hiddenSourceBoundary, hiddenTargetBoundary].filter(
        (id): id is string => id !== undefined
      )
    )) {
      crossBoundaryRelationshipCountByNode.set(
        boundaryId,
        (crossBoundaryRelationshipCountByNode.get(boundaryId) ?? 0) + 1
      );
    }
  }

  return {
    hierarchyType,
    entries,
    visibleNodes: entries.map((entry) => entry.node),
    visibleNodeIds,
    visibleRelationships,
    parentByNode,
    directChildCountByNode: new Map(
      [...childrenByNode].map(([nodeId, children]) => [
        nodeId,
        children.length
      ])
    ),
    descendantCountByNode,
    hiddenByCollapsedNode,
    crossBoundaryRelationshipCountByNode
  };
}

export function normalizedCollapsedNodeIds(
  document: GraphDocument,
  collapsedNodeIds: readonly string[]
): string[] {
  const projection = createHierarchyProjection(document, []);
  const seen = new Set<string>();
  return collapsedNodeIds.filter((nodeId) => {
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    return (projection.descendantCountByNode.get(nodeId) ?? 0) > 0;
  });
}

export function descendantCountLabel(count: number): string {
  return `${count} descendant${count === 1 ? "" : "s"}`;
}
