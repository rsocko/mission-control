import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  connectorConfigs,
  financeConnectionOutages,
  myDayExclusions,
  myDayItems,
  notificationActions,
  notifications,
  tasks,
} from '@/db/schema';
import type { ConnectorConfig } from '@/types';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
} from '@/lib/notifications/service';
import { syncFinanceProviderPresentation } from '@/db/persistence/sqlite-finance-insight-notification-lifecycle';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import { resolveTyrionReconnectUrl } from '@/lib/finance/tyrion-reconnect';
import { isConnectorSyncQuarantinedAsync } from '@/lib/sync/control-state';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
  type MonarchBridgeHealth,
} from './client';
import { financeConnectorConfigFromRow } from './config';
import type {
  FinanceConnectionRecoveryStatus,
  FinanceConnectionRecoveryView,
} from './recovery-contract';

export const FINANCE_CONNECTION_NOTIFICATION_AFTER_MS = 15 * 60 * 1_000;
export const FINANCE_CONNECTION_TASK_AFTER_MS = 4 * 60 * 60 * 1_000;
export const FINANCE_RECOVERY_SYNC_DAYS = 30;

type OutageRow = typeof financeConnectionOutages.$inferSelect;
type OutageStatus = OutageRow['status'];
type OutageAuthState = OutageRow['authState'];

export type FinanceConnectionObservation =
  | { kind: 'health'; health: MonarchBridgeHealth }
  | { kind: 'unavailable'; errorCode: string };

export interface FinanceConnectionReconcileResult {
  status: OutageStatus | 'healthy';
  notificationCreated: boolean;
  taskCreated: boolean;
  recovered: boolean;
}

function episodeId(connectorId: string, startedAt: string): string {
  return createHash('sha256')
    .update(`${connectorId}\0${startedAt}`)
    .digest('hex')
    .slice(0, 32);
}

function outageSourceId(row: Pick<OutageRow, 'connectorId' | 'episodeId'>): string {
  return `finance-connection:${row.connectorId}:${row.episodeId}`;
}

function outageNotificationId(row: Pick<OutageRow, 'connectorId' | 'episodeId'>): string {
  return `finance-connection-notification-${row.episodeId}`;
}

function outageTaskId(row: Pick<OutageRow, 'connectorId' | 'episodeId'>): string {
  return `finance-connection-task-${row.episodeId}`;
}

function isStrictlyHealthy(health: MonarchBridgeHealth): boolean {
  return health.status === 'ok'
    && health.mode === 'live'
    && health.reachable
    && health.authenticated
    && health.authState === 'connected';
}

function observationAuthState(observation: FinanceConnectionObservation): OutageAuthState {
  if (observation.kind === 'unavailable') return 'unavailable';
  return observation.health.authState;
}

function isAuthenticationExpired(observation: FinanceConnectionObservation): boolean {
  return observation.kind === 'health'
    && (
      observation.health.authState === 'expired'
      || observation.health.authState === 'unauthenticated'
      || !observation.health.authenticated
    );
}

function desiredStatus(
  row: Pick<OutageRow, 'status' | 'startedAt'>,
  observation: FinanceConnectionObservation,
  now: Date,
): OutageStatus {
  if (observation.kind === 'health' && isStrictlyHealthy(observation.health)) {
    return 'recovery_pending';
  }
  if (isAuthenticationExpired(observation) || row.status === 'authentication_expired') {
    return 'authentication_expired';
  }
  return now.getTime() - Date.parse(row.startedAt) >= FINANCE_CONNECTION_NOTIFICATION_AFTER_MS
    ? 'degraded'
    : 'transient';
}

function notificationType(status: OutageStatus): 'connectorDegraded' | 'connectorAuthenticationExpired' {
  return status === 'authentication_expired'
    ? 'connectorAuthenticationExpired'
    : 'connectorDegraded';
}

function notificationCopy(status: OutageStatus) {
  if (status === 'authentication_expired') {
    return {
      title: 'Reconnect Monarch',
      body: 'Monarch authentication has expired. Finance data is stale and scheduled sync is blocked until you reconnect in Tyrion.',
      level: 'urgent' as const,
    };
  }
  return {
    title: 'Monarch connection needs attention',
    body: 'Mission Control cannot refresh Monarch data. Finance data is stale while the Tyrion connection remains degraded.',
    level: 'action_needed' as const,
  };
}

function notificationMetadata(row: OutageRow, status: OutageStatus, now: Date) {
  return {
    notificationType: notificationType(status),
    financeConnectionRecovery: {
      contractVersion: '1.0',
      outageEpisodeId: row.episodeId,
      connectorRef: row.connectorId,
      status,
      authState: row.authState,
      startedAt: row.startedAt,
      observedAt: now.toISOString(),
      staleData: true,
    },
  };
}

function createOrUpdateNotification(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  row: OutageRow,
  now: Date,
): { created: boolean; hasPendingDelivery: boolean } {
  const copy = notificationCopy(row.status);
  const sourceId = outageSourceId(row);
  const [result] = createNotificationsInTransaction(transaction, [{
    id: outageNotificationId(row),
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: row.connectorId,
    title: copy.title,
    body: copy.body,
    level: copy.level,
    category: 'finance',
    templateKey: notificationType(row.status),
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt: now.toISOString(),
    sourceActivityKey: `${row.episodeId}:${notificationType(row.status)}`,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: row.startedAt,
    sortAt: now.toISOString(),
    groupKey: `finance-connection:${row.connectorId}`,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-connection-outage',
    relatedEntityId: row.episodeId,
    navigationTarget: '/settings/connectors',
    isActionable: true,
    occurrenceKey: `${row.episodeId}:${notificationType(row.status)}`,
    metadata: notificationMetadata(row, row.status, now),
  }], { now, wakeDispatcher: false });
  syncFinanceProviderPresentation(transaction, [result]);
  return {
    created: result.created,
    hasPendingDelivery: result.deliveryEvents.some((event) => event.status === 'pending'),
  };
}

function createTaskAndMyDay(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  row: OutageRow,
  attentionStatus: 'degraded' | 'authentication_expired',
  now: Date,
): boolean {
  const taskId = outageTaskId(row);
  const sourceId = outageSourceId(row);
  const copy = notificationCopy(attentionStatus);
  const recoveryPending = row.status === 'recovery_pending';
  const inserted = transaction.insert(tasks).values({
    id: taskId,
    sourceId,
    connectorType: 'mission-control',
    connectorInstanceId: 'mission-control',
    title: recoveryPending ? 'Verify Monarch recovery' : 'Reconnect Monarch',
    description: recoveryPending
      ? 'Monarch is connected, but Finance data remains stale until Mission Control verifies a bounded refresh. Open Finance settings and select Verify recovery.'
      : `${copy.body} Open Finance settings to reconnect and verify a bounded refresh.`,
    status: 'todo',
    localDisposition: 'active',
    priority: attentionStatus === 'authentication_expired' ? 'critical' : 'high',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
    sourceListId: 'local',
    sourceListName: 'Local',
    metadata: {
      financeConnectionRecovery: {
        contractVersion: '1.0',
        outageEpisodeId: row.episodeId,
        connectorRef: row.connectorId,
        status: attentionStatus,
        startedAt: row.startedAt,
        staleData: true,
      },
    },
    syncStatus: 'synced',
  }).onConflictDoNothing({
    target: [tasks.sourceId, tasks.connectorInstanceId],
  }).run();

  const date = formatDateInLocalTimezone(now);
  const excluded = transaction.select({ id: myDayExclusions.id })
    .from(myDayExclusions)
    .where(and(
      eq(myDayExclusions.taskId, taskId),
      eq(myDayExclusions.date, date),
    ))
    .get();
  if (!excluded) {
    const existingDayItem = transaction.select({ id: myDayItems.id })
      .from(myDayItems)
      .where(and(eq(myDayItems.taskId, taskId), eq(myDayItems.date, date)))
      .get();
    if (!existingDayItem) {
      const maxOrder = transaction.select().from(myDayItems)
        .where(eq(myDayItems.date, date))
        .all()
        .reduce((maximum, item) => Math.max(maximum, item.order), 0);
      transaction.insert(myDayItems).values({
        id: `finance-connection-myday-${row.episodeId}`,
        taskId,
        date,
        addedAt: now.toISOString(),
        isAutoIncluded: true,
        order: maxOrder + 1,
      }).run();
    }
  }

  const notification = transaction.select().from(notifications)
    .where(eq(notifications.sourceId, sourceId))
    .get();
  if (notification) {
    transaction.update(notifications).set({
      state: notification.disposition === 'dismissed' ? 'dismissed' : 'resolved',
      sourceState: 'resolved',
      sourceResolvedAt: notification.sourceResolvedAt ?? now.toISOString(),
      autoResolveReason: 'promoted_to_task',
      relatedTaskId: taskId,
      isActionable: false,
      primaryActionId: null,
      lastSourceSyncedAt: now.toISOString(),
    }).where(eq(notifications.id, notification.id)).run();
    transaction.delete(notificationActions)
      .where(eq(notificationActions.notificationId, notification.id))
      .run();
  }
  return inserted.changes > 0;
}

function settleEpisode(
  transaction: Parameters<typeof createNotificationsInTransaction>[0],
  row: OutageRow,
  now: Date,
): void {
  const sourceId = outageSourceId(row);
  const notification = transaction.select().from(notifications)
    .where(eq(notifications.sourceId, sourceId))
    .get();
  if (notification) {
    transaction.update(notifications).set({
      state: notification.disposition === 'dismissed' ? 'dismissed' : 'resolved',
      sourceState: 'resolved',
      sourceResolvedAt: notification.sourceResolvedAt ?? now.toISOString(),
      autoResolveReason: 'connection_recovered',
      isActionable: false,
      primaryActionId: null,
      lastSourceSyncedAt: now.toISOString(),
    }).where(eq(notifications.id, notification.id)).run();
    transaction.delete(notificationActions)
      .where(eq(notificationActions.notificationId, notification.id))
      .run();
  }
  const taskId = outageTaskId(row);
  const task = transaction.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task && task.status !== 'done' && task.status !== 'cancelled') {
    transaction.update(tasks).set({
      status: 'done',
      statusReason: 'completed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastSyncedAt: now.toISOString(),
    }).where(eq(tasks.id, taskId)).run();
  }
  transaction.delete(myDayItems).where(eq(myDayItems.taskId, taskId)).run();
  transaction.update(financeConnectionOutages).set({
    status: 'recovered',
    authState: 'connected',
    lastObservedAt: now.toISOString(),
    recoveredAt: now.toISOString(),
    lastErrorCode: null,
    updatedAt: now.toISOString(),
  }).where(eq(financeConnectionOutages.connectorId, row.connectorId)).run();
}

export function reconcileFinanceConnectionObservation(input: {
  connectorId: string;
  observation: FinanceConnectionObservation;
  now?: Date;
}): FinanceConnectionReconcileResult {
  const now = input.now ?? new Date();
  let hasPendingDelivery = false;
  const result = runTransaction((transaction) => {
    const existing = transaction.select().from(financeConnectionOutages)
      .where(eq(financeConnectionOutages.connectorId, input.connectorId))
      .get();
    const healthy = input.observation.kind === 'health'
      && isStrictlyHealthy(input.observation.health);
    if (!existing || existing.status === 'recovered') {
      if (healthy) {
        return {
          status: 'healthy' as const,
          notificationCreated: false,
          taskCreated: false,
          recovered: false,
        };
      }
      const startedAt = now.toISOString();
      const newEpisode = {
        connectorId: input.connectorId,
        episodeId: episodeId(input.connectorId, startedAt),
        status: isAuthenticationExpired(input.observation)
          ? 'authentication_expired' as const
          : 'transient' as const,
        authState: observationAuthState(input.observation),
        startedAt,
        lastObservedAt: startedAt,
        notificationCreatedAt: null,
        taskCreatedAt: null,
        recoverySyncSucceededAt: null,
        recoveredAt: null,
        lastErrorCode: input.observation.kind === 'unavailable'
          ? input.observation.errorCode
          : null,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      if (existing) {
        transaction.update(financeConnectionOutages)
          .set(newEpisode)
          .where(eq(financeConnectionOutages.connectorId, input.connectorId))
          .run();
      } else {
        transaction.insert(financeConnectionOutages).values(newEpisode).run();
      }
    }

    let row = transaction.select().from(financeConnectionOutages)
      .where(eq(financeConnectionOutages.connectorId, input.connectorId))
      .get()!;
    const status = desiredStatus(row, input.observation, now);
    transaction.update(financeConnectionOutages).set({
      status,
      authState: observationAuthState(input.observation),
      lastObservedAt: now.toISOString(),
      lastErrorCode: input.observation.kind === 'unavailable'
        ? input.observation.errorCode
        : null,
      updatedAt: now.toISOString(),
    }).where(eq(financeConnectionOutages.connectorId, input.connectorId)).run();
    row = {
      ...row,
      status,
      authState: observationAuthState(input.observation),
      lastObservedAt: now.toISOString(),
      lastErrorCode: input.observation.kind === 'unavailable'
        ? input.observation.errorCode
        : null,
      updatedAt: now.toISOString(),
    };

    let notificationCreated = false;
    let taskCreated = false;
    const elapsed = now.getTime() - Date.parse(row.startedAt);
    const notificationEligible = row.status !== 'recovery_pending'
      && (
        row.status === 'authentication_expired'
        || elapsed >= FINANCE_CONNECTION_NOTIFICATION_AFTER_MS
      );
    if (notificationEligible && !row.taskCreatedAt) {
      const notificationResult = createOrUpdateNotification(transaction, row, now);
      notificationCreated = notificationResult.created;
      hasPendingDelivery ||= notificationResult.hasPendingDelivery;
      if (!row.notificationCreatedAt) {
        row = { ...row, notificationCreatedAt: now.toISOString() };
        transaction.update(financeConnectionOutages).set({
          notificationCreatedAt: row.notificationCreatedAt,
          updatedAt: now.toISOString(),
        }).where(eq(financeConnectionOutages.connectorId, input.connectorId)).run();
      }
    }
    if (elapsed >= FINANCE_CONNECTION_TASK_AFTER_MS && !row.taskCreatedAt) {
      const currentNotification = transaction.select({ metadata: notifications.metadata })
        .from(notifications)
        .where(eq(notifications.sourceId, outageSourceId(row)))
        .get();
      const previousNotificationType = (
        currentNotification?.metadata
        && typeof currentNotification.metadata === 'object'
        && !Array.isArray(currentNotification.metadata)
      )
        ? (currentNotification.metadata as Record<string, unknown>).notificationType
        : null;
      const attentionStatus = (
        previousNotificationType === 'connectorAuthenticationExpired'
      )
        ? 'authentication_expired'
        : row.status === 'authentication_expired'
          ? 'authentication_expired'
          : 'degraded';
      taskCreated = createTaskAndMyDay(transaction, row, attentionStatus, now);
      transaction.update(financeConnectionOutages).set({
        taskCreatedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).where(eq(financeConnectionOutages.connectorId, input.connectorId)).run();
    }
    return {
      status,
      notificationCreated,
      taskCreated,
      recovered: false,
    };
  });
  if (hasPendingDelivery) wakeNotificationDeliveryDispatcher();
  return result;
}

export async function probeFinanceConnection(
  config: ConnectorConfig,
  now = new Date(),
): Promise<FinanceConnectionReconcileResult> {
  try {
    const health = await new MonarchBridgeClient(config).getHealth();
    return reconcileFinanceConnectionObservation({
      connectorId: config.id,
      observation: { kind: 'health', health },
      now,
    });
  } catch (error) {
    return reconcileFinanceConnectionObservation({
      connectorId: config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
  }
}

export async function probeAllFinanceConnections(now = new Date()): Promise<void> {
  const rows = await db.select().from(connectorConfigs).where(and(
    inArray(connectorConfigs.type, [...FINANCE_PROVIDER_ALIASES]),
    eq(connectorConfigs.enabled, true),
    isNull(connectorConfigs.deletedAt),
  ));
  await Promise.all(rows.map((row) => (
    probeFinanceConnection(financeConnectorConfigFromRow(row), now)
  )));
}

export async function verifyFinanceConnectionRecovery(input: {
  config: ConnectorConfig;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ recovered: boolean; reason?: string }> {
  const now = input.now ?? new Date();
  if (await isConnectorSyncQuarantinedAsync(input.config.id)) {
    return { recovered: false, reason: 'connector_sync_quarantined' };
  }
  const client = new MonarchBridgeClient(input.config);
  let health: MonarchBridgeHealth;
  try {
    health = await client.getHealth(input.signal);
  } catch (error) {
    reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
    return { recovered: false, reason: 'health_unavailable' };
  }
  if (!isStrictlyHealthy(health)) {
    reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: { kind: 'health', health },
      now,
    });
    return { recovered: false, reason: 'authentication_not_connected' };
  }

  const existing = await db.select().from(financeConnectionOutages)
    .where(eq(financeConnectionOutages.connectorId, input.config.id))
    .limit(1);
  if (!existing[0] || existing[0].status === 'recovered') {
    return { recovered: true };
  }

  reconcileFinanceConnectionObservation({
    connectorId: input.config.id,
    observation: { kind: 'health', health },
    now,
  });
  try {
    await client.runBoundedSync(FINANCE_RECOVERY_SYNC_DAYS, input.signal);
  } catch (error) {
    await db.update(financeConnectionOutages).set({
      lastErrorCode: error instanceof MonarchBridgeError ? error.code : 'bounded_sync_failed',
      updatedAt: now.toISOString(),
    }).where(eq(financeConnectionOutages.connectorId, input.config.id));
    return { recovered: false, reason: 'bounded_sync_failed' };
  }
  await db.update(financeConnectionOutages).set({
    recoverySyncSucceededAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }).where(eq(financeConnectionOutages.connectorId, input.config.id));

  let confirmation: MonarchBridgeHealth;
  try {
    confirmation = await client.getHealth(input.signal);
  } catch (error) {
    reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: {
        kind: 'unavailable',
        errorCode: error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable',
      },
      now,
    });
    return { recovered: false, reason: 'confirmation_health_unavailable' };
  }
  if (!isStrictlyHealthy(confirmation)) {
    reconcileFinanceConnectionObservation({
      connectorId: input.config.id,
      observation: { kind: 'health', health: confirmation },
      now,
    });
    return { recovered: false, reason: 'confirmation_not_connected' };
  }
  runTransaction((transaction) => {
    const row = transaction.select().from(financeConnectionOutages)
      .where(eq(financeConnectionOutages.connectorId, input.config.id))
      .get();
    if (row && row.status !== 'recovered') settleEpisode(transaction, row, now);
  });
  return { recovered: true };
}

export function getFinanceConnectionRecoveryView(
  connectorId: string,
): FinanceConnectionRecoveryView | null {
  const row = db.select().from(financeConnectionOutages)
    .where(eq(financeConnectionOutages.connectorId, connectorId))
    .get();
  if (!row || row.status === 'recovered') return null;
  let reconnectUrl: string | null = null;
  try {
    reconnectUrl = resolveTyrionReconnectUrl();
  } catch {
    reconnectUrl = null;
  }
  const status = row.status as FinanceConnectionRecoveryStatus;
  const message = status === 'authentication_expired'
    ? 'Monarch authentication is disconnected. Finance data is stale until Tyrion reconnects and Mission Control verifies a bounded refresh.'
    : status === 'recovery_pending'
      ? 'Monarch is connected, but Finance data remains stale until Mission Control completes and verifies a bounded refresh.'
      : status === 'transient'
        ? 'Monarch health is temporarily unavailable. Finance data may be stale while Mission Control waits for the transient window to settle.'
        : 'The Monarch connection is degraded. Finance data is stale until Tyrion reconnects and Mission Control verifies a bounded refresh.';
  return {
    active: true,
    status,
    authState: row.authState,
    startedAt: row.startedAt,
    lastObservedAt: row.lastObservedAt,
    notificationCreatedAt: row.notificationCreatedAt,
    taskCreatedAt: row.taskCreatedAt,
    staleData: true,
    message,
    reconnectUrl,
    canVerifyRecovery: row.status === 'recovery_pending',
  };
}
