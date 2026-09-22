import type {
  ProjectGraphNode,
  PropertyGraphNode,
  SharedGraphEdge,
  TagGraphNode,
  TaskGraphNode,
} from './types';

export const UNIVERSE_DIMENSIONS = [
  'priority',
  'source',
  'tags',
  'status',
  'list',
  'effort',
  'project',
] as const;

export type UniverseDimension = (typeof UNIVERSE_DIMENSIONS)[number];
export type UniverseNeighborLayer = 'explicit' | 'derived' | 'semantic';
export type UniverseSemanticState =
  | 'not-requested'
  | 'available'
  | 'partial'
  | 'missing'
  | 'stale'
  | 'incompatible'
  | 'denied'
  | 'unavailable';
export type UniverseNodeKind = 'task' | 'tag' | 'property';
export type UniverseLod = 'far' | 'medium' | 'close';
export type UniverseClusterDestination = 'project' | 'tag';

export interface UniverseClusterSettings {
  algorithm: 'deterministic-threshold-components-v1';
  resolution: number;
  minimumSize: number;
  outlierThreshold: number;
  includeExplicitEdges: boolean;
  seed: number;
}

export interface UniverseCluster {
  id: string;
  label: string;
  explanation: string;
  confidence: number;
  color: string;
  memberNodeIds: string[];
  taskIds: string[];
  representativeNodeIds: string[];
  terms: string[];
}

export interface UniverseClusterProjection {
  clusters: UniverseCluster[];
  outlierNodeIds: string[];
  membershipByNodeId: Record<string, string>;
  fingerprint: string;
  settings: UniverseClusterSettings;
}

export const DEFAULT_UNIVERSE_DIMENSIONS: UniverseDimension[] = [
  'priority',
  'source',
  'tags',
];

export const UNIVERSE_DIMENSION_LABELS: Record<UniverseDimension, string> = {
  priority: 'Priority',
  source: 'Source',
  tags: 'Tags',
  status: 'Status',
  list: 'List',
  effort: 'Effort',
  project: 'Project',
};

export const UNIVERSE_DIMENSION_COLORS: Record<UniverseDimension, string> = {
  priority: '#f59e0b',
  source: '#a78bfa',
  tags: '#34d399',
  status: '#38bdf8',
  list: '#fb7185',
  effort: '#c084fc',
  project: '#60a5fa',
};

export const UNIVERSE_DIMENSION_ICONS: Record<UniverseDimension, string> = {
  priority: '!',
  source: '↗',
  tags: '#',
  status: '●',
  list: '≡',
  effort: '◷',
  project: '□',
};

const UNIVERSE_SOURCE_COLORS: Record<string, string> = {
  github: '#c084fc',
  microsoft_todo: '#60a5fa',
  microsofttodo: '#60a5fa',
  todoist: '#fb7185',
  linear: '#a78bfa',
  local: '#94a3b8',
};

export function getUniverseSourceColor(source: string): string {
  const normalized = source.toLowerCase().replaceAll(/[\s-]+/g, '_');
  return UNIVERSE_SOURCE_COLORS[normalized]
    ?? UNIVERSE_SOURCE_COLORS[normalized.replaceAll('_', '')]
    ?? Object.entries(UNIVERSE_SOURCE_COLORS)
      .find(([provider]) => normalized.startsWith(`${provider}_`))?.[1]
    ?? UNIVERSE_DIMENSION_COLORS.source;
}

type ForceCoordinates = {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

export type UniverseNode = (
  | (Omit<TaskGraphNode, 'color'> & { color: string })
  | (Omit<ProjectGraphNode, 'color'> & { color: string })
  | (Omit<TagGraphNode, 'color'> & {
      color: string;
      dimension: 'tags';
      value: string;
    })
  | (Omit<PropertyGraphNode, 'color'> & { color: string })
) & ForceCoordinates;

export type UniverseEdge = SharedGraphEdge & {
  dimension?: UniverseDimension;
};

export interface UniverseFacets {
  priorities: string[];
  statuses: string[];
  sources: string[];
  lists: Array<{ id: string; label: string }>;
}

export interface UniverseSubgraph {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  stats: {
    taskCount: number;
    filteredTaskCount: number;
    attributeCount: number;
  };
  facets: UniverseFacets;
  pageInfo: import('./types').GraphPageInfo;
  truncated: boolean;
  capabilities?: {
    semanticNeighbors: boolean;
    clusters?: boolean;
  };
}

export interface UniverseGraphFilters {
  dimensions: UniverseDimension[];
  taskQuery: URLSearchParams;
  seedTaskIds?: string[];
  maxNodes?: number;
  maxEdges?: number;
}

export interface UniverseTaskRecord {
  id: string;
  title: string;
  priority: string;
  status: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  effort: number | null;
}

export interface UniverseTagRecord {
  taskId: string;
  id: string;
  name: string;
  color: string | null;
}

export interface UniverseProjectRecord {
  taskId: string;
  id: string;
  name: string;
  color: string;
  status: string;
}
