import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
} from '@/db/persistence/webhook-integrations';
import { ingestPostgresConnectorNotificationInTransaction } from './connector-execution-repositories';

type Client = Pool | PoolClient;
type Column = [string, unknown];

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Builds an INSERT from `[column, value]` pairs, dropping only `undefined`
 * entries so the column keeps its schema default — the same "omitted column"
 * semantics the SQLite adapter gets from its query builder. `null` is a real
 * stored value and is always kept.
 */
function insertStatement(table: string, columns: readonly Column[]) {
  const present = columns.filter(([, value]) => value !== undefined);
  return {
    text: `INSERT INTO ${table} (${present.map(([name]) => `"${name}"`).join(', ')}) `
      + `VALUES (${present.map((_, index) => `$${index + 1}`).join(', ')})`,
    params: present.map(([, value]) => value),
  };
}

/** Builds a single-row UPDATE keyed by `id`, or `null` when nothing changes. */
function updateByIdStatement(table: string, columns: readonly Column[], id: string) {
  const present = columns.filter(([, value]) => value !== undefined);
  if (present.length === 0) return null;
  return {
    text: `UPDATE ${table} SET ${
      present.map(([name], index) => `"${name}" = $${index + 1}`).join(', ')
    } WHERE id = $${present.length + 1}`,
    params: [...present.map(([, value]) => value), id],
  };
}

function taskColumns(input: WebhookTaskInsert): Column[] {
  return [
    ['id', input.id],
    ['source_id', input.sourceId],
    ['connector_type', input.connectorType],
    ['connector_instance_id', input.connectorInstanceId],
    ['title', input.title],
    ['description', input.description],
    ['status', input.status],
    ['priority', input.priority],
    ['status_reason', input.statusReason],
    ['due_date', input.dueDate],
    ['created_at', input.createdAt],
    ['updated_at', input.updatedAt],
    ['completed_at', input.completedAt],
    ['depth', 0],
    ['is_checklist_item', false],
    ['source_list_id', input.sourceListId],
    ['source_list_name', input.sourceListName],
    ['assignee', input.assignee],
    ['metadata', input.metadata],
    ['sync_status', input.syncStatus],
    ['last_synced_at', input.lastSyncedAt],
  ];
}

function taskUpdateColumns(values: WebhookTaskUpdate): Column[] {
  return [
    ['title', values.title],
    ['description', values.description],
    ['priority', values.priority],
    ['status', values.status],
    ['completed_at', values.completedAt],
    ['status_reason', values.statusReason],
    ['updated_at', values.updatedAt],
    ['sync_status', values.syncStatus],
    ['last_synced_at', values.lastSyncedAt],
  ];
}

function notificationColumns(input: WebhookNotificationInsert): Column[] {
  return [
    ['id', input.id],
    ['source_id', input.sourceId],
    ['connector_type', input.connectorType],
    ['connector_instance_id', input.connectorInstanceId],
    ['title', input.title],
    ['body', input.body],
    ['level', input.level],
    ['level_rank', input.levelRank],
    ['category', input.category],
    ['template_key', input.templateKey],
    ['state', input.state],
    ['is_actionable', input.isActionable],
    ['primary_action_id', input.primaryActionId],
    ['received_at', input.receivedAt],
    ['sort_at', input.sortAt],
    ['expires_at', input.expiresAt],
    ['related_task_id', input.relatedTaskId],
    ['metadata', input.metadata],
    ['presentation', input.presentation],
  ];
}

const SEARCH_COLUMNS = `
  id, title, body, category, connector_type AS "connectorType"
`;

async function readSearchRecord(
  client: Client,
  id: string,
): Promise<WebhookSearchableNotification> {
  const [row] = await query<WebhookSearchableNotification>(
    client,
    `SELECT ${SEARCH_COLUMNS} FROM notifications WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error(`Notification ${id} disappeared during ingestion`);
  return row;
}

async function insertAction(
  client: Client,
  notificationId: string,
  action: WebhookNotificationAction,
): Promise<void> {
  await client.query(
    `
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, icon, variant, is_primary,
        sort_order, payload, opens_external, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      action.id,
      notificationId,
      action.actionType,
      action.label,
      action.icon ?? null,
      action.variant,
      action.isPrimary,
      action.sortOrder,
      action.payload,
      action.opensExternal,
      action.createdBy,
    ],
  );
}

async function syncOpenUrlAction(
  client: Client,
  notificationId: string,
  action: WebhookOpenUrlActionSync | undefined,
): Promise<void> {
  if (!action) return;
  await client.query(
    `DELETE FROM notification_actions WHERE notification_id = $1 AND action_type = 'open_url'`,
    [notificationId],
  );
  if (!action.url) return;
  await insertAction(client, notificationId, {
    id: randomUUID(),
    actionType: 'open_url',
    label: action.label,
    icon: null,
    variant: 'primary',
    isPrimary: true,
    sortOrder: 0,
    payload: { url: action.url },
    opensExternal: true,
    createdBy: 'connector',
  });
}

async function findNotificationIdBySource(
  client: Client,
  connectorType: string,
  sourceId: string,
  lock: boolean,
): Promise<string | null> {
  const [row] = await query<{ id: string }>(
    client,
    `
      SELECT id FROM notifications
      WHERE connector_type = $1 AND source_id = $2
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [connectorType, sourceId],
  );
  return row?.id ?? null;
}

/**
 * PostgreSQL adapter for the Layer L19 webhook configuration/delivery/log
 * port. Nothing here imports `@/db`, a SQLite driver, or a SQLite schema, so
 * selecting PostgreSQL never loads or falls back to SQLite persistence.
 */
export function createPostgresWebhookIntegrationsRepository(
  pool: Pool,
): WebhookIntegrationsPersistence {
  return {
    inbound: {
      async list(): Promise<InboundWebhookSummary[]> {
        return query<InboundWebhookSummary>(
          pool,
          `
            SELECT
              id, name, source_label AS "sourceLabel", enabled,
              default_action AS "defaultAction", field_mappings AS "fieldMappings",
              total_received AS "totalReceived", last_received_at AS "lastReceivedAt",
              last_status AS "lastStatus", created_at AS "createdAt",
              updated_at AS "updatedAt", (secret IS NOT NULL) AS "hasSecret"
            FROM inbound_webhooks
            ORDER BY created_at DESC, id DESC
          `,
        );
      },

      async create(input: CreateInboundWebhookInput): Promise<void> {
        await pool.query(
          `
            INSERT INTO inbound_webhooks (
              id, name, source_label, secret, enabled, default_action, field_mappings,
              total_received, last_received_at, last_status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, true, $5, $6, 0, NULL, NULL, $7, $8)
          `,
          [
            input.id,
            input.name,
            input.sourceLabel,
            input.secret,
            input.defaultAction,
            input.fieldMappings,
            input.createdAt,
            input.updatedAt,
          ],
        );
      },

      async update(input: UpdateInboundWebhookInput): Promise<UpdateInboundWebhookOutcome> {
        const { patch } = input;
        return transaction(pool, async (client) => {
          await client.query('SELECT id FROM inbound_webhooks WHERE id = $1 FOR UPDATE', [
            input.id,
          ]);
          if (patch.secret === null) {
            const referencing = await query<{ id: string }>(
              client,
              `
                SELECT id FROM external_agents
                WHERE inbound_webhook_id = $1 AND deleted_at IS NULL
                LIMIT 1
              `,
              [input.id],
            );
            if (referencing.length > 0) return 'secret-referenced' as const;
          }
          const statement = updateByIdStatement('inbound_webhooks', [
            ['name', patch.name],
            ['source_label', patch.sourceLabel],
            ['secret', patch.secret],
            ['enabled', patch.enabled],
            ['default_action', patch.defaultAction],
            ['field_mappings', patch.fieldMappings],
            ['updated_at', input.updatedAt],
          ], input.id);
          if (statement) await client.query(statement.text, statement.params);
          return 'updated' as const;
        });
      },

      async delete(id: string): Promise<DeleteInboundWebhookOutcome> {
        return transaction(pool, async (client) => {
          await client.query('SELECT id FROM inbound_webhooks WHERE id = $1 FOR UPDATE', [id]);
          const referencing = await query<{ id: string }>(
            client,
            `
              SELECT id FROM external_agents
              WHERE inbound_webhook_id = $1 AND deleted_at IS NULL
              LIMIT 1
            `,
            [id],
          );
          if (referencing.length > 0) return 'agent-referenced' as const;
          await client.query(
            'DELETE FROM notification_push_rules WHERE connector_instance_id = $1',
            [id],
          );
          await client.query('DELETE FROM inbound_webhooks WHERE id = $1', [id]);
          return 'deleted' as const;
        });
      },

      async listLog(input: ListInboundWebhookLogInput): Promise<InboundWebhookLogEntry[]> {
        return query<InboundWebhookLogEntry>(
          pool,
          `
            SELECT
              id, webhook_id AS "webhookId", status, http_status AS "httpStatus",
              created_type AS "createdType", created_id AS "createdId",
              error_message AS "errorMessage", payload_preview AS "payloadPreview",
              received_at AS "receivedAt"
            FROM inbound_webhook_log
            WHERE webhook_id = $1
            ORDER BY received_at DESC, id DESC
            LIMIT $2
          `,
          [input.webhookId, input.limit],
        );
      },

      async appendLog(input: AppendInboundWebhookLogInput): Promise<void> {
        const { entry, compaction } = input;
        await transaction(pool, async (client) => {
          await client.query(
            `
              INSERT INTO inbound_webhook_log (
                id, webhook_id, status, http_status, created_type, created_id,
                error_message, payload_preview, received_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `,
            [
              entry.id,
              entry.webhookId,
              entry.status,
              entry.httpStatus,
              entry.createdType,
              entry.createdId,
              entry.errorMessage,
              entry.payloadPreview,
              entry.receivedAt,
            ],
          );
          if (!compaction) return;
          await client.query(
            'DELETE FROM inbound_webhook_log WHERE webhook_id = $1 AND received_at < $2',
            [entry.webhookId, compaction.retentionCutoff],
          );
          await client.query(
            `
              DELETE FROM inbound_webhook_log
              WHERE webhook_id = $1
                AND id NOT IN (
                  SELECT id FROM inbound_webhook_log
                  WHERE webhook_id = $1
                  ORDER BY received_at DESC, id DESC
                  LIMIT $2
                )
            `,
            [entry.webhookId, compaction.retainLatest],
          );
        });
      },

      async findForDelivery(id: string): Promise<InboundWebhookDeliveryConfig | null> {
        const [row] = await query<InboundWebhookDeliveryConfig>(
          pool,
          `
            SELECT
              id, name, source_label AS "sourceLabel", secret, enabled,
              default_action AS "defaultAction", field_mappings AS "fieldMappings"
            FROM inbound_webhooks
            WHERE id = $1
            LIMIT 1
          `,
          [id],
        );
        return row ?? null;
      },

      async claimDelivery(input: ClaimInboundWebhookDeliveryInput): Promise<boolean> {
        if (input.sweepExpiredBefore) {
          await pool.query(
            'DELETE FROM inbound_webhook_replays WHERE expires_at <= $1',
            [input.sweepExpiredBefore],
          );
        }
        return transaction(pool, async (client) => {
          // Serializes competing claims for the same delivery so the
          // expire-then-insert pair below cannot interleave.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `inbound-webhook-replay:${input.webhookId}:${input.deliveryKey}`,
          ]);
          await client.query(
            `
              DELETE FROM inbound_webhook_replays
              WHERE webhook_id = $1 AND delivery_key = $2 AND expires_at <= $3
            `,
            [input.webhookId, input.deliveryKey, input.receivedAt],
          );
          const inserted = await client.query(
            `
              INSERT INTO inbound_webhook_replays (
                id, webhook_id, delivery_key, received_at, expires_at
              ) VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (webhook_id, delivery_key) DO NOTHING
              RETURNING id
            `,
            [
              input.id,
              input.webhookId,
              input.deliveryKey,
              input.receivedAt,
              input.expiresAt,
            ],
          );
          return inserted.rowCount === 1;
        });
      },

      async releaseDelivery(input: ReleaseInboundWebhookDeliveryInput): Promise<void> {
        await pool.query(
          'DELETE FROM inbound_webhook_replays WHERE webhook_id = $1 AND delivery_key = $2',
          [input.webhookId, input.deliveryKey],
        );
      },

      async recordDeliveryStats(
        input: RecordInboundWebhookDeliveryStatsInput,
      ): Promise<void> {
        await pool.query(
          `
            UPDATE inbound_webhooks
            SET total_received = total_received + 1,
                last_received_at = $2,
                last_status = $3,
                updated_at = $4
            WHERE id = $1
          `,
          [input.webhookId, input.receivedAt, input.lastStatus, input.updatedAt],
        );
      },

      async createTask(input: WebhookTaskInsert): Promise<void> {
        const statement = insertStatement('tasks', taskColumns(input));
        await pool.query(statement.text, statement.params);
      },

      async createAlert(
        input: CreateInboundWebhookAlertInput,
      ): Promise<CreateInboundWebhookAlertResult> {
        const { notification, action } = input;
        return transaction(pool, async (client) => {
          const result = await ingestPostgresConnectorNotificationInTransaction(client, {
            input: {
              id: notification.id,
              sourceId: notification.sourceId,
              connectorType: notification.connectorType,
              connectorInstanceId: notification.connectorInstanceId,
              title: notification.title,
              body: notification.body ?? null,
              level: notification.level,
              category: notification.category,
              templateKey: notification.templateKey ?? null,
              readState: 'unread',
              disposition: 'inbox',
              sourceState: 'active',
              syncState: 'synced',
              sourceActivityAt: null,
              sourceActivityKey: null,
              reopenPolicy: 'handled',
              occurrenceKey: 'initial',
              isActionable: notification.isActionable,
              primaryActionId: notification.primaryActionId ?? null,
              receivedAt: notification.receivedAt,
              sortAt: notification.sortAt,
              expiresAt: notification.expiresAt ?? null,
              relatedTaskId: notification.relatedTaskId ?? null,
              relatedProjectId: null,
              relatedEntityType: null,
              relatedEntityId: null,
              navigationTarget: null,
              metadata: notification.metadata ?? {},
              presentation: notification.presentation ?? {},
            },
            actions: action
              ? [{
                  id: action.id,
                  notificationId: notification.id,
                  actionType: action.actionType,
                  label: action.label,
                  icon: action.icon ?? null,
                  variant: action.variant,
                  isPrimary: action.isPrimary,
                  sortOrder: action.sortOrder,
                  payload: action.payload,
                  opensExternal: action.opensExternal,
                  requiresConfirmation: false,
                  createdBy: action.createdBy,
                }]
              : [],
          });
          return result;
        });
      },
    },

    outbound: {
      async list(): Promise<OutboundWebhookRecord[]> {
        return query<OutboundWebhookRecord>(
          pool,
          `
            SELECT
              id, name, url, secret, event_types AS "eventTypes", enabled,
              last_triggered_at AS "lastTriggeredAt", last_status AS "lastStatus",
              created_at AS "createdAt"
            FROM outbound_webhooks
            ORDER BY created_at DESC, id DESC
          `,
        );
      },

      async find(id: string): Promise<OutboundWebhookRecord | null> {
        const [row] = await query<OutboundWebhookRecord>(
          pool,
          `
            SELECT
              id, name, url, secret, event_types AS "eventTypes", enabled,
              last_triggered_at AS "lastTriggeredAt", last_status AS "lastStatus",
              created_at AS "createdAt"
            FROM outbound_webhooks
            WHERE id = $1
            LIMIT 1
          `,
          [id],
        );
        return row ?? null;
      },

      async create(input: CreateOutboundWebhookInput): Promise<void> {
        await pool.query(
          `
            INSERT INTO outbound_webhooks (
              id, name, url, secret, event_types, enabled, created_at
            ) VALUES ($1, $2, $3, $4, $5, true, $6)
          `,
          [
            input.id,
            input.name,
            input.url,
            input.secret,
            JSON.stringify([...input.eventTypes]),
            input.createdAt,
          ],
        );
      },

      async update(id: string, patch: OutboundWebhookPatch): Promise<void> {
        const statement = updateByIdStatement('outbound_webhooks', [
          ['name', patch.name],
          ['url', patch.url],
          ['secret', patch.secret],
          ['enabled', patch.enabled],
          [
            'event_types',
            patch.eventTypes === undefined
              ? undefined
              : JSON.stringify([...patch.eventTypes]),
          ],
        ], id);
        if (statement) await pool.query(statement.text, statement.params);
      },

      async delete(id: string): Promise<void> {
        await pool.query('DELETE FROM outbound_webhooks WHERE id = $1', [id]);
      },
    },

    integrations: {
      async find(id: string): Promise<IntegrationConfigRecord | null> {
        const [row] = await query<IntegrationConfigRecord>(
          pool,
          `
            SELECT
              id, type, name, base_url AS "baseUrl", api_key AS "apiKey", enabled,
              settings, created_at AS "createdAt", updated_at AS "updatedAt"
            FROM integration_configs
            WHERE id = $1
            LIMIT 1
          `,
          [id],
        );
        return row ?? null;
      },

      async save(input: SaveIntegrationConfigInput): Promise<void> {
        await pool.query(
          `
            INSERT INTO integration_configs (
              id, type, name, base_url, api_key, enabled, settings, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
              base_url = EXCLUDED.base_url,
              api_key = EXCLUDED.api_key,
              enabled = EXCLUDED.enabled,
              settings = EXCLUDED.settings,
              updated_at = EXCLUDED.updated_at
          `,
          [
            input.id,
            input.type,
            input.name,
            input.baseUrl,
            input.apiKey,
            input.enabled,
            input.settings,
            input.createdAt,
            input.updatedAt,
          ],
        );
      },

      async updateSettings(input: UpdateIntegrationConfigSettingsInput): Promise<void> {
        await pool.query(
          'UPDATE integration_configs SET settings = $2, updated_at = $3 WHERE id = $1',
          [input.id, input.settings, input.updatedAt],
        );
      },
    },

    ingest: {
      async findConnector(connectorId: string): Promise<ConnectorWebhookConfig | null> {
        const [row] = await query<ConnectorWebhookConfig>(
          pool,
          `
            SELECT id, type, enabled, settings
            FROM connector_configs
            WHERE id = $1
            LIMIT 1
          `,
          [connectorId],
        );
        return row ?? null;
      },

      async findTaskBySourceId(sourceId: string): Promise<WebhookTaskIdentity | null> {
        const [row] = await query<WebhookTaskIdentity>(
          pool,
          `
            SELECT id, status, completed_at AS "completedAt", status_reason AS "statusReason"
            FROM tasks
            WHERE source_id = $1
            LIMIT 1
          `,
          [sourceId],
        );
        return row ?? null;
      },

      async createTask(input: WebhookTaskInsert): Promise<void> {
        const statement = insertStatement('tasks', taskColumns(input));
        await pool.query(statement.text, statement.params);
      },

      async updateTask(id: string, values: WebhookTaskUpdate): Promise<void> {
        const statement = updateByIdStatement('tasks', taskUpdateColumns(values), id);
        if (statement) await pool.query(statement.text, statement.params);
      },

      async createNotification(
        input: CreateWebhookNotificationInput,
      ): Promise<WebhookSearchableNotification> {
        const { notification, actions, openUrlAction } = input;
        return transaction(pool, async (client) => {
          const statement = insertStatement(
            'notifications',
            notificationColumns(notification),
          );
          await client.query(statement.text, statement.params);
          for (const action of actions ?? []) {
            await insertAction(client, notification.id, action);
          }
          await syncOpenUrlAction(client, notification.id, openUrlAction);
          return readSearchRecord(client, notification.id);
        });
      },

      async upsertNotificationBySource(
        input: UpsertWebhookNotificationInput,
      ): Promise<UpsertWebhookNotificationResult> {
        const { match, insert, update, openUrlAction } = input;
        return transaction(pool, async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `webhook-notification-source:${match.connectorType}:${match.sourceId}`,
          ]);
          const existingId = await findNotificationIdBySource(
            client,
            match.connectorType,
            match.sourceId,
            true,
          );

          if (existingId) {
            const statement = updateByIdStatement('notifications', [
              ['source_id', update.sourceId],
              ['connector_type', update.connectorType],
              ['connector_instance_id', update.connectorInstanceId],
              ['title', update.title],
              ['body', update.body],
              ['level', update.level],
              ['level_rank', update.levelRank],
              ['category', update.category],
              ['state', update.state],
              ['is_actionable', update.isActionable],
              ['received_at', update.receivedAt],
              ['sort_at', update.sortAt],
              ['expires_at', update.expiresAt],
              ['related_task_id', update.relatedTaskId],
              ['metadata', update.metadata],
            ], existingId);
            if (statement) await client.query(statement.text, statement.params);
            await syncOpenUrlAction(client, existingId, openUrlAction);
            return {
              id: existingId,
              created: false,
              search: await readSearchRecord(client, existingId),
            };
          }

          const statement = insertStatement('notifications', notificationColumns(insert));
          await client.query(statement.text, statement.params);
          await syncOpenUrlAction(client, insert.id, openUrlAction);
          return {
            id: insert.id,
            created: true,
            search: await readSearchRecord(client, insert.id),
          };
        });
      },

      async deleteNotificationBySource(
        match: { connectorType: string; sourceId: string },
      ): Promise<string | null> {
        return transaction(pool, async (client) => {
          const existingId = await findNotificationIdBySource(
            client,
            match.connectorType,
            match.sourceId,
            true,
          );
          if (!existingId) return null;
          await client.query(
            'DELETE FROM notification_actions WHERE notification_id = $1',
            [existingId],
          );
          await client.query('DELETE FROM notifications WHERE id = $1', [existingId]);
          return existingId;
        });
      },

      async snoozeNotificationBySource(
        input: SnoozeWebhookNotificationInput,
      ): Promise<string | null> {
        return transaction(pool, async (client) => {
          const existingId = await findNotificationIdBySource(
            client,
            input.connectorType,
            input.sourceId,
            true,
          );
          if (!existingId) return null;
          await client.query(
            `
              UPDATE notifications
              SET snoozed_until = $2, expires_at = $2, metadata = $3
              WHERE id = $1
            `,
            [existingId, input.snoozedUntil, input.metadata],
          );
          return existingId;
        });
      },

      async appendSyncLog(entry: WebhookSyncLogEntry): Promise<void> {
        await pool.query(
          `
            INSERT INTO sync_log (
              id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
              alerts_added, errors, synced_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            entry.id,
            entry.connectorId,
            entry.success,
            entry.tasksAdded,
            entry.tasksUpdated,
            entry.tasksRemoved,
            entry.notificationsAdded,
            // The caller supplies already-serialized JSON text; both backends
            // persist it through their JSON encoder so the stored bytes match.
            JSON.stringify(entry.errors),
            entry.syncedAt,
          ],
        );
      },
    },
  };
}
