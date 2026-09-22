import {
  getProfile,
  hierarchyNodeIds,
  type GraphDocument,
  type GraphLayoutOrientation,
  type GraphProfile,
  type GraphView,
  type JsonValue,
  type Placement
} from "../core/index.js";
import { fallbackPlacement } from "./arrangement.js";
import { createRadialHierarchyLayout } from "./hierarchy-layout.js";
import { createLayeredHierarchyLayout } from "./layered-hierarchy-layout.js";

export const GRAPH_LAYOUT_EXTENSION_KEY = "genericGraph.layout";

export const GRAPH_LAYOUT_STRATEGIES = [
  { value: "radial-balanced", label: "Radial / balanced" },
  { value: "top-down", label: "Top down" },
  { value: "left-to-right", label: "Left to right" },
  { value: "layered-dependency", label: "Layered dependency" },
  { value: "bounded-force", label: "Bounded relationship" }
] as const;

export type GraphLayoutStrategy =
  (typeof GRAPH_LAYOUT_STRATEGIES)[number]["value"];
export type GraphLayoutDirection =
  | "top-down"
  | "left-to-right"
  | "bottom-up"
  | "right-to-left";

export type { GraphLayoutOrientation };

/**
 * The full set of orientation choices a hierarchy-shaped layout can offer,
 * in display order. A profile narrows this list to the subset that makes
 * sense for it via `hierarchyConstraints.orientations` (see
 * `profileLayoutOrientations`).
 */
export const GRAPH_LAYOUT_ORIENTATIONS: Array<{
  value: GraphLayoutOrientation;
  label: string;
}> = [
  { value: "balanced", label: "Balanced" },
  { value: "top-down", label: "Top down" },
  { value: "bottom-up", label: "Bottom up" },
  { value: "right-to-left", label: "Left" },
  { value: "left-to-right", label: "Right" }
];

/**
 * Returns the profile's declared orientation options, or `undefined` if
 * the profile has no hierarchy relationship (in which case orientation
 * is not a meaningful concept and the compact orientation control should
 * not be shown).
 */
export function profileLayoutOrientations(
  profile: Pick<GraphProfile, "hierarchyRelationship" | "hierarchyConstraints">
): readonly GraphLayoutOrientation[] | undefined {
  if (!profile.hierarchyRelationship) return undefined;
  return profile.hierarchyConstraints?.orientations ?? ["top-down"];
}

/** Derives the current compact orientation value from a layout config. */
export function graphLayoutOrientation(
  config: Pick<GraphLayoutConfig, "strategy" | "direction">
): GraphLayoutOrientation {
  return config.strategy === "radial-balanced" ? "balanced" : config.direction;
}

/** Builds the config patch to apply when the user picks a new orientation. */
export function graphLayoutOrientationPatch(
  orientation: GraphLayoutOrientation
): GraphLayoutConfigPatch {
  return orientation === "balanced"
    ? { strategy: "radial-balanced" }
    : { strategy: "top-down", direction: orientation };
}
export type GraphLayoutCompactness = "compact" | "comfortable" | "spacious";
export type DisconnectedComponentLayout =
  | "grid"
  | "horizontal"
  | "vertical";

export interface GraphLayoutConfig {
  strategy: GraphLayoutStrategy;
  direction: GraphLayoutDirection;
  spacing: number;
  compactness: GraphLayoutCompactness;
  rootId?: string;
  disconnectedComponents: DisconnectedComponentLayout;
}

export type GraphLayoutConfigPatch = Omit<
  Partial<GraphLayoutConfig>,
  "rootId"
> & {
  rootId?: string | undefined;
};

interface LayoutComponent {
  nodeIds: string[];
  relationships: Array<{ source: string; target: string }>;
}

const STRATEGIES = new Set<GraphLayoutStrategy>(
  GRAPH_LAYOUT_STRATEGIES.map(({ value }) => value)
);
const DIRECTIONS = new Set<GraphLayoutDirection>([
  "top-down",
  "left-to-right",
  "bottom-up",
  "right-to-left"
]);
const COMPACTNESS = new Set<GraphLayoutCompactness>([
  "compact",
  "comfortable",
  "spacious"
]);
const COMPONENT_LAYOUTS = new Set<DisconnectedComponentLayout>([
  "grid",
  "horizontal",
  "vertical"
]);
const DEFAULT_CENTER = { x: 450, y: 325 };
const MAX_FORCE_ITERATIONS = 120;
const MAX_REPULSION_NEIGHBORS = 24;

export function defaultGraphLayoutConfig(
  document: GraphDocument
): GraphLayoutConfig {
  const profile = document.document.profile;
  const strategy: GraphLayoutStrategy =
    profile === "mind-map"
      ? "radial-balanced"
      : profile === "dependency-map"
        ? "layered-dependency"
        : profile === "architecture-map" || profile === "blank"
          ? "bounded-force"
          : profile === "process-map"
            ? "left-to-right"
            : getProfile(document).hierarchyRelationship
              ? "top-down"
              : "bounded-force";
  return {
    strategy,
    direction:
      strategy === "left-to-right" || strategy === "layered-dependency"
        ? "left-to-right"
        : "top-down",
    spacing: 92,
    compactness: "comfortable",
    disconnectedComponents: "grid"
  };
}

export function graphLayoutConfig(
  document: GraphDocument,
  view: GraphView
): GraphLayoutConfig {
  const defaults = preferredGraphLayoutConfig(
    defaultGraphLayoutConfig(document),
    view.preferredLayout?.strategy
  );
  const raw = view.extensions?.[GRAPH_LAYOUT_EXTENSION_KEY];
  if (!isRecord(raw)) return defaults;
  const nodeIds = new Set(document.nodes.map(({ id }) => id));
  return {
    strategy: isMember(raw.strategy, STRATEGIES)
      ? raw.strategy
      : defaults.strategy,
    direction: isMember(raw.direction, DIRECTIONS)
      ? raw.direction
      : defaults.direction,
    spacing:
      typeof raw.spacing === "number" && Number.isFinite(raw.spacing)
        ? clamp(Math.round(raw.spacing), 20, 240)
        : defaults.spacing,
    compactness: isMember(raw.compactness, COMPACTNESS)
      ? raw.compactness
      : defaults.compactness,
    ...(typeof raw.rootId === "string" && nodeIds.has(raw.rootId)
      ? { rootId: raw.rootId }
      : {}),
    disconnectedComponents: isMember(
      raw.disconnectedComponents,
      COMPONENT_LAYOUTS
    )
      ? raw.disconnectedComponents
      : defaults.disconnectedComponents
  };
}

function preferredGraphLayoutConfig(
  defaults: GraphLayoutConfig,
  preferredStrategy: string | undefined
): GraphLayoutConfig {
  const strategy: GraphLayoutStrategy | undefined =
    preferredStrategy === "radial"
      ? "radial-balanced"
      : preferredStrategy === "hierarchy"
        ? "top-down"
        : preferredStrategy === "force"
          ? "bounded-force"
          : isMember(preferredStrategy, STRATEGIES)
            ? preferredStrategy
            : undefined;
  if (!strategy) return defaults;
  return {
    ...defaults,
    strategy,
    direction:
      strategy === "left-to-right" || strategy === "layered-dependency"
        ? "left-to-right"
        : "top-down"
  };
}

export function graphLayoutExtensionValue(
  config: GraphLayoutConfig
): JsonValue {
  const spacing = Number.isFinite(config.spacing)
    ? clamp(Math.round(config.spacing), 20, 240)
    : 92;
  return {
    strategy: config.strategy,
    direction: config.direction,
    spacing,
    compactness: config.compactness,
    ...(config.rootId ? { rootId: config.rootId } : {}),
    disconnectedComponents: config.disconnectedComponents
  };
}

export function createGraphLayout(
  document: GraphDocument,
  currentPlacements: ReadonlyMap<string, Placement>,
  config: GraphLayoutConfig
): Map<string, Placement> {
  if (document.nodes.length === 0) return new Map();
  const normalized = normalizeConfig(document, config);
  const placements = completePlacements(document, currentPlacements);
  const spacing = normalized.spacing * compactnessFactor(normalized.compactness);
  const components = collectComponents(document, normalized.strategy);
  const layouts = components.map((component) => {
    switch (normalized.strategy) {
      case "radial-balanced":
        return radialLayout(document, component, placements, normalized, spacing);
      case "bounded-force":
        return forceLayout(component, placements, normalized, spacing);
      case "layered-dependency":
        return layeredLayout(component, placements, normalized, spacing);
      case "top-down":
      case "left-to-right":
        return hierarchyLayeredLayout(
          document,
          component,
          placements,
          normalized,
          spacing
        );
    }
  });
  const packed = packLayouts(
    layouts,
    normalized.disconnectedComponents,
    spacing * 1.8
  );
  return anchorLayout(packed, placements, normalized.rootId);
}

function normalizeConfig(
  document: GraphDocument,
  config: GraphLayoutConfig
): GraphLayoutConfig {
  const defaults = defaultGraphLayoutConfig(document);
  const nodeIds = new Set(document.nodes.map(({ id }) => id));
  return {
    strategy: STRATEGIES.has(config.strategy)
      ? config.strategy
      : defaults.strategy,
    direction: DIRECTIONS.has(config.direction)
      ? config.direction
      : defaults.direction,
    spacing: Number.isFinite(config.spacing)
      ? clamp(Math.round(config.spacing), 20, 240)
      : defaults.spacing,
    compactness: COMPACTNESS.has(config.compactness)
      ? config.compactness
      : defaults.compactness,
    ...(config.rootId && nodeIds.has(config.rootId)
      ? { rootId: config.rootId }
      : {}),
    disconnectedComponents: COMPONENT_LAYOUTS.has(
      config.disconnectedComponents
    )
      ? config.disconnectedComponents
      : defaults.disconnectedComponents
  };
}

function completePlacements(
  document: GraphDocument,
  placements: ReadonlyMap<string, Placement>
): Map<string, Placement> {
  const ordered = sortedNodeIds(document);
  return new Map(
    ordered.map((nodeId, index) => [
      nodeId,
      structuredClone(placements.get(nodeId) ?? fallbackPlacement(index))
    ])
  );
}

function collectComponents(
  document: GraphDocument,
  strategy: GraphLayoutStrategy
): LayoutComponent[] {
  const nodeIds = sortedNodeIds(document);
  const available = new Set(nodeIds);
  const relationships = layoutRelationships(document, strategy).filter(
    ({ source, target }) =>
      source !== target && available.has(source) && available.has(target)
  );
  const adjacent = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  relationships.forEach(({ source, target }) => {
    adjacent.get(source)!.add(target);
    adjacent.get(target)!.add(source);
  });
  const visited = new Set<string>();
  const components: LayoutComponent[] = [];
  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    const pending = [nodeId];
    const componentIds: string[] = [];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      componentIds.push(current);
      pending.push(
        ...[...(adjacent.get(current) ?? [])]
          .filter((id) => !visited.has(id))
          .sort(compareIds)
      );
    }
    const memberIds = new Set(componentIds);
    components.push({
      nodeIds: componentIds.sort(compareIds),
      relationships: relationships.filter(
        ({ source, target }) =>
          memberIds.has(source) && memberIds.has(target)
      )
    });
  }
  return components.sort((left, right) =>
    compareIds(left.nodeIds[0]!, right.nodeIds[0]!)
  );
}

function layoutRelationships(
  document: GraphDocument,
  strategy: GraphLayoutStrategy
): Array<{ source: string; target: string }> {
  const profile = getProfile(document);
  const hierarchyType = profile.hierarchyRelationship;
  const hierarchyOnly =
    hierarchyType &&
    (strategy === "radial-balanced" ||
      strategy === "top-down" ||
      strategy === "left-to-right");
  return [...document.relationships]
    .filter(
      (relationship) => !hierarchyOnly || relationship.type === hierarchyType
    )
    .sort((left, right) => compareIds(left.id, right.id))
    .map((relationship): { source: string; target: string } => {
      if (hierarchyOnly) {
        const { parentId, childId } = hierarchyNodeIds(profile, relationship);
        return { source: parentId, target: childId };
      }
      if (
        strategy === "layered-dependency" &&
        relationship.type === "depends-on"
      ) {
        return { source: relationship.target, target: relationship.source };
      }
      return { source: relationship.source, target: relationship.target };
    });
}

function radialLayout(
  document: GraphDocument,
  component: LayoutComponent,
  placements: ReadonlyMap<string, Placement>,
  config: GraphLayoutConfig,
  spacing: number
): Map<string, Placement> {
  const profile = getProfile(document);
  if (profile.hierarchyRelationship) {
    const memberIds = new Set(component.nodeIds);
    const scoped: GraphDocument = {
      ...document,
      nodes: document.nodes.filter(({ id }) => memberIds.has(id)),
      relationships: document.relationships.filter(
        ({ source, target }) =>
          memberIds.has(source) && memberIds.has(target)
      )
    };
    return createRadialHierarchyLayout(scoped, placements, {
      ...(config.rootId ? { rootId: config.rootId } : {}),
      horizontalGap: spacing,
      verticalGap: spacing * 0.3,
      componentGap: spacing * 1.8
    });
  }

  const rootId = component.nodeIds.includes(config.rootId ?? "")
    ? config.rootId!
    : component.nodeIds[0]!;
  const levels = breadthFirstLevels(component, rootId);
  const result = new Map<string, Placement>();
  const root = placements.get(rootId)!;
  result.set(rootId, { ...root, x: -root.width / 2, y: -root.height / 2 });
  const maxSize = Math.max(
    ...component.nodeIds.map((id) => {
      const placement = placements.get(id)!;
      return Math.max(placement.width, placement.height);
    })
  );
  [...levels.entries()]
    .filter(([level]) => level > 0)
    .sort(([left], [right]) => left - right)
    .forEach(([level, ids]) => {
      const radius = level * (maxSize + spacing);
      ids.sort(compareIds).forEach((nodeId, index) => {
        const placement = placements.get(nodeId)!;
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / ids.length;
        result.set(nodeId, {
          ...placement,
          x: Math.cos(angle) * radius - placement.width / 2,
          y: Math.sin(angle) * radius - placement.height / 2
        });
      });
    });
  return rounded(result);
}

/**
 * Routes "top-down" / "left-to-right" layout to a real layered/rank-based
 * tree algorithm for hierarchy profiles (e.g. Work Breakdown Structure),
 * so parent/child boxes never overlap and edges don't cross. Falls back
 * to the generic layered layout for profiles with no hierarchy
 * relationship (e.g. process-map), where "top-down"/"left-to-right" are
 * just directional flowcharts rather than a tree.
 */
function hierarchyLayeredLayout(
  document: GraphDocument,
  component: LayoutComponent,
  placements: ReadonlyMap<string, Placement>,
  config: GraphLayoutConfig,
  spacing: number
): Map<string, Placement> {
  const profile = getProfile(document);
  if (!profile.hierarchyRelationship) {
    return layeredLayout(component, placements, config, spacing);
  }
  const memberIds = new Set(component.nodeIds);
  const scoped: GraphDocument = {
    ...document,
    nodes: document.nodes.filter(({ id }) => memberIds.has(id)),
    relationships: document.relationships.filter(
      ({ source, target }) => memberIds.has(source) && memberIds.has(target)
    )
  };
  const orientation =
    config.direction === "top-down" || config.direction === "bottom-up"
      ? "vertical"
      : "horizontal";
  const canonical = createLayeredHierarchyLayout(scoped, placements, {
    ...(config.rootId ? { rootId: config.rootId } : {}),
    siblingGap: spacing * 0.55,
    levelGap: spacing,
    componentGap: spacing * 1.8,
    orientation
  });
  return rounded(orientLayout(canonical, config.direction));
}

function layeredLayout(
  component: LayoutComponent,
  placements: ReadonlyMap<string, Placement>,
  config: GraphLayoutConfig,
  spacing: number
): Map<string, Placement> {
  const preferredRoot = component.nodeIds.includes(config.rootId ?? "")
    ? config.rootId
    : undefined;
  const levels = directedLevels(component, preferredRoot);
  const grouped = new Map<number, string[]>();
  component.nodeIds.forEach((nodeId) => {
    const level = levels.get(nodeId) ?? 0;
    const ids = grouped.get(level) ?? [];
    ids.push(nodeId);
    grouped.set(level, ids);
  });
  const result = new Map<string, Placement>();
  let primaryCursor = 0;
  [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([, ids]) => {
      ids.sort(compareIds);
      const primarySize = Math.max(
        ...ids.map((id) => placements.get(id)!.width)
      );
      const totalSecondary =
        ids.reduce((total, id) => total + placements.get(id)!.height, 0) +
        Math.max(0, ids.length - 1) * spacing * 0.55;
      let secondaryCursor = -totalSecondary / 2;
      ids.forEach((nodeId) => {
        const placement = placements.get(nodeId)!;
        result.set(nodeId, {
          ...placement,
          x: primaryCursor + (primarySize - placement.width) / 2,
          y: secondaryCursor
        });
        secondaryCursor += placement.height + spacing * 0.55;
      });
      primaryCursor += primarySize + spacing;
    });
  return rounded(orientLayout(result, config.direction));
}

function forceLayout(
  component: LayoutComponent,
  placements: ReadonlyMap<string, Placement>,
  config: GraphLayoutConfig,
  spacing: number
): Map<string, Placement> {
  const ids = rootFirst(component.nodeIds, config.rootId);
  if (ids.length === 1) {
    const placement = placements.get(ids[0]!)!;
    return new Map([[ids[0]!, { ...placement, x: 0, y: 0 }]]);
  }
  const radius = Math.max(180, Math.sqrt(ids.length) * (90 + spacing));
  const centers = new Map(
    ids.map((id, index) => [
      id,
      {
        x: Math.cos((index * Math.PI * 2) / ids.length) * radius,
        y: Math.sin((index * Math.PI * 2) / ids.length) * radius
      }
    ])
  );
  const edges = component.relationships
    .map(({ source, target }) =>
      compareIds(source, target) <= 0
        ? { source, target }
        : { source: target, target: source }
    )
    .sort(
      (left, right) =>
        compareIds(left.source, right.source) ||
        compareIds(left.target, right.target)
    );
  const ideal = 150 + spacing;
  const bound = Math.max(240, Math.sqrt(ids.length) * ideal);
  const iterations =
    ids.length > 500
      ? Math.floor(MAX_FORCE_ITERATIONS / 2)
      : MAX_FORCE_ITERATIONS;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const movement = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    ids.forEach((leftId, leftIndex) => {
      ids
        .slice(leftIndex + 1, leftIndex + 1 + MAX_REPULSION_NEIGHBORS)
        .forEach((rightId) => {
        const left = centers.get(leftId)!;
        const right = centers.get(rightId)!;
        let dx = left.x - right.x;
        let dy = left.y - right.y;
        if (dx === 0 && dy === 0) dx = compareIds(leftId, rightId);
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (ideal * ideal) / distance;
        dx = (dx / distance) * force;
        dy = (dy / distance) * force;
        movement.get(leftId)!.x += dx;
        movement.get(leftId)!.y += dy;
        movement.get(rightId)!.x -= dx;
        movement.get(rightId)!.y -= dy;
        });
    });
    edges.forEach(({ source, target }) => {
      const left = centers.get(source)!;
      const right = centers.get(target)!;
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance * distance) / ideal;
      movement.get(source)!.x += (dx / distance) * force;
      movement.get(source)!.y += (dy / distance) * force;
      movement.get(target)!.x -= (dx / distance) * force;
      movement.get(target)!.y -= (dy / distance) * force;
    });
    const temperature = 24 * (1 - iteration / iterations);
    ids.forEach((id) => {
      const center = centers.get(id)!;
      const delta = movement.get(id)!;
      const magnitude = Math.max(1, Math.hypot(delta.x, delta.y));
      center.x = clamp(
        center.x + (delta.x / magnitude) * Math.min(magnitude, temperature),
        -bound,
        bound
      );
      center.y = clamp(
        center.y + (delta.y / magnitude) * Math.min(magnitude, temperature),
        -bound,
        bound
      );
    });
  }
  return rounded(
    new Map(
      ids.map((id) => {
        const placement = placements.get(id)!;
        const center = centers.get(id)!;
        return [
          id,
          {
            ...placement,
            x: center.x - placement.width / 2,
            y: center.y - placement.height / 2
          }
        ];
      })
    )
  );
}

function directedLevels(
  component: LayoutComponent,
  preferredRoot?: string
): Map<string, number> {
  const incoming = new Map(component.nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(
    component.nodeIds.map((id) => [id, new Set<string>()])
  );
  component.relationships.forEach(({ source, target }) => {
    if (!outgoing.get(source)!.has(target)) {
      outgoing.get(source)!.add(target);
      incoming.set(target, incoming.get(target)! + 1);
    }
  });
  const roots = rootFirst(
    component.nodeIds.filter((id) => incoming.get(id) === 0),
    preferredRoot
  );
  if (roots.length === 0) roots.push(preferredRoot ?? component.nodeIds[0]!);
  const levels = new Map<string, number>();
  const pending = roots.map((id) => ({ id, level: 0 }));
  while (pending.length > 0) {
    const { id, level } = pending.shift()!;
    if ((levels.get(id) ?? -1) >= level) continue;
    levels.set(id, level);
    [...(outgoing.get(id) ?? [])].sort(compareIds).forEach((target) => {
      if (!levels.has(target)) pending.push({ id: target, level: level + 1 });
    });
  }
  component.nodeIds
    .filter((id) => !levels.has(id))
    .sort(compareIds)
    .forEach((id) => levels.set(id, 0));
  return levels;
}

function breadthFirstLevels(
  component: LayoutComponent,
  rootId: string
): Map<number, string[]> {
  const adjacent = new Map(
    component.nodeIds.map((id) => [id, new Set<string>()])
  );
  component.relationships.forEach(({ source, target }) => {
    adjacent.get(source)!.add(target);
    adjacent.get(target)!.add(source);
  });
  const byLevel = new Map<number, string[]>();
  const visited = new Set<string>();
  const pending = [{ id: rootId, level: 0 }];
  while (pending.length > 0) {
    const { id, level } = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const ids = byLevel.get(level) ?? [];
    ids.push(id);
    byLevel.set(level, ids);
    pending.push(
      ...[...(adjacent.get(id) ?? [])]
        .sort(compareIds)
        .map((childId) => ({ id: childId, level: level + 1 }))
    );
  }
  return byLevel;
}

function orientLayout(
  placements: ReadonlyMap<string, Placement>,
  direction: GraphLayoutDirection
): Map<string, Placement> {
  if (direction === "left-to-right") return new Map(placements);
  return new Map(
    [...placements].map(([id, placement]) => {
      switch (direction) {
        case "right-to-left":
          return [id, { ...placement, x: -placement.x - placement.width }];
        case "top-down":
          return [id, { ...placement, x: placement.y, y: placement.x }];
        case "bottom-up":
          return [
            id,
            {
              ...placement,
              x: placement.y,
              y: -placement.x - placement.height
            }
          ];
      }
    })
  );
}

function packLayouts(
  layouts: readonly ReadonlyMap<string, Placement>[],
  mode: DisconnectedComponentLayout,
  gap: number
): Map<string, Placement> {
  if (layouts.length === 0) return new Map();
  const bounds = layouts.map(layoutBounds);
  const maxWidth = Math.max(...bounds.map(({ width }) => width));
  const maxHeight = Math.max(...bounds.map(({ height }) => height));
  const columns =
    mode === "vertical"
      ? 1
      : mode === "horizontal"
        ? layouts.length
        : Math.ceil(Math.sqrt(layouts.length));
  const result = new Map<string, Placement>();
  layouts.forEach((layout, index) => {
    const bound = bounds[index]!;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const offsetX = column * (maxWidth + gap) - bound.left;
    const offsetY = row * (maxHeight + gap) - bound.top;
    layout.forEach((placement, id) => {
      result.set(id, {
        ...placement,
        x: placement.x + offsetX,
        y: placement.y + offsetY
      });
    });
  });
  return result;
}

function anchorLayout(
  placements: ReadonlyMap<string, Placement>,
  current: ReadonlyMap<string, Placement>,
  rootId?: string
): Map<string, Placement> {
  const anchorId =
    rootId && placements.has(rootId)
      ? rootId
      : [...placements.keys()].sort(compareIds)[0]!;
  const placement = placements.get(anchorId)!;
  const previous = current.get(anchorId);
  const target = previous
    ? {
        x: previous.x + previous.width / 2,
        y: previous.y + previous.height / 2
      }
    : DEFAULT_CENTER;
  const dx = target.x - (placement.x + placement.width / 2);
  const dy = target.y - (placement.y + placement.height / 2);
  return rounded(
    new Map(
      [...placements].map(([id, value]) => [
        id,
        { ...value, x: value.x + dx, y: value.y + dy }
      ])
    )
  );
}

function layoutBounds(placements: ReadonlyMap<string, Placement>) {
  const values = [...placements.values()];
  const left = Math.min(...values.map(({ x }) => x));
  const top = Math.min(...values.map(({ y }) => y));
  const right = Math.max(...values.map(({ x, width }) => x + width));
  const bottom = Math.max(...values.map(({ y, height }) => y + height));
  return { left, top, width: right - left, height: bottom - top };
}

function rounded(
  placements: ReadonlyMap<string, Placement>
): Map<string, Placement> {
  return new Map(
    [...placements].map(([id, placement]) => [
      id,
      {
        ...placement,
        x: Math.round(placement.x),
        y: Math.round(placement.y)
      }
    ])
  );
}

function sortedNodeIds(document: GraphDocument): string[] {
  return document.nodes.map(({ id }) => id).sort(compareIds);
}

function rootFirst(ids: readonly string[], rootId?: string): string[] {
  const sorted = [...ids].sort(compareIds);
  return rootId && sorted.includes(rootId)
    ? [rootId, ...sorted.filter((id) => id !== rootId)]
    : sorted;
}

function compactnessFactor(compactness: GraphLayoutCompactness): number {
  return compactness === "compact"
    ? 0.72
    : compactness === "spacious"
      ? 1.35
      : 1;
}

function isRecord(value: JsonValue | undefined): value is {
  [key: string]: JsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMember<T extends string>(
  value: JsonValue | undefined,
  values: ReadonlySet<T>
): value is T {
  return typeof value === "string" && values.has(value as T);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
