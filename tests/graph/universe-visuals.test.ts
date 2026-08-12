import { describe, expect, it } from 'vitest';
import {
  deterministicUniversePosition,
  universeCollisionRadius,
  universeNodeIcon,
  universePillScreenSize,
  universeTaskRadius,
} from '@/lib/graph/universe-visuals';
import type { UniverseNode } from '@/lib/graph/universe-types';

const task: UniverseNode = {
  id: 'task:1',
  entityId: '1',
  kind: 'task',
  label: 'Refactor auth middleware',
  color: '#e2e8f0',
  status: 'in_progress',
};

const tag: UniverseNode = {
  id: 'tag:backend',
  entityId: 'backend',
  kind: 'tag',
  dimension: 'tags',
  value: 'backend',
  label: 'Backend',
  color: '#22c55e',
  taskCount: 12,
};

describe('Universe graph visuals', () => {
  it('keeps tasks as compact dots at every detail level', () => {
    expect(universeTaskRadius('far')).toBe(2.5);
    expect(universeTaskRadius('medium')).toBe(4);
    expect(universeTaskRadius('close')).toBe(5.5);
    expect(universeCollisionRadius(task)).toBe(8);
  });

  it('sizes attribute pills for their label and exposes a type icon', () => {
    expect(universeNodeIcon(tag)).toBe('#');
    expect(universePillScreenSize(tag)).toEqual({ width: 110, height: 28 });
    expect(universeCollisionRadius(tag)).toBeGreaterThan(50);
  });

  it('assigns stable initial positions by node identity', () => {
    expect(deterministicUniversePosition('task:1')).toEqual(
      deterministicUniversePosition('task:1'),
    );
    expect(deterministicUniversePosition('task:1')).not.toEqual(
      deterministicUniversePosition('task:2'),
    );
  });
});
