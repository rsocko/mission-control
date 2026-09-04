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

export interface ConnectorListSnapshot {
  connector: Pick<ManagedConnectorRecord, 'id' | 'type' | 'settings' | 'syncedLists'> | null;
  sourceLists: SourceListRecord[];
  openTaskCounts: Array<{
    sourceListId: string | null;
    count: number;
  }>;
  groups: Array<{
    id: string;
    name: string;
    sortOrder: number;
  }>;
}

export interface GitHubRepositorySnapshot {
  connectors: Array<Pick<ManagedConnectorRecord, 'id' | 'name' | 'settings'>>;
  sourceLists: Array<Pick<
    SourceListRecord,
    'connectorInstanceId' | 'sourceId' | 'name'
  >>;
}

export interface MicrosoftTodoHealthSnapshot {
  connectors: ManagedConnectorRecord[];
  sourceLists: SourceListRecord[];
  taskCounts: Array<{
    connectorInstanceId: string;
    sourceListId: string | null;
    count: number;
  }>;
}

export type SourceListRepairStrategy = 'strip-emoji' | 'migrate';
export type SourceListRepairStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed';

export interface SourceListRepairTask {
  id: string;
  title: string;
  status: string;
}

export interface SourceListRepairMoveResult {
  taskId: string;
  title: string;
  status: string;
  newTaskId?: string;
  success: boolean;
  error?: string;
}

export interface SourceListRepairRecord {
  id: string;
  createdAt: string;
  strategy: SourceListRepairStrategy;
  status: SourceListRepairStatus;
  originalListId: string;
  originalSourceId: string;
  originalName: string;
  originalGroupId: string | null;
  connectorInstanceId: string;
  newListId: string | null;
  newName: string;
  taskSnapshot: SourceListRepairTask[];
  moveResults: SourceListRepairMoveResult[];
  tasksTotal: number;
  tasksMoved: number;
  tasksFailed: number;
  oldListDeleted: boolean;
}

export interface BeginSourceListRepair {
  id: string;
  createdAt: string;
  strategy: SourceListRepairStrategy;
  sourceList: Pick<
    SourceListRecord,
    'id' | 'sourceId' | 'name' | 'groupId' | 'connectorInstanceId'
  >;
  newName: string;
}

export interface SourceListRepairCheckpoint {
  id: string;
  status: Exclude<SourceListRepairStatus, 'completed'>;
  newListId?: string | null;
  taskSnapshot?: readonly SourceListRepairTask[];
  moveResults?: readonly SourceListRepairMoveResult[];
  oldListDeleted?: boolean;
}

export type SourceListRepairFinalizationOutcome =
  | 'completed'
  | 'replayed'
  | 'conflict';

export type FinalizeSourceListRepair =
  | {
    strategy: 'strip-emoji';
    id: string;
    sourceListId: string;
    expectedOriginalName: string;
    newName: string;
    userDisplayName?: string;
  }
  | {
    strategy: 'migrate';
    id: string;
    sourceListId: string;
    expectedOriginalName: string;
    status: 'completed' | 'partial' | 'failed';
    newListId: string;
    taskSnapshot: readonly SourceListRepairTask[];
    moveResults: readonly SourceListRepairMoveResult[];
    oldListDeleted: boolean;
  };

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
  getConnectorListSnapshot(connectorId: string): Promise<ConnectorListSnapshot>;
  getGitHubRepositorySnapshot(): Promise<GitHubRepositorySnapshot>;
  listActiveConnectorsByType(type: string): Promise<ManagedConnectorRecord[]>;
  getMicrosoftTodoHealthSnapshot(): Promise<MicrosoftTodoHealthSnapshot>;
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
  beginSourceListRepair(input: BeginSourceListRepair): Promise<{
    repair: SourceListRepairRecord;
    replayed: boolean;
  }>;
  getSourceListRepair(id: string): Promise<SourceListRepairRecord | null>;
  checkpointSourceListRepair(input: SourceListRepairCheckpoint): Promise<boolean>;
  finalizeSourceListRepair(
    input: FinalizeSourceListRepair,
  ): Promise<SourceListRepairFinalizationOutcome>;
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
