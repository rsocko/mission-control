import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runTransaction, sqlite } from '@/db';
import {
  myDayExclusions,
  myDayItems,
  notificationActions,
  notifications,
  tasks,
} from '@/db/schema';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
  type CreateNotificationResult,
} from '@/lib/notifications/service';
import { syncFinanceProviderPresentation } from '@/lib/finance-insights/notification-ingestion';
import { formatDateInLocalTimezone } from '@/lib/utils/date';

const ATTRIBUTION_ESCALATION_MS = 24 * 60 * 60 * 1_000;
const ATTRIBUTION_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const WRITE_BACK_FRESHNESS_MS = 60 * 60 * 1_000;
const WRITE_BACK_EXHAUSTED_ATTEMPTS = 3;
const SOURCE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
const SOURCE_BATCH_SIZE = 500;
const TASK_CONNECTOR_TYPE = 'mission-control';
const TASK_CONNECTOR_INSTANCE_ID = 'mission-control';

export type FinanceAttentionSignalKind =
  | 'attributionReviewRequired'
  | 'writeBackFailed';
export type FinanceAttentionRoute =
  | 'actionableNotification'
  | 'task'
  | 'statusOnly'
  | 'settled'
  | 'stale';

export interface FinanceAttentionSignal {
  connectorId: string;
  signalKind: FinanceAttentionSignalKind;
  sourceRef: string;
  sourceLifecycle: 'open' | 'resolved' | 'superseded';
  conditionSince: string;
  sourceAsOf: string;
  activityKey: string;
  actionable: boolean;
  settlementReason: string | null;
}

export interface FinanceAttentionRoutingResult {
  evaluated: number;
  notificationsCreated: number;
  notificationsUpdated: number;
  tasksCreated: number;
  tasksUpdated: number;
  tasksSettled: number;
  stalePreserved: number;
  statusOnly: number;
}

interface AttributionExceptionRow {
  id: string;
  status: 'open' | 'retry_requested' | 'resolved' | 'dismissed';
  reviewState: 'pending' | 'resolved';
  reasonCode: string;
  retryable: number;
  sourceFingerprint: string;
  policyVersion: number | null;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

interface WriteBackRow {
  id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface SourceCursor {
  updatedAt: string;
  id: string;
}

function stableDigest(signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>): string {
  return createHash('sha256')
    .update(`${signal.connectorId}\0${signal.signalKind}\0${signal.sourceRef}`)
    .digest('hex');
}

export function financeAttentionSourceId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-attention:${stableDigest(signal)}`;
}

export function financeAttentionTaskId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-task-${stableDigest(signal).slice(0, 32)}`;
}

function financeAttentionNotificationId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-notification-${stableDigest(signal).slice(0, 32)}`;
}

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function selectFinanceAttentionRoute(
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): FinanceAttentionRoute {
  if (signal.sourceLifecycle !== 'open') return 'settled';
  if (!signal.actionable) return 'statusOnly';

  const sourceAsOf = validTimestamp(signal.sourceAsOf);
  const conditionSince = validTimestamp(signal.conditionSince);
  if (
    sourceAsOf === null
    || conditionSince === null
    || sourceAsOf > decisionAt.getTime()
    || conditionSince > sourceAsOf
  ) {
    return 'stale';
  }
  const maximumAge = signal.signalKind === 'attributionReviewRequired'
    ? ATTRIBUTION_FRESHNESS_MS
    : WRITE_BACK_FRESHNESS_MS;
  if (decisionAt.getTime() - sourceAsOf > maximumAge) return 'stale';
  if (signal.signalKind === 'writeBackFailed') return 'task';
  return decisionAt.getTime() - conditionSince >= ATTRIBUTION_ESCALATION_MS
    ? 'task'
    : 'actionableNotification';
}

function attributionSignal(
  connectorId: string,
  row: AttributionExceptionRow,
): FinanceAttentionSignal {
  const open = (row.status === 'open' || row.status === 'retry_requested')
    && row.reviewState === 'pending';
  return {
    connectorId,
    signalKind: 'attributionReviewRequired',
    sourceRef: row.id,
    sourceLifecycle: open
      ? 'open'
      : row.status === 'dismissed'
        ? 'superseded'
        : 'resolved',
    conditionSince: row.firstObservedAt,
    sourceAsOf: row.lastObservedAt,
    activityKey: [
      'attribution-v1',
      row.id,
      row.reasonCode,
      row.sourceFingerprint,
      row.policyVersion ?? 'none',
    ].join(':'),
    actionable: open && row.retryable === 0,
    settlementReason: open
      ? null
      : row.status === 'dismissed'
        ? 'source_superseded'
        : 'authoritative_state_verified',
  };
}

function writeBackSignal(
  connectorId: string,
  row: WriteBackRow,
): FinanceAttentionSignal {
  return {
    connectorId,
    signalKind: 'writeBackFailed',
    sourceRef: row.id,
    sourceLifecycle: row.status === 'succeeded' ? 'resolved' : 'open',
    conditionSince: row.updatedAt,
    sourceAsOf: row.updatedAt,
    activityKey: `write-back-v1:${row.id}:${row.status}:${row.attemptCount}`,
    actionable: row.status === 'failed'
      && row.attemptCount >= WRITE_BACK_EXHAUSTED_ATTEMPTS,
    settlementReason: row.status === 'succeeded'
      ? 'authoritative_state_verified'
      : null,
  };
}

function loadAttributionBatch(
  connectorId: string,
  since: string,
  cursor: SourceCursor | null,
): AttributionExceptionRow[] {
  if (!cursor) {
    return sqlite.prepare(`
      SELECT id, status, review_state AS reviewState, reason_code AS reasonCode,
             retryable, source_fingerprint AS sourceFingerprint,
             policy_version AS policyVersion, first_observed_at AS firstObservedAt,
             last_observed_at AS lastObservedAt, resolved_at AS resolvedAt,
             updated_at AS updatedAt
      FROM finance_attribution_exceptions
      WHERE connector_id = ? AND updated_at >= ?
      ORDER BY updated_at, id
      LIMIT ?
    `).all(connectorId, since, SOURCE_BATCH_SIZE) as AttributionExceptionRow[];
  }
  return sqlite.prepare(`
    SELECT id, status, review_state AS reviewState, reason_code AS reasonCode,
           retryable, source_fingerprint AS sourceFingerprint,
           policy_version AS policyVersion, first_observed_at AS firstObservedAt,
           last_observed_at AS lastObservedAt, resolved_at AS resolvedAt,
           updated_at AS updatedAt
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND (updated_at, id) > (?, ?)
    ORDER BY updated_at, id
    LIMIT ?
  `).all(
    connectorId,
    cursor.updatedAt,
    cursor.id,
    SOURCE_BATCH_SIZE,
  ) as AttributionExceptionRow[];
}

function loadWriteBackBatch(
  connectorId: string,
  since: string,
  cursor: SourceCursor | null,
): WriteBackRow[] {
  if (!cursor) {
    return sqlite.prepare(`
      SELECT id, status, attempt_count AS attemptCount, created_at AS createdAt,
             updated_at AS updatedAt, completed_at AS completedAt
      FROM finance_mutation_audit
      WHERE connector_id = ? AND updated_at >= ?
        AND status IN ('pending', 'processing', 'succeeded', 'failed')
      ORDER BY updated_at, id
      LIMIT ?
    `).all(connectorId, since, SOURCE_BATCH_SIZE) as WriteBackRow[];
  }
  return sqlite.prepare(`
    SELECT id, status, attempt_count AS attemptCount, created_at AS createdAt,
           updated_at AS updatedAt, completed_at AS completedAt
    FROM finance_mutation_audit
    WHERE connector_id = ? AND (updated_at, id) > (?, ?)
      AND status IN ('pending', 'processing', 'succeeded', 'failed')
    ORDER BY updated_at, id
    LIMIT ?
  `).all(
    connectorId,
    cursor.updatedAt,
    cursor.id,
    SOURCE_BATCH_SIZE,
  ) as WriteBackRow[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function attentionMetadata(
  signal: FinanceAttentionSignal,
  route: FinanceAttentionRoute,
  decisionAt: Date,
  existing: unknown = {},
): Record<string, unknown> {
  return {
    ...record(existing),
    financeAttention: {
      contractVersion: '1.0',
      signalFamily: signal.signalKind === 'writeBackFailed' ? 'writeBack' : 'attribution',
      signalKind: signal.signalKind,
      connectorRef: signal.connectorId,
      sourceRef: signal.sourceRef,
      activityKey: signal.activityKey,
      sourceLifecycle: signal.sourceLifecycle,
      sourceAsOf: signal.sourceAsOf,
      decisionAt: decisionAt.toISOString(),
      route,
      freshness: route === 'stale' ? 'stale' : 'fresh',
      settlementReason: signal.settlementReason,
    },
  };
}

function findTask(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  sourceId: string,
) {
  return transaction.select().from(tasks).where(and(
    eq(tasks.sourceId, sourceId),
    eq(tasks.connectorInstanceId, TASK_CONNECTOR_INSTANCE_ID),
  )).get();
}

function findNotification(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  sourceId: string,
) {
  return transaction.select().from(notifications).where(eq(notifications.sourceId, sourceId)).get();
}

function settleNotification(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  notification: typeof notifications.$inferSelect | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
  taskId: string | null,
): boolean {
  if (!notification) return false;
  const promoted = taskId !== null && signal.sourceLifecycle === 'open';
  const state = notification.disposition === 'dismissed'
    ? 'dismissed'
    : notification.disposition === 'handled'
      ? 'archived'
      : 'resolved';
  transaction.update(notifications).set({
    state,
    sourceState: 'resolved',
    sourceResolvedAt: notification.sourceResolvedAt ?? decisionAt.toISOString(),
    lastSourceActivityAt: signal.sourceAsOf,
    lastSourceActivityKey: signal.activityKey,
    lastSourceSyncedAt: decisionAt.toISOString(),
    autoResolveReason: signal.settlementReason ?? (taskId ? 'promoted_to_task' : 'condition_cleared'),
    relatedTaskId: taskId,
    isActionable: false,
    primaryActionId: null,
    metadata: attentionMetadata(
      signal,
      promoted ? 'task' : 'settled',
      decisionAt,
      notification.metadata,
    ),
  }).where(eq(notifications.id, notification.id)).run();
  transaction.delete(notificationActions).where(and(
    eq(notificationActions.notificationId, notification.id),
    eq(notificationActions.createdBy, 'connector'),
  )).run();
  return true;
}

function settleTask(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  task: typeof tasks.$inferSelect | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): boolean {
  if (!task) return false;
  const superseded = signal.sourceLifecycle === 'superseded';
  transaction.update(tasks).set({
    status: superseded ? 'cancelled' : 'done',
    statusReason: superseded ? 'not_planned' : 'completed',
    completedAt: task.completedAt ?? decisionAt.toISOString(),
    updatedAt: decisionAt.toISOString(),
    lastSyncedAt: decisionAt.toISOString(),
    metadata: attentionMetadata(signal, 'settled', decisionAt, task.metadata),
  }).where(eq(tasks.id, task.id)).run();
  transaction.delete(myDayItems).where(eq(myDayItems.taskId, task.id)).run();
  return true;
}

function preserveStale(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  notification: typeof notifications.$inferSelect | undefined,
  task: typeof tasks.$inferSelect | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): boolean {
  if (notification) {
    const state = notification.disposition === 'dismissed'
      ? 'dismissed'
      : notification.disposition === 'handled'
        ? 'archived'
        : 'resolved';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: notification.sourceResolvedAt ?? decisionAt.toISOString(),
      autoResolveReason: 'source_stale',
      staleSince: notification.staleSince ?? decisionAt.toISOString(),
      lastSourceSyncedAt: decisionAt.toISOString(),
      isActionable: false,
      primaryActionId: null,
      metadata: attentionMetadata(signal, 'stale', decisionAt, notification.metadata),
    }).where(eq(notifications.id, notification.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
  if (task) {
    transaction.update(tasks).set({
      lastSyncedAt: decisionAt.toISOString(),
      metadata: attentionMetadata(signal, 'stale', decisionAt, task.metadata),
    }).where(eq(tasks.id, task.id)).run();
  }
  return Boolean(notification || task);
}

function preserveStatusOnly(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  notification: typeof notifications.$inferSelect | undefined,
  task: typeof tasks.$inferSelect | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): void {
  if (notification) {
    const state = notification.disposition === 'dismissed'
      ? 'dismissed'
      : 'archived';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: notification.sourceResolvedAt ?? decisionAt.toISOString(),
      autoResolveReason: 'status_only',
      lastSourceActivityAt: signal.sourceAsOf,
      lastSourceActivityKey: signal.activityKey,
      lastSourceSyncedAt: decisionAt.toISOString(),
      isActionable: false,
      primaryActionId: null,
      metadata: attentionMetadata(signal, 'statusOnly', decisionAt, notification.metadata),
    }).where(eq(notifications.id, notification.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
  if (task) {
    transaction.update(tasks).set({
      status: 'cancelled',
      statusReason: 'not_planned',
      completedAt: task.completedAt ?? decisionAt.toISOString(),
      updatedAt: decisionAt.toISOString(),
      lastSyncedAt: decisionAt.toISOString(),
      metadata: attentionMetadata(signal, 'statusOnly', decisionAt, task.metadata),
    }).where(eq(tasks.id, task.id)).run();
    transaction.delete(myDayItems).where(eq(myDayItems.taskId, task.id)).run();
  }
}

function createOrUpdateNotification(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): CreateNotificationResult {
  const sourceId = financeAttentionSourceId(signal);
  const result = createNotificationsInTransaction(transaction, [{
    id: financeAttentionNotificationId(signal),
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: signal.connectorId,
    title: 'Review a finance attribution exception',
    body: 'An attribution decision needs review in Finance.',
    level: 'heads_up',
    category: 'finance',
    templateKey: 'finance-attribution-review',
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt: signal.sourceAsOf,
    sourceActivityKey: signal.activityKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: signal.conditionSince,
    sortAt: signal.sourceAsOf,
    groupKey: `finance-attribution:${signal.connectorId}`,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-attribution-exception',
    relatedEntityId: signal.sourceRef,
    navigationTarget: '/finance/review',
    isActionable: true,
    occurrenceKey: signal.activityKey,
    metadata: {
      notificationType: 'financeAttributionReview',
      ...attentionMetadata(signal, 'actionableNotification', decisionAt),
    },
  }], { now: decisionAt, wakeDispatcher: false })[0]!;
  syncFinanceProviderPresentation(transaction, [result]);
  return result;
}

function createOrUpdateTask(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  signal: FinanceAttentionSignal,
  decisionAt: Date,
) {
  const sourceId = financeAttentionSourceId(signal);
  const existing = findTask(transaction, sourceId);
  if (existing) {
    const wasCompleted = existing.status === 'done' || existing.status === 'cancelled';
    const previousAttention = record(record(existing.metadata).financeAttention);
    const resurface = wasCompleted
      && (
        previousAttention.route === 'settled'
        || previousAttention.route === 'statusOnly'
        || previousAttention.sourceLifecycle !== 'open'
      );
    const metadata = attentionMetadata(signal, 'task', decisionAt, existing.metadata);
    if (wasCompleted && !resurface) metadata.verificationPending = true;
    else delete metadata.verificationPending;
    transaction.update(tasks).set({
      ...(resurface
        ? {
            status: 'todo' as const,
            statusReason: null,
            completedAt: null,
            localDisposition: 'active' as const,
          }
        : {}),
      lastSyncedAt: decisionAt.toISOString(),
      updatedAt: decisionAt.toISOString(),
      metadata,
    }).where(eq(tasks.id, existing.id)).run();
    return { task: findTask(transaction, sourceId)!, created: false };
  }
  const task = {
    id: financeAttentionTaskId(signal),
    sourceId,
    connectorType: TASK_CONNECTOR_TYPE,
    connectorInstanceId: TASK_CONNECTOR_INSTANCE_ID,
    title: signal.signalKind === 'writeBackFailed'
      ? 'Resolve a failed finance write-back'
      : 'Review a finance attribution exception',
    description: signal.signalKind === 'writeBackFailed'
      ? 'A confirmed Finance change could not be verified. Review it in Finance.'
      : 'An unresolved attribution decision requires review in Finance.',
    status: 'todo',
    localDisposition: 'active' as const,
    priority: signal.signalKind === 'writeBackFailed' ? 'high' : 'medium',
    createdAt: decisionAt.toISOString(),
    updatedAt: decisionAt.toISOString(),
    lastSyncedAt: decisionAt.toISOString(),
    sourceListId: 'local',
    sourceListName: 'Local',
    metadata: attentionMetadata(signal, 'task', decisionAt),
    syncStatus: 'synced',
  };
  const inserted = transaction.insert(tasks).values(task).onConflictDoNothing({
    target: [tasks.sourceId, tasks.connectorInstanceId],
  }).run();
  return { task: findTask(transaction, sourceId)!, created: inserted.changes > 0 };
}

function projectTaskToMyDay(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  taskId: string,
  decisionAt: Date,
): void {
  const date = formatDateInLocalTimezone(decisionAt);
  const excluded = transaction.select({ id: myDayExclusions.id })
    .from(myDayExclusions)
    .where(and(eq(myDayExclusions.taskId, taskId), eq(myDayExclusions.date, date)))
    .get();
  if (excluded) return;
  const digest = createHash('sha256').update(`${taskId}\0${date}`).digest('hex').slice(0, 24);
  transaction.insert(myDayItems).values({
    id: `finance-myday-${digest}`,
    taskId,
    date,
    addedAt: decisionAt.toISOString(),
    isAutoIncluded: true,
    order: 0,
  }).onConflictDoNothing().run();
}

export class FinanceAttentionRoutingError extends Error {
  constructor(readonly code = 'finance_attention_routing_failed') {
    super(`Finance attention routing failed (${code})`);
    this.name = 'FinanceAttentionRoutingError';
  }
}

export async function reconcileFinanceAttention(input: {
  connectorId: string;
  now?: Date;
}): Promise<FinanceAttentionRoutingResult> {
  const decisionAt = input.now ?? new Date();
  let hasPendingDelivery = false;
  try {
    const result = runTransaction((transaction) => {
      const summary: FinanceAttentionRoutingResult = {
        evaluated: 0,
        notificationsCreated: 0,
        notificationsUpdated: 0,
        tasksCreated: 0,
        tasksUpdated: 0,
        tasksSettled: 0,
        stalePreserved: 0,
        statusOnly: 0,
      };
      const routeSignals = (signals: FinanceAttentionSignal[]) => {
        summary.evaluated += signals.length;
        for (const signal of signals) {
          const sourceId = financeAttentionSourceId(signal);
          const task = findTask(transaction, sourceId);
          const notification = findNotification(transaction, sourceId);
          const route = selectFinanceAttentionRoute(signal, decisionAt);
          if (route === 'settled') {
            if (settleTask(transaction, task, signal, decisionAt)) summary.tasksSettled++;
            if (settleNotification(transaction, notification, signal, decisionAt, task?.id ?? null)) {
              summary.notificationsUpdated++;
            }
            continue;
          }
          if (route === 'stale') {
            preserveStale(transaction, notification, task, signal, decisionAt);
            summary.stalePreserved++;
            continue;
          }
          if (route === 'statusOnly') {
            preserveStatusOnly(transaction, notification, task, signal, decisionAt);
            summary.statusOnly++;
            continue;
          }
          if (route === 'actionableNotification' && !task) {
            const routed = createOrUpdateNotification(transaction, signal, decisionAt);
            if (routed.created) summary.notificationsCreated++;
            else summary.notificationsUpdated++;
            hasPendingDelivery ||= routed.deliveryEvents.some((event) => event.status === 'pending');
            continue;
          }
          const routedTask = createOrUpdateTask(transaction, signal, decisionAt);
          if (routedTask.created) summary.tasksCreated++;
          else summary.tasksUpdated++;
          settleNotification(transaction, notification, signal, decisionAt, routedTask.task.id);
          if (routedTask.task.status === 'done' || routedTask.task.status === 'cancelled') {
            transaction.delete(myDayItems).where(eq(myDayItems.taskId, routedTask.task.id)).run();
          } else {
            projectTaskToMyDay(transaction, routedTask.task.id, decisionAt);
          }
        }
      };
      const since = new Date(decisionAt.getTime() - SOURCE_LOOKBACK_MS).toISOString();
      let attributionCursor: SourceCursor | null = null;
      while (true) {
        const rows = loadAttributionBatch(input.connectorId, since, attributionCursor);
        routeSignals(rows.map((row) => attributionSignal(input.connectorId, row)));
        if (rows.length < SOURCE_BATCH_SIZE) break;
        const last = rows.at(-1)!;
        attributionCursor = { updatedAt: last.updatedAt, id: last.id };
      }
      let writeBackCursor: SourceCursor | null = null;
      while (true) {
        const rows = loadWriteBackBatch(input.connectorId, since, writeBackCursor);
        routeSignals(rows.map((row) => writeBackSignal(input.connectorId, row)));
        if (rows.length < SOURCE_BATCH_SIZE) break;
        const last = rows.at(-1)!;
        writeBackCursor = { updatedAt: last.updatedAt, id: last.id };
      }
      return summary;
    });
    if (hasPendingDelivery) wakeNotificationDeliveryDispatcher();
    return result;
  } catch (error) {
    if (error instanceof FinanceAttentionRoutingError) throw error;
    throw new FinanceAttentionRoutingError();
  }
}
