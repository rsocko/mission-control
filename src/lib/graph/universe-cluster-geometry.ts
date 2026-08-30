export type ClusterPoint = { x: number; y: number };

function cross(origin: ClusterPoint, left: ClusterPoint, right: ClusterPoint): number {
  return (left.x - origin.x) * (right.y - origin.y)
    - (left.y - origin.y) * (right.x - origin.x);
}

export function universeClusterHull(
  points: ClusterPoint[],
  padding: number,
): ClusterPoint[] {
  const unique = [...new Map(points.map((point) => [`${point.x}:${point.y}`, point])).values()]
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (!unique.length) return [];
  if (unique.length === 1) {
    const point = unique[0];
    return [
      { x: point.x - padding, y: point.y - padding },
      { x: point.x + padding, y: point.y - padding },
      { x: point.x + padding, y: point.y + padding },
      { x: point.x - padding, y: point.y + padding },
    ];
  }
  if (unique.length === 2) {
    const [start, end] = unique;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * padding;
    const ny = (dx / length) * padding;
    const ex = (dx / length) * padding;
    const ey = (dy / length) * padding;
    return [
      { x: start.x - ex + nx, y: start.y - ey + ny },
      { x: end.x + ex + nx, y: end.y + ey + ny },
      { x: end.x + ex - nx, y: end.y + ey - ny },
      { x: start.x - ex - nx, y: start.y - ey - ny },
    ];
  }

  const lower: ClusterPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: ClusterPoint[] = [];
  for (const point of unique.slice().reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const center = hull.reduce(
    (result, point) => ({ x: result.x + point.x, y: result.y + point.y }),
    { x: 0, y: 0 },
  );
  center.x /= hull.length;
  center.y /= hull.length;
  return hull.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (dx / length) * padding,
      y: point.y + (dy / length) * padding,
    };
  });
}
