import type { GraphDocument } from "../core/index.js";

/**
 * Renderer-neutral single-document selection. Mirrors the shape historically
 * duplicated as `WorkspaceSelection` in the Generic Graph Canvas prototype;
 * that type is now a thin alias over this one (see
 * `experiments/computing/generic-graph-canvas/prototype/src/model/
 * workspace.ts`).
 */
export type GraphSelection =
  | {
      kind: "node";
      id: string;
      ids?: readonly string[];
      anchorId?: string;
    }
  | { kind: "property"; nodeId: string; key: string }
  | { kind: "relationship"; id: string };

export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function graphSelectionNodeIds(
  selection: GraphSelection | undefined
): readonly string[] {
  if (selection?.kind !== "node") return [];
  return uniqueIds(selection.ids ?? [selection.id]);
}

export function isGraphNodeSelected(
  selection: GraphSelection | undefined,
  nodeId: string
): boolean {
  return graphSelectionNodeIds(selection).includes(nodeId);
}

export function createGraphNodeSelection(
  nodeIds: readonly string[],
  primaryId: string,
  anchorId: string
): GraphSelection {
  const ids = uniqueIds(nodeIds);
  if (ids.length <= 1) return { kind: "node", id: primaryId };
  return { kind: "node", id: primaryId, ids, anchorId };
}

export interface ClickNodeSelectionOptions {
  additive?: boolean;
  range?: boolean;
  orderedNodeIds?: readonly string[];
}

/**
 * Resolves the next selection for a single-node click/tap, honoring
 * shift-range and ctrl/cmd-additive modifiers the same way a spreadsheet or
 * file explorer would. Pure: callers own applying the returned selection
 * (and any focus-projection change) to their own state.
 */
export function resolveClickNodeSelection(
  current: GraphSelection | undefined,
  nodeId: string,
  availableNodeIds: ReadonlySet<string>,
  options: ClickNodeSelectionOptions = {}
): GraphSelection | undefined {
  const currentNodeSelection =
    current?.kind === "node" ? current : undefined;
  const currentIds = graphSelectionNodeIds(currentNodeSelection);
  let anchorId =
    currentNodeSelection?.anchorId ?? currentNodeSelection?.id ?? nodeId;
  let nodeIds: string[];

  if (options.range && options.orderedNodeIds) {
    const ordered = options.orderedNodeIds.filter((id) =>
      availableNodeIds.has(id)
    );
    const anchorIndex = ordered.indexOf(anchorId);
    const targetIndex = ordered.indexOf(nodeId);
    const range =
      anchorIndex >= 0 && targetIndex >= 0
        ? ordered.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1
          )
        : [nodeId];
    nodeIds = options.additive ? uniqueIds([...currentIds, ...range]) : range;
  } else if (options.additive) {
    nodeIds = currentIds.includes(nodeId)
      ? currentIds.filter((id) => id !== nodeId)
      : [...currentIds, nodeId];
    if (!currentNodeSelection) anchorId = nodeId;
  } else {
    nodeIds = [nodeId];
    anchorId = nodeId;
  }

  const primaryId = nodeIds.includes(nodeId) ? nodeId : nodeIds.at(-1);
  if (!nodeIds.includes(anchorId)) {
    anchorId = nodeIds[0] ?? primaryId ?? nodeId;
  }
  return primaryId
    ? createGraphNodeSelection(nodeIds, primaryId, anchorId)
    : undefined;
}

export interface MultiNodeSelectionOptions {
  additive?: boolean;
  primaryId?: string;
  anchorId?: string;
}

/**
 * Resolves the next selection for a programmatic multi-node selection (e.g.
 * a marquee/box select or "select all of type"). Pure, mirroring
 * {@link resolveClickNodeSelection}.
 */
export function resolveMultiNodeSelection(
  current: GraphSelection | undefined,
  nodeIds: readonly string[],
  availableNodeIds: ReadonlySet<string>,
  options: MultiNodeSelectionOptions = {}
): GraphSelection | undefined {
  const incoming = uniqueIds(
    nodeIds.filter((id) => availableNodeIds.has(id))
  );
  if (options.additive && incoming.length === 0) {
    return current;
  }
  const currentNodeSelection = current?.kind === "node" ? current : undefined;
  const currentIds = graphSelectionNodeIds(currentNodeSelection);
  const selected = options.additive
    ? uniqueIds([...currentIds, ...incoming])
    : incoming;
  const primaryId =
    (options.primaryId && selected.includes(options.primaryId)
      ? options.primaryId
      : selected.at(-1)) ?? undefined;
  if (!primaryId) return undefined;
  const anchorId =
    options.additive && currentNodeSelection
      ? (currentNodeSelection.anchorId ?? currentNodeSelection.id)
      : (options.anchorId ?? selected[0] ?? primaryId);
  return createGraphNodeSelection(selected, primaryId, anchorId);
}

/**
 * Reconciles a selection against the live document, dropping references to
 * nodes/relationships/properties that no longer exist (e.g. after an
 * undo/redo or a remote mutation).
 */
export function repairMissingGraphSelection(
  selection: GraphSelection | undefined,
  document: GraphDocument
): GraphSelection | undefined {
  if (!selection) return undefined;
  if (selection.kind === "relationship") {
    return document.relationships.some(
      (relationship) => relationship.id === selection.id
    )
      ? selection
      : undefined;
  }
  if (selection.kind === "property") {
    const node = document.nodes.find(
      (candidate) => candidate.id === selection.nodeId
    );
    return node && Object.hasOwn(node.properties, selection.key)
      ? selection
      : undefined;
  }
  const available = new Set(document.nodes.map((node) => node.id));
  const ids = graphSelectionNodeIds(selection).filter((id) =>
    available.has(id)
  );
  if (ids.length === 0) return undefined;
  const primaryId = available.has(selection.id) ? selection.id : ids.at(-1)!;
  const anchorId =
    selection.anchorId && available.has(selection.anchorId)
      ? selection.anchorId
      : ids[0]!;
  const previousIds = graphSelectionNodeIds(selection);
  if (
    primaryId === selection.id &&
    anchorId === (selection.anchorId ?? selection.id) &&
    ids.length === previousIds.length &&
    ids.every((id, index) => id === previousIds[index])
  ) {
    return selection;
  }
  return createGraphNodeSelection(ids, primaryId, anchorId);
}

/**
 * Reconciles a selection against nodes hidden by hierarchy collapse,
 * re-targeting hidden node/property selections at their nearest visible
 * (collapsed) ancestor. `hiddenByCollapsedNode` is
 * `HierarchyProjection.hiddenByCollapsedNode` from `../layout/index.js`.
 */
export function repairHiddenGraphSelection(
  selection: GraphSelection | undefined,
  hiddenByCollapsedNode: ReadonlyMap<string, string>
): GraphSelection | undefined {
  if (!selection || selection.kind === "relationship") return selection;
  if (selection.kind === "property") {
    const collapsedAncestorId = hiddenByCollapsedNode.get(selection.nodeId);
    return collapsedAncestorId
      ? { kind: "node", id: collapsedAncestorId }
      : selection;
  }
  const ids = uniqueIds(
    graphSelectionNodeIds(selection).map(
      (nodeId) => hiddenByCollapsedNode.get(nodeId) ?? nodeId
    )
  );
  const primaryId = hiddenByCollapsedNode.get(selection.id) ?? selection.id;
  const anchorId =
    hiddenByCollapsedNode.get(selection.anchorId ?? selection.id) ??
    selection.anchorId ??
    selection.id;
  const previousIds = graphSelectionNodeIds(selection);
  if (
    primaryId === selection.id &&
    anchorId === (selection.anchorId ?? selection.id) &&
    ids.length === previousIds.length &&
    ids.every((id, index) => id === previousIds[index])
  ) {
    return selection;
  }
  return createGraphNodeSelection(ids, primaryId, anchorId);
}
