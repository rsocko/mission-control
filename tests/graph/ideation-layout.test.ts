import { describe, expect, it } from 'vitest';
import { layoutIdeationMindMap } from '@/lib/graph/ideation-layout';

describe('layoutIdeationMindMap', () => {
  it('places descendants in columns and parents between their children', () => {
    const layout = layoutIdeationMindMap([
      { id: 'root', parentId: null, sortOrder: 0, kind: 'idea' },
      { id: 'left', parentId: 'root', sortOrder: 0, kind: 'phase' },
      { id: 'right', parentId: 'root', sortOrder: 1, kind: 'phase' },
      { id: 'leaf', parentId: 'left', sortOrder: 0, kind: 'task' },
    ]);

    expect(layout.positions.get('root')?.x).toBeLessThan(layout.positions.get('left')!.x);
    expect(layout.positions.get('left')?.x).toBeLessThan(layout.positions.get('leaf')!.x);
    expect(layout.positions.get('root')?.y).toBe(
      (layout.positions.get('left')!.y + layout.positions.get('right')!.y) / 2,
    );
  });

  it('is deterministic and describes proposal edges without React or DOM values', () => {
    const nodes = [
      { id: 'root', parentId: null, sortOrder: 0, kind: 'idea' as const },
      { id: 'proposal', parentId: 'root', sortOrder: 1, kind: 'idea' as const, proposal: true },
    ];

    expect(layoutIdeationMindMap(nodes)).toEqual(layoutIdeationMindMap(nodes));
    expect(layoutIdeationMindMap(nodes).edges).toEqual([{
      id: 'hierarchy:root:proposal',
      source: 'root',
      target: 'proposal',
      kind: 'idea',
      proposal: true,
    }]);
  });

  it('lays out disconnected or cyclic data without recursing forever', () => {
    const layout = layoutIdeationMindMap([
      { id: 'orphan', parentId: 'missing', sortOrder: 0, kind: 'task' },
      { id: 'a', parentId: 'b', sortOrder: 1, kind: 'idea' },
      { id: 'b', parentId: 'a', sortOrder: 2, kind: 'idea' },
    ]);

    expect(layout.positions.size).toBe(3);
    for (const position of layout.positions.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });
});
