import type {
  ConnectionSide,
  NodeAppearanceShape,
  Placement,
} from "../core/index.js";

export interface NodeConnectionAnchor {
  side: ConnectionSide;
  x: number;
  y: number;
}

interface NodeShapeGeometry {
  anchors: readonly NodeConnectionAnchor[];
}

const CARDINAL_ANCHORS: readonly NodeConnectionAnchor[] = [
  { side: "top", x: 0.5, y: 0 },
  { side: "right", x: 1, y: 0.5 },
  { side: "bottom", x: 0.5, y: 1 },
  { side: "left", x: 0, y: 0.5 },
];

const PARALLELOGRAM_ANCHORS: readonly NodeConnectionAnchor[] = [
  { side: "top", x: 0.56, y: 0 },
  { side: "right", x: 0.94, y: 0.5 },
  { side: "bottom", x: 0.44, y: 1 },
  { side: "left", x: 0.06, y: 0.5 },
];

export const NODE_SHAPE_GEOMETRIES: Readonly<
  Record<NodeAppearanceShape, NodeShapeGeometry>
> = {
  rectangle: { anchors: CARDINAL_ANCHORS },
  rounded: { anchors: CARDINAL_ANCHORS },
  capsule: { anchors: CARDINAL_ANCHORS },
  oval: { anchors: CARDINAL_ANCHORS },
  circle: { anchors: CARDINAL_ANCHORS },
  "cut-corner": { anchors: CARDINAL_ANCHORS },
  diamond: { anchors: CARDINAL_ANCHORS },
  parallelogram: { anchors: PARALLELOGRAM_ANCHORS },
  cylinder: { anchors: CARDINAL_ANCHORS },
  document: { anchors: CARDINAL_ANCHORS },
  fallback: { anchors: CARDINAL_ANCHORS },
};

export function nodeConnectionAnchors(
  shape: NodeAppearanceShape,
): readonly NodeConnectionAnchor[] {
  return NODE_SHAPE_GEOMETRIES[shape].anchors;
}

export function nodeConnectionPoint(
  placement: Placement,
  shape: NodeAppearanceShape,
  side: ConnectionSide,
  outwardOffset = 0,
): { x: number; y: number } {
  const anchor =
    nodeConnectionAnchors(shape).find((candidate) => candidate.side === side) ??
    CARDINAL_ANCHORS.find((candidate) => candidate.side === side)!;
  const offset =
    side === "top"
      ? { x: 0, y: -outwardOffset }
      : side === "right"
        ? { x: outwardOffset, y: 0 }
        : side === "bottom"
          ? { x: 0, y: outwardOffset }
          : { x: -outwardOffset, y: 0 };
  return {
    x: placement.x + placement.width * anchor.x + offset.x,
    y: placement.y + placement.height * anchor.y + offset.y,
  };
}

export function nearestNodeConnectionSide(
  bounds: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  shape: NodeAppearanceShape,
  clientX: number,
  clientY: number,
): ConnectionSide {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return nodeConnectionAnchors(shape).reduce((nearest, anchor) => {
    const distance =
      anchor.side === "top" || anchor.side === "bottom"
        ? Math.abs(clientY - (bounds.top + height * anchor.y))
        : Math.abs(clientX - (bounds.left + width * anchor.x));
    const nearestDistance =
      nearest.side === "top" || nearest.side === "bottom"
        ? Math.abs(clientY - (bounds.top + height * nearest.y))
        : Math.abs(clientX - (bounds.left + width * nearest.x));
    return distance < nearestDistance ? anchor : nearest;
  }).side;
}

export function nodeConnectorEndpoints(
  source: Placement,
  target: Placement,
  sourceShape: NodeAppearanceShape,
  targetShape: NodeAppearanceShape,
  outwardOffset = 0,
): {
  start: { x: number; y: number };
  end: { x: number; y: number };
  horizontal: boolean;
} {
  const sourceCenterX = source.x + source.width / 2;
  const targetCenterX = target.x + target.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const targetCenterY = target.y + target.height / 2;
  const horizontal =
    Math.abs(targetCenterX - sourceCenterX) >=
    Math.abs(targetCenterY - sourceCenterY);
  if (!horizontal) {
    const travelsDown = targetCenterY >= sourceCenterY;
    return {
      start: nodeConnectionPoint(
        source,
        sourceShape,
        travelsDown ? "bottom" : "top",
        outwardOffset,
      ),
      end: nodeConnectionPoint(
        target,
        targetShape,
        travelsDown ? "top" : "bottom",
        outwardOffset,
      ),
      horizontal,
    };
  }
  const travelsRight = targetCenterX >= sourceCenterX;
  return {
    start: nodeConnectionPoint(
      source,
      sourceShape,
      travelsRight ? "right" : "left",
      outwardOffset,
    ),
    end: nodeConnectionPoint(
      target,
      targetShape,
      travelsRight ? "left" : "right",
      outwardOffset,
    ),
    horizontal,
  };
}
