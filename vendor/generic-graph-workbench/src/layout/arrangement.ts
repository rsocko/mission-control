import type { Placement } from "../core/index.js";

export type Alignment =
  | "left"
  | "horizontal-center"
  | "right"
  | "top"
  | "vertical-center"
  | "bottom";

export type Distribution = "horizontal" | "vertical";

export interface PlacementSnapOptions {
  gridSize?: number;
  alignmentThreshold?: number;
  alignmentCandidates?: ReadonlyMap<string, Placement>;
}

export interface AlignmentGuide {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
  candidateId: string;
  candidateAnchor: AlignmentAnchor;
  selectedAnchor: AlignmentAnchor;
}

export interface PlacementTranslation {
  placements: Map<string, Placement>;
  guides: readonly AlignmentGuide[];
}

type AlignmentAnchor = "start" | "center" | "end";

export const DEFAULT_GRID_SIZE = 20;
export const DEFAULT_ALIGNMENT_THRESHOLD = 8;

export function fallbackPlacement(index: number): Placement {
  return {
    x: 70 + (index % 3) * 270,
    y: 90 + Math.floor(index / 3) * 160,
    width: 220,
    height: 104
  };
}

export function translatePlacements(
  placements: ReadonlyMap<string, Placement>,
  nodeIds: readonly string[],
  primaryId: string,
  delta: { x: number; y: number },
  snap: PlacementSnapOptions = {}
): Map<string, Placement> {
  return resolvePlacementTranslation(
    placements,
    nodeIds,
    primaryId,
    delta,
    snap
  ).placements;
}

export function resolvePlacementTranslation(
  placements: ReadonlyMap<string, Placement>,
  nodeIds: readonly string[],
  primaryId: string,
  delta: { x: number; y: number },
  snap: PlacementSnapOptions = {}
): PlacementTranslation {
  const selected = selectedPlacements(placements, nodeIds);
  if (selected.size === 0) return { placements: new Map(), guides: [] };
  const primary = selected.get(primaryId) ?? selected.values().next().value;
  if (!primary) return { placements: new Map(), guides: [] };

  const rawBounds = placementBounds(selected.values());
  const translatedBounds = offsetBounds(rawBounds, delta.x, delta.y);
  const gridCorrection = snap.gridSize
    ? {
        x: snapCoordinate(primary.x + delta.x, snap.gridSize) -
          (primary.x + delta.x),
        y: snapCoordinate(primary.y + delta.y, snap.gridSize) -
          (primary.y + delta.y)
      }
    : { x: 0, y: 0 };
  const alignmentMatches = snap.alignmentCandidates
    ? nearestAlignmentMatches(
        translatedBounds,
        snap.alignmentCandidates,
        snap.alignmentThreshold ?? DEFAULT_ALIGNMENT_THRESHOLD
      )
    : {};
  const x =
    delta.x + (alignmentMatches.x === undefined
      ? gridCorrection.x
      : alignmentMatches.x.offset);
  const y =
    delta.y + (alignmentMatches.y === undefined
      ? gridCorrection.y
      : alignmentMatches.y.offset);
  const finalBounds = offsetBounds(rawBounds, x, y);
  const guides = alignmentGuides(finalBounds, alignmentMatches);

  return {
    placements: new Map(
      [...selected].map(([nodeId, placement]) => [
        nodeId,
        { ...placement, x: placement.x + x, y: placement.y + y }
      ])
    ),
    guides
  };
}

export function alignPlacements(
  placements: ReadonlyMap<string, Placement>,
  nodeIds: readonly string[],
  primaryId: string,
  alignment: Alignment
): Map<string, Placement> {
  const selected = selectedPlacements(placements, nodeIds);
  const anchor = selected.get(primaryId) ?? selected.values().next().value;
  if (!anchor || selected.size < 2) return new Map();
  return new Map(
    [...selected].map(([nodeId, placement]) => [
      nodeId,
      alignPlacement(placement, anchor, alignment)
    ])
  );
}

export function distributePlacements(
  placements: ReadonlyMap<string, Placement>,
  nodeIds: readonly string[],
  distribution: Distribution
): Map<string, Placement> {
  const entries = [...selectedPlacements(placements, nodeIds)];
  if (entries.length < 3) return new Map();
  const horizontal = distribution === "horizontal";
  const leadingEdge = ([, placement]: [string, Placement]) =>
    horizontal ? placement.x : placement.y;
  const trailingEdge = ([, placement]: [string, Placement]) =>
    horizontal
      ? placement.x + placement.width
      : placement.y + placement.height;
  const byLeadingEdge = (
    left: [string, Placement],
    right: [string, Placement]
  ) =>
    leadingEdge(left) - leadingEdge(right) ||
    compareStableIds(left[0], right[0]);
  const firstEntry = [...entries].sort(byLeadingEdge)[0]!;
  const lastEntry = [...entries]
    .filter(([nodeId]) => nodeId !== firstEntry[0])
    .sort(
      (left, right) =>
        trailingEdge(right) - trailingEdge(left) ||
        compareStableIds(left[0], right[0])
    )[0]!;
  const selected = [
    firstEntry,
    ...entries
      .filter(
        ([nodeId]) =>
          nodeId !== firstEntry[0] && nodeId !== lastEntry[0]
      )
      .sort(byLeadingEdge),
    lastEntry
  ];
  const first = selected[0]![1];
  const last = selected.at(-1)![1];
  const start = horizontal ? first.x : first.y;
  const end = horizontal ? last.x + last.width : last.y + last.height;
  const totalSize = selected.reduce(
    (total, [, placement]) =>
      total + (horizontal ? placement.width : placement.height),
    0
  );
  const gap = (end - start - totalSize) / (selected.length - 1);
  let cursor = start;
  const result = new Map<string, Placement>();
  selected.forEach(([nodeId, placement]) => {
    result.set(nodeId, {
      ...placement,
      ...(horizontal ? { x: cursor } : { y: cursor })
    });
    cursor += (horizontal ? placement.width : placement.height) + gap;
  });
  return result;
}

export function placementsEqual(
  left: Placement,
  right: Placement
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.collapsed === right.collapsed &&
    JSON.stringify(left.appearance) === JSON.stringify(right.appearance) &&
    JSON.stringify(left.style) === JSON.stringify(right.style)
  );
}

function selectedPlacements(
  placements: ReadonlyMap<string, Placement>,
  nodeIds: readonly string[]
): Map<string, Placement> {
  const result = new Map<string, Placement>();
  for (const nodeId of nodeIds) {
    const placement = placements.get(nodeId);
    if (placement && !result.has(nodeId)) result.set(nodeId, placement);
  }
  return result;
}

function alignPlacement(
  placement: Placement,
  anchor: Placement,
  alignment: Alignment
): Placement {
  switch (alignment) {
    case "left":
      return { ...placement, x: anchor.x };
    case "horizontal-center":
      return {
        ...placement,
        x: anchor.x + anchor.width / 2 - placement.width / 2
      };
    case "right":
      return {
        ...placement,
        x: anchor.x + anchor.width - placement.width
      };
    case "top":
      return { ...placement, y: anchor.y };
    case "vertical-center":
      return {
        ...placement,
        y: anchor.y + anchor.height / 2 - placement.height / 2
      };
    case "bottom":
      return {
        ...placement,
        y: anchor.y + anchor.height - placement.height
      };
  }
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function placementBounds(placements: Iterable<Placement>): Bounds {
  const values = [...placements];
  const left = Math.min(...values.map((placement) => placement.x));
  const right = Math.max(
    ...values.map((placement) => placement.x + placement.width)
  );
  const top = Math.min(...values.map((placement) => placement.y));
  const bottom = Math.max(
    ...values.map((placement) => placement.y + placement.height)
  );
  return {
    left,
    right,
    top,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2
  };
}

function offsetBounds(bounds: Bounds, x: number, y: number): Bounds {
  return {
    left: bounds.left + x,
    right: bounds.right + x,
    top: bounds.top + y,
    bottom: bounds.bottom + y,
    centerX: bounds.centerX + x,
    centerY: bounds.centerY + y
  };
}

interface AlignmentMatch {
  offset: number;
  key: string;
  candidateId: string;
  candidateBounds: Bounds;
  candidateAnchor: AlignmentAnchor;
  selectedAnchor: AlignmentAnchor;
  position: number;
}

function nearestAlignmentMatches(
  bounds: Bounds,
  candidates: ReadonlyMap<string, Placement>,
  threshold: number
): { x?: AlignmentMatch; y?: AlignmentMatch } {
  let x: AlignmentMatch | undefined;
  let y: AlignmentMatch | undefined;
  for (const [nodeId, placement] of candidates) {
    const candidate = placementBounds([placement]);
    for (const [candidateAnchor, position] of [
      ["start", candidate.left],
      ["center", candidate.centerX],
      ["end", candidate.right]
    ] as const) {
      for (const [selectedAnchor, selectedPosition] of [
        ["start", bounds.left],
        ["center", bounds.centerX],
        ["end", bounds.right]
      ] as const) {
        x = nearerAlignmentMatch(
          x,
          nodeId,
          candidate,
          candidateAnchor,
          selectedAnchor,
          position,
          selectedPosition,
          threshold
        );
      }
    }
    for (const [candidateAnchor, position] of [
      ["start", candidate.top],
      ["center", candidate.centerY],
      ["end", candidate.bottom]
    ] as const) {
      for (const [selectedAnchor, selectedPosition] of [
        ["start", bounds.top],
        ["center", bounds.centerY],
        ["end", bounds.bottom]
      ] as const) {
        y = nearerAlignmentMatch(
          y,
          nodeId,
          candidate,
          candidateAnchor,
          selectedAnchor,
          position,
          selectedPosition,
          threshold
        );
      }
    }
  }
  return {
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y })
  };
}

function nearerAlignmentMatch(
  current: AlignmentMatch | undefined,
  candidateId: string,
  candidateBounds: Bounds,
  candidateAnchor: AlignmentAnchor,
  selectedAnchor: AlignmentAnchor,
  position: number,
  selectedPosition: number,
  threshold: number
): AlignmentMatch | undefined {
  const offset = position - selectedPosition;
  if (Math.abs(offset) > threshold) return current;
  const key = `${candidateId}:${candidateAnchor}:${selectedAnchor}`;
  if (
    !current ||
    Math.abs(offset) < Math.abs(current.offset) ||
    (Math.abs(offset) === Math.abs(current.offset) &&
      compareStableIds(key, current.key) < 0)
  ) {
    return {
      offset,
      key,
      candidateId,
      candidateBounds,
      candidateAnchor,
      selectedAnchor,
      position
    };
  }
  return current;
}

function alignmentGuides(
  selected: Bounds,
  matches: { x?: AlignmentMatch; y?: AlignmentMatch }
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  if (matches.x) {
    guides.push({
      axis: "x",
      position: matches.x.position,
      start: Math.min(selected.top, matches.x.candidateBounds.top),
      end: Math.max(selected.bottom, matches.x.candidateBounds.bottom),
      candidateId: matches.x.candidateId,
      candidateAnchor: matches.x.candidateAnchor,
      selectedAnchor: matches.x.selectedAnchor
    });
  }
  if (matches.y) {
    guides.push({
      axis: "y",
      position: matches.y.position,
      start: Math.min(selected.left, matches.y.candidateBounds.left),
      end: Math.max(selected.right, matches.y.candidateBounds.right),
      candidateId: matches.y.candidateId,
      candidateAnchor: matches.y.candidateAnchor,
      selectedAnchor: matches.y.selectedAnchor
    });
  }
  return guides;
}

function snapCoordinate(value: number, size: number): number {
  return Math.round(value / size) * size;
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
