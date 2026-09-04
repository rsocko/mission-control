import type { NotificationQuery } from '@/lib/notifications/query';
import type { NotificationView } from '@/lib/notifications/views';
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
  archivedAt: string | null;
  snoozedUntil: string | null;
  mutedAt: string | null;
  metadata: unknown;
  presentation: unknown;
  isActionable: boolean | number;
  primaryActionId: string | null;
  lastSourceActivityAt: string | null;
  lastSourceActivityKey: string | null;
  handledSourceActivityAt: string | null;
  handledSourceActivityKey: string | null;
  [key: string]: unknown;
}

export interface NotificationActionRow {
  id: string;
  notificationId: string;
  isPrimary: boolean | number;
  actionType: string;
  label: string | null;
  sortOrder: number;
  executionState: string;
  [key: string]: unknown;
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
  actionType: string;
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

// ─── Contract ───────────────────────────────────────────────────────────────

export interface NotificationWebPersistence {
  // Query
  queryNotifications(input: {
    query: NotificationQuery;
    limit: number;
    cursor: string | null;
  }): Promise<NotificationQueryResult>;

  recoverStaleActions(recoveryCutoff: string): void;

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

  // Writeback-integrated mutations
  mutateNotificationsAndEnqueueWritebacks(
    ids: string[],
    action: NotificationMutationAction,
    now: string,
  ): NotificationMutationResult;
  dismissNotificationsAndEnqueueWritebacks(
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
  ): { retried: Array<{ id: string; notificationId: string }> };

  // Web push subscriptions
  findSubscriptionByEndpoint(endpoint: string): Promise<{ id: string } | null>;
  registerSubscription(input: WebSubscriptionInput): Promise<string>;
  removeSubscription(endpoint: string): Promise<void>;

  // Writeback dispatch internals
  claimNextConnectorBatch(input: {
    batchSize: number;
    leaseMs: number;
    singleJobConnectorIds: ReadonlySet<string>;
  }): WritebackClaimRow[];
  completeWritebackJobs(jobs: WritebackClaimRow[]): void;
  failWritebackJobs(
    jobs: WritebackClaimRow[],
    error: { message: string; retryable: boolean; retryAt?: Date },
    maxRetryMs: number,
    retryBaseMs: number,
  ): void;
  renewWritebackLeases(jobs: WritebackClaimRow[], leaseMs: number): WritebackClaimRow[];
  releaseUnattemptedWritebackJobs(jobs: WritebackClaimRow[]): void;
  getNextScheduledWriteback(): { nextAttemptAt: string } | null;
  refreshNotificationSyncState(notificationId: string): void;

  /** Lazily wakes the writeback dispatcher without importing tainted connector modules. */
  wakeWritebackDispatcher(): void;
}
