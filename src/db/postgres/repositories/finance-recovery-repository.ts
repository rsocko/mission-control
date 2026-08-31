import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ConnectorNotificationCommand } from '@/db/persistence/connector-execution';
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
} from '@/db/persistence/finance-recovery';
import { financeConnectorConfigFromRow } from '@/lib/connectors/monarch-money/config';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import {
  ingestPostgresConnectorNotificationInTransaction,
} from './connector-execution-repositories';

type Client = Pool | PoolClient;

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

async function lockRecoveryScope(client: PoolClient, connectorId: string): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-connection-recovery:${connectorId}`],
  );
}

async function readOutage(
  client: Client,
  connectorId: string,
): Promise<FinanceConnectionOutage | null> {
  const rows = await query<FinanceConnectionOutage>(client, `
    SELECT connector_id AS "connectorId", episode_id AS "episodeId", status,
           auth_state AS "authState", started_at AS "startedAt",
           last_observed_at AS "lastObservedAt",
           notification_created_at AS "notificationCreatedAt",
           task_created_at AS "taskCreatedAt",
           recovery_sync_succeeded_at AS "recoverySyncSucceededAt",
           recovered_at AS "recoveredAt", last_error_code AS "lastErrorCode",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM finance_connection_outages
    WHERE connector_id = $1
  `, [connectorId]);
  return rows[0] ?? null;
}

function notificationCommand(
  row: FinanceConnectionOutage,
  now: Date,
): ConnectorNotificationCommand {
  const id = financeConnectionNotificationId(row);
  const sourceId = financeConnectionSourceId(row);
  const copy = financeConnectionNotificationCopy(row.status);
  const metadata = financeConnectionNotificationMetadata(row, row.status, now);
  const notification: InboundNotification = {
    id,
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: row.connectorId,
    title: copy.title,
    body: copy.body,
    level: copy.level,
    category: 'finance',
    isRead: false,
    isActionable: true,
    receivedAt: row.startedAt,
    sourceState: 'active',
    hubProjectIds: [],
    tags: [],
    metadata,
  };
  registerDefaultNotificationProviders();
  const resolved = resolveNotificationProvider(notification);
  const drafts = (resolved?.presentation.actions ?? [])
    .filter((action) => action.actionType !== 'create_task');
  let actionIndex = 0;
  const actions = materializeNotificationActions(
    id,
    drafts,
    () => `${id}:finance-action:${actionIndex++}`,
  );
  const presentation = resolved?.presentation.presentation ?? {};
  const notificationType = financeConnectionNotificationType(row.status);
  return {
    input: {
      id,
      sourceId,
      connectorType: 'finance-manager',
      connectorInstanceId: row.connectorId,
      title: resolved?.presentation.title ?? copy.title,
      body: resolved?.presentation.body ?? copy.body,
      level: copy.level,
      category: 'finance',
      templateKey: notificationType,
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt: now.toISOString(),
      sourceActivityKey: `${row.episodeId}:${notificationType}`,
      reopenPolicy: 'handled_and_dismissed',
      receivedAt: row.startedAt,
      sortAt: now.toISOString(),
      groupKey: `finance-connection:${row.connectorId}`,
      dedupeKey: sourceId,
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: 'finance-connection-outage',
      relatedEntityId: row.episodeId,
      navigationTarget: '/settings/connectors',
      isActionable: resolved
        ? (resolved.presentation.isActionable ?? actions.length > 0)
        : true,
      primaryActionId: actions.find((action) => action.isPrimary)?.id ?? null,
      occurrenceKey: `${row.episodeId}:${notificationType}`,
      metadata,
      presentation,
    },
    actions,
  };
}

async function createTaskAndMyDay(
  client: PoolClient,
  row: FinanceConnectionOutage,
  attentionStatus: 'degraded' | 'authentication_expired',
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const taskId = financeConnectionTaskId(row);
  const copy = financeConnectionNotificationCopy(attentionStatus);
  const recoveryPending = row.status === 'recovery_pending';
  const inserted = await client.query(`
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, local_disposition, priority, created_at, updated_at,
      last_synced_at, source_list_id, source_list_name, metadata, sync_status
    ) VALUES (
      $1, $2, 'mission-control', 'mission-control', $3, $4,
      'todo', 'active', $5, $6, $6, $6, 'local', 'Local', $7::jsonb, 'synced'
    )
    ON CONFLICT (source_id, connector_instance_id) DO NOTHING
  `, [
    taskId,
    financeConnectionSourceId(row),
    recoveryPending ? 'Verify Monarch recovery' : 'Reconnect Monarch',
    recoveryPending
      ? 'Monarch is connected, but Finance data remains stale until Mission Control verifies a bounded refresh. Open Finance settings and select Verify recovery.'
      : `${copy.body} Open Finance settings to reconnect and verify a bounded refresh.`,
    attentionStatus === 'authentication_expired' ? 'critical' : 'high',
    nowIso,
    JSON.stringify({
      financeConnectionRecovery: {
        contractVersion: '1.0',
        outageEpisodeId: row.episodeId,
        connectorRef: row.connectorId,
        status: attentionStatus,
        startedAt: row.startedAt,
        staleData: true,
      },
    }),
  ]);

  const date = formatDateInLocalTimezone(now);
  const excluded = await query<{ excluded: boolean }>(client, `
    SELECT EXISTS (
      SELECT 1 FROM my_day_exclusions WHERE task_id = $1 AND date = $2
    ) AS excluded
  `, [taskId, date]);
  if (!excluded[0]?.excluded) {
    await client.query(`
      INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
      SELECT $1, $2, $3, $4, true,
             COALESCE((SELECT MAX("order") FROM my_day_items WHERE date = $3), 0) + 1
      WHERE NOT EXISTS (
        SELECT 1 FROM my_day_items WHERE task_id = $2 AND date = $3
      )
      ON CONFLICT (id) DO NOTHING
    `, [`finance-connection-myday-${row.episodeId}`, taskId, date, nowIso]);
  }

  const notifications = await query<{ id: string }>(client, `
    UPDATE notifications
    SET state = CASE WHEN disposition = 'dismissed' THEN 'dismissed' ELSE 'resolved' END,
        source_state = 'resolved',
        source_resolved_at = COALESCE(source_resolved_at, $1),
        auto_resolve_reason = 'promoted_to_task',
        related_task_id = $2,
        is_actionable = false,
        primary_action_id = NULL,
        last_source_synced_at = $1
    WHERE source_id = $3
    RETURNING id
  `, [nowIso, taskId, financeConnectionSourceId(row)]);
  if (notifications[0]) {
    await client.query(
      'DELETE FROM notification_actions WHERE notification_id = $1',
      [notifications[0].id],
    );
  }
  return inserted.rowCount === 1;
}

async function settle(
  client: PoolClient,
  row: FinanceConnectionOutage,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const notifications = await query<{ id: string }>(client, `
    UPDATE notifications
    SET state = CASE WHEN disposition = 'dismissed' THEN 'dismissed' ELSE 'resolved' END,
        source_state = 'resolved',
        source_resolved_at = COALESCE(source_resolved_at, $1),
        auto_resolve_reason = 'connection_recovered',
        is_actionable = false,
        primary_action_id = NULL,
        last_source_synced_at = $1
    WHERE source_id = $2
    RETURNING id
  `, [nowIso, financeConnectionSourceId(row)]);
  if (notifications[0]) {
    await client.query(
      'DELETE FROM notification_actions WHERE notification_id = $1',
      [notifications[0].id],
    );
  }
  const taskId = financeConnectionTaskId(row);
  await client.query(`
    UPDATE tasks
    SET status = 'done', status_reason = 'completed', completed_at = $1,
        updated_at = $1, last_synced_at = $1
    WHERE id = $2 AND status NOT IN ('done', 'cancelled')
  `, [nowIso, taskId]);
  await client.query('DELETE FROM my_day_items WHERE task_id = $1', [taskId]);
  await client.query(`
    UPDATE finance_connection_outages
    SET status = 'recovered', auth_state = 'connected', last_observed_at = $1,
        recovered_at = $1, last_error_code = NULL, updated_at = $1
    WHERE connector_id = $2 AND episode_id = $3
  `, [nowIso, row.connectorId, row.episodeId]);
}

export function createPostgresFinanceConnectionRecoveryPersistence(
  pool: Pool,
): FinanceConnectionRecoveryPersistence {
  return {
    async reconcileObservation(input) {
      return transaction(pool, async (client) => {
        await lockRecoveryScope(client, input.connectorId);
        const nowIso = input.now.toISOString();
        let existing = await readOutage(client, input.connectorId);
        if (!existing || existing.status === 'recovered') {
          if (isStrictlyHealthyFinanceObservation(input.observation)) {
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
          await client.query(`
            INSERT INTO finance_connection_outages (
              connector_id, episode_id, status, auth_state, started_at,
              last_observed_at, notification_created_at, task_created_at,
              recovery_sync_succeeded_at, recovered_at, last_error_code,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $5, NULL, NULL, NULL, NULL, $6, $5, $5)
            ON CONFLICT (connector_id) DO UPDATE SET
              episode_id = EXCLUDED.episode_id,
              status = EXCLUDED.status,
              auth_state = EXCLUDED.auth_state,
              started_at = EXCLUDED.started_at,
              last_observed_at = EXCLUDED.last_observed_at,
              notification_created_at = NULL,
              task_created_at = NULL,
              recovery_sync_succeeded_at = NULL,
              recovered_at = NULL,
              last_error_code = EXCLUDED.last_error_code,
              created_at = EXCLUDED.created_at,
              updated_at = EXCLUDED.updated_at
          `, [
            episode.connectorId,
            episode.episodeId,
            episode.status,
            episode.authState,
            nowIso,
            episode.lastErrorCode,
          ]);
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
        await client.query(`
          UPDATE finance_connection_outages
          SET status = $1, auth_state = $2, last_observed_at = $3,
              last_error_code = $4, updated_at = $3
          WHERE connector_id = $5 AND episode_id = $6
        `, [
          row.status,
          row.authState,
          nowIso,
          row.lastErrorCode,
          row.connectorId,
          row.episodeId,
        ]);

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
          const notification = await ingestPostgresConnectorNotificationInTransaction(
            client,
            notificationCommand(row, input.now),
          );
          notificationCreated = notification.created;
          pendingDelivery = notification.pendingDelivery;
          if (!row.notificationCreatedAt) {
            row = { ...row, notificationCreatedAt: nowIso };
            await client.query(`
              UPDATE finance_connection_outages
              SET notification_created_at = $1, updated_at = $1
              WHERE connector_id = $2 AND episode_id = $3
            `, [nowIso, row.connectorId, row.episodeId]);
          }
        }
        if (elapsed >= FINANCE_CONNECTION_TASK_AFTER_MS && !row.taskCreatedAt) {
          const notifications = await query<{ notificationType: string | null }>(client, `
            SELECT metadata->>'notificationType' AS "notificationType"
            FROM notifications WHERE source_id = $1
          `, [financeConnectionSourceId(row)]);
          const attentionStatus = notifications[0]?.notificationType
            === 'connectorAuthenticationExpired'
            || row.status === 'authentication_expired'
            ? 'authentication_expired'
            : 'degraded';
          taskCreated = await createTaskAndMyDay(client, row, attentionStatus, input.now);
          await client.query(`
            UPDATE finance_connection_outages
            SET task_created_at = $1, updated_at = $1
            WHERE connector_id = $2 AND episode_id = $3
          `, [nowIso, row.connectorId, row.episodeId]);
        }
        return {
          status,
          notificationCreated,
          taskCreated,
          recovered: false,
          pendingDelivery,
        };
      });
    },

    async listEnabledConnectors() {
      const rows = await query(pool, `
        SELECT id, type, name, enabled, sync_mode AS "syncMode",
               poll_interval_minutes AS "pollIntervalMinutes", capabilities,
               credentials, settings, synced_lists AS "syncedLists"
        FROM connector_configs
        WHERE type = ANY($1::text[]) AND enabled = true AND deleted_at IS NULL
      `, [[...FINANCE_PROVIDER_ALIASES]]);
      return rows.map((row) => financeConnectorConfigFromRow(row as never));
    },

    async getActiveEpisode(connectorId) {
      const row = await readOutage(pool, connectorId);
      return row?.status === 'recovered' ? null : row;
    },

    async recordBoundedSyncFailure(input) {
      const result = await pool.query(`
        UPDATE finance_connection_outages
        SET last_error_code = $1, updated_at = $2
        WHERE connector_id = $3 AND episode_id = $4 AND status <> 'recovered'
      `, [input.errorCode, input.now.toISOString(), input.connectorId, input.episodeId]);
      return result.rowCount === 1;
    },

    async recordBoundedSyncSuccess(input) {
      const result = await pool.query(`
        UPDATE finance_connection_outages
        SET recovery_sync_succeeded_at = $1, updated_at = $1
        WHERE connector_id = $2 AND episode_id = $3 AND status <> 'recovered'
      `, [input.now.toISOString(), input.connectorId, input.episodeId]);
      return result.rowCount === 1;
    },

    async settleEpisode(input) {
      return transaction(pool, async (client) => {
        await lockRecoveryScope(client, input.connectorId);
        const row = await readOutage(client, input.connectorId);
        if (!row || row.status === 'recovered' || row.episodeId !== input.episodeId) {
          return false;
        }
        await settle(client, row, input.now);
        return true;
      });
    },

    async getView(input) {
      const row = await readOutage(pool, input.connectorId);
      return row ? financeConnectionRecoveryView(row, input.reconnectUrl) : null;
    },
  };
}
