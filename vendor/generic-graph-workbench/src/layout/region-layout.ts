import {
  getProfile,
  hierarchyNodeIds,
  type Diagnostic,
  type GraphDocument,
  type GraphView,
  type Placement,
  type ViewAxis,
  type ViewRegion
} from "../core/index.js";
import { fallbackPlacement } from "./arrangement.js";

export interface MixedRegionLayoutResult {
  placements: Map<string, Placement>;
  diagnostics: Diagnostic[];
}

interface RegionContext {
  document: GraphDocument;
  view: GraphView;
  region: ViewRegion;
  nodeIds: string[];
  current: ReadonlyMap<string, Placement>;
}

const HEADER_SIZE = 34;
const PADDING = 18;

export function layoutOwningRegions(view: GraphView): ViewRegion[] {
  return (view.structure?.regions ?? []).filter((region) => region.layout);
}

export function createMixedRegionLayout(
  document: GraphDocument,
  view: GraphView,
  current: ReadonlyMap<string, Placement>
): MixedRegionLayoutResult {
  const regions = layoutOwningRegions(view).sort((left, right) =>
    compareIds(left.id, right.id)
  );
  const diagnostics: Diagnostic[] = [];
  const placements = new Map<string, Placement>();
  if (!view.structure || regions.length === 0) {
    return {
      placements,
      diagnostics: [{
        severity: "error",
        code: "missing-region-layouts",
        message: "This view has no regions with an explicit layout strategy.",
        entityId: view.id
      }]
    };
  }

  const owners = new Map<string, string[]>();
  for (const region of regions) {
    for (const [nodeId, mapping] of Object.entries(view.structure.nodeMappings)) {
      if (!mapping.regionIds.includes(region.id)) continue;
      const nodeOwners = owners.get(nodeId) ?? [];
      nodeOwners.push(region.id);
      owners.set(nodeId, nodeOwners);
    }
  }
  for (const [nodeId, regionIds] of owners) {
    if (regionIds.length > 1) {
      diagnostics.push({
        severity: "error",
        code: "ambiguous-region-layout-membership",
        message: `Node ${nodeId} belongs to multiple layout-owning regions: ${regionIds.join(", ")}.`,
        entityId: nodeId
      });
    }
  }
  if (hasErrors(diagnostics)) return { placements, diagnostics };

  for (const region of regions) {
    const nodeIds = [...owners.entries()]
      .filter(([, regionIds]) => regionIds[0] === region.id)
      .map(([nodeId]) => nodeId)
      .filter((nodeId) => document.nodes.some(({ id }) => id === nodeId))
      .sort(compareIds);
    if (nodeIds.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "empty-region-layout",
        message: `${region.label} has no explicitly mapped nodes to reflow.`,
        entityId: region.id
      });
      continue;
    }
    const context = { document, view, region, nodeIds, current };
    const result = layoutRegion(context);
    diagnostics.push(...result.diagnostics);
    for (const [nodeId, placement] of result.placements) {
      placements.set(nodeId, placement);
    }
  }

  return hasErrors(diagnostics)
    ? { placements: new Map(), diagnostics }
    : { placements, diagnostics };
}

function layoutRegion(context: RegionContext): MixedRegionLayoutResult {
  switch (context.region.layout!.strategy) {
    case "tree":
      return layoutTreeRegion(context);
    case "timeline":
      return layoutTimelineRegion(context);
    case "matrix":
      return layoutMatrixRegion(context);
    case "fishbone":
      return layoutFishboneRegion(context);
  }
}

function layoutTreeRegion(context: RegionContext): MixedRegionLayoutResult {
  const hierarchy = hierarchyForRegion(context);
  if (!hierarchy) return unsupportedHierarchy(context, "Tree");
  const { parents, children } = hierarchy;
  const configuredRoot = context.region.layout?.rootId;
  if (configuredRoot && !context.nodeIds.includes(configuredRoot)) {
    return errorResult(
      context,
      "region-layout-root-outside-membership",
      `Tree root ${configuredRoot} is not explicitly mapped to ${context.region.label}.`
    );
  }
  if (configuredRoot && parents.has(configuredRoot)) {
    return errorResult(
      context,
      "region-layout-root-has-parent",
      `Tree root ${configuredRoot} has a parent inside ${context.region.label}.`
    );
  }
  const roots = context.nodeIds
    .filter((nodeId) => !parents.has(nodeId))
    .sort(compareIds);
  if (configuredRoot) {
    roots.sort((left, right) =>
      left === configuredRoot ? -1 : right === configuredRoot ? 1 : compareIds(left, right)
    );
  }
  if (roots.length === 0) {
    return errorResult(
      context,
      "region-layout-cycle",
      `${context.region.label} has no hierarchy root for its tree layout.`
    );
  }

  const levels = new Map<string, number>();
  const pending = roots.map((nodeId) => ({ nodeId, level: 0 }));
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (levels.has(next.nodeId)) continue;
    levels.set(next.nodeId, next.level);
    for (const childId of children.get(next.nodeId) ?? []) {
      pending.push({ nodeId: childId, level: next.level + 1 });
    }
  }
  context.nodeIds.forEach((nodeId) => {
    if (!levels.has(nodeId)) levels.set(nodeId, 0);
  });
  return placeByLevels(context, levels, configuredRoot);
}

function layoutTimelineRegion(context: RegionContext): MixedRegionLayoutResult {
  const axis = layoutAxes(context)[0];
  if (
    !axis ||
    context.region.layout!.axisIds?.length !== 1 ||
    axis.scale !== "temporal"
  ) {
    return errorResult(
      context,
      "unsupported-timeline-region",
      `${context.region.label} timeline layout requires exactly one declared temporal axis.`
    );
  }
  return placeByAxisBuckets(context, axis);
}

function layoutMatrixRegion(context: RegionContext): MixedRegionLayoutResult {
  const axes = layoutAxes(context);
  const horizontal = axes.find(({ orientation }) => orientation === "horizontal");
  const vertical = axes.find(({ orientation }) => orientation === "vertical");
  if (
    context.region.layout!.axisIds?.length !== 2 ||
    !horizontal ||
    !vertical
  ) {
    return errorResult(
      context,
      "unsupported-matrix-region",
      `${context.region.label} matrix layout requires one horizontal and one vertical declared axis.`
    );
  }

  const groups = new Map<string, string[]>();
  for (const nodeId of context.nodeIds) {
    const mapping = context.view.structure!.nodeMappings[nodeId];
    const column = valueIndex(horizontal, mapping?.axisValues?.[horizontal.id]);
    const row = valueIndex(vertical, mapping?.axisValues?.[vertical.id]);
    if (column < 0 || row < 0) {
      return errorResult(
        context,
        "missing-matrix-axis-value",
        `Node ${nodeId} needs explicit ${horizontal.label} and ${vertical.label} values for ${context.region.label}.`,
        nodeId
      );
    }
    const key = `${row}:${column}`;
    const members = groups.get(key) ?? [];
    members.push(nodeId);
    groups.set(key, members);
  }

  const inner = innerBounds(context.region);
  const cellWidth = inner.width / horizontal.values.length;
  const cellHeight = inner.height / vertical.values.length;
  const placements = new Map<string, Placement>();
  for (const [key, nodeIds] of [...groups].sort(([left], [right]) =>
    compareIds(left, right)
  )) {
    const [row, column] = key.split(":").map(Number);
    const result = placeStack(
      context,
      nodeIds.sort(compareIds),
      {
        x: inner.x + column! * cellWidth,
        y: inner.y + row! * cellHeight,
        width: cellWidth,
        height: cellHeight
      }
    );
    if (result.diagnostics.length > 0) return result;
    result.placements.forEach((placement, nodeId) =>
      placements.set(nodeId, placement)
    );
  }
  return { placements, diagnostics: [] };
}

function layoutFishboneRegion(context: RegionContext): MixedRegionLayoutResult {
  const hierarchy = hierarchyForRegion(context);
  if (!hierarchy) return unsupportedHierarchy(context, "Fishbone");
  const configuredRoot = context.region.layout?.rootId;
  const roots = context.nodeIds
    .filter((nodeId) => !hierarchy.parents.has(nodeId))
    .sort(compareIds);
  const rootId = configuredRoot ?? roots[0];
  if (!rootId || !context.nodeIds.includes(rootId)) {
    return errorResult(
      context,
      "unsupported-fishbone-region",
      `${context.region.label} fishbone layout requires a mapped hierarchy root.`
    );
  }
  if (hierarchy.parents.has(rootId)) {
    return errorResult(
      context,
      "region-layout-root-has-parent",
      `Fishbone root ${rootId} has a parent inside ${context.region.label}.`
    );
  }
  const categories = hierarchy.children.get(rootId) ?? [];
  if (categories.length === 0) {
    return errorResult(
      context,
      "unsupported-fishbone-region",
      `${context.region.label} fishbone layout requires hierarchy branches beneath its root.`
    );
  }
  const reachable = new Set([rootId, ...descendants(rootId, hierarchy.children)]);
  const unreachable = context.nodeIds.filter((nodeId) => !reachable.has(nodeId));
  if (unreachable.length > 0) {
    return errorResult(
      context,
      "unreachable-fishbone-members",
      `${context.region.label} has mapped nodes outside root ${rootId}: ${unreachable.join(", ")}.`
    );
  }

  const inner = innerBounds(context.region);
  const horizontal = context.region.layout?.direction !== "vertical";
  const logicalWidth = horizontal ? inner.width : inner.height;
  const logicalHeight = horizontal ? inner.height : inner.width;
  const spacing = context.region.layout?.spacing ?? 24;
  const branchOffset = logicalHeight * 0.22 + spacing * 0.25;
  const descendantRun = Math.max(logicalWidth * 0.1, spacing * 2);
  const descendantRise = logicalHeight * 0.1 + spacing * 0.6;
  const logical = new Map<string, { x: number; y: number }>();
  const root = placementFor(context, rootId);
  logical.set(rootId, {
    x: logicalWidth - root.width / 2,
    y: logicalHeight / 2
  });
  categories.sort(compareIds).forEach((categoryId, index) => {
    const slot = (index + 1) / (categories.length + 1);
    const above = index % 2 === 0;
    const categoryX = logicalWidth * (0.15 + slot * 0.63);
    const categoryY =
      logicalHeight / 2 + (above ? -1 : 1) * branchOffset;
    logical.set(categoryId, { x: categoryX, y: categoryY });
    descendants(categoryId, hierarchy.children).forEach((nodeId, childIndex) => {
      logical.set(nodeId, {
        x: Math.max(0, categoryX - (childIndex + 1) * descendantRun),
        y:
          categoryY +
          (above ? -1 : 1) * (childIndex + 1) * descendantRise
      });
    });
  });
  const placements = new Map<string, Placement>();
  for (const nodeId of context.nodeIds) {
    const point = logical.get(nodeId);
    if (!point) continue;
    const current = placementFor(context, nodeId);
    const center = horizontal
      ? { x: inner.x + point.x, y: inner.y + point.y }
      : { x: inner.x + point.y, y: inner.y + logicalWidth - point.x };
    placements.set(nodeId, centered(current, center.x, center.y));
  }
  return ensureContained(context, placements);
}

function placeByLevels(
  context: RegionContext,
  levels: ReadonlyMap<string, number>,
  preferredRoot?: string
): MixedRegionLayoutResult {
  const groups = new Map<number, string[]>();
  for (const nodeId of context.nodeIds) {
    const level = levels.get(nodeId) ?? 0;
    const members = groups.get(level) ?? [];
    members.push(nodeId);
    groups.set(level, members);
  }
  const ordered = [...groups.entries()].sort(([left], [right]) => left - right);
  const inner = innerBounds(context.region);
  const horizontal = context.region.layout?.direction === "horizontal";
  const primarySize = (horizontal ? inner.width : inner.height) / ordered.length;
  const placements = new Map<string, Placement>();
  for (const [index, [, nodeIds]] of ordered.entries()) {
    const bounds = horizontal
      ? {
          x: inner.x + index * primarySize,
          y: inner.y,
          width: primarySize,
          height: inner.height
        }
      : {
          x: inner.x,
          y: inner.y + index * primarySize,
          width: inner.width,
          height: primarySize
        };
    const result = placeStack(
      context,
      nodeIds.sort((left, right) =>
        left === preferredRoot
          ? -1
          : right === preferredRoot
            ? 1
            : compareIds(left, right)
      ),
      bounds,
      horizontal
    );
    if (result.diagnostics.length > 0) return result;
    result.placements.forEach((placement, nodeId) =>
      placements.set(nodeId, placement)
    );
  }
  return { placements, diagnostics: [] };
}

function placeByAxisBuckets(
  context: RegionContext,
  axis: ViewAxis
): MixedRegionLayoutResult {
  const groups = new Map<number, string[]>();
  for (const nodeId of context.nodeIds) {
    const mapping = context.view.structure!.nodeMappings[nodeId];
    const index = valueIndex(axis, mapping?.axisValues?.[axis.id]);
    if (index < 0) {
      return errorResult(
        context,
        "missing-timeline-axis-value",
        `Node ${nodeId} needs an explicit ${axis.label} value for ${context.region.label}.`,
        nodeId
      );
    }
    const members = groups.get(index) ?? [];
    members.push(nodeId);
    groups.set(index, members);
  }
  const inner = innerBounds(context.region);
  const horizontal = axis.orientation === "horizontal";
  const bucketSize =
    (horizontal ? inner.width : inner.height) / axis.values.length;
  const placements = new Map<string, Placement>();
  for (const [index, nodeIds] of groups) {
    const bounds = horizontal
      ? {
          x: inner.x + index * bucketSize,
          y: inner.y,
          width: bucketSize,
          height: inner.height
        }
      : {
          x: inner.x,
          y: inner.y + index * bucketSize,
          width: inner.width,
          height: bucketSize
        };
    const result = placeStack(context, nodeIds.sort(compareIds), bounds, horizontal);
    if (result.diagnostics.length > 0) return result;
    result.placements.forEach((placement, nodeId) =>
      placements.set(nodeId, placement)
    );
  }
  return { placements, diagnostics: [] };
}

function placeStack(
  context: RegionContext,
  nodeIds: readonly string[],
  bounds: { x: number; y: number; width: number; height: number },
  horizontalPrimary = false
): MixedRegionLayoutResult {
  const gap = context.region.layout?.spacing ?? 24;
  const total = nodeIds.reduce(
    (sum, nodeId) =>
      sum +
      (horizontalPrimary
        ? placementFor(context, nodeId).height
        : placementFor(context, nodeId).width),
    0
  ) + Math.max(0, nodeIds.length - 1) * gap;
  const available = horizontalPrimary ? bounds.height : bounds.width;
  if (total > available) {
    return errorResult(
      context,
      "region-layout-overflow",
      `${context.region.label} cannot fit ${nodeIds.length} mapped nodes at the configured spacing.`
    );
  }
  let cursor = (horizontalPrimary ? bounds.y : bounds.x) + (available - total) / 2;
  const placements = new Map<string, Placement>();
  for (const nodeId of nodeIds) {
    const current = placementFor(context, nodeId);
    const centerX = horizontalPrimary
      ? bounds.x + bounds.width / 2
      : cursor + current.width / 2;
    const centerY = horizontalPrimary
      ? cursor + current.height / 2
      : bounds.y + bounds.height / 2;
    placements.set(nodeId, centered(current, centerX, centerY));
    cursor += (horizontalPrimary ? current.height : current.width) + gap;
  }
  return ensureContained(context, placements);
}

function hierarchyForRegion(context: RegionContext): {
  parents: Map<string, string>;
  children: Map<string, string[]>;
} | undefined {
  const profile = getProfile(context.document);
  if (!profile.hierarchyRelationship) return undefined;
  const memberIds = new Set(context.nodeIds);
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const relationship of [...context.document.relationships].sort((left, right) =>
    compareIds(left.id, right.id)
  )) {
    if (relationship.type !== profile.hierarchyRelationship) continue;
    const { parentId, childId } = hierarchyNodeIds(profile, relationship);
    if (!memberIds.has(parentId) || !memberIds.has(childId)) continue;
    parents.set(childId, parentId);
    const childIds = children.get(parentId) ?? [];
    childIds.push(childId);
    childIds.sort(compareIds);
    children.set(parentId, childIds);
  }
  return { parents, children };
}

function layoutAxes(context: RegionContext): ViewAxis[] {
  return (context.region.layout?.axisIds ?? []).flatMap((axisId) => {
    const axis = context.view.structure?.axes.find(({ id }) => id === axisId);
    return axis ? [axis] : [];
  });
}

function innerBounds(region: ViewRegion) {
  return {
    x: region.bounds.x + PADDING,
    y: region.bounds.y + HEADER_SIZE,
    width: region.bounds.width - PADDING * 2,
    height: region.bounds.height - HEADER_SIZE - PADDING
  };
}

function ensureContained(
  context: RegionContext,
  placements: Map<string, Placement>
): MixedRegionLayoutResult {
  const inner = innerBounds(context.region);
  const outside = [...placements.entries()].find(([, placement]) =>
    placement.x < inner.x ||
    placement.y < inner.y ||
    placement.x + placement.width > inner.x + inner.width ||
    placement.y + placement.height > inner.y + inner.height
  );
  return outside
    ? errorResult(
        context,
        "region-layout-overflow",
        `${context.region.label} cannot contain node ${outside[0]} with its current size and layout settings.`,
        outside[0]
      )
    : { placements, diagnostics: [] };
}

function unsupportedHierarchy(
  context: RegionContext,
  label: string
): MixedRegionLayoutResult {
  return errorResult(
    context,
    "unsupported-hierarchy-region",
    `${label} layout is unavailable because ${context.document.document.profile} does not declare a hierarchy relationship.`
  );
}

function errorResult(
  context: RegionContext,
  code: string,
  message: string,
  entityId = context.region.id
): MixedRegionLayoutResult {
  return {
    placements: new Map(),
    diagnostics: [{ severity: "error", code, message, entityId }]
  };
}

function placementFor(context: RegionContext, nodeId: string): Placement {
  const index = context.document.nodes.findIndex(({ id }) => id === nodeId);
  return structuredClone(context.current.get(nodeId) ?? fallbackPlacement(index));
}

function centered(
  placement: Placement,
  centerX: number,
  centerY: number
): Placement {
  return {
    ...placement,
    x: Math.round(centerX - placement.width / 2),
    y: Math.round(centerY - placement.height / 2)
  };
}

function descendants(
  rootId: string,
  children: ReadonlyMap<string, readonly string[]>
): string[] {
  const result: string[] = [];
  const pending = [...(children.get(rootId) ?? [])].sort(compareIds);
  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    result.push(nodeId);
    pending.push(...[...(children.get(nodeId) ?? [])].sort(compareIds));
  }
  return result;
}

function valueIndex(axis: ViewAxis, value: unknown): number {
  return axis.values.findIndex(
    (entry) =>
      typeof entry.value === typeof value &&
      JSON.stringify(entry.value) === JSON.stringify(value)
  );
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(({ severity }) => severity === "error");
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
