import {
  UNIVERSE_DIMENSION_ICONS,
  type UniverseDimension,
  type UniverseLod,
  type UniverseNode,
} from './universe-types';

const TASK_RADII: Record<UniverseLod, number> = {
  far: 2.5,
  medium: 4,
  close: 5.5,
};

export function universeNodeDimension(node: UniverseNode): UniverseDimension | null {
  if (node.kind === 'task') return null;
  if (node.kind === 'project') return 'project';
  return node.dimension;
}

export function universeNodeIcon(node: UniverseNode): string {
  const dimension = universeNodeDimension(node);
  return dimension ? UNIVERSE_DIMENSION_ICONS[dimension] : '';
}

export function universeTaskRadius(lod: UniverseLod): number {
  return TASK_RADII[lod];
}

export function universePillScreenSize(node: UniverseNode): {
  width: number;
  height: number;
} {
  const countLength = String(node.taskCount ?? 0).length;
  return {
    width: Math.min(Math.max(58 + node.label.length * 6 + countLength * 5, 82), 190),
    height: 28,
  };
}

export function universeCollisionRadius(node: UniverseNode): number {
  if (node.kind === 'task') return 8;
  const { width, height } = universePillScreenSize(node);
  return Math.sqrt((width / 2) ** 2 + (height / 2) ** 2) + 8;
}

export function deterministicUniversePosition(id: string): { x: number; y: number } {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  const angle = (unsigned / 0xffffffff) * Math.PI * 2;
  const radius = 60 + ((unsigned >>> 8) % 180);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}
