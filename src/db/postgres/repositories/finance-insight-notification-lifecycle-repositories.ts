import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  ConnectorNotificationCommand,
} from '@/db/persistence/connector-execution';
import { ingestPostgresConnectorNotificationInTransaction } from './connector-execution-repositories';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationLifecycleOutcome,
  FinanceInsightNotificationLifecyclePersistence,
  FinanceInsightNotificationLifecycleResult,
  FinanceInsightNotificationReconcileItem,
} from '@/db/persistence/finance-insights';

/**
 * PostgreSQL equivalent of the portable half of
 * `src/db/persistence/sqlite-finance-insight-notification-lifecycle.ts`.
 * Create/dedupe reuses the generic connector notification ingestion
 * transaction primitive (same push-rule, dedupe, and outbox behavior as
 * every other migrated connector); reconcile, `group_key`/`dedupe_key`
 * persistence, and provider presentation/action sync are bespoke SQL
 * mirroring the SQLite adapter's behavior, reusing the same portable
 * provider-resolution primitives
 * (`resolveNotificationProvider`/`materializeNotificationActions`).
 * `group_key`/`dedupe_key` are written by a small follow-up `UPDATE` here
 * (rather than by the generic ingest helper, which has no equivalent
 * `ConnectorNotificationInput` fields for them).
 */

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

async function lockFinanceInsightNotificationScope(
  client: PoolClient,
  connectorId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-insight-notifications:${connectorId}`],
  );
}

interface StoredNotificationRow {
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
  presentation: unknown;
}

async function reconcileOne(
  client: PoolClient,
  connectorId: string,
  item: FinanceInsightNotificationReconcileItem,
  nowIso: string,
): Promise<void> {
  const [existing] = await query<{
    id: string;
    disposition: string;
    sourceResolvedAt: string | null;
  }>(client, `
    SELECT id, disposition, source_resolved_at AS "sourceResolvedAt"
    FROM notifications
    WHERE source_id = $1 AND connector_type = 'finance-manager' AND connector_instance_id = $2
  `, [item.sourceId, connectorId]);
  if (!existing) return;

  const state = existing.disposition === 'dismissed'
    ? 'dismissed'
    : existing.disposition === 'handled'
      ? 'archived'
      : 'resolved';
  const sourceResolvedAt = existing.sourceResolvedAt ?? item.sourceResolvedAt ?? nowIso;
  await client.query(`
    UPDATE notifications
    SET state = $1, source_state = 'resolved', source_resolved_at = $2,
        last_source_activity_at = $3, last_source_activity_key = $4,
        last_source_synced_at = $5, is_actionable = false, primary_action_id = NULL,
        metadata = $6::jsonb
    WHERE id = $7
  `, [
    state,
    sourceResolvedAt,
    item.lastSourceActivityAt,
    item.lastSourceActivityKey,
    nowIso,
    JSON.stringify(item.metadata),
    existing.id,
  ]);
  await client.query(`
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [existing.id]);
}

function providerNotification(row: StoredNotificationRow): InboundNotification {
  return {
    id: row.id,
    sourceId: row.sourceId,
    connectorType: row.connectorType,
    connectorInstanceId: row.connectorInstanceId,
    title: row.title,
    body: row.body ?? undefined,
    level: row.level as InboundNotification['level'],
    category: row.category,
    isRead: row.readState === 'read',
    isActionable: row.isActionable,
    receivedAt: row.receivedAt,
    sourceState: row.sourceState as InboundNotification['sourceState'],
    hubProjectIds: [],
    tags: [],
    metadata: row.metadata as Record<string, unknown>,
  };
}

async function syncPresentation(client: PoolClient, notificationId: string): Promise<void> {
  const [row] = await query<StoredNotificationRow>(client, `
    SELECT id, source_id AS "sourceId", connector_type AS "connectorType",
           connector_instance_id AS "connectorInstanceId", title, body, level, category,
           read_state AS "readState", is_actionable AS "isActionable",
           received_at AS "receivedAt", metadata, source_state AS "sourceState", presentation
    FROM notifications WHERE id = $1
  `, [notificationId]);
  if (!row) return;

  registerDefaultNotificationProviders();
  const resolved = resolveNotificationProvider(providerNotification(row));
  if (!resolved) return;

  const active = row.sourceState === 'active';
  const drafts = active
    ? (resolved.presentation.actions ?? []).filter((action) => action.actionType !== 'create_task')
    : [];
  let actionIndex = 0;
  const actionRecords = materializeNotificationActions(
    row.id,
    drafts,
    () => `${row.id}:finance-action:${actionIndex++}`,
  );
  await client.query(`
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [row.id]);
  for (const action of actionRecords) {
    await client.query(`
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, icon, variant, is_primary,
        sort_order, payload, opens_external, requires_confirmation, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
    `, [
      action.id,
      action.notificationId,
      action.actionType,
      action.label,
      action.icon ?? null,
      action.variant,
      action.isPrimary,
      action.sortOrder,
      JSON.stringify(action.payload),
      action.opensExternal,
      action.requiresConfirmation,
      action.createdBy,
    ]);
  }
  const existingPresentation = row.presentation !== null
    && typeof row.presentation === 'object'
    && !Array.isArray(row.presentation)
    ? row.presentation
    : {};
  const mergedPresentation = {
    ...existingPresentation,
    ...(resolved.presentation.presentation ?? {}),
  };
  await client.query(`
    UPDATE notifications
    SET title = $1, body = $2, presentation = $3::jsonb, is_actionable = $4, primary_action_id = $5
    WHERE id = $6
  `, [
    resolved.presentation.title ?? row.title,
    resolved.presentation.body ?? row.body,
    JSON.stringify(mergedPresentation),
    active && (resolved.presentation.isActionable ?? actionRecords.length > 0),
    actionRecords.find((action) => action.isPrimary)?.id ?? null,
    row.id,
  ]);
}

async function ingestOne(
  client: PoolClient,
  item: FinanceInsightNotificationIngestItem,
): Promise<FinanceInsightNotificationLifecycleResult> {
  const command: ConnectorNotificationCommand = { input: item.input, actions: [] };
  const result = await ingestPostgresConnectorNotificationInTransaction(client, command);
  await client.query(`
    UPDATE notifications SET group_key = $1, dedupe_key = $2 WHERE id = $3
  `, [item.groupKey, item.dedupeKey, result.id]);
  await syncPresentation(client, result.id);
  return result;
}

export function createPostgresFinanceInsightNotificationLifecyclePersistence(
  pool: Pool,
): FinanceInsightNotificationLifecyclePersistence {
  return {
    async isDeliveryEnabled(connectorId) {
      const rows = await query<{ deliveryEnabled: boolean }>(
        pool,
        `SELECT delivery_enabled AS "deliveryEnabled"
         FROM finance_insight_cutovers WHERE connector_id = $1`,
        [connectorId],
      );
      return rows[0]?.deliveryEnabled === true;
    },

    async runLifecycle(input): Promise<FinanceInsightNotificationLifecycleOutcome> {
      const results = await transaction(pool, async (client) => {
        await lockFinanceInsightNotificationScope(client, input.connectorId);
        for (const item of input.reconcile) {
          await reconcileOne(client, input.connectorId, item, input.now);
        }
        const ingested: FinanceInsightNotificationLifecycleResult[] = [];
        for (const item of input.ingest) {
          ingested.push(await ingestOne(client, item));
        }
        return ingested;
      });
      return {
        results,
        hasPendingDelivery: results.some((entry) => entry.pendingDelivery),
      };
    },
  };
}
