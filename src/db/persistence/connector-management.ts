import type { SourceListRecord } from './connector-execution';

export interface ManagedConnectorRecord {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  syncMode: string;
  pollIntervalMinutes: number | null;
  capabilities: Record<string, unknown>;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  syncedLists: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lastTestStatus: 'success' | 'failed' | null;
  lastTestError: string | null;
  lastTestAt: string | null;
}

export interface ConnectorOverview {
  connectors: ManagedConnectorRecord[];
  sourceLists: SourceListRecord[];
  openTaskCounts: Array<{
    connectorInstanceId: string;
    sourceListId: string | null;
    count: number;
  }>;
  syncOutcomes: Array<{
    connectorId: string;
    lastSyncedAt: string | null;
    success: boolean | null;
    error: string | null;
  }>;
}

export interface CreateManagedConnector {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  syncMode: string;
  pollIntervalMinutes: number;
  capabilities: Record<string, unknown>;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  syncedLists: string[];
  now: string;
}

export interface ManagedSourceListInsert {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  taskCount: number;
  lastSyncedAt: string | null;
  sortOrder: number;
  hidden: boolean;
  icon: string | null;
  iconColor: string | null;
}

export interface WorkTodoBridgeBootstrap {
  connectorId: string;
  transport: 'power-automate-standard' | 'power-automate-graph';
  capabilityProfile: 'standard-v1' | 'extended-v1';
  now: string;
}

export type ManagedConnectorUpdate = Partial<Pick<
  ManagedConnectorRecord,
  | 'name'
  | 'enabled'
  | 'syncMode'
  | 'pollIntervalMinutes'
  | 'capabilities'
  | 'credentials'
  | 'settings'
  | 'syncedLists'
>>;

export interface SourceRankingRecord {
  id: string;
  connectorType: string;
  name: string;
  rank: number;
  updatedAt: string;
}

export interface SourceRankingWrite {
  id: string;
  connectorType?: string;
  name?: string;
  rank: number;
}

export interface SyncHistoryRecord {
  id: string;
  connectorId: string;
  success: boolean;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  tasksPushed: number;
  localOnlyProtected: number;
  notificationsAdded: number;
  errors: unknown[];
  details: unknown[];
  syncedAt: string;
  durationMs: number | null;
  jobId: string | null;
  trigger: string | null;
  scheduledFor: string | null;
  startedAt: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  identityMode: string | null;
  identityModeRevision: number | null;
}

export interface ConnectorManagementPersistence {
  getOverview(includeDeleted: boolean): Promise<ConnectorOverview>;
  projectExists(projectId: string): Promise<boolean>;
  createConnector(input: CreateManagedConnector): Promise<boolean>;
  ensureSourceLists(lists: readonly ManagedSourceListInsert[]): Promise<void>;
  ensureWorkTodoBridge(input: WorkTodoBridgeBootstrap): Promise<void>;
  getConnector(connectorId: string): Promise<ManagedConnectorRecord | null>;
  updateConnector(input: {
    connectorId: string;
    updates: ManagedConnectorUpdate;
    now: string;
    expected?: Pick<ManagedConnectorRecord, 'updatedAt' | 'settings'>;
  }): Promise<boolean>;
  updateWorkTodoConnector(input: {
    connectorId: string;
    updates: ManagedConnectorUpdate;
    transport: WorkTodoBridgeBootstrap['transport'];
    capabilityProfile: WorkTodoBridgeBootstrap['capabilityProfile'];
    now: string;
  }): Promise<'updated' | 'tier-conflict'>;
  softDeleteConnector(connectorId: string, now: string): Promise<{
    affectedTasks: number;
    affectedLists: number;
  }>;
  hardDeleteConnector(connectorId: string): Promise<void>;
  getSourceList(sourceListId: string): Promise<SourceListRecord | null>;
  listGroupExists(groupId: string): Promise<boolean>;
  patchSourceList(input: {
    sourceListId: string;
    groupId?: string | null;
    hidden?: boolean;
  }): Promise<void>;
  applyLocalSourceListRename(input: {
    sourceListId: string;
    name: string;
    icon?: string | null;
    iconColor?: string | null;
  }): Promise<void>;
  confirmRemoteSourceListRename(sourceListId: string, name: string): Promise<void>;
  reorderSourceLists(orderedIds: readonly string[]): Promise<void>;
  listSourceRankings(): Promise<SourceRankingRecord[]>;
  putSourceRankings(rankings: readonly SourceRankingWrite[], now: string): Promise<SourceRankingRecord[]>;
  listSyncHistory(input: {
    limit: number;
    before: string | null;
  }): Promise<{ history: SyncHistoryRecord[]; hasMore: boolean }>;
  getSyncWorkerHeartbeat(): Promise<{
    startedAt: string;
    heartbeatAt: string;
  } | null>;
}
