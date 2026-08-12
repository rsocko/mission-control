import type {
  BlocksGraphEdge,
  GraphEdgeSyncAction,
  GraphEdgeSyncStatus,
  GraphPageInfo,
  RelatedGraphEdge,
} from '@/lib/graph/types';

export interface TaskRelationshipTask {
  id: string;
  title: string;
  status: string;
  connectorType?: string;
  sourceId?: string | null;
  metadata?: unknown;
  projectIds: string[];
  projectNames: string[];
}

export type TaskRelationshipEdge = (BlocksGraphEdge | RelatedGraphEdge) & {
  syncStatus: GraphEdgeSyncStatus;
  syncAction: GraphEdgeSyncAction | null;
  syncError: string | null;
  lastSyncedAt: string | null;
};

export interface TaskRelationship {
  edge: TaskRelationshipEdge;
  direction: 'incoming' | 'outgoing' | 'related';
  task: TaskRelationshipTask;
}

export interface TaskRelationshipsResult {
  relationships: TaskRelationship[];
  pageInfo: GraphPageInfo;
}

export interface TaskRelationshipCandidate extends TaskRelationshipTask {
  connectorType: string;
  sourceListName: string | null;
}
