import { describe, expect, it } from 'vitest';
import { universeClusterHull } from '@/lib/graph/universe-cluster-geometry';

describe('universeClusterHull', () => {
  it('returns no hull for an empty group and padded bounds for two members', () => {
    expect(universeClusterHull([], 10)).toEqual([]);
    expect(universeClusterHull([{ x: 0, y: 0 }, { x: 20, y: 0 }], 5)).toEqual([
      { x: -5, y: 5 },
      { x: 25, y: 5 },
      { x: 25, y: -5 },
      { x: -5, y: -5 },
    ]);
  });

  it('creates a deterministic convex outline independent of point order', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ];
    expect(universeClusterHull(points, 2))
      .toEqual(universeClusterHull(points.slice().reverse(), 2));
    expect(universeClusterHull(points, 2)).toHaveLength(4);
  });
});
