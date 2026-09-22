export type GraphNodeKind = 'project' | 'phase' | 'task';
export type SharedGraphNodeKind = GraphNodeKind | 'tag' | 'property' | 'word';
export type GraphNodeStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type GraphEdgeType =
  | 'contains'
  | 'blocks'
  | 'related'
  | 'has-tag'
  | 'has-property'
  | 'word-task-provenance'
  | 'tag-co-occurrence'
  | 'semantic-similarity';
export type GraphEdgeProvenance = 'explicit' | 'derived' | 'embedding';
export type GraphEdgeSyncStatus = 'local' | 'pending' | 'synced' | 'failed';
export type GraphEdgeSyncAction = 'create' | 'delete';
export type GraphPropertyDimension =
  | 'priority'
  | 'source'
  | 'status'
  | 'list'
  | 'effort';

interface BaseGraphNode {
  id: string;
  entityId: string;
  kind: SharedGraphNodeKind;
  label: string;
  description?: string | null;
  color?: string | null;
  taskCount?: number;
}

export interface ProjectGraphNode extends BaseGraphNode {
  kind: 'project';
  status: GraphNodeStatus;
}

export interface PhaseGraphNode extends BaseGraphNode {
  kind: 'phase';
  status: GraphNodeStatus;
}

export interface TaskGraphNode extends BaseGraphNode {
  kind: 'task';
  status: GraphNodeStatus;
}

export interface TagGraphNode extends BaseGraphNode {
  kind: 'tag';
}

export interface PropertyGraphNode extends BaseGraphNode {
  kind: 'property';
  dimension: GraphPropertyDimension;
  value: string;
}

export interface WordGraphNode extends BaseGraphNode {
  kind: 'word';
  count: number;
}

export type SharedGraphNode =
  | ProjectGraphNode
  | PhaseGraphNode
  | TaskGraphNode
  | TagGraphNode
  | PropertyGraphNode
  | WordGraphNode;

interface BaseGraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  provenance: GraphEdgeProvenance;
}

interface GraphEdgeSyncMetadata {
  syncStatus?: GraphEdgeSyncStatus;
  syncAction?: GraphEdgeSyncAction | null;
  syncError?: string | null;
  lastSyncedAt?: string | null;
}

export interface ContainsGraphEdge extends BaseGraphEdge {
  type: 'contains';
  provenance: 'derived';
}

export interface BlocksGraphEdge extends BaseGraphEdge, GraphEdgeSyncMetadata {
  type: 'blocks';
  provenance: 'explicit';
  syncStatus?: GraphEdgeSyncStatus;
  syncAction?: GraphEdgeSyncAction | null;
  syncError?: string | null;
  lastSyncedAt?: string | null;
}

export interface RelatedGraphEdge extends BaseGraphEdge, GraphEdgeSyncMetadata {
  type: 'related';
  provenance: 'explicit';
  syncStatus?: GraphEdgeSyncStatus;
  syncAction?: GraphEdgeSyncAction | null;
  syncError?: string | null;
  lastSyncedAt?: string | null;
}

export interface HasTagGraphEdge extends BaseGraphEdge {
  type: 'has-tag';
  provenance: 'derived';
}

export interface HasPropertyGraphEdge extends BaseGraphEdge {
  type: 'has-property';
  provenance: 'derived';
  dimension: GraphPropertyDimension;
}

export interface WordTaskProvenanceGraphEdge extends BaseGraphEdge {
  type: 'word-task-provenance';
  provenance: 'derived';
  sources: Array<{
    source: 'title' | 'notes' | 'tag' | 'list' | 'project' | 'phase';
    count: number;
    labels: string[];
  }>;
}

export interface TagCoOccurrenceGraphEdge extends BaseGraphEdge {
  type: 'tag-co-occurrence';
  provenance: 'derived';
  count: number;
  taskIds: string[];
}

export interface SemanticSimilarityGraphEdge extends BaseGraphEdge {
  type: 'semantic-similarity';
  provenance: 'embedding';
  score: number;
  explanation: string;
  embedding: {
    provider?: string;
    model?: string;
    version?: string;
    indexId?: string;
    projectionVersion?: number;
    sourceUpdatedAt?: string;
    targetUpdatedAt?: string;
    sourceEmbeddedAt?: string;
    targetEmbeddedAt?: string;
  };
}

export type SharedGraphEdge =
  | ContainsGraphEdge
  | BlocksGraphEdge
  | RelatedGraphEdge
  | HasTagGraphEdge
  | HasPropertyGraphEdge
  | WordTaskProvenanceGraphEdge
  | TagCoOccurrenceGraphEdge
  | SemanticSimilarityGraphEdge;

export interface GraphPageInfo {
  nodeLimit: number;
  edgeLimit: number;
  returnedNodes: number;
  returnedEdges: number;
  truncated: boolean;
  truncationReasons: Array<'node-limit' | 'edge-limit' | 'source-limit'>;
  nextCursor?: string;
}

export interface GraphSubgraph<
  TNode extends SharedGraphNode = SharedGraphNode,
  TEdge extends SharedGraphEdge = SharedGraphEdge,
> {
  nodes: TNode[];
  edges: TEdge[];
  pageInfo: GraphPageInfo;
  /** Compatibility field for existing consumers. */
  truncated: boolean;
}

export type GraphNode = ProjectGraphNode | PhaseGraphNode | TaskGraphNode;
type ProjectContainsGraphEdge = ContainsGraphEdge & GraphEdgeSyncMetadata;
export type GraphEdge = ProjectContainsGraphEdge | BlocksGraphEdge | RelatedGraphEdge;
export type ProjectSubgraph = Omit<GraphSubgraph<GraphNode, GraphEdge>, 'pageInfo'> & {
  pageInfo?: GraphPageInfo;
};

export interface ProjectGraphRecords {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    color: string;
  };
  phases: Array<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    color: string | null;
    startAfterPhaseId: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    microStatus: string | null;
  }>;
  phaseItems: Array<{ phaseId: string; taskId: string }>;
  taskDependencies: Array<{
    id: string;
    taskId: string;
    dependsOnTaskId: string;
    type: 'blocks' | 'related';
    syncStatus: GraphEdgeSyncStatus;
    syncAction: GraphEdgeSyncAction | null;
    syncError: string | null;
    lastSyncedAt: string | null;
  }>;
}
