import type { ViewRegionLayout, ViewRegionLayoutStrategy } from "../core/index.js";

/**
 * A named, bounded parameter bundle for one of the existing region layout
 * strategies (tree/timeline/matrix/fishbone). Presets are data only — they
 * never introduce new layout algorithms, they just make the existing
 * strategies easier to reach with sensible, named parameter combinations.
 *
 * Presets intentionally omit `rootId` and `axisIds`: those reference
 * specific nodes/axes in a document and cannot be generalized across
 * documents.
 */
export interface LayoutPreset {
  id: string;
  label: string;
  description: string;
  strategy: ViewRegionLayoutStrategy;
  direction?: "horizontal" | "vertical";
  spacing?: number;
}

export type LayoutPresetParams = Pick<LayoutPreset, "direction" | "spacing">;

const DIRECTIONAL_STRATEGIES = new Set<ViewRegionLayoutStrategy>([
  "tree",
  "fishbone"
]);

export const BUILT_IN_LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: "tree-org-chart",
    label: "Org chart",
    description: "Top-down hierarchy, comfortable spacing.",
    strategy: "tree",
    direction: "vertical",
    spacing: 24
  },
  {
    id: "tree-left-to-right",
    label: "Left-to-right tree",
    description: "Hierarchy grows left to right, comfortable spacing.",
    strategy: "tree",
    direction: "horizontal",
    spacing: 24
  },
  {
    id: "tree-compact",
    label: "Compact tree",
    description: "Top-down hierarchy with tight spacing.",
    strategy: "tree",
    direction: "vertical",
    spacing: 12
  },
  {
    id: "timeline-horizontal",
    label: "Timeline",
    description: "Chronological buckets flow left to right.",
    strategy: "timeline",
    spacing: 20
  },
  {
    id: "timeline-compact",
    label: "Compact timeline",
    description: "Chronological buckets with tight spacing.",
    strategy: "timeline",
    spacing: 10
  },
  {
    id: "matrix-standard",
    label: "Priority matrix",
    description: "Two-axis grid with comfortable spacing.",
    strategy: "matrix",
    spacing: 16
  },
  {
    id: "matrix-dense",
    label: "Dense matrix",
    description: "Two-axis grid with tight spacing for larger sets.",
    strategy: "matrix",
    spacing: 8
  },
  {
    id: "fishbone-root-cause-horizontal",
    label: "Fishbone root cause",
    description: "Classic horizontal fishbone/Ishikawa diagram.",
    strategy: "fishbone",
    direction: "horizontal",
    spacing: 20
  },
  {
    id: "fishbone-root-cause-vertical",
    label: "Vertical fishbone",
    description: "Fishbone diagram rotated to grow top to bottom.",
    strategy: "fishbone",
    direction: "vertical",
    spacing: 20
  }
];

export function layoutPresetsForStrategy(
  strategy: ViewRegionLayoutStrategy
): LayoutPreset[] {
  return BUILT_IN_LAYOUT_PRESETS.filter((preset) => preset.strategy === strategy);
}

export function findLayoutPreset(presetId: string): LayoutPreset | undefined {
  return BUILT_IN_LAYOUT_PRESETS.find((preset) => preset.id === presetId);
}

/**
 * Reject presets whose declared params are not legal for their strategy.
 * `direction` only affects tree/fishbone layouts today — timeline and
 * matrix regions derive their orientation from the axes they are bound to,
 * so a preset that sets `direction` for those strategies is invalid.
 */
export function validateLayoutPreset(preset: LayoutPreset): string[] {
  const errors: string[] = [];
  if (preset.direction && !DIRECTIONAL_STRATEGIES.has(preset.strategy)) {
    errors.push(
      `"${preset.label}" sets a direction, but ${preset.strategy} layouts derive orientation from their axes.`
    );
  }
  if (preset.spacing !== undefined && preset.spacing <= 0) {
    errors.push(`"${preset.label}" spacing must be a positive number.`);
  }
  return errors;
}

/**
 * Finds a built-in preset whose params exactly match a region's current
 * layout. Used so the UI can show which preset (if any) is already active
 * for a region — including one recommended by a template/profile that
 * baked the matching params directly into the region.
 */
export function matchingLayoutPresetId(layout: ViewRegionLayout): string | undefined {
  return BUILT_IN_LAYOUT_PRESETS.find(
    (preset) =>
      preset.strategy === layout.strategy &&
      (preset.direction ?? undefined) === (layout.direction ?? undefined) &&
      (preset.spacing ?? undefined) === (layout.spacing ?? undefined)
  )?.id;
}

export function applyLayoutPresetParams(
  layout: ViewRegionLayout,
  preset: LayoutPreset
): ViewRegionLayout {
  const next: ViewRegionLayout = { ...layout, strategy: preset.strategy };
  if (preset.direction === undefined) {
    delete next.direction;
  } else {
    next.direction = preset.direction;
  }
  if (preset.spacing === undefined) {
    delete next.spacing;
  } else {
    next.spacing = preset.spacing;
  }
  return next;
}
