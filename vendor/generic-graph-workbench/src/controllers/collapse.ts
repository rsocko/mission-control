import type { GraphDocument } from "../core/index.js";
import {
  createHierarchyProjection,
  normalizedCollapsedNodeIds,
  type HierarchyProjection
} from "../layout/index.js";

export interface HierarchyExpansionResult {
  collapsedNodeIds: string[];
  hierarchy: HierarchyProjection;
}

/**
 * Resolves the collapsed-id set and resulting hierarchy projection for
 * expanding or collapsing a single node. Returns `undefined` when the node
 * has no descendants (nothing to expand/collapse).
 */
export function resolveNodeExpansion(
  document: GraphDocument,
  collapsedNodeIds: readonly string[],
  nodeId: string,
  expanded: boolean
): HierarchyExpansionResult | undefined {
  const hierarchy = createHierarchyProjection(document, collapsedNodeIds);
  if ((hierarchy.descendantCountByNode.get(nodeId) ?? 0) === 0) {
    return undefined;
  }
  const next = new Set(collapsedNodeIds);
  if (expanded) next.delete(nodeId);
  else next.add(nodeId);
  const nextCollapsedNodeIds = normalizedCollapsedNodeIds(document, [
    ...next
  ]);
  return {
    collapsedNodeIds: nextCollapsedNodeIds,
    hierarchy: createHierarchyProjection(document, nextCollapsedNodeIds)
  };
}

/**
 * Resolves the collapsed-id set and resulting hierarchy projection required
 * to make `nodeId` visible: expands every collapsed ancestor. Returns
 * `undefined` when `nodeId` does not exist in the document.
 */
export function resolveNodeReveal(
  document: GraphDocument,
  collapsedNodeIds: readonly string[],
  nodeId: string
): HierarchyExpansionResult | undefined {
  if (!document.nodes.some((node) => node.id === nodeId)) return undefined;
  const hierarchy = createHierarchyProjection(document, collapsedNodeIds);
  const next = new Set(collapsedNodeIds);
  let ancestorId = hierarchy.parentByNode.get(nodeId);
  while (ancestorId) {
    next.delete(ancestorId);
    ancestorId = hierarchy.parentByNode.get(ancestorId);
  }
  const nextCollapsedNodeIds = normalizedCollapsedNodeIds(document, [
    ...next
  ]);
  return {
    collapsedNodeIds: nextCollapsedNodeIds,
    hierarchy: createHierarchyProjection(document, nextCollapsedNodeIds)
  };
}
