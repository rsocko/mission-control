import type {
  ConnectorConfig,
  NotificationDisposition,
  NotificationReadState,
  NotificationReopenPolicy,
  NotificationSourceState,
  NotificationSyncState,
  TaskItem,
} from '@/types';

export class UnsupportedConnectorExecutionError extends Error {
  readonly code = 'unsupported-connector-execution';

  constructor(readonly reason: string) {
    super(`PostgreSQL generic connector execution does not support ${reason}`);
    this.name = 'UnsupportedConnectorExecutionError';
  }
}

export interface ConnectorTaskRecord {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  description: string | null;
  status: string;
  localDisposition: string;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  pushCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recurrenceGeneratedFromTaskId: string | null;
  parentId: string | null;
  depth: number;
  isChecklistItem: boolean;
  sourceListId: string | null;
  sourceListName: string | null;
  assignee: string | null;
  microStatus: string | null;
  statusReason: string | null;
  metadata: Record<string, unknown>;
  syncStatus: string;
  lastSyncedAt: string;
  pushRetryCount: number;
  kanbanColumn: string | null;
  kanbanOrder: number | null;
  snoozedUntil: string | null;
  reminderAt: string | null;
  reminderRelative: string | null;
  reminderDueTime: string | null;
  effort: number | null;
  isBulkImport: boolean;
}

export type ConnectorTaskInsert = ConnectorTaskRecord;
export type ConnectorTaskUpdate = Partial<Omit<ConnectorTaskRecord, 'id'>>;

export interface SourceListRecord {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  taskCount: number;
  lastSyncedAt: string | null;
  wellKnownListName: string | null;
  groupId: string | null;
  sortOrder: number;
  hidden: boolean;
  lastKnownRemoteName: string | null;
  userDisplayName: string | null;
  icon: string | null;
  iconColor: string | null;
}

export interface SourceListWrite {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
  taskCount: number;
  lastSyncedAt: string | null;
  wellKnownListName: string | null;
  lastKnownRemoteName: string | null;
}

export interface SourceListDiscoveryCommand {
  connectorId: string;
  upserts: readonly SourceListWrite[];
  stale: readonly {
    id: string;
    action: 'delete' | 'mark-unobserved';
  }[];
}

export interface RemoteFolderGroup {
  sourceId: string;
  name: string;
}

export interface SourceListPersistence {
  list(connectorId: string): Promise<SourceListRecord[]>;
  applyDiscovery(command: SourceListDiscoveryCommand): Promise<void>;
  assignFolderGroups(input: {
    groups: readonly RemoteFolderGroup[];
    lists: readonly { sourceId: string; parentFolderGroupId: string }[];
    now: string;
  }): Promise<number>;
  removeLegacyProjectLists(connectorId: string): Promise<void>;
}

export interface TaskPushPersistence {
  listCandidates(input: {
    connectorId: string;
    taskIds?: readonly string[];
    includePushing: boolean;
  }): Promise<ConnectorTaskRecord[]>;
  listSourceIds(taskIds: readonly string[]): Promise<Array<{ id: string; sourceId: string }>>;
  markSynced(
    taskId: string,
    now: string,
    updates?: Pick<ConnectorTaskUpdate, 'status' | 'completedAt'>,
  ): Promise<boolean>;
  markFailure(
    taskId: string,
    status: 'push_error' | 'push_failed',
    retryCount: number,
  ): Promise<boolean>;
  claim(taskId: string, leaseToken: string, staleBefore: string): Promise<boolean>;
  loadClaimed(taskId: string, leaseToken: string): Promise<ConnectorTaskRecord | null>;
  heartbeat(taskId: string, leaseToken: string, renewedToken: string): Promise<boolean>;
  release(input: {
    taskId: string;
    leaseToken: string;
    syncStatus: string;
    now: string;
    expectedTaskVersion?: string;
  }): Promise<boolean>;
  complete(input: {
    taskId: string;
    leaseToken: string;
    sourceId: string;
    now: string;
    metadata?: Record<string, unknown>;
    localUpdates?: {
      status?: TaskItem['status'];
      completedAt?: string | null;
    };
    expectedTaskVersion?: string;
    createdFromSourceId?: string;
  }): Promise<boolean>;
  fail(input: {
    taskId: string;
    leaseToken: string;
    syncStatus: 'push_error' | 'push_failed';
    now: string;
    pushRetryCount?: number;
    expectedTaskVersion?: string;
  }): Promise<boolean>;
}

export interface PullTag {
  id?: string;
  name: string;
  slug: string;
  type: string;
  source?: string;
  confirmed?: boolean;
  color?: string | null;
}

export interface PullSnapshot {
  tasks: ConnectorTaskRecord[];
  tags: Array<{ id: string; slug: string; type: string }>;
  archivedRecurringDuplicateSourceIds: string[];
  linkedSources: Array<{
    id: string;
    taskId: string;
    sourceId: string;
    entityProvider: string | null;
    entityHostKey: string | null;
    entityType: string | null;
    entityStableId: string | null;
  }>;
}

export interface PullTaskInsert {
  task: ConnectorTaskInsert;
  tags: readonly PullTag[];
}

export interface TaskPullPersistence {
  loadSnapshot(connectorId: string, options?: {
    includeArchivedRecurringDuplicates?: boolean;
    includeLinkedSources?: boolean;
  }): Promise<PullSnapshot>;
  updateLinkedSourceLocator(id: string, sourceId: string): Promise<void>;
  updateTaskSourceId(taskId: string, sourceId: string): Promise<boolean>;
  adoptLocalTask(input: {
    taskId: string;
    connectorId: string;
    remoteSourceId: string;
    hasLocalEdits: boolean;
    now: string;
  }): Promise<ConnectorTaskRecord | null>;
  insertBatch(tasks: readonly PullTaskInsert[]): Promise<{
    insertedIds: ReadonlySet<string>;
    records: ConnectorTaskRecord[];
  }>;
  findBySourceIds(
    connectorId: string,
    sourceIds: readonly string[],
  ): Promise<ConnectorTaskRecord[]>;
  applyRemoteUpdate(input: {
    taskId: string;
    expectedSyncStatus: string;
    values: ConnectorTaskUpdate;
    sourceTags?: readonly PullTag[];
  }): Promise<boolean>;
  replaceSourceTags(taskId: string, tags: readonly PullTag[]): Promise<void>;
  listChecklistItems(connectorId: string): Promise<Array<{
    id: string;
    sourceId: string;
    parentId: string | null;
  }>>;
  correctParents(corrections: readonly { taskId: string; parentId: string }[]): Promise<void>;
  listChildren(taskId: string): Promise<string[]>;
  listTasks(connectorId: string): Promise<ConnectorTaskRecord[]>;
  listStaleInProgress(connectorId: string): Promise<Array<{
    id: string;
    sourceId: string;
    status: string;
    completedAt: string | null;
  }>>;
  applyVerifiedTerminalStatus(input: {
    taskId: string;
    expectedStatus: string;
    status: 'done' | 'cancelled';
    completedAt: string;
    now: string;
  }): Promise<boolean>;
}

export interface DeletionCandidateRecord {
  id: string;
  connectorId: string;
  taskId: string;
  sourceId: string;
  firstMissingAt: string;
  lastMissingAt: string;
  missingCount: number;
  identityMode: string | null;
  identityModeRevision: number | null;
  issueEntityId: string | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  locatorRevision: number | null;
  bindingState: string | null;
  bindingRevision: string | null;
}

export interface DeletionIdentityState {
  localId: string;
  externalEntityId: string | null;
  stableId: string | null;
  bindingState: string | null;
  backfillState: string | null;
  locatorRevision: number | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  bindingRevision: string | null;
}

export interface GitHubDeletionFenceRecord {
  identityMode: 'legacy' | 'comparison' | 'stable';
  identityModeRevision: number;
  issueEntityId: string | null;
  repositoryEntityId: string | null;
  hostKey: string | null;
  locatorRevision: number | null;
  bindingState: string | null;
  bindingRevision: string | null;
  sourceId: string;
}

export interface ArchiveTaskResult {
  snapshotId: string;
  taskTitle: string;
  sourceId: string;
}

export interface DeletionSnapshotRecord {
  id: string;
  originalTaskId: string;
  connectorId: string;
  sourceId: string;
  taskTitle: string;
  taskData: Pick<
    ConnectorTaskRecord,
    | 'description'
    | 'status'
    | 'priority'
    | 'dueDate'
    | 'connectorType'
    | 'sourceListName'
    | 'isChecklistItem'
    | 'parentId'
  >;
  reason: string;
  deletedAt: string;
  restoredAt: string | null;
  restoredTaskId: string | null;
  restoreMode: string | null;
}

export interface DeletionPersistence {
  getSnapshot(snapshotId: string): Promise<DeletionSnapshotRecord | null>;
  getRestoreParent(taskId: string): Promise<{
    connectorInstanceId: string;
    sourceId: string;
  } | null>;
  listCandidates(connectorId: string): Promise<DeletionCandidateRecord[]>;
  listIdentityStates(connectorId: string): Promise<DeletionIdentityState[]>;
  clearCandidate(connectorId: string, sourceId: string): Promise<void>;
  markPendingPush(taskId: string): Promise<boolean>;
  observeMissing(input: {
    connectorId: string;
    taskId: string;
    sourceId: string;
    now: string;
    expectedCandidateId?: string;
    expectedFence: Omit<DeletionCandidateRecord, 'id' | 'connectorId' | 'taskId'
      | 'sourceId' | 'firstMissingAt' | 'lastMissingAt' | 'missingCount'>;
  }): Promise<'quarantined' | 'ready' | 'fence-reset'>;
  archiveAndDeleteTask(
    taskId: string,
    reason: string,
    expectedGitHubFence?: GitHubDeletionFenceRecord,
  ): Promise<ArchiveTaskResult | null>;
  restoreDeletionSnapshot(
    snapshotId: string,
    mode: 'local' | 'source',
    githubPreflight?: (route: {
      targets: ReadonlyArray<{
        role: string;
        owner: string;
        repository: string;
        issueNumber: number | null;
      }>;
    }) => Promise<{
      targets: Record<string, { repositoryStableId: string; issueStableId?: string }>;
    }>,
  ): Promise<{ taskId: string; alreadyRestored: boolean }>;
}

export interface ConnectorNotificationInput {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  templateKey: string | null;
  readState: NotificationReadState;
  disposition?: NotificationDisposition;
  sourceState: NotificationSourceState;
  syncState?: NotificationSyncState;
  sourceActivityAt: string | null;
  sourceActivityKey: string | null;
  reopenPolicy: NotificationReopenPolicy;
  occurrenceKey: string;
  isActionable: boolean;
  primaryActionId: string | null;
  receivedAt: string;
  sortAt: string;
  groupKey?: string | null;
  dedupeKey?: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;
}

export interface ConnectorNotificationAction {
  id: string;
  notificationId: string;
  actionType: string;
  label: string;
  icon?: string | null;
  variant: string;
  isPrimary: boolean;
  sortOrder: number;
  payload: Record<string, unknown>;
  opensExternal: boolean;
  requiresConfirmation: boolean;
  createdBy: string;
}

export interface ConnectorNotificationCommand {
  input: ConnectorNotificationInput;
  actions: readonly ConnectorNotificationAction[];
  enrichment?: {
    sourceRevision: string;
    payload: {
      notificationId: string;
      title: string;
      body: string | null;
      connectorType: string;
      category: string;
      metadata: Record<string, unknown>;
      presentation: Record<string, unknown>;
    } | null;
  };
}

export interface ActiveConnectorNotification {
  id: string;
  sourceId: string;
  reconcileAttempts: number;
  staleSince: string | null;
}

export interface NotificationReconciliationOutcome {
  notificationId: string;
  resolved: boolean;
  resolvedAt?: string;
  reason?: string;
}

export interface ConnectorNotificationPersistence {
  ingest(commands: readonly ConnectorNotificationCommand[]): Promise<Array<{
    id: string;
    created: boolean;
    pendingDelivery: boolean;
  }>>;
  listActive(connectorId: string): Promise<ActiveConnectorNotification[]>;
  applyReconciliation(input: {
    outcomes: readonly NotificationReconciliationOutcome[];
    now: string;
  }): Promise<number>;
  recordReconciliationFailure(input: {
    notificationIds: readonly string[];
    now: string;
  }): Promise<void>;
  archiveStale(input: {
    connectorId: string;
    cutoff: string;
    minimumAttempts: number;
    now: string;
  }): Promise<number>;
  mergeMetadata(
    notificationId: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface ConflictResolutionWrite {
  taskId: string;
  connectorId: string;
  winningVersion: {
    title: string;
    description?: string | null;
    status: string;
    priority: string;
    dueDate?: string | null;
  };
  resolution: string;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  resolvedAt: string;
}

export interface ConflictPersistence {
  applyResolution(command: ConflictResolutionWrite): Promise<void>;
  listUnresolved(): Promise<ConnectorTaskRecord[]>;
}

export interface RetentionDetailRecord {
  connectorId: string;
  syncedAt: string;
  detail: {
    action: string;
    taskTitle: string;
    taskSourceId: string;
    taskId?: string;
    reason?: string;
    resolution?: {
      action: string;
      status: string;
      resolvedAt: string;
      message: string;
      claimId?: string;
      leaseExpiresAt?: string;
    };
    [key: string]: unknown;
  };
}

export type RetentionClaimOutcome =
  | { status: 'claimed'; record: RetentionDetailRecord; recoveringStaleClaim: boolean }
  | { status: 'not-found' }
  | { status: 'unchanged'; record: RetentionDetailRecord };

export interface RetentionPersistence {
  getDetail(syncLogId: string, detailIndex: number): Promise<RetentionDetailRecord | null>;
  claim(input: {
    syncLogId: string;
    detailIndex: number;
    action: string;
    claimId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<RetentionClaimOutcome>;
  renew(input: {
    syncLogId: string;
    detailIndex: number;
    claimId: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  finalize(input: {
    syncLogId: string;
    detailIndex: number;
    claimId: string;
    resolution: {
      action: string;
      status: string;
      resolvedAt: string;
      message: string;
    };
  }): Promise<boolean>;
  findTask(input: {
    connectorId: string;
    taskId?: string;
    taskSourceId: string;
  }): Promise<ConnectorTaskRecord | null>;
  getTask(taskId: string): Promise<ConnectorTaskRecord | null>;
  convertTaskTreeToLocal(taskId: string, archive: boolean): Promise<void>;
  deleteTaskTree(taskId: string): Promise<void>;
}

export interface ConnectorExecutionSupport {
  allowsLegacyWorkflow(
    workflow:
      | 'dependency-reconciliation'
      | 'durable-ai'
      | 'event-outbox'
      | 'notification-dispatcher'
      | 'notification-enrichment'
      | 'planning-signals'
      | 'project-automation'
      | 'semantic-search',
  ): boolean;
  assertConfigSupported(config: ConnectorConfig): void;
  assertConnectorSupported(connector: {
    type: string;
    syncDomainData?: unknown;
    dependencySnapshotStrategy?: unknown;
    fetchProjectAssociations?: unknown;
  }): void;
  listEnabledConnectorIds(): Promise<string[]>;
  listEnabledGitHubConfigs(): Promise<Array<{
    id: string;
    type: string;
    capabilities: ConnectorConfig['capabilities'];
  }>>;
  listConnectorTaskIdentities(connectorId: string): Promise<Array<{
    id: string;
    sourceId: string;
  }>>;
  listConnectorTaskIds(
    connectorId: string,
    sourceIds?: ReadonlySet<string>,
  ): Promise<string[]>;
}

export interface ConnectorExecutionRepositories {
  readonly management: import('./connector-management').ConnectorManagementPersistence;
  readonly lists: SourceListPersistence;
  readonly pushes: TaskPushPersistence;
  readonly pulls: TaskPullPersistence;
  readonly deletions: DeletionPersistence;
  readonly notifications: ConnectorNotificationPersistence;
  readonly conflicts: ConflictPersistence;
  readonly retention: RetentionPersistence;
  readonly support: ConnectorExecutionSupport;
}
