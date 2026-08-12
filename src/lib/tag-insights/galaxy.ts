import type {
  TagInsightPair,
  TagInsights,
  TagInsightTag,
} from './types';

export const TAG_GALAXY_EDGE_LIMIT = 435;
export const TAG_GALAXY_LINK_DISTANCE = 112;

export type TagGalaxyLod = 'overview' | 'labels' | 'detail';

export interface TagGalaxyNode extends TagInsightTag {
  x?: number;
  y?: number;
}

export interface TagGalaxyLink extends TagInsightPair {
  source: string;
  target: string;
}

export interface TagGalaxyData {
  nodes: TagGalaxyNode[];
  links: TagGalaxyLink[];
}

const TAG_COLORS = [
  '#60a5fa',
  '#c084fc',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#22d3ee',
  '#a3e635',
  '#f472b6',
] as const;

function compareText(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

export function getTagGalaxyLod(zoom: number): TagGalaxyLod {
  if (zoom < 0.45) return 'overview';
  if (zoom < 1.2) return 'labels';
  return 'detail';
}

export function getTagGalaxyColor(tag: Pick<TagInsightTag, 'id' | 'color'>): string {
  if (tag.color?.trim()) return tag.color;
  let hash = 0;
  for (const character of tag.id) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length];
}

export function getTagGalaxyNodeRadius(taskCount: number): number {
  return Math.min(10 + Math.sqrt(taskCount) * 3, 34);
}

export function getTagGalaxyCollisionRadius(node: Pick<TagInsightTag, 'taskCount'>): number {
  return getTagGalaxyNodeRadius(node.taskCount) + 12;
}

export function getTagGalaxyDisplayName(name: string, maxLength = 16): string {
  const prefixed = name.startsWith('#') ? name : `#${name}`;
  if (prefixed.length <= maxLength) return prefixed;
  return `${prefixed.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}

export function fitTagGalaxyDisplayName(
  name: string,
  maxWidth: number,
  measureText: (text: string) => number,
): string {
  const fullName = getTagGalaxyDisplayName(name, Number.MAX_SAFE_INTEGER);
  if (measureText(fullName) <= maxWidth) return fullName;

  let lower = 0;
  let upper = fullName.length;
  let fitted = '…';
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2);
    const candidate = `${fullName.slice(0, length).trimEnd()}…`;
    if (measureText(candidate) <= maxWidth) {
      fitted = candidate;
      lower = length + 1;
    } else {
      upper = length - 1;
    }
  }
  return fitted;
}

export function filterTagInsights(data: TagInsights, search: string): TagInsights {
  const query = search.trim().toLowerCase();
  if (!query) return data;
  const tags = data.tags.filter((tag) => tag.name.toLowerCase().includes(query));
  const tagIds = new Set(tags.map((tag) => tag.id));
  return {
    ...data,
    tags,
    pairs: data.pairs.filter((pair) => (
      tagIds.has(pair.sourceTagId) && tagIds.has(pair.targetTagId)
    )),
  };
}

export function buildTagGalaxyData(data: TagInsights): TagGalaxyData {
  const nodes = [...data.tags]
    .sort((first, second) => (
      second.taskCount - first.taskCount
      || compareText(first.name, second.name)
      || compareText(first.id, second.id)
    ))
    .map((tag, index, tags) => {
      const angle = tags.length > 0 ? (index / tags.length) * Math.PI * 2 : 0;
      const radius = 70 + Math.floor(index / 8) * 55;
      return {
        ...tag,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = data.pairs
    .filter((pair) => nodeIds.has(pair.sourceTagId) && nodeIds.has(pair.targetTagId))
    .slice(0, TAG_GALAXY_EDGE_LIMIT)
    .map((pair) => ({
      ...pair,
      source: pair.sourceTagId,
      target: pair.targetTagId,
    }));
  return { nodes, links };
}
