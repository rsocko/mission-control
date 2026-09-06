import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  alertmanagerIntegrationEvents,
  appSettings,
  externalAgents,
  homelabAlertReceipts,
  inboundWebhooks,
  integrationConfigs,
  notificationActions,
  notificationDeliveryEvents,
  notificationPushRules,
  notifications,
  outboundWebhooks,
  syncLog,
  tasks,
} from '@/db/schema';
import {
  createSqliteNotificationsInTransaction,
} from './sqlite-notification-creation';
import type { CreateNotificationInput } from './notification-delivery';
import { decodeLenientJsonObject } from './value-codecs';
import type {
  AlertmanagerIntegrationEventInput,
  AlertmanagerIntegrationEventRecord,
  AlertmanagerStatusSnapshot,
  AlertmanagerSyntheticIdentity,
  AlertmanagerSyntheticInspection,
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
  WebhookTaskSourceIdentity,
  WebhookTaskUpdate,
} from './webhook-integrations';

type SqliteDrizzle = BetterSQLite3Database<typeof schema>;
type SqliteTransaction = Parameters<Parameters<SqliteDrizzle['transaction']>[0]>[0];
const ALERTMANAGER_CONTROL_KEY = 'alertmanager-integration-control';

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
 * SQLite adapter for the Layer L20 webhook configuration/delivery/log port.
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

  function alertmanagerEventValues(event: AlertmanagerIntegrationEventRecord) {
    return {
      id: event.id,
      integration: event.integration,
      kind: event.kind,
      outcome: event.outcome,
      authenticated: event.authenticated,
      httpStatus: event.httpStatus,
      accepted: event.accepted,
      applied: event.applied,
      created: event.created,
      updated: event.updated,
      stale: event.stale,
      duplicateReceipts: event.duplicateReceipts,
      detail: event.detail,
      occurredAt: event.occurredAt,
    };
  }

  async function pruneAlertmanagerEvents(
    input: Pick<AlertmanagerIntegrationEventInput, 'retainLatest' | 'pruneBatchSize'>,
    integration: string,
  ): Promise<void> {
    const protectedRows = await Promise.all([
      db.select({ id: alertmanagerIntegrationEvents.id })
        .from(alertmanagerIntegrationEvents)
        .where(and(
          eq(alertmanagerIntegrationEvents.integration, integration),
          eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
          eq(alertmanagerIntegrationEvents.outcome, 'projected'),
        ))
        .orderBy(desc(alertmanagerIntegrationEvents.occurredAt), desc(alertmanagerIntegrationEvents.id))
        .limit(1),
      db.select({ id: alertmanagerIntegrationEvents.id })
        .from(alertmanagerIntegrationEvents)
        .where(and(
          eq(alertmanagerIntegrationEvents.integration, integration),
          eq(alertmanagerIntegrationEvents.kind, 'synthetic_test'),
        ))
        .orderBy(desc(alertmanagerIntegrationEvents.occurredAt), desc(alertmanagerIntegrationEvents.id))
        .limit(1),
      db.select({ id: alertmanagerIntegrationEvents.id })
        .from(alertmanagerIntegrationEvents)
        .where(and(
          eq(alertmanagerIntegrationEvents.integration, integration),
          eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
          eq(alertmanagerIntegrationEvents.authenticated, true),
          notInArray(alertmanagerIntegrationEvents.outcome, ['projected', 'paused']),
        ))
        .orderBy(desc(alertmanagerIntegrationEvents.occurredAt), desc(alertmanagerIntegrationEvents.id))
        .limit(1),
    ]);
    const protectedIds = new Set(protectedRows.flat().map(row => row.id));
    const expired = await db.select({ id: alertmanagerIntegrationEvents.id })
      .from(alertmanagerIntegrationEvents)
      .where(eq(alertmanagerIntegrationEvents.integration, integration))
      .orderBy(desc(alertmanagerIntegrationEvents.occurredAt), desc(alertmanagerIntegrationEvents.id))
      .limit(input.pruneBatchSize)
      .offset(input.retainLatest);
    const expiredIds = expired.map(row => row.id).filter(id => !protectedIds.has(id));
    if (expiredIds.length > 0) {
      await db.delete(alertmanagerIntegrationEvents)
        .where(inArray(alertmanagerIntegrationEvents.id, expiredIds));
    }
  }

  function alertmanagerEventPrecedesProjection(
    event: { occurredAt: string; status: 'firing' | 'resolved' },
    current: typeof notifications.$inferSelect | undefined,
  ): boolean {
    if (!current?.lastSourceActivityAt) return false;
    const incomingTime = Date.parse(event.occurredAt);
    const currentTime = Date.parse(current.lastSourceActivityAt);
    if (incomingTime < currentTime) return true;
    return incomingTime === currentTime
      && current.sourceState === 'resolved'
      && event.status === 'firing';
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
          const [result] = createSqliteNotificationsInTransaction(transaction, [{
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

      async findTaskBySource(
        input: WebhookTaskSourceIdentity,
      ): Promise<WebhookTaskIdentity | null> {
        const [row] = await db
          .select({
            id: tasks.id,
            status: tasks.status,
            completedAt: tasks.completedAt,
            statusReason: tasks.statusReason,
          })
          .from(tasks)
          .where(and(
            eq(tasks.connectorInstanceId, input.connectorInstanceId),
            eq(tasks.sourceId, input.sourceId),
          ))
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

    alertmanager: {
      async getControl() {
        const [row] = await db
          .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
          .from(appSettings)
          .where(eq(appSettings.key, ALERTMANAGER_CONTROL_KEY))
          .limit(1);
        const value = row?.value;
        return {
          paused: Boolean(
            value && typeof value === 'object' && 'paused' in value && value.paused === true,
          ),
          updatedAt: row?.updatedAt ?? null,
        };
      },

      async setPaused(input) {
        db.transaction((transaction) => {
          transaction.insert(appSettings).values({
            key: ALERTMANAGER_CONTROL_KEY,
            value: { paused: input.paused },
            updatedAt: input.updatedAt,
          }).onConflictDoUpdate({
            target: appSettings.key,
            set: { value: { paused: input.paused }, updatedAt: input.updatedAt },
          }).run();
          transaction.insert(alertmanagerIntegrationEvents)
            .values(alertmanagerEventValues(input.auditEvent))
            .run();
        }, { behavior: 'immediate' });
        await pruneAlertmanagerEvents(input, input.integration);
        return { paused: input.paused, updatedAt: input.updatedAt };
      },

      async recordEvent(input) {
        await db.insert(alertmanagerIntegrationEvents)
          .values(alertmanagerEventValues(input.event));
        await pruneAlertmanagerEvents(input, input.event.integration);
      },

      async getStatus(integration): Promise<AlertmanagerStatusSnapshot> {
        const eventWhere = eq(alertmanagerIntegrationEvents.integration, integration);
        const [
          controlRow,
          [lastRequest = null],
          [lastAuthenticatedReceipt = null],
          [lastSuccessfulProjection = null],
          [lastSyntheticTest = null],
          recentFailures,
          [counts],
        ] = await Promise.all([
          db.select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
            .from(appSettings)
            .where(eq(appSettings.key, ALERTMANAGER_CONTROL_KEY))
            .limit(1),
          db.select().from(alertmanagerIntegrationEvents)
            .where(and(
              eventWhere,
              eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
            ))
            .orderBy(
              desc(alertmanagerIntegrationEvents.occurredAt),
              desc(alertmanagerIntegrationEvents.id),
            )
            .limit(1),
          db.select().from(alertmanagerIntegrationEvents)
            .where(and(
              eventWhere,
              eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
              eq(alertmanagerIntegrationEvents.authenticated, true),
            ))
            .orderBy(
              desc(alertmanagerIntegrationEvents.occurredAt),
              desc(alertmanagerIntegrationEvents.id),
            )
            .limit(1),
          db.select().from(alertmanagerIntegrationEvents)
            .where(and(
              eventWhere,
              eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
              eq(alertmanagerIntegrationEvents.outcome, 'projected'),
            ))
            .orderBy(
              desc(alertmanagerIntegrationEvents.occurredAt),
              desc(alertmanagerIntegrationEvents.id),
            )
            .limit(1),
          db.select().from(alertmanagerIntegrationEvents)
            .where(and(
              eventWhere,
              eq(alertmanagerIntegrationEvents.kind, 'synthetic_test'),
            ))
            .orderBy(
              desc(alertmanagerIntegrationEvents.occurredAt),
              desc(alertmanagerIntegrationEvents.id),
            )
            .limit(1),
          db.select().from(alertmanagerIntegrationEvents)
            .where(and(
              eventWhere,
              eq(alertmanagerIntegrationEvents.kind, 'webhook_request'),
              eq(alertmanagerIntegrationEvents.authenticated, true),
              notInArray(alertmanagerIntegrationEvents.outcome, ['projected', 'paused']),
            ))
            .orderBy(
              desc(alertmanagerIntegrationEvents.occurredAt),
              desc(alertmanagerIntegrationEvents.id),
            )
            .limit(5),
          db.select({
            requests: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.kind} = 'webhook_request' then 1 else 0 end), 0)`,
            failures: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.kind} = 'webhook_request' and ${alertmanagerIntegrationEvents.authenticated} = true and ${alertmanagerIntegrationEvents.outcome} not in ('projected', 'paused') then 1 else 0 end), 0)`,
            intentionalDrops: sql<number>`coalesce(sum(case when ${alertmanagerIntegrationEvents.outcome} = 'paused' and ${alertmanagerIntegrationEvents.kind} = 'webhook_request' then 1 else 0 end), 0)`,
            accepted: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.accepted}), 0)`,
            applied: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.applied}), 0)`,
            created: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.created}), 0)`,
            updated: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.updated}), 0)`,
            stale: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.stale}), 0)`,
            duplicateReceipts: sql<number>`coalesce(sum(${alertmanagerIntegrationEvents.duplicateReceipts}), 0)`,
          }).from(alertmanagerIntegrationEvents).where(eventWhere),
        ]);
        const value = controlRow[0]?.value;
        return {
          control: {
            paused: Boolean(
              value && typeof value === 'object' && 'paused' in value && value.paused === true,
            ),
            updatedAt: controlRow[0]?.updatedAt ?? null,
          },
          lastRequest,
          lastAuthenticatedReceipt,
          lastSuccessfulProjection,
          lastSyntheticTest,
          recentFailures,
          counts: Object.fromEntries(
            Object.entries(counts ?? {}).map(([key, value]) => [key, Number(value)]),
          ) as AlertmanagerStatusSnapshot['counts'],
        };
      },

      async ingestBatch(input) {
        return db.transaction((transaction) => {
          const totals = {
            accepted: input.events.length,
            applied: 0,
            stale: 0,
            created: 0,
            updated: 0,
            duplicateReceipts: 0,
            pendingDelivery: false,
          };

          for (const event of input.events) {
            const current = transaction.select().from(notifications)
              .where(eq(notifications.sourceId, event.projection.sourceId))
              .get();
            const stale = alertmanagerEventPrecedesProjection(event, current);
            const existingReceipt = transaction.select({ id: homelabAlertReceipts.id })
              .from(homelabAlertReceipts)
              .where(and(
                eq(homelabAlertReceipts.integration, input.integration),
                eq(homelabAlertReceipts.source, event.source),
                eq(homelabAlertReceipts.eventId, event.eventId),
              ))
              .get();
            if (existingReceipt) {
              transaction.update(homelabAlertReceipts).set({
                lastReceivedAt: input.receivedAt,
                deliveryCount: sql`${homelabAlertReceipts.deliveryCount} + 1`,
                applied: !stale,
              }).where(eq(homelabAlertReceipts.id, existingReceipt.id)).run();
              totals.duplicateReceipts++;
            } else {
              transaction.insert(homelabAlertReceipts).values({
                id: randomUUID(),
                integration: input.integration,
                source: event.source,
                eventId: event.eventId,
                fingerprint: event.fingerprint,
                status: event.status,
                occurredAt: event.occurredAt,
                notificationId: current?.id ?? event.projection.sourceId,
                firstReceivedAt: input.receivedAt,
                lastReceivedAt: input.receivedAt,
                deliveryCount: 1,
                applied: !stale,
              }).run();
            }
            if (stale) {
              totals.stale++;
              continue;
            }

            const projection = event.projection;
            const [creation] = createSqliteNotificationsInTransaction(transaction, [{
              id: current?.id ?? projection.newNotificationId,
              sourceId: projection.sourceId,
              connectorType: 'homelab',
              connectorInstanceId: input.integration,
              title: projection.title,
              body: projection.body,
              level: projection.level,
              category: projection.category,
              templateKey: projection.templateKey,
              readState: projection.readState,
              sourceState: projection.sourceState,
              sourceActivityAt: projection.sourceActivityAt,
              sourceActivityKey: projection.sourceActivityKey,
              reopenPolicy: 'handled',
              receivedAt: projection.receivedAt,
              sortAt: projection.sortAt,
              dedupeKey: projection.dedupeKey,
              metadata: projection.metadata,
              presentation: projection.presentation,
              isActionable: projection.isActionable,
              occurrenceKey: projection.occurrenceKey,
            }], {
              now: new Date(input.receivedAt),
              wakeDispatcher: false,
            });
            const notificationId = creation.notification.id;
            transaction.delete(notificationActions).where(and(
              eq(notificationActions.notificationId, notificationId),
              eq(notificationActions.createdBy, 'connector'),
              eq(notificationActions.actionType, 'open_url'),
            )).run();
            for (const action of projection.actions) {
              transaction.insert(notificationActions)
                .values(actionValues(notificationId, action))
                .run();
            }
            transaction.update(notifications).set({
              primaryActionId: projection.actions[0]?.id ?? null,
              isActionable: projection.sourceState === 'active' && projection.actions.length > 0,
            }).where(eq(notifications.id, notificationId)).run();
            if (input.suppressDeliveries) {
              transaction.delete(notificationDeliveryEvents)
                .where(eq(notificationDeliveryEvents.notificationId, notificationId))
                .run();
            }
            transaction.update(homelabAlertReceipts).set({ notificationId }).where(and(
              eq(homelabAlertReceipts.integration, input.integration),
              eq(homelabAlertReceipts.source, event.source),
              eq(homelabAlertReceipts.eventId, event.eventId),
            )).run();
            totals.applied++;
            if (creation.created) totals.created++;
            else totals.updated++;
            totals.pendingDelivery ||= !input.suppressDeliveries
              && creation.deliveryEvents.some(delivery => delivery.status === 'pending');
          }
          return totals;
        }, { behavior: 'immediate' });
      },

      async inspectSyntheticLifecycle(
        identity: AlertmanagerSyntheticIdentity,
      ): Promise<AlertmanagerSyntheticInspection> {
        const [projections, receipts] = await Promise.all([
          db.select({ sourceState: notifications.sourceState })
            .from(notifications)
            .where(eq(notifications.sourceId, identity.sourceId)),
          db.select({
            status: homelabAlertReceipts.status,
            deliveryCount: homelabAlertReceipts.deliveryCount,
          })
            .from(homelabAlertReceipts)
            .where(and(
              eq(homelabAlertReceipts.integration, identity.integration),
              eq(homelabAlertReceipts.source, identity.source),
              eq(homelabAlertReceipts.fingerprint, identity.fingerprint),
            )),
        ]);
        return {
          projectionCount: projections.length,
          sourceState: projections[0]?.sourceState ?? null,
          receiptCount: receipts.length,
          firingDeliveryCount: receipts.find(receipt => receipt.status === 'firing')
            ?.deliveryCount ?? null,
        };
      },

      async cleanupSyntheticLifecycle(identity) {
        db.transaction((transaction) => {
          const projection = transaction.select({ id: notifications.id })
            .from(notifications)
            .where(eq(notifications.sourceId, identity.sourceId))
            .get();
          if (projection) {
            transaction.delete(notificationActions)
              .where(eq(notificationActions.notificationId, projection.id))
              .run();
            transaction.delete(notificationDeliveryEvents)
              .where(eq(notificationDeliveryEvents.notificationId, projection.id))
              .run();
          }
          transaction.delete(homelabAlertReceipts).where(and(
            eq(homelabAlertReceipts.integration, identity.integration),
            eq(homelabAlertReceipts.source, identity.source),
            eq(homelabAlertReceipts.fingerprint, identity.fingerprint),
          )).run();
          transaction.delete(notifications)
            .where(eq(notifications.sourceId, identity.sourceId))
            .run();
        }, { behavior: 'immediate' });
      },
    },
  };
}
