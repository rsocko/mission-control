import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, ne } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  financeConnectionOutages,
  myDayExclusions,
  myDayItems,
  notificationActions,
  notifications,
  tasks,
} from '@/db/schema';
import {
  createNotificationsInTransaction,
} from '@/lib/notifications/service';
import { syncFinanceProviderPresentation } from './sqlite-finance-insight-notification-lifecycle';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import { financeConnectorConfigFromRow } from '@/lib/connectors/monarch-money/config';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import {
  desiredFinanceConnectionStatus,
  financeConnectionEpisodeId,
  financeConnectionNotificationCopy,
  financeConnectionNotificationId,
  financeConnectionNotificationMetadata,
  financeConnectionNotificationType,
  financeConnectionRecoveryView,
  financeConnectionSourceId,
  financeConnectionTaskId,
  financeObservationAuthState,
  FINANCE_CONNECTION_NOTIFICATION_AFTER_MS,
  FINANCE_CONNECTION_TASK_AFTER_MS,
  isFinanceAuthenticationExpired,
  isStrictlyHealthyFinanceObservation,
  type FinanceConnectionOutage,
  type FinanceConnectionRecoveryPersistence,
} from './finance-recovery';

type SqliteDatabase = Database.Database;
type DrizzleDatabase = BetterSQLite3Database<typeof schema>;
type Transaction = Parameters<typeof createNotificationsInTransaction>[0];

function readOutage(
  database: Transaction,
  connectorId: string,
): FinanceConnectionOutage | null {
  return database.select().from(financeConnectionOutages)
    .where(eq(financeConnectionOutages.connectorId, connectorId))
    .get() ?? null;
}

function createOrUpdateNotification(
  transaction: Transaction,
  row: FinanceConnectionOutage,
  now: Date,
): { created: boolean; pendingDelivery: boolean } {
  const copy = financeConnectionNotificationCopy(row.status);
  const sourceId = financeConnectionSourceId(row);
  const [result] = createNotificationsInTransaction(transaction, [{
    id: financeConnectionNotificationId(row),
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: row.connectorId,
    title: copy.title,
    body: copy.body,
    level: copy.level,
    category: 'finance',
    templateKey: financeConnectionNotificationType(row.status),
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt: now.toISOString(),
    sourceActivityKey: `${row.episodeId}:${financeConnectionNotificationType(row.status)}`,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: row.startedAt,
    sortAt: now.toISOString(),
    groupKey: `finance-connection:${row.connectorId}`,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-connection-outage',
    relatedEntityId: row.episodeId,
    navigationTarget: '/settings/connectors',
    isActionable: true,
    occurrenceKey: `${row.episodeId}:${financeConnectionNotificationType(row.status)}`,
    metadata: financeConnectionNotificationMetadata(row, row.status, now),
  }], { now, wakeDispatcher: false });
  syncFinanceProviderPresentation(transaction, [result]);
  return {
    created: result.created,
    pendingDelivery: result.deliveryEvents.some((event) => event.status === 'pending'),
  };
}

function createTaskAndMyDay(
  transaction: Transaction,
  row: FinanceConnectionOutage,
  attentionStatus: 'degraded' | 'authentication_expired',
  now: Date,
): boolean {
  const taskId = financeConnectionTaskId(row);
  const sourceId = financeConnectionSourceId(row);
  const copy = financeConnectionNotificationCopy(attentionStatus);
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
    const existing = transaction.select({ id: myDayItems.id })
      .from(myDayItems)
      .where(and(eq(myDayItems.taskId, taskId), eq(myDayItems.date, date)))
      .get();
    if (!existing) {
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

function settle(
  transaction: Transaction,
  row: FinanceConnectionOutage,
  now: Date,
): void {
  const notification = transaction.select().from(notifications)
    .where(eq(notifications.sourceId, financeConnectionSourceId(row)))
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
  const taskId = financeConnectionTaskId(row);
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
  }).where(and(
    eq(financeConnectionOutages.connectorId, row.connectorId),
    eq(financeConnectionOutages.episodeId, row.episodeId),
  )).run();
}

export function createSqliteFinanceConnectionRecoveryPersistence(
  sqlite: SqliteDatabase,
  database: DrizzleDatabase,
): FinanceConnectionRecoveryPersistence {
  return {
    async reconcileObservation(input) {
      return sqlite.transaction(() => {
        const nowIso = input.now.toISOString();
        let existing = readOutage(database, input.connectorId);
        const healthy = isStrictlyHealthyFinanceObservation(input.observation);
        if (!existing || existing.status === 'recovered') {
          if (healthy) {
            return {
              status: 'healthy' as const,
              notificationCreated: false,
              taskCreated: false,
              recovered: false,
              pendingDelivery: false,
            };
          }
          const episode: FinanceConnectionOutage = {
            connectorId: input.connectorId,
            episodeId: financeConnectionEpisodeId(input.connectorId, nowIso),
            status: isFinanceAuthenticationExpired(input.observation)
              ? 'authentication_expired'
              : 'transient',
            authState: financeObservationAuthState(input.observation),
            startedAt: nowIso,
            lastObservedAt: nowIso,
            notificationCreatedAt: null,
            taskCreatedAt: null,
            recoverySyncSucceededAt: null,
            recoveredAt: null,
            lastErrorCode: input.observation.kind === 'unavailable'
              ? input.observation.errorCode
              : null,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          if (existing) {
            database.update(financeConnectionOutages).set(episode)
              .where(eq(financeConnectionOutages.connectorId, input.connectorId))
              .run();
          } else {
            database.insert(financeConnectionOutages).values(episode).run();
          }
          existing = episode;
        }

        const status = desiredFinanceConnectionStatus(existing, input.observation, input.now);
        let row: FinanceConnectionOutage = {
          ...existing,
          status,
          authState: financeObservationAuthState(input.observation),
          lastObservedAt: nowIso,
          lastErrorCode: input.observation.kind === 'unavailable'
            ? input.observation.errorCode
            : null,
          updatedAt: nowIso,
        };
        database.update(financeConnectionOutages).set({
          status: row.status,
          authState: row.authState,
          lastObservedAt: row.lastObservedAt,
          lastErrorCode: row.lastErrorCode,
          updatedAt: row.updatedAt,
        }).where(and(
          eq(financeConnectionOutages.connectorId, input.connectorId),
          eq(financeConnectionOutages.episodeId, row.episodeId),
        )).run();

        let notificationCreated = false;
        let taskCreated = false;
        let pendingDelivery = false;
        const elapsed = input.now.getTime() - Date.parse(row.startedAt);
        const notificationEligible = row.status !== 'recovery_pending'
          && (
            row.status === 'authentication_expired'
            || elapsed >= FINANCE_CONNECTION_NOTIFICATION_AFTER_MS
          );
        if (notificationEligible && !row.taskCreatedAt) {
          const notificationResult = createOrUpdateNotification(database, row, input.now);
          notificationCreated = notificationResult.created;
          pendingDelivery = notificationResult.pendingDelivery;
          if (!row.notificationCreatedAt) {
            row = { ...row, notificationCreatedAt: nowIso };
            database.update(financeConnectionOutages).set({
              notificationCreatedAt: nowIso,
              updatedAt: nowIso,
            }).where(and(
              eq(financeConnectionOutages.connectorId, input.connectorId),
              eq(financeConnectionOutages.episodeId, row.episodeId),
            )).run();
          }
        }
        if (elapsed >= FINANCE_CONNECTION_TASK_AFTER_MS && !row.taskCreatedAt) {
          const currentNotification = database.select({ metadata: notifications.metadata })
            .from(notifications)
            .where(eq(notifications.sourceId, financeConnectionSourceId(row)))
            .get();
          const metadata = currentNotification?.metadata;
          const previousNotificationType = metadata
            && typeof metadata === 'object'
            && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>).notificationType
            : null;
          const attentionStatus = previousNotificationType === 'connectorAuthenticationExpired'
            || row.status === 'authentication_expired'
            ? 'authentication_expired'
            : 'degraded';
          taskCreated = createTaskAndMyDay(database, row, attentionStatus, input.now);
          database.update(financeConnectionOutages).set({
            taskCreatedAt: nowIso,
            updatedAt: nowIso,
          }).where(and(
            eq(financeConnectionOutages.connectorId, input.connectorId),
            eq(financeConnectionOutages.episodeId, row.episodeId),
          )).run();
        }
        return {
          status,
          notificationCreated,
          taskCreated,
          recovered: false,
          pendingDelivery,
        };
      }).immediate();
    },

    async listEnabledConnectors() {
      const aliases = [...FINANCE_PROVIDER_ALIASES];
      const placeholders = aliases.map(() => '?').join(', ');
      const rows = sqlite.prepare(`
        SELECT id, type, name, enabled, sync_mode AS syncMode,
               poll_interval_minutes AS pollIntervalMinutes, capabilities,
               credentials, settings, synced_lists AS syncedLists
        FROM connector_configs
        WHERE type IN (${placeholders}) AND enabled = 1 AND deleted_at IS NULL
      `).all(...aliases);
      return rows.map((row) => financeConnectorConfigFromRow(row as never));
    },

    async getActiveEpisode(connectorId) {
      const row = readOutage(database, connectorId);
      return row?.status === 'recovered' ? null : row;
    },

    async recordBoundedSyncFailure(input) {
      return database.update(financeConnectionOutages).set({
        lastErrorCode: input.errorCode,
        updatedAt: input.now.toISOString(),
      }).where(and(
        eq(financeConnectionOutages.connectorId, input.connectorId),
        eq(financeConnectionOutages.episodeId, input.episodeId),
        ne(financeConnectionOutages.status, 'recovered'),
      )).run().changes === 1;
    },

    async recordBoundedSyncSuccess(input) {
      return database.update(financeConnectionOutages).set({
        recoverySyncSucceededAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      }).where(and(
        eq(financeConnectionOutages.connectorId, input.connectorId),
        eq(financeConnectionOutages.episodeId, input.episodeId),
        ne(financeConnectionOutages.status, 'recovered'),
      )).run().changes === 1;
    },

    async settleEpisode(input) {
      return sqlite.transaction(() => {
        const row = readOutage(database, input.connectorId);
        if (!row || row.status === 'recovered' || row.episodeId !== input.episodeId) {
          return false;
        }
        settle(database, row, input.now);
        return true;
      }).immediate();
    },

    async getView(input) {
      const row = readOutage(database, input.connectorId);
      return row ? financeConnectionRecoveryView(row, input.reconnectUrl) : null;
    },
  };
}
