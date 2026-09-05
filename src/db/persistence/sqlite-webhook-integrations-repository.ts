import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  externalAgents,
  inboundWebhooks,
  integrationConfigs,
  notificationActions,
  notificationPushRules,
  notifications,
  outboundWebhooks,
  syncLog,
  tasks,
} from '@/db/schema';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
} from '@/lib/notifications/service';
import { decodeLenientJsonObject } from './value-codecs';
import type {
  AppendInboundWebhookLogInput,
  ClaimInboundWebhookDeliveryInput,
  ConnectorWebhookConfig,
  CreateInboundWebhookAlertInput,
  CreateInboundWebhookAlertResult,
  CreateInboundWebhookInput,
  CreateOutboundWebhookInput,
  CreateWebhookNotificationInput,
  DeleteInboundWebhookOutcome,
  InboundWebhookDeliveryConfig,
  InboundWebhookLogEntry,
  InboundWebhookSummary,
  IntegrationConfigRecord,
  ListInboundWebhookLogInput,
  OutboundWebhookPatch,
  OutboundWebhookRecord,
  RecordInboundWebhookDeliveryStatsInput,
  ReleaseInboundWebhookDeliveryInput,
  SaveIntegrationConfigInput,
  SnoozeWebhookNotificationInput,
  UpdateInboundWebhookInput,
  UpdateInboundWebhookOutcome,
  UpdateIntegrationConfigSettingsInput,
  UpsertWebhookNotificationInput,
  UpsertWebhookNotificationResult,
  WebhookIntegrationsPersistence,
  WebhookNotificationAction,
  WebhookNotificationInsert,
  WebhookOpenUrlActionSync,
  WebhookSearchableNotification,
  WebhookSyncLogEntry,
  WebhookTaskIdentity,
  WebhookTaskInsert,
  WebhookTaskUpdate,
} from './webhook-integrations';

type SqliteDrizzle = BetterSQLite3Database<typeof schema>;
type SqliteTransaction = Parameters<Parameters<SqliteDrizzle['transaction']>[0]>[0];

function actionValues(notificationId: string, action: WebhookNotificationAction) {
  return {
    id: action.id,
    notificationId,
    actionType: action.actionType,
    label: action.label,
    icon: action.icon ?? null,
    variant: action.variant,
    isPrimary: action.isPrimary,
    sortOrder: action.sortOrder,
    payload: action.payload,
    opensExternal: action.opensExternal,
    createdBy: action.createdBy,
  };
}

function notificationInsertValues(input: WebhookNotificationInsert) {
  return {
    id: input.id,
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    body: input.body,
    level: input.level,
    levelRank: input.levelRank,
    category: input.category,
    templateKey: input.templateKey,
    state: input.state,
    isActionable: input.isActionable,
    primaryActionId: input.primaryActionId,
    receivedAt: input.receivedAt,
    sortAt: input.sortAt,
    expiresAt: input.expiresAt,
    relatedTaskId: input.relatedTaskId,
    metadata: input.metadata,
    presentation: input.presentation,
  };
}

function taskInsertValues(input: WebhookTaskInsert) {
  return {
    id: input.id,
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    statusReason: input.statusReason,
    dueDate: input.dueDate,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
    depth: 0,
    isChecklistItem: false,
    sourceListId: input.sourceListId,
    sourceListName: input.sourceListName,
    assignee: input.assignee,
    metadata: input.metadata,
    syncStatus: input.syncStatus,
    lastSyncedAt: input.lastSyncedAt,
  };
}

/**
 * SQLite adapter for the Layer L19 webhook configuration/delivery/log port.
 *
 * It receives the native handle and the drizzle handle from the SQLite
 * composition only. Multi-row work (secret/agent reference checks, webhook
 * deletion, replay claiming, log compaction, notification+action ingestion)
 * runs inside one immediate transaction so a concurrent delivery can never
 * observe a half-applied write.
 */
export function createSqliteWebhookIntegrationsRepository(
  sqlite: Database.Database,
  db: SqliteDrizzle,
): WebhookIntegrationsPersistence {
  function hasReferencingAgent(
    transaction: SqliteTransaction,
    webhookId: string,
  ): boolean {
    return Boolean(transaction
      .select({ id: externalAgents.id })
      .from(externalAgents)
      .where(and(
        eq(externalAgents.inboundWebhookId, webhookId),
        isNull(externalAgents.deletedAt),
      ))
      .limit(1)
      .get());
  }

  function readSearchRecord(
    transaction: SqliteTransaction,
    id: string,
  ): WebhookSearchableNotification {
    const row = transaction
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        category: notifications.category,
        connectorType: notifications.connectorType,
      })
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1)
      .get();
    if (!row) throw new Error(`Notification ${id} disappeared during ingestion`);
    return row;
  }

  function findNotificationIdBySource(
    transaction: SqliteTransaction,
    connectorType: string,
    sourceId: string,
  ): string | null {
    const row = transaction
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.connectorType, connectorType),
        eq(notifications.sourceId, sourceId),
      ))
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  function syncOpenUrlAction(
    transaction: SqliteTransaction,
    notificationId: string,
    action: WebhookOpenUrlActionSync | undefined,
  ): void {
    if (!action) return;
    transaction
      .delete(notificationActions)
      .where(and(
        eq(notificationActions.notificationId, notificationId),
        eq(notificationActions.actionType, 'open_url'),
      ))
      .run();
    if (!action.url) return;
    transaction.insert(notificationActions).values({
      id: randomUUID(),
      notificationId,
      actionType: 'open_url',
      label: action.label,
      variant: 'primary',
      isPrimary: true,
      sortOrder: 0,
      payload: { url: action.url },
      opensExternal: true,
      createdBy: 'connector',
    }).run();
  }

  return {
    inbound: {
      async list(): Promise<InboundWebhookSummary[]> {
        const rows = await db
          .select()
          .from(inboundWebhooks)
          .orderBy(desc(inboundWebhooks.createdAt), desc(inboundWebhooks.id));
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          sourceLabel: row.sourceLabel,
          enabled: row.enabled,
          defaultAction: row.defaultAction,
          fieldMappings: decodeLenientJsonObject(row.fieldMappings),
          totalReceived: row.totalReceived,
          lastReceivedAt: row.lastReceivedAt,
          lastStatus: row.lastStatus,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          hasSecret: Boolean(row.secret),
        }));
      },

      async create(input: CreateInboundWebhookInput): Promise<void> {
        await db.insert(inboundWebhooks).values({
          id: input.id,
          name: input.name,
          sourceLabel: input.sourceLabel,
          secret: input.secret,
          enabled: true,
          defaultAction: input.defaultAction,
          fieldMappings: input.fieldMappings,
          totalReceived: 0,
          lastReceivedAt: null,
          lastStatus: null,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        });
      },

      async update(input: UpdateInboundWebhookInput): Promise<UpdateInboundWebhookOutcome> {
        const { patch } = input;
        return db.transaction((transaction) => {
          if (patch.secret === null && hasReferencingAgent(transaction, input.id)) {
            return 'secret-referenced' as const;
          }
          transaction.update(inboundWebhooks)
            .set({
              ...(patch.name === undefined ? {} : { name: patch.name }),
              ...(patch.sourceLabel === undefined ? {} : { sourceLabel: patch.sourceLabel }),
              ...(patch.secret === undefined ? {} : { secret: patch.secret }),
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              ...(patch.defaultAction === undefined ? {} : { defaultAction: patch.defaultAction }),
              ...(patch.fieldMappings === undefined ? {} : { fieldMappings: patch.fieldMappings }),
              updatedAt: input.updatedAt,
            })
            .where(eq(inboundWebhooks.id, input.id))
            .run();
          return 'updated' as const;
        }, { behavior: 'immediate' });
      },

      async delete(id: string): Promise<DeleteInboundWebhookOutcome> {
        return db.transaction((transaction) => {
          if (hasReferencingAgent(transaction, id)) {
            return 'agent-referenced' as const;
          }
          transaction.delete(notificationPushRules)
            .where(eq(notificationPushRules.connectorInstanceId, id))
            .run();
          transaction.delete(inboundWebhooks).where(eq(inboundWebhooks.id, id)).run();
          return 'deleted' as const;
        }, { behavior: 'immediate' });
      },

      async listLog(input: ListInboundWebhookLogInput): Promise<InboundWebhookLogEntry[]> {
        return sqlite.prepare(`
          SELECT
            id,
            webhook_id AS webhookId,
            status,
            http_status AS httpStatus,
            created_type AS createdType,
            created_id AS createdId,
            error_message AS errorMessage,
            payload_preview AS payloadPreview,
            received_at AS receivedAt
          FROM inbound_webhook_log
          WHERE webhook_id = ?
          ORDER BY received_at DESC, id DESC
          LIMIT ?
        `).all(input.webhookId, input.limit) as InboundWebhookLogEntry[];
      },

      async appendLog(input: AppendInboundWebhookLogInput): Promise<void> {
        const { entry, compaction } = input;
        sqlite.transaction(() => {
          sqlite.prepare(`
            INSERT INTO inbound_webhook_log (
              id, webhook_id, status, http_status, created_type, created_id,
              error_message, payload_preview, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            entry.id,
            entry.webhookId,
            entry.status,
            entry.httpStatus,
            entry.createdType,
            entry.createdId,
            entry.errorMessage,
            entry.payloadPreview,
            entry.receivedAt,
          );
          if (!compaction) return;
          sqlite.prepare(`
            DELETE FROM inbound_webhook_log
            WHERE webhook_id = ? AND received_at < ?
          `).run(entry.webhookId, compaction.retentionCutoff);
          sqlite.prepare(`
            DELETE FROM inbound_webhook_log
            WHERE webhook_id = ?
              AND id NOT IN (
                SELECT id FROM inbound_webhook_log
                WHERE webhook_id = ?
                ORDER BY received_at DESC, id DESC
                LIMIT ?
              )
          `).run(entry.webhookId, entry.webhookId, compaction.retainLatest);
        }).immediate();
      },

      async findForDelivery(id: string): Promise<InboundWebhookDeliveryConfig | null> {
        const [row] = await db
          .select({
            id: inboundWebhooks.id,
            name: inboundWebhooks.name,
            sourceLabel: inboundWebhooks.sourceLabel,
            secret: inboundWebhooks.secret,
            enabled: inboundWebhooks.enabled,
            defaultAction: inboundWebhooks.defaultAction,
            fieldMappings: inboundWebhooks.fieldMappings,
          })
          .from(inboundWebhooks)
          .where(eq(inboundWebhooks.id, id))
          .limit(1);
        return row
          ? { ...row, fieldMappings: decodeLenientJsonObject(row.fieldMappings) }
          : null;
      },

      async claimDelivery(input: ClaimInboundWebhookDeliveryInput): Promise<boolean> {
        return sqlite.transaction(() => {
          if (input.sweepExpiredBefore) {
            sqlite.prepare('DELETE FROM inbound_webhook_replays WHERE expires_at <= ?')
              .run(input.sweepExpiredBefore);
          }
          sqlite.prepare(`
            DELETE FROM inbound_webhook_replays
            WHERE webhook_id = ? AND delivery_key = ? AND expires_at <= ?
          `).run(input.webhookId, input.deliveryKey, input.receivedAt);
          const result = sqlite.prepare(`
            INSERT OR IGNORE INTO inbound_webhook_replays (
              id, webhook_id, delivery_key, received_at, expires_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            input.id,
            input.webhookId,
            input.deliveryKey,
            input.receivedAt,
            input.expiresAt,
          );
          return result.changes === 1;
        }).immediate();
      },

      async releaseDelivery(input: ReleaseInboundWebhookDeliveryInput): Promise<void> {
        sqlite.prepare(`
          DELETE FROM inbound_webhook_replays
          WHERE webhook_id = ? AND delivery_key = ?
        `).run(input.webhookId, input.deliveryKey);
      },

      async recordDeliveryStats(
        input: RecordInboundWebhookDeliveryStatsInput,
      ): Promise<void> {
        await db.update(inboundWebhooks).set({
          totalReceived: sql`${inboundWebhooks.totalReceived} + 1`,
          lastReceivedAt: input.receivedAt,
          lastStatus: input.lastStatus,
          updatedAt: input.updatedAt,
        }).where(eq(inboundWebhooks.id, input.webhookId));
      },

      async createTask(input: WebhookTaskInsert): Promise<void> {
        await db.insert(tasks).values(taskInsertValues(input));
      },

      async createAlert(
        input: CreateInboundWebhookAlertInput,
      ): Promise<CreateInboundWebhookAlertResult> {
        const { notification, action } = input;
        return db.transaction((transaction) => {
          const [result] = createNotificationsInTransaction(transaction, [{
            id: notification.id,
            sourceId: notification.sourceId,
            connectorType: notification.connectorType,
            connectorInstanceId: notification.connectorInstanceId,
            title: notification.title,
            body: notification.body,
            level: notification.level,
            category: notification.category,
            templateKey: notification.templateKey,
            state: notification.state,
            isActionable: notification.isActionable,
            primaryActionId: notification.primaryActionId,
            receivedAt: notification.receivedAt,
            sortAt: notification.sortAt,
            expiresAt: notification.expiresAt,
            metadata: notification.metadata,
            presentation: notification.presentation,
          } as CreateNotificationInput]);

          if (result.created && action) {
            transaction.insert(notificationActions)
              .values(actionValues(notification.id, action))
              .run();
          }
          return {
            id: result.notification.id,
            created: result.created,
            pendingDelivery: result.deliveryEvent?.status === 'pending',
          };
        });
      },
    },

    outbound: {
      async list(): Promise<OutboundWebhookRecord[]> {
        return db
          .select()
          .from(outboundWebhooks)
          .orderBy(desc(outboundWebhooks.createdAt), desc(outboundWebhooks.id));
      },

      async find(id: string): Promise<OutboundWebhookRecord | null> {
        const [row] = await db
          .select()
          .from(outboundWebhooks)
          .where(eq(outboundWebhooks.id, id))
          .limit(1);
        return row ?? null;
      },

      async create(input: CreateOutboundWebhookInput): Promise<void> {
        await db.insert(outboundWebhooks).values({
          id: input.id,
          name: input.name,
          url: input.url,
          secret: input.secret,
          eventTypes: [...input.eventTypes],
          enabled: true,
          createdAt: input.createdAt,
        });
      },

      async update(id: string, patch: OutboundWebhookPatch): Promise<void> {
        await db.update(outboundWebhooks)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.url === undefined ? {} : { url: patch.url }),
            ...(patch.secret === undefined ? {} : { secret: patch.secret }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.eventTypes === undefined
              ? {}
              : { eventTypes: [...patch.eventTypes] }),
          })
          .where(eq(outboundWebhooks.id, id));
      },

      async delete(id: string): Promise<void> {
        await db.delete(outboundWebhooks).where(eq(outboundWebhooks.id, id));
      },
    },

    integrations: {
      async find(id: string): Promise<IntegrationConfigRecord | null> {
        const [row] = await db
          .select()
          .from(integrationConfigs)
          .where(eq(integrationConfigs.id, id))
          .limit(1);
        return row
          ? { ...row, settings: decodeLenientJsonObject(row.settings) }
          : null;
      },

      async save(input: SaveIntegrationConfigInput): Promise<void> {
        await db
          .insert(integrationConfigs)
          .values({
            id: input.id,
            type: input.type,
            name: input.name,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            enabled: input.enabled,
            settings: input.settings,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .onConflictDoUpdate({
            target: integrationConfigs.id,
            set: {
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
              enabled: input.enabled,
              settings: input.settings,
              updatedAt: input.updatedAt,
            },
          });
      },

      async updateSettings(input: UpdateIntegrationConfigSettingsInput): Promise<void> {
        await db
          .update(integrationConfigs)
          .set({ settings: input.settings, updatedAt: input.updatedAt })
          .where(eq(integrationConfigs.id, input.id));
      },
    },

    ingest: {
      async findConnector(connectorId: string): Promise<ConnectorWebhookConfig | null> {
        const [row] = await db
          .select({
            id: connectorConfigs.id,
            type: connectorConfigs.type,
            enabled: connectorConfigs.enabled,
            settings: connectorConfigs.settings,
          })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.id, connectorId))
          .limit(1);
        return row
          ? { ...row, settings: decodeLenientJsonObject(row.settings) }
          : null;
      },

      async findTaskBySourceId(sourceId: string): Promise<WebhookTaskIdentity | null> {
        const [row] = await db
          .select({
            id: tasks.id,
            status: tasks.status,
            completedAt: tasks.completedAt,
            statusReason: tasks.statusReason,
          })
          .from(tasks)
          .where(eq(tasks.sourceId, sourceId))
          .limit(1);
        return row ?? null;
      },

      async createTask(input: WebhookTaskInsert): Promise<void> {
        await db.insert(tasks).values(taskInsertValues(input));
      },

      async updateTask(id: string, values: WebhookTaskUpdate): Promise<void> {
        if (Object.values(values).every((value) => value === undefined)) return;
        await db.update(tasks).set(values).where(eq(tasks.id, id));
      },

      async createNotification(
        input: CreateWebhookNotificationInput,
      ): Promise<WebhookSearchableNotification> {
        const { notification, actions, openUrlAction } = input;
        return db.transaction((transaction) => {
          transaction.insert(notifications)
            .values(notificationInsertValues(notification))
            .run();
          for (const action of actions ?? []) {
            transaction.insert(notificationActions)
              .values(actionValues(notification.id, action))
              .run();
          }
          syncOpenUrlAction(transaction, notification.id, openUrlAction);
          return readSearchRecord(transaction, notification.id);
        }, { behavior: 'immediate' });
      },

      async upsertNotificationBySource(
        input: UpsertWebhookNotificationInput,
      ): Promise<UpsertWebhookNotificationResult> {
        const { match, insert, update, openUrlAction } = input;
        return db.transaction((transaction) => {
          const existingId = findNotificationIdBySource(
            transaction,
            match.connectorType,
            match.sourceId,
          );

          if (existingId) {
            transaction.update(notifications)
              .set(update)
              .where(eq(notifications.id, existingId))
              .run();
            syncOpenUrlAction(transaction, existingId, openUrlAction);
            return {
              id: existingId,
              created: false,
              search: readSearchRecord(transaction, existingId),
            };
          }

          transaction.insert(notifications)
            .values(notificationInsertValues(insert))
            .run();
          syncOpenUrlAction(transaction, insert.id, openUrlAction);
          return {
            id: insert.id,
            created: true,
            search: readSearchRecord(transaction, insert.id),
          };
        }, { behavior: 'immediate' });
      },

      async deleteNotificationBySource(
        match: { connectorType: string; sourceId: string },
      ): Promise<string | null> {
        return db.transaction((transaction) => {
          const existingId = findNotificationIdBySource(
            transaction,
            match.connectorType,
            match.sourceId,
          );
          if (!existingId) return null;
          transaction.delete(notificationActions)
            .where(eq(notificationActions.notificationId, existingId))
            .run();
          transaction.delete(notifications)
            .where(eq(notifications.id, existingId))
            .run();
          return existingId;
        }, { behavior: 'immediate' });
      },

      async snoozeNotificationBySource(
        input: SnoozeWebhookNotificationInput,
      ): Promise<string | null> {
        return db.transaction((transaction) => {
          const existingId = findNotificationIdBySource(
            transaction,
            input.connectorType,
            input.sourceId,
          );
          if (!existingId) return null;
          transaction.update(notifications).set({
            snoozedUntil: input.snoozedUntil,
            expiresAt: input.snoozedUntil,
            metadata: input.metadata,
          }).where(eq(notifications.id, existingId)).run();
          return existingId;
        }, { behavior: 'immediate' });
      },

      async appendSyncLog(entry: WebhookSyncLogEntry): Promise<void> {
        await db.insert(syncLog).values({
          id: entry.id,
          connectorId: entry.connectorId,
          success: entry.success,
          tasksAdded: entry.tasksAdded,
          tasksUpdated: entry.tasksUpdated,
          tasksRemoved: entry.tasksRemoved,
          notificationsAdded: entry.notificationsAdded,
          errors: entry.errors,
          syncedAt: entry.syncedAt,
        });
      },
    },
  };
}
