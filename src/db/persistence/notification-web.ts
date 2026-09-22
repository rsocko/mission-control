import type { NotificationQuery } from '@/lib/notifications/query';
import type { NotificationState } from '@/types';

// ─── Mutation action/result types (shared with notification-writeback) ───────

export type NotificationWritebackAction =
  | 'mark_read'
  | 'mark_done'
  | 'mute'
  | 'unmute';

export type NotificationMutationAction =
  | NotificationWritebackAction
  | 'dismiss';

export interface NotificationMutationItemResult {
  id: string;
  localStatus: 'updated' | 'not_found';
  writebackStatus: 'pending' | 'not_required';
}

export interface NotificationMutationResult {
  updatedCount: number;
  queuedCount: number;
  results: NotificationMutationItemResult[];
}

// ─── Query result shapes ────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  levelRank: number;
  category: string;
  templateKey: string | null;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  syncState: string;
  receivedAt: string;
  sortAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  handledAt: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  mutedAt: string | null;
  sourceResolvedAt: string | null;
  metadata: unknown;
  presentation: unknown;
  isActionable: boolean | number;
  primaryActionId: string | null;
  aiSuggestedActionId: string | null;
  lastSourceActivityAt: string | null;
  lastSourceActivityKey: string | null;
  handledSourceActivityAt: string | null;
  handledSourceActivityKey: string | null;
  lastSourceSyncedAt: string | null;
  expiresAt: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  staleSince: string | null;
  autoResolveReason: string | null;
  enrichmentRevision: string | null;
  enrichmentGeneration: number;
}

export interface NotificationActionRow {
  id: string;
  notificationId: string;
  isPrimary: boolean | number;
  actionType: string;
  label: string | null;
  icon: string | null;
  variant: string;
  sortOrder: number;
  payload: unknown;
  opensExternal: boolean | number;
  requiresConfirmation: boolean | number;
  createdBy: string;
  executionState: string;
  claimedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface NotificationStats {
  total: number;
  unread: number;
  attention: number;
  urgent: number;
  actionNeeded: number;
  headsUp: number;
  fyi: number;
  digest: number;
  actionable: number;
}

export interface NotificationFacets {
  level: Record<string, number>;
  category: Record<string, number>;
  source: Record<string, number>;
  sourceAccount: Array<{ key: string; label: string; source: string; count: number }>;
  notificationType: Array<{ key: string; label: string; count: number }>;
  state: Record<string, number>;
  merchant: Array<{ key: string; label: string; count: number }>;
}

export interface NotificationQueryResult {
  items: NotificationRow[];
  actions: NotificationActionRow[];
  hasMore: boolean;
  cursor: string | null;
  stats: NotificationStats;
  facets: NotificationFacets;
  matchingCount: number;
}

// ─── Mutation shapes ────────────────────────────────────────────────────────

export interface RestoreSnapshot {
  id: string;
  readState: 'unread' | 'read';
  disposition: 'inbox' | 'handled' | 'dismissed';
  readAt?: string | null;
  handledAt?: string | null;
  dismissedAt?: string | null;
  archivedAt?: string | null;
  handledSourceActivityAt?: string | null;
  handledSourceActivityKey?: string | null;
}

export interface BulkSelectedRow {
  id: string;
  readState: string;
  disposition: string;
  sourceState: string;
  mutedAt: string | null;
}

// ─── Saved view shapes ──────────────────────────────────────────────────────

export interface SavedViewRow {
  id: string;
  name: string;
  query: unknown;
  createdAt: string;
  updatedAt: string;
}

// ─── Writeback shapes ───────────────────────────────────────────────────────

export interface WritebackJob {
  id: string;
  notificationId: string;
  connectorInstanceId: string;
  connectorType: string;
  sourceId: string;
  actionType: string;
  status: string;
  retryable: number | boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WritebackStatusResult {
  counts: Record<string, number>;
  jobs: WritebackJob[];
  failed: WritebackJob[];
  syncState: 'synced' | 'pending' | 'failed';
  retryable: boolean;
}

export interface WritebackClaimRow {
  id: string;
  notificationId: string;
  connectorInstanceId: string;
  connectorType: string;
  sourceId: string;
  actionType: NotificationWritebackAction;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: string;
}

// ─── Web push subscription shapes ───────────────────────────────────────────

export interface WebSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
}

// ─── Action, enrichment, and classification shapes ──────────────────────────

export interface NotificationActionNotification {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  templateKey: string | null;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  navigationTarget: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  groupKey: string | null;
  metadata: unknown;
  presentation: unknown;
  lastSourceActivityAt: string | null;
  lastSourceActivityKey: string | null;
}

export interface NotificationRouteAction {
  id: string;
  notificationId: string;
  actionType: string;
  payload: unknown;
}

export type NotificationRouteLifecycleState = 'read' | 'archived' | 'dismissed';

export interface ReminderActionInput {
  notificationId: string;
  actionId: string;
  taskId: string;
  actionType: 'remind_later' | 'complete_task' | 'dismiss_reminder';
  now: string;
  reminderAt: string | null;
}

export type ReminderActionResult =
  | { applied: true }
  | {
      applied: false;
      conflict:
        | 'missing'
        | 'handled'
        | 'task_terminal'
        | 'action_claimed'
        | 'reminder_changed';
    };

export interface WorkflowFollowUpInput {
  id: string;
  sourceId: string;
  title: string;
  body: string;
  level: 'heads_up' | 'action_needed';
  levelRank: number;
  groupKey: string;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityId: string;
  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;
  retryAction: {
    id: string;
    payload: Record<string, unknown>;
  } | null;
}

export interface ReEnrichmentNotification {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  state: string;
  readState: string;
  isActionable: boolean;
  metadata: unknown;
}

export type ReEnrichmentScope =
  | { scope: 'all'; limit: number }
  | { scope: 'unenriched'; limit: number }
  | { scope: 'connector'; connectorType: string; limit: number }
  | { scope: 'ids'; ids: string[] };

export interface ReEnrichedNotificationInput {
  id: string;
  title: string;
  body: string | null;
  category: string;
  templateKey: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
  metadata: Record<string, unknown>;
  presentation: Record<string, unknown>;
  providerSignature: boolean;
  isActionable: boolean;
  primaryActionId: string | null;
  actions: Array<{
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
  }>;
}

export interface NotificationClassificationItem {
  id: string;
  title: string;
  level: string;
  category: string;
  isActionable: boolean;
  connectorType: string;
  receivedAt: string;
}

// ─── Contract ───────────────────────────────────────────────────────────────

export interface NotificationWebPersistence {
  // Query
  queryNotifications(input: {
    query: NotificationQuery;
    limit: number;
    cursor: string | null;
  }): Promise<NotificationQueryResult>;

  recoverStaleActions(recoveryCutoff: string): Promise<void>;

  // Action route
  findNotificationForAction(id: string): Promise<NotificationActionNotification | null>;
  findNotificationAction(
    notificationId: string,
    actionId: string,
  ): Promise<NotificationRouteAction | null>;
  updateNotificationFromAction(input: {
    notificationId: string;
    state: NotificationRouteLifecycleState;
    now: string;
  }): Promise<void>;
  getReminderMorningHour(): Promise<number>;
  applyReminderAction(input: ReminderActionInput): Promise<ReminderActionResult>;
  findWorkflowEndpoint(
    workflowId: string,
  ): Promise<{ found: boolean; url: string | null }>;
  claimWorkflowAction(input: {
    notificationId: string;
    actionId: string;
    claimedAt: string;
    recoveryCutoff: string;
  }): Promise<boolean>;
  claimProviderAction(input: {
    notificationId: string;
    actionId: string;
    claimedAt: string;
    recoveryCutoff: string;
  }): Promise<boolean>;
  finalizeProviderAction(input: {
    notificationId: string;
    claimedAt: string;
    now: string;
    success: boolean;
    error: string | null;
  }): Promise<boolean>;
  finalizeWorkflowAction(input: {
    notificationId: string;
    actionId: string;
    claimedAt: string;
    now: string;
    success: boolean;
    error: string | null;
    groupKey: string;
    followUp: WorkflowFollowUpInput;
  }): Promise<boolean>;

  // Re-enrichment and notification triage
  listNotificationsForReEnrichment(
    input: ReEnrichmentScope,
  ): Promise<ReEnrichmentNotification[]>;
  saveReEnrichedNotification(input: ReEnrichedNotificationInput): Promise<void>;
  listNotificationsForClassification(limit: number): Promise<NotificationClassificationItem[]>;

  // Single mutations
  restoreSnapshots(snapshots: RestoreSnapshot[]): Promise<{ updatedCount: number }>;
  mutateStates(
    ids: string[],
    state: NotificationState,
    now: string,
  ): Promise<{ updatedCount: number }>;
  snoozeNotification(id: string, snoozeUntil: string): Promise<boolean>;

  // Bulk selection
  selectForBulkByIds(ids: string[], limit: number): Promise<BulkSelectedRow[]>;
  selectForBulkByQuery(query: NotificationQuery, limit: number): Promise<BulkSelectedRow[]>;
  validateMerchantExists(merchant: string): Promise<boolean>;
  validateMerchantForSelected(merchant: string): Promise<{ label: string; count: number } | null>;

  // Bulk execution (demo mode, non-writeback paths)
  bulkMarkUnread(ids: string[], now: string): Promise<number>;
  bulkDismissDemo(ids: string[], now: string): Promise<number>;
  bulkHandleDemo(ids: string[], now: string): Promise<number>;
  bulkMarkReadDemo(ids: string[], now: string): Promise<number>;

  // Writeback-integrated mutations (backend-neutral async contract)
  mutateNotificationsAndEnqueueWritebacks(
    ids: string[],
    action: NotificationMutationAction,
    now: string,
  ): Promise<NotificationMutationResult>;
  dismissNotificationsAndEnqueueWritebacks(
    ids: string[],
    now: string,
  ): Promise<{ updatedCount: number; queuedCount: number }>;

  /**
   * SQLite-only synchronous compatibility hook for the legacy notification
   * action route, which dismisses and enqueues a writeback in a single
   * synchronous request path and cannot be made async. Implemented only by the
   * SQLite adapter (direct better-sqlite3 transaction); the PostgreSQL adapter
   * intentionally omits it so that callers relying on it fail loudly rather
   * than silently degrading. In-scope routes and the dispatcher use the async
   * `dismissNotificationsAndEnqueueWritebacks` contract method instead.
   */
  dismissNotificationsAndEnqueueWritebacksSync?(
    ids: string[],
    now: string,
  ): { updatedCount: number; queuedCount: number };

  // Saved views
  listSavedViews(): Promise<SavedViewRow[]>;
  createSavedView(input: {
    id: string;
    name: string;
    query: NotificationQuery;
    now: string;
  }): Promise<SavedViewRow>;
  deleteSavedView(id: string): Promise<boolean>;

  // Writeback status and retry
  listWritebackStatus(notificationId: string | null): Promise<WritebackStatusResult>;
  retryWritebacks(
    selector: 'id' | 'notification_id',
    ids: string[],
    now: string,
  ): Promise<{ retried: Array<{ id: string; notificationId: string }> }>;

  // Web push subscriptions
  findSubscriptionByEndpoint(endpoint: string): Promise<{ id: string } | null>;
  registerSubscription(input: WebSubscriptionInput): Promise<string>;
  removeSubscription(endpoint: string): Promise<void>;

  // Writeback dispatch internals (backend-neutral async contract)
  claimNextConnectorBatch(input: {
    batchSize: number;
    leaseMs: number;
    singleJobConnectorIds: ReadonlySet<string>;
  }): Promise<WritebackClaimRow[]>;
  completeWritebackJobs(jobs: WritebackClaimRow[]): Promise<void>;
  failWritebackJobs(
    jobs: WritebackClaimRow[],
    error: { message: string; retryable: boolean; retryAt?: Date },
    maxRetryMs: number,
    retryBaseMs: number,
  ): Promise<void>;
  renewWritebackLeases(jobs: WritebackClaimRow[], leaseMs: number): Promise<WritebackClaimRow[]>;
  releaseUnattemptedWritebackJobs(jobs: WritebackClaimRow[]): Promise<void>;
  getNextScheduledWriteback(): Promise<{ nextAttemptAt: string } | null>;
  refreshNotificationSyncState(notificationId: string): Promise<void>;

  /** Lazily wakes the writeback dispatcher without importing tainted connector modules. */
  wakeWritebackDispatcher(): void;
}
