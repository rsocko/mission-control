import type { Placement } from "../core/index.js";

export const MIN_CANVAS_ZOOM = 0.25;
export const MAX_CANVAS_ZOOM = 2;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverviewTransform {
  scale: number;
  x: number;
  y: number;
}

export function worldToViewport(
  point: CanvasPoint,
  viewport: CanvasViewport
): CanvasPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y
  };
}

export function viewportToWorld(
  point: CanvasPoint,
  viewport: CanvasViewport
): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom
  };
}

export function zoomViewport(
  viewport: CanvasViewport,
  requestedZoom: number,
  anchor: CanvasPoint
): CanvasViewport {
  const zoom = clampZoom(requestedZoom);
  if (zoom === viewport.zoom) return viewport;
  const worldAnchor = viewportToWorld(anchor, viewport);
  return {
    x: anchor.x - worldAnchor.x * zoom,
    y: anchor.y - worldAnchor.y * zoom,
    zoom
  };
}

export function fitViewport(
  placements: readonly Placement[],
  size: ViewportSize,
  padding = 72
): CanvasViewport {
  const width = finitePositive(size.width);
  const height = finitePositive(size.height);
  if (placements.length === 0 || width === 0 || height === 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const minX = Math.min(...placements.map((placement) => placement.x));
  const minY = Math.min(...placements.map((placement) => placement.y));
  const maxX = Math.max(
    ...placements.map((placement) => placement.x + placement.width)
  );
  const maxY = Math.max(
    ...placements.map((placement) => placement.y + placement.height)
  );
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const zoom = clampZoom(
    Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight)
  );
  return {
    x: (width - boundsWidth * zoom) / 2 - minX * zoom,
    y: (height - boundsHeight * zoom) / 2 - minY * zoom,
    zoom
  };
}

export function centerPlacement(
  viewport: CanvasViewport,
  placement: Placement,
  size: ViewportSize
): CanvasViewport {
  return {
    x:
      finitePositive(size.width) / 2 -
      (placement.x + placement.width / 2) * viewport.zoom,
    y:
      finitePositive(size.height) / 2 -
      (placement.y + placement.height / 2) * viewport.zoom,
    zoom: viewport.zoom
  };
}

export function viewportCenter(size: ViewportSize): CanvasPoint {
  return { x: size.width / 2, y: size.height / 2 };
}

export function placementBounds(
  placements: readonly Placement[]
): CanvasBounds | undefined {
  if (placements.length === 0) return undefined;
  const minX = Math.min(...placements.map((placement) => placement.x));
  const minY = Math.min(...placements.map((placement) => placement.y));
  const maxX = Math.max(
    ...placements.map((placement) => placement.x + placement.width)
  );
  const maxY = Math.max(
    ...placements.map((placement) => placement.y + placement.height)
  );
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function viewportWorldBounds(
  viewport: CanvasViewport,
  size: ViewportSize
): CanvasBounds {
  const topLeft = viewportToWorld({ x: 0, y: 0 }, viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: finitePositive(size.width) / viewport.zoom,
    height: finitePositive(size.height) / viewport.zoom
  };
}

export function unionBounds(
  bounds: readonly CanvasBounds[]
): CanvasBounds | undefined {
  if (bounds.length === 0) return undefined;
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function overviewTransform(
  bounds: CanvasBounds,
  size: ViewportSize,
  padding = 8
): OverviewTransform {
  const availableWidth = Math.max(1, finitePositive(size.width) - padding * 2);
  const availableHeight = Math.max(1, finitePositive(size.height) - padding * 2);
  const scale = Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height)
  );
  return {
    scale,
    x: (size.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (size.height - bounds.height * scale) / 2 - bounds.y * scale
  };
}

export function worldToOverview(
  point: CanvasPoint,
  transform: OverviewTransform
): CanvasPoint {
  return {
    x: point.x * transform.scale + transform.x,
    y: point.y * transform.scale + transform.y
  };
}

export function overviewToWorld(
  point: CanvasPoint,
  transform: OverviewTransform
): CanvasPoint {
  return {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale
  };
}

export function centerViewportOn(
  viewport: CanvasViewport,
  point: CanvasPoint,
  size: ViewportSize
): CanvasViewport {
  return {
    x: size.width / 2 - point.x * viewport.zoom,
    y: size.height / 2 - point.y * viewport.zoom,
    zoom: viewport.zoom
  };
}

export function wheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  const pixels =
    deltaMode === 1
      ? deltaY * 16
      : deltaMode === 2
        ? deltaY * finitePositive(viewportHeight)
        : deltaY;
  if (!Number.isFinite(pixels)) return 1;
  return Math.exp(Math.min(4, Math.max(-4, -pixels * 0.002)));
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, value));
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
