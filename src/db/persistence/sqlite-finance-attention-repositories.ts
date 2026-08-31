import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import db, { sqlite } from '@/db';
import * as schema from '@/db/schema';
import {
  myDayExclusions,
  myDayItems,
  notificationActions,
  notifications,
  tasks,
} from '@/db/schema';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
} from '@/lib/notifications/service';
import type { InboundNotification } from '@/types';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import {
  compareFinanceAttentionMyDayCandidates,
  compareFinanceAttentionSignalsForRouting,
  financeAttentionAttributionSignal,
  FINANCE_ATTENTION_MAX_REPAIR_SCOPE,
  financeAttentionMetadata,
  financeAttentionMyDayCandidateRank,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  financeAttentionRepairedMetadata,
  financeAttentionNotificationInput,
  financeAttentionRecord,
  financeAttentionRequiresTaskPromotion,
  FINANCE_ATTENTION_SOURCE_BATCH_SIZE,
  FINANCE_ATTENTION_SOURCE_LOOKBACK_MS,
  financeAttentionSourceId,
  financeAttentionTaskId,
  FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID,
  FINANCE_ATTENTION_TASK_CONNECTOR_TYPE,
  financeAttentionValidTimestamp,
  financeAttentionWriteBackSignal,
  FINANCE_MY_DAY_DAILY_CAP,
  FINANCE_TASK_PROMOTION_DAILY_CAP,
  FinanceAttentionRepairError,
  resolveFinanceAttentionNotificationPresentation,
  selectFinanceAttentionRoute,
  type FinanceAttentionAttributionExceptionRow,
  type FinanceAttentionMyDayTaskCandidate,
  type FinanceAttentionRepairConnector,
  type FinanceAttentionRepairCounts,
  type FinanceAttentionRepairPersistence,
  type FinanceAttentionRepairResult,
  type FinanceAttentionRoutingOutcome,
  type FinanceAttentionRoutingPersistence,
  type FinanceAttentionRoutingResult,
  type FinanceAttentionSignal,
  type FinanceAttentionSourceCursor,
  type FinanceAttentionWriteBackRow,
} from './finance-attention';

type SqliteDatabase = Database.Database;
type DrizzleDatabase = BetterSQLite3Database<typeof schema>;
type Transaction = Parameters<typeof createNotificationsInTransaction>[0];

interface SqliteFinanceAttentionHandles {
  sqlite: SqliteDatabase;
  db: DrizzleDatabase;
}

function defaultHandles(): SqliteFinanceAttentionHandles {
  return { sqlite, db };
}

function loadAttributionBatch(
  handle: SqliteDatabase,
  connectorId: string,
  since: string,
  cursor: FinanceAttentionSourceCursor | null,
): FinanceAttentionAttributionExceptionRow[] {
  if (!cursor) {
    return handle.prepare(`
      SELECT id, status, review_state AS reviewState, reason_code AS reasonCode,
             retryable, source_fingerprint AS sourceFingerprint,
             policy_version AS policyVersion, first_observed_at AS firstObservedAt,
             last_observed_at AS lastObservedAt, resolved_at AS resolvedAt,
             updated_at AS updatedAt
      FROM finance_attribution_exceptions
      WHERE connector_id = ? AND updated_at >= ?
      ORDER BY updated_at, id
      LIMIT ?
    `).all(connectorId, since, FINANCE_ATTENTION_SOURCE_BATCH_SIZE) as
      FinanceAttentionAttributionExceptionRow[];
  }
  return handle.prepare(`
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
    FINANCE_ATTENTION_SOURCE_BATCH_SIZE,
  ) as FinanceAttentionAttributionExceptionRow[];
}

function loadWriteBackBatch(
  handle: SqliteDatabase,
  connectorId: string,
  since: string,
  cursor: FinanceAttentionSourceCursor | null,
): FinanceAttentionWriteBackRow[] {
  if (!cursor) {
    return handle.prepare(`
      SELECT id, status, attempt_count AS attemptCount, created_at AS createdAt,
             updated_at AS updatedAt, completed_at AS completedAt
      FROM finance_mutation_audit
      WHERE connector_id = ? AND updated_at >= ?
        AND status IN ('pending', 'processing', 'succeeded', 'failed')
      ORDER BY updated_at, id
      LIMIT ?
    `).all(connectorId, since, FINANCE_ATTENTION_SOURCE_BATCH_SIZE) as FinanceAttentionWriteBackRow[];
  }
  return handle.prepare(`
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
    FINANCE_ATTENTION_SOURCE_BATCH_SIZE,
  ) as FinanceAttentionWriteBackRow[];
}

function findTask(transaction: Transaction, sourceId: string) {
  return transaction.select().from(tasks).where(and(
    eq(tasks.sourceId, sourceId),
    eq(tasks.connectorInstanceId, FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID),
  )).get();
}

function findNotification(transaction: Transaction, sourceId: string) {
  return transaction.select().from(notifications).where(eq(notifications.sourceId, sourceId)).get();
}

function settleNotification(
  transaction: Transaction,
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
    metadata: financeAttentionMetadata(
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
  transaction: Transaction,
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
    metadata: financeAttentionMetadata(signal, 'settled', decisionAt, task.metadata),
  }).where(eq(tasks.id, task.id)).run();
  transaction.delete(myDayItems).where(eq(myDayItems.taskId, task.id)).run();
  return true;
}

function preserveStale(
  transaction: Transaction,
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
      metadata: financeAttentionMetadata(signal, 'stale', decisionAt, notification.metadata),
    }).where(eq(notifications.id, notification.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
  if (task) {
    transaction.update(tasks).set({
      lastSyncedAt: decisionAt.toISOString(),
      metadata: financeAttentionMetadata(signal, 'stale', decisionAt, task.metadata),
    }).where(eq(tasks.id, task.id)).run();
  }
  return Boolean(notification || task);
}

function preserveStatusOnly(
  transaction: Transaction,
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
      metadata: financeAttentionMetadata(signal, 'statusOnly', decisionAt, notification.metadata),
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
      metadata: financeAttentionMetadata(signal, 'statusOnly', decisionAt, task.metadata),
    }).where(eq(tasks.id, task.id)).run();
    transaction.delete(myDayItems).where(eq(myDayItems.taskId, task.id)).run();
  }
}

function createOrUpdateTask(
  transaction: Transaction,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): { task: typeof tasks.$inferSelect; created: boolean; promoted: boolean } {
  const sourceId = financeAttentionSourceId(signal);
  const existing = findTask(transaction, sourceId);
  if (existing) {
    const wasCompleted = existing.status === 'done' || existing.status === 'cancelled';
    const previousAttention = financeAttentionRecord(
      financeAttentionRecord(existing.metadata).financeAttention,
    );
    const resurface = wasCompleted
      && (
        previousAttention.route === 'settled'
        || previousAttention.route === 'statusOnly'
        || previousAttention.sourceLifecycle !== 'open'
      );
    const metadata = financeAttentionMetadata(signal, 'task', decisionAt, existing.metadata);
    if (wasCompleted && !resurface) {
      metadata.verificationPending = true;
    } else {
      delete metadata.verificationPending;
      if (resurface) {
        financeAttentionRecord(metadata.financeAttention).promotedAt = decisionAt.toISOString();
      }
    }
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
    return {
      task: findTask(transaction, sourceId)!,
      created: false,
      promoted: resurface,
    };
  }
  const metadata = financeAttentionMetadata(signal, 'task', decisionAt);
  financeAttentionRecord(metadata.financeAttention).promotedAt = decisionAt.toISOString();
  const task = {
    id: financeAttentionTaskId(signal),
    sourceId,
    connectorType: FINANCE_ATTENTION_TASK_CONNECTOR_TYPE,
    connectorInstanceId: FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID,
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
    metadata,
    syncStatus: 'synced',
  };
  const inserted = transaction.insert(tasks).values(task).onConflictDoNothing({
    target: [tasks.sourceId, tasks.connectorInstanceId],
  }).run();
  return {
    task: findTask(transaction, sourceId)!,
    created: inserted.changes > 0,
    promoted: inserted.changes > 0,
  };
}

function promotionCountForDay(transaction: Transaction, decisionAt: Date): number {
  const date = formatDateInLocalTimezone(decisionAt);
  return transaction.select({
    sourceId: tasks.sourceId,
    createdAt: tasks.createdAt,
    metadata: tasks.metadata,
  }).from(tasks).where(like(tasks.sourceId, 'finance-attention:%')).all().filter((task) => {
    const attention = financeAttentionRecord(financeAttentionRecord(task.metadata).financeAttention);
    const promotedAt = typeof attention.promotedAt === 'string'
      ? attention.promotedAt
      : task.createdAt;
    return financeAttentionValidTimestamp(promotedAt) !== null
      && formatDateInLocalTimezone(new Date(promotedAt)) === date;
  }).length;
}

function rebuildFinanceMyDay(
  transaction: Transaction,
  decisionAt: Date,
): { autoIncluded: number; deferred: number } {
  const date = formatDateInLocalTimezone(decisionAt);
  const financeTasks = transaction.select().from(tasks)
    .where(like(tasks.sourceId, 'finance-attention:%'))
    .all();
  const financeTaskIds = new Set(financeTasks.map((task) => task.id));
  const dayItems = transaction.select().from(myDayItems)
    .where(eq(myDayItems.date, date))
    .all();

  for (const item of dayItems) {
    if (item.isAutoIncluded && financeTaskIds.has(item.taskId)) {
      transaction.delete(myDayItems).where(eq(myDayItems.id, item.id)).run();
    }
  }

  const manualTaskIds = new Set(
    dayItems.filter((item) => !item.isAutoIncluded).map((item) => item.taskId),
  );
  const excludedTaskIds = new Set(
    transaction.select({ taskId: myDayExclusions.taskId })
      .from(myDayExclusions)
      .where(eq(myDayExclusions.date, date))
      .all()
      .map((row) => row.taskId),
  );
  const candidates = financeTasks.flatMap((task) => {
    if (manualTaskIds.has(task.id) || excludedTaskIds.has(task.id)) return [];
    const candidate: FinanceAttentionMyDayTaskCandidate = {
      id: task.id,
      status: task.status,
      localDisposition: task.localDisposition,
      metadata: task.metadata,
      dueDate: task.dueDate,
      priority: task.priority,
      createdAt: task.createdAt,
    };
    const rank = financeAttentionMyDayCandidateRank(candidate, date);
    return rank ? [{ task, policyRank: rank.policyRank, conditionSince: rank.conditionSince }] : [];
  }).sort(compareFinanceAttentionMyDayCandidates);

  const selected = candidates.slice(0, FINANCE_MY_DAY_DAILY_CAP);
  const maxOrder = dayItems
    .filter((item) => !item.isAutoIncluded || !financeTaskIds.has(item.taskId))
    .reduce((maximum, item) => Math.max(maximum, item.order), 0);
  selected.forEach(({ task }, index) => {
    const digest = financeMyDayItemId(task.id, date);
    transaction.insert(myDayItems).values({
      id: digest,
      taskId: task.id,
      date,
      addedAt: decisionAt.toISOString(),
      isAutoIncluded: true,
      order: maxOrder + index + 1,
    }).onConflictDoNothing().run();
  });
  return {
    autoIncluded: selected.length,
    deferred: Math.max(0, candidates.length - selected.length),
  };
}

function financeMyDayItemId(taskId: string, date: string): string {
  const digest = createHash('sha256').update(`${taskId}\0${date}`).digest('hex').slice(0, 24);
  return `finance-myday-${digest}`;
}

function providerNotification(notification: {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  readState: string;
  isActionable: boolean;
  receivedAt: string;
  metadata: unknown;
  sourceState: string;
}): InboundNotification {
  return {
    id: notification.id,
    sourceId: notification.sourceId,
    connectorType: notification.connectorType,
    connectorInstanceId: notification.connectorInstanceId,
    title: notification.title,
    body: notification.body ?? undefined,
    level: notification.level as InboundNotification['level'],
    category: notification.category,
    isRead: notification.readState === 'read',
    isActionable: notification.isActionable,
    receivedAt: notification.receivedAt,
    sourceState: notification.sourceState as InboundNotification['sourceState'],
    hubProjectIds: [],
    tags: [],
    metadata: notification.metadata as Record<string, unknown>,
  };
}

function syncFinanceAttentionNotificationPresentation(
  transaction: Transaction,
  results: ReturnType<typeof createNotificationsInTransaction>,
): void {
  for (const result of results) {
    const resolved = resolveFinanceAttentionNotificationPresentation({
      notification: providerNotification(result.notification),
      existingPresentation: result.notification.presentation,
    });
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, result.notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
    if (resolved.actions.length > 0) {
      transaction.insert(notificationActions).values(resolved.actions).run();
    }
    transaction.update(notifications).set({
      title: resolved.title,
      body: resolved.body,
      presentation: resolved.presentation,
      isActionable: resolved.isActionable,
      primaryActionId: resolved.primaryActionId,
    }).where(eq(notifications.id, result.notification.id)).run();
  }
}

export function createSqliteFinanceAttentionRoutingPersistence(
  handles: SqliteFinanceAttentionHandles = defaultHandles(),
): FinanceAttentionRoutingPersistence {
  return {
    async reconcile(input): Promise<FinanceAttentionRoutingOutcome> {
      const decisionAt = input.decisionAt;
      let hasPendingDelivery = false;
      const summary = handles.db.transaction((transaction) => {
        const result: FinanceAttentionRoutingResult = {
          evaluated: 0,
          notificationsCreated: 0,
          notificationsUpdated: 0,
          tasksCreated: 0,
          tasksUpdated: 0,
          tasksSettled: 0,
          taskPromoted: 0,
          autoIncluded: 0,
          deferred: 0,
          settled: 0,
          stalePreserved: 0,
          statusOnly: 0,
        };
        const signals: FinanceAttentionSignal[] = [];
        const pendingNotifications: FinanceAttentionSignal[] = [];
        const collectSignals = (batch: FinanceAttentionSignal[]) => {
          result.evaluated += batch.length;
          signals.push(...batch);
        };
        const since = new Date(
          decisionAt.getTime() - FINANCE_ATTENTION_SOURCE_LOOKBACK_MS,
        ).toISOString();
        let attributionCursor: FinanceAttentionSourceCursor | null = null;
        while (true) {
          const rows = loadAttributionBatch(handles.sqlite, input.connectorId, since, attributionCursor);
          collectSignals(rows.map((row) => financeAttentionAttributionSignal(
            input.connectorId,
            row,
          )));
          if (rows.length < FINANCE_ATTENTION_SOURCE_BATCH_SIZE) break;
          const last = rows.at(-1)!;
          attributionCursor = { updatedAt: last.updatedAt, id: last.id };
        }
        let writeBackCursor: FinanceAttentionSourceCursor | null = null;
        while (true) {
          const rows = loadWriteBackBatch(handles.sqlite, input.connectorId, since, writeBackCursor);
          collectSignals(rows.map((row) => financeAttentionWriteBackSignal(
            input.connectorId,
            row,
          )));
          if (rows.length < FINANCE_ATTENTION_SOURCE_BATCH_SIZE) break;
          const last = rows.at(-1)!;
          writeBackCursor = { updatedAt: last.updatedAt, id: last.id };
        }

        let promotionsRemaining = Math.max(
          0,
          FINANCE_TASK_PROMOTION_DAILY_CAP - promotionCountForDay(transaction, decisionAt),
        );
        signals.sort((left, right) => (
          compareFinanceAttentionSignalsForRouting(left, right, decisionAt)
        ));

        for (const signal of signals) {
          const sourceId = financeAttentionSourceId(signal);
          const task = findTask(transaction, sourceId);
          const decidedRoute = selectFinanceAttentionRoute(signal, decisionAt);
          if (decidedRoute === 'settled') {
            const notification = findNotification(transaction, sourceId);
            result.settled++;
            if (settleTask(transaction, task, signal, decisionAt)) {
              result.tasksSettled++;
            }
            if (settleNotification(transaction, notification, signal, decisionAt, task?.id ?? null)) {
              result.notificationsUpdated++;
            }
            continue;
          }
          if (decidedRoute === 'stale') {
            const notification = findNotification(transaction, sourceId);
            preserveStale(transaction, notification, task, signal, decisionAt);
            result.stalePreserved++;
            continue;
          }
          if (decidedRoute === 'statusOnly') {
            const notification = findNotification(transaction, sourceId);
            preserveStatusOnly(transaction, notification, task, signal, decisionAt);
            result.statusOnly++;
            continue;
          }
          if (decidedRoute === 'actionableNotification' && !task) {
            pendingNotifications.push(signal);
            continue;
          }
          if (financeAttentionRequiresTaskPromotion(task, signal)) {
            if (promotionsRemaining === 0) {
              result.deferred++;
              continue;
            }
            promotionsRemaining--;
          }
          const routedTask = createOrUpdateTask(transaction, signal, decisionAt);
          if (routedTask.created) result.tasksCreated++;
          else result.tasksUpdated++;
          if (routedTask.promoted) result.taskPromoted++;
          const notification = findNotification(transaction, sourceId);
          settleNotification(transaction, notification, signal, decisionAt, routedTask.task.id);
        }
        if (pendingNotifications.length > 0) {
          const inputs: CreateNotificationInput[] = pendingNotifications.map((signal) => (
            financeAttentionNotificationInput(signal, decisionAt)
          ));
          const routed = createNotificationsInTransaction(transaction, inputs, {
            now: decisionAt,
            wakeDispatcher: false,
          });
          syncFinanceAttentionNotificationPresentation(transaction, routed);
          for (const routedResult of routed) {
            if (routedResult.created) result.notificationsCreated++;
            else result.notificationsUpdated++;
            hasPendingDelivery ||= routedResult.deliveryEvents.some(
              (event) => event.status === 'pending',
            );
          }
        }
        const myDay = rebuildFinanceMyDay(transaction, decisionAt);
        result.autoIncluded = myDay.autoIncluded;
        result.deferred += myDay.deferred;
        return result;
      }, { behavior: 'immediate' });
      return { summary, hasPendingDelivery };
    },
  };
}

interface SqliteRepairExceptionRow {
  id: string;
  status: string;
  reviewState: string;
}

interface SqliteRepairNotificationRow {
  id: string;
  state: string;
  disposition: string;
  sourceState: string;
  sourceResolvedAt: string | null;
  isActionable: number;
  primaryActionId: string | null;
  autoResolveReason: string | null;
  metadata: string;
}

interface SqliteRepairActionRow {
  id: string;
  executionState: string;
}

interface SqliteRepairDeliveryRow {
  id: string;
  status: string;
  leaseExpiresAt: string | null;
}

interface SqliteRepairTaskRow {
  id: string;
  status: string;
  localDisposition: string;
  completedAt: string | null;
  metadata: string;
}

interface SqliteRepairMyDayRow {
  id: string;
}

interface SqliteRepairTarget {
  exception: SqliteRepairExceptionRow;
  sourceId: string;
  notification: SqliteRepairNotificationRow | null;
  actions: SqliteRepairActionRow[];
  deliveries: SqliteRepairDeliveryRow[];
  task: SqliteRepairTaskRow | null;
  myDayItems: SqliteRepairMyDayRow[];
}

interface SqliteRepairAuditRow {
  id: string;
  mode: 'dry-run' | 'apply';
  dryRunId: string | null;
  targetDigest: string;
  occurrenceCount: number;
  notificationCount: number;
  actionCount: number;
  deliveryCount: number;
  taskCount: number;
  myDayCount: number;
  createdAt: string;
  completedAt: string;
}

function repairCountsFor(targets: SqliteRepairTarget[]): FinanceAttentionRepairCounts {
  return {
    occurrences: targets.length,
    notifications: targets.filter((target) => target.notification).length,
    connectorActions: targets.reduce((sum, target) => sum + target.actions.length, 0),
    pendingDeliveries: targets.reduce((sum, target) => sum + target.deliveries.length, 0),
    tasks: targets.filter((target) => target.task).length,
    myDayItems: targets.reduce((sum, target) => sum + target.myDayItems.length, 0),
  };
}

function repairDigestTargets(targets: SqliteRepairTarget[]): string {
  const evidence = targets.map((target) => ({
    exception: [target.exception.id, target.exception.status, target.exception.reviewState],
    sourceId: target.sourceId,
    notification: target.notification
      ? [
          target.notification.id,
          target.notification.state,
          target.notification.disposition,
          target.notification.sourceState,
          target.notification.isActionable,
          target.notification.primaryActionId,
          target.notification.autoResolveReason,
        ]
      : null,
    actions: target.actions.map((action) => [action.id, action.executionState]),
    deliveries: target.deliveries.map((delivery) => [
      delivery.id,
      delivery.status,
      delivery.leaseExpiresAt,
    ]),
    task: target.task
      ? [target.task.id, target.task.status, target.task.localDisposition, target.task.completedAt]
      : null,
    myDayItems: target.myDayItems.map((item) => item.id),
  }));
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function loadRepairConnector(
  handle: SqliteDatabase,
  connectorId: string,
): FinanceAttentionRepairConnector {
  const connector = handle.prepare(`
    SELECT type, enabled
    FROM connector_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(connectorId) as { type: string; enabled: number } | undefined;
  if (!connector) {
    throw new FinanceAttentionRepairError(
      'finance_connector_not_found',
      'Finance connector not found',
      404,
    );
  }
  if (connector.type !== 'finance-manager') {
    throw new FinanceAttentionRepairError(
      'invalid_finance_connector_type',
      'Connector is not a finance-manager connector',
      409,
    );
  }
  return { type: connector.type, enabled: connector.enabled === 1 };
}

function loadRepairTargets(
  handle: SqliteDatabase,
  connectorId: string,
): SqliteRepairTarget[] {
  const exceptions = handle.prepare(`
    SELECT id, status, review_state AS reviewState
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND reason_code = ?
      AND first_observed_at >= ? AND last_observed_at < ?
    ORDER BY id
    LIMIT ?
  `).all(
    connectorId,
    FINANCE_ATTENTION_REPAIR_REASON,
    FINANCE_ATTENTION_REPAIR_WINDOW_START,
    FINANCE_ATTENTION_REPAIR_CUTOVER,
    FINANCE_ATTENTION_MAX_REPAIR_SCOPE + 1,
  ) as SqliteRepairExceptionRow[];
  if (exceptions.length > FINANCE_ATTENTION_MAX_REPAIR_SCOPE) {
    throw new FinanceAttentionRepairError(
      'repair_scope_too_large',
      `Repair scope exceeds the ${FINANCE_ATTENTION_MAX_REPAIR_SCOPE}-occurrence safety bound`,
      409,
    );
  }

  const notificationStatement = handle.prepare(`
    SELECT id, state, disposition, source_state AS sourceState,
           source_resolved_at AS sourceResolvedAt,
           is_actionable AS isActionable, primary_action_id AS primaryActionId,
           auto_resolve_reason AS autoResolveReason, metadata
    FROM notifications
    WHERE source_id = ?
      AND connector_type = 'finance-manager'
      AND connector_instance_id = ?
      AND level = 'heads_up'
      AND category = 'finance'
      AND template_key = 'finance-attribution-review'
      AND related_entity_type = 'finance-attribution-exception'
      AND related_entity_id = ?
      AND received_at >= ?
      AND received_at < ?
      AND json_extract(metadata, '$.notificationType') = 'financeAttributionReview'
      AND json_extract(metadata, '$.financeAttention.signalKind') = 'attributionReviewRequired'
  `);
  const actionStatement = handle.prepare(`
    SELECT id, execution_state AS executionState
    FROM notification_actions
    WHERE notification_id = ? AND created_by = 'connector'
    ORDER BY id
  `);
  const taskStatement = handle.prepare(`
    SELECT id, status, local_disposition AS localDisposition,
           completed_at AS completedAt, metadata
    FROM tasks
    WHERE id = ? AND source_id = ?
      AND connector_type = 'mission-control'
      AND connector_instance_id = 'mission-control'
  `);
  const deliveryStatement = handle.prepare(`
    SELECT id, status, lease_expires_at AS leaseExpiresAt
    FROM notification_delivery_events
    WHERE notification_id = ? AND status IN ('pending', 'sending')
    ORDER BY id
  `);
  const myDayStatement = handle.prepare(`
    SELECT id FROM my_day_items WHERE task_id = ? ORDER BY id
  `);

  const targets: SqliteRepairTarget[] = [];
  for (const exception of exceptions) {
    const signal = {
      connectorId,
      signalKind: 'attributionReviewRequired' as const,
      sourceRef: exception.id,
    };
    const sourceId = financeAttentionSourceId(signal);
    const rawNotification = notificationStatement.get(
      sourceId,
      connectorId,
      exception.id,
      FINANCE_ATTENTION_REPAIR_WINDOW_START,
      FINANCE_ATTENTION_REPAIR_CUTOVER,
    ) as SqliteRepairNotificationRow | undefined;
    const actions = rawNotification
      ? actionStatement.all(rawNotification.id) as SqliteRepairActionRow[]
      : [];
    const deliveries = rawNotification
      ? deliveryStatement.all(rawNotification.id) as SqliteRepairDeliveryRow[]
      : [];
    const rawTask = taskStatement.get(
      financeAttentionTaskId(signal),
      sourceId,
    ) as SqliteRepairTaskRow | undefined;
    const taskAttention = rawTask
      ? financeAttentionRecord(
          financeAttentionRecord(JSON.parse(rawTask.metadata)).financeAttention,
        )
      : {};
    const task = rawTask
      && taskAttention.connectorRef === connectorId
      && taskAttention.sourceRef === exception.id
      && taskAttention.signalKind === 'attributionReviewRequired'
      ? rawTask
      : null;
    const myDayItemsForTask = task
      ? myDayStatement.all(task.id) as SqliteRepairMyDayRow[]
      : [];

    const notificationNeedsRepair = Boolean(rawNotification && (
      rawNotification.sourceState !== 'resolved'
      || rawNotification.isActionable !== 0
      || rawNotification.primaryActionId !== null
      || rawNotification.autoResolveReason !== 'status_only'
      || actions.length > 0
      || deliveries.length > 0
    ));
    const taskNeedsRepair = Boolean(task && (
      task.status !== 'cancelled'
      || taskAttention.route !== 'statusOnly'
      || myDayItemsForTask.length > 0
    ));
    if (!notificationNeedsRepair && !taskNeedsRepair) continue;
    targets.push({
      exception,
      sourceId,
      notification: notificationNeedsRepair ? rawNotification! : null,
      actions: notificationNeedsRepair ? actions : [],
      deliveries: notificationNeedsRepair ? deliveries : [],
      task: taskNeedsRepair ? task : null,
      myDayItems: taskNeedsRepair ? myDayItemsForTask : [],
    });
  }
  return targets;
}

function findRepairAudit(
  handle: SqliteDatabase,
  connectorId: string,
  idempotencyKey: string,
): SqliteRepairAuditRow | undefined {
  return handle.prepare(`
    SELECT id, mode, dry_run_id AS dryRunId, target_digest AS targetDigest,
           occurrence_count AS occurrenceCount,
           notification_count AS notificationCount, action_count AS actionCount,
           delivery_count AS deliveryCount, task_count AS taskCount,
           my_day_count AS myDayCount,
           created_at AS createdAt, completed_at AS completedAt
    FROM finance_attention_repair_audit
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as SqliteRepairAuditRow | undefined;
}

function insertRepairAudit(
  handle: SqliteDatabase,
  input: {
    id: string;
    connectorId: string;
    mode: 'dry-run' | 'apply';
    actorType: string;
    idempotencyKey: string;
    dryRunId: string | null;
    targetDigest: string;
    counts: FinanceAttentionRepairCounts;
    now: string;
  },
): void {
  handle.prepare(`
    INSERT INTO finance_attention_repair_audit (
      id, connector_id, mode, actor_type, idempotency_key, dry_run_id,
      reason_code, target_digest, occurrence_count, notification_count,
      action_count, delivery_count, task_count, my_day_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.connectorId,
    input.mode,
    input.actorType,
    input.idempotencyKey,
    input.dryRunId,
    FINANCE_ATTENTION_REPAIR_REASON,
    input.targetDigest,
    input.counts.occurrences,
    input.counts.notifications,
    input.counts.connectorActions,
    input.counts.pendingDeliveries,
    input.counts.tasks,
    input.counts.myDayItems,
    input.now,
    input.now,
  );
}

function assertNoInFlightDeliveries(targets: SqliteRepairTarget[]): void {
  if (targets.some((target) => (
    target.deliveries.some((delivery) => delivery.status === 'sending')
  ))) {
    throw new FinanceAttentionRepairError(
      'repair_delivery_in_flight',
      'A targeted push delivery is currently in flight; retry after delivery workers drain',
      409,
    );
  }
}

function applyRepairTargets(
  handle: SqliteDatabase,
  targets: SqliteRepairTarget[],
  now: string,
  runId: string,
): void {
  const updateNotification = handle.prepare(`
    UPDATE notifications
    SET state = ?, source_state = 'resolved',
        source_resolved_at = COALESCE(source_resolved_at, ?),
        last_source_synced_at = ?, auto_resolve_reason = 'status_only',
        is_actionable = 0, primary_action_id = NULL, metadata = ?
    WHERE id = ?
  `);
  const deleteAction = handle.prepare(`
    DELETE FROM notification_actions WHERE id = ? AND created_by = 'connector'
  `);
  const suppressDelivery = handle.prepare(`
    UPDATE notification_delivery_events
    SET status = 'suppressed',
        suppression_reason = 'finance_attention_projection_repair',
        next_attempt_at = NULL, lease_expires_at = NULL
    WHERE id = ? AND status IN ('pending', 'sending')
  `);
  const updateTask = handle.prepare(`
    UPDATE tasks
    SET status = 'cancelled', status_reason = 'not_planned',
        completed_at = COALESCE(completed_at, ?), updated_at = ?,
        last_synced_at = ?, metadata = ?
    WHERE id = ?
  `);
  const deleteMyDay = handle.prepare(`DELETE FROM my_day_items WHERE task_id = ?`);

  for (const target of targets) {
    if (target.notification) {
      const state = target.notification.disposition === 'dismissed'
        ? 'dismissed'
        : 'archived';
      updateNotification.run(
        state,
        now,
        now,
        financeAttentionRepairedMetadata(target.notification.metadata, now, runId),
        target.notification.id,
      );
      for (const action of target.actions) deleteAction.run(action.id);
      for (const delivery of target.deliveries) suppressDelivery.run(delivery.id);
    }
    if (target.task) {
      updateTask.run(
        now,
        now,
        now,
        financeAttentionRepairedMetadata(target.task.metadata, now, runId),
        target.task.id,
      );
      deleteMyDay.run(target.task.id);
    }
  }
}

export function createSqliteFinanceAttentionRepairPersistence(
  handle: SqliteDatabase = sqlite,
): FinanceAttentionRepairPersistence {
  return {
    async repair(input): Promise<FinanceAttentionRepairResult> {
      return handle.transaction((): FinanceAttentionRepairResult => {
        const connector = loadRepairConnector(handle, input.connectorId);
        const replay = findRepairAudit(handle, input.connectorId, input.idempotencyKey);
        if (replay) {
          if (
            replay.mode !== input.mode
            || (input.mode === 'apply' && replay.dryRunId !== input.dryRunId)
          ) {
            throw new FinanceAttentionRepairError(
              'repair_idempotency_conflict',
              'Idempotency key was already used for a different repair request',
              409,
            );
          }
          return {
            runId: replay.id,
            mode: replay.mode,
            connectorId: input.connectorId,
            connectorEnabled: connector.enabled,
            reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
            targetDigest: replay.targetDigest,
            counts: {
              occurrences: replay.occurrenceCount,
              notifications: replay.notificationCount,
              connectorActions: replay.actionCount,
              pendingDeliveries: replay.deliveryCount,
              tasks: replay.taskCount,
              myDayItems: replay.myDayCount,
            },
            dryRunId: replay.dryRunId,
            applied: replay.mode === 'apply',
            replayed: true,
            completedAt: replay.completedAt,
          };
        }

        const targets = loadRepairTargets(handle, input.connectorId);
        const targetDigest = repairDigestTargets(targets);
        const counts = repairCountsFor(targets);
        let dryRunId: string | null = null;
        if (input.mode === 'apply') {
          dryRunId = input.dryRunId;
          const dryRun = dryRunId
            ? handle.prepare(`
                SELECT id, target_digest AS targetDigest
                FROM finance_attention_repair_audit
                WHERE id = ? AND connector_id = ? AND mode = 'dry-run'
              `).get(dryRunId, input.connectorId) as
                | { id: string; targetDigest: string }
                | undefined
            : undefined;
          if (!dryRun) {
            throw new FinanceAttentionRepairError(
              'repair_dry_run_not_found',
              'A completed dry-run for this connector is required',
              409,
            );
          }
          assertNoInFlightDeliveries(targets);
          if (dryRun.targetDigest !== targetDigest) {
            throw new FinanceAttentionRepairError(
              'repair_scope_changed',
              'Repair scope changed after dry-run; run a new dry-run',
              409,
            );
          }
        }

        if (input.mode === 'apply') applyRepairTargets(handle, targets, input.now, input.runId);
        insertRepairAudit(handle, {
          id: input.runId,
          connectorId: input.connectorId,
          mode: input.mode,
          actorType: input.actorType,
          idempotencyKey: input.idempotencyKey,
          dryRunId,
          targetDigest,
          counts,
          now: input.now,
        });

        return {
          runId: input.runId,
          mode: input.mode,
          connectorId: input.connectorId,
          connectorEnabled: connector.enabled,
          reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
          targetDigest,
          counts,
          dryRunId,
          applied: input.mode === 'apply',
          replayed: false,
          completedAt: input.now,
        };
      }).immediate();
    },
  };
}
