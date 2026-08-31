import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresFinanceAttentionRepairPersistence,
  createPostgresFinanceAttentionRoutingPersistence,
} from '@/db/postgres/repositories/finance-attention-repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceAttentionPersistenceContract,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  type FinanceAttentionContractHarness,
} from '../contracts/finance-attention-persistence.contract';
import { financeAttentionSourceId, financeAttentionTaskId } from '@/db/persistence/finance-attention';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-attention-contract',
        }),
      }
    : {}),
});
let initialized = false;

function attributionSignal(sourceRef: string) {
  return {
    connectorId: CONNECTOR_ID,
    signalKind: 'attributionReviewRequired' as const,
    sourceRef,
  };
}

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function createHarness(): Promise<FinanceAttentionContractHarness> {
  await initialize();
  const pool = backend.context.pool;
  const routing = createPostgresFinanceAttentionRoutingPersistence(pool);
  const repair = createPostgresFinanceAttentionRepairPersistence(pool);

  return {
    routing,
    repair,
    async reset() {
      for (const table of [
        'my_day_items',
        'my_day_exclusions',
        'notification_delivery_events',
        'notification_actions',
        'notifications',
        'tasks',
        'finance_attention_repair_audit',
        'finance_mutation_audit',
        'finance_attribution_exceptions',
        'connector_configs',
      ]) {
        await pool.query(`DELETE FROM ${table}`);
      }
    },
    async seedConnector(input = {}) {
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, sync_mode, capabilities, credentials,
           settings, synced_lists, created_at, updated_at
         ) VALUES (
           $1, 'finance-manager', $1, $2, 'poll',
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $3, $3
         )`,
        [CONNECTOR_ID, input.enabled === false ? false : true, BASE_TIME],
      );
    },
    async seedAttributionException(input) {
      await pool.query(
        `INSERT INTO finance_attribution_exceptions (
           id, connector_id, transaction_id, source_ref, status, reason_code,
           retryable, review_state, source_fingerprint, policy_version,
           occurrence_count, created_at, first_observed_at, last_observed_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, review_state = excluded.review_state,
           reason_code = excluded.reason_code, retryable = excluded.retryable,
           first_observed_at = excluded.first_observed_at,
           last_observed_at = excluded.last_observed_at,
           updated_at = excluded.updated_at`,
        [
          input.id,
          CONNECTOR_ID,
          `transaction-${input.id}`,
          `source-${input.id}`,
          input.status ?? 'open',
          input.reasonCode ?? 'attribution_ambiguous',
          input.retryable ?? false,
          input.reviewState ?? 'pending',
          `fingerprint-${input.id}`,
          input.firstObservedAt,
          input.firstObservedAt,
          input.lastObservedAt,
          input.updatedAt ?? input.lastObservedAt,
        ],
      );
    },
    async seedWriteBackAudit(input) {
      await pool.query(
        `INSERT INTO finance_mutation_audit (
           id, idempotency_key, connector_id, transaction_id, upstream_transaction_id,
           operation, requested_value, status, attempt_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'category_update', '"contract-category"', $6, $7, $8, $9)`,
        [
          input.id,
          `idempotency-${input.id}`,
          CONNECTOR_ID,
          `transaction-${input.id}`,
          `upstream-${input.id}`,
          input.status ?? 'failed',
          input.attemptCount ?? 3,
          input.updatedAt,
          input.updatedAt,
        ],
      );
    },
    async notificationBySourceId(sourceId) {
      const result = await pool.query<{
        id: string;
        state: string;
        sourceState: string;
        isActionable: boolean;
        primaryActionId: string | null;
        autoResolveReason: string | null;
        relatedTaskId: string | null;
      }>(
        `SELECT id, state, source_state AS "sourceState", is_actionable AS "isActionable",
                primary_action_id AS "primaryActionId", auto_resolve_reason AS "autoResolveReason",
                related_task_id AS "relatedTaskId"
         FROM notifications WHERE source_id = $1`,
        [sourceId],
      );
      return result.rows[0] ?? null;
    },
    async deliveryEventCount(notificationId) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM notification_delivery_events WHERE notification_id = $1`,
        [notificationId],
      );
      return Number(result.rows[0]!.count);
    },
    async pendingDeliveryCount(notificationId) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM notification_delivery_events
         WHERE notification_id = $1 AND status = 'pending'`,
        [notificationId],
      );
      return Number(result.rows[0]!.count);
    },
    async taskBySourceId(sourceId) {
      const result = await pool.query<{
        id: string;
        status: string;
        localDisposition: string;
        statusReason: string | null;
      }>(
        `SELECT id, status, local_disposition AS "localDisposition", status_reason AS "statusReason"
         FROM tasks WHERE source_id = $1`,
        [sourceId],
      );
      return result.rows[0] ?? null;
    },
    async countNotifications() {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM notifications`);
      return Number(result.rows[0]!.count);
    },
    async countTasks() {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM tasks`);
      return Number(result.rows[0]!.count);
    },
    async myDayTaskIds(date) {
      const result = await pool.query<{ taskId: string }>(
        `SELECT task_id AS "taskId" FROM my_day_items WHERE date = $1`,
        [date],
      );
      return result.rows.map((row) => row.taskId);
    },
    async seedRepairProjection(input) {
      const incidentAt = FINANCE_ATTENTION_REPAIR_WINDOW_START;
      const signal = attributionSignal(input.exceptionId);
      const sourceId = financeAttentionSourceId(signal);
      await pool.query(
        `INSERT INTO finance_attribution_exceptions (
           id, connector_id, transaction_id, status, reason_code, retryable,
           review_state, source_fingerprint, occurrence_count, created_at,
           first_observed_at, last_observed_at, updated_at
         ) VALUES ($1, $2, $3, 'open', $4, false, 'pending', $5, 1, $6, $6, $6, $6)`,
        [
          input.exceptionId,
          CONNECTOR_ID,
          `transaction-${input.exceptionId}`,
          FINANCE_ATTENTION_REPAIR_REASON,
          `fingerprint-${input.exceptionId}`,
          incidentAt,
        ],
      );
      const notificationId = `notification-${input.exceptionId}`;
      const actionId = `action-${input.exceptionId}`;
      await pool.query(
        `INSERT INTO notifications (
           id, source_id, connector_type, connector_instance_id, title, body,
           level, level_rank, category, template_key, state, read_state,
           disposition, source_state, sync_state, is_actionable, primary_action_id,
           received_at, sort_at, related_entity_type, related_entity_id,
           metadata, presentation
         ) VALUES (
           $1, $2, 'finance-manager', $3, 'Review finance attribution',
           'contract body', 'heads_up', 2, 'finance', 'finance-attribution-review',
           'unread', 'unread', 'inbox', 'active', 'synced', true, $4, $5, $5,
           'finance-attribution-exception', $6, $7::jsonb, '{}'::jsonb
         )`,
        [
          notificationId,
          sourceId,
          CONNECTOR_ID,
          actionId,
          incidentAt,
          input.exceptionId,
          JSON.stringify({
            notificationType: 'financeAttributionReview',
            financeAttention: {
              connectorRef: CONNECTOR_ID,
              sourceRef: input.exceptionId,
              signalKind: 'attributionReviewRequired',
              route: 'actionableNotification',
            },
          }),
        ],
      );
      await pool.query(
        `INSERT INTO notification_actions (
           id, notification_id, action_type, label, created_by, execution_state
         ) VALUES ($1, $2, 'navigate', 'Review', 'connector', 'pending')`,
        [actionId, notificationId],
      );
      await pool.query(
        `INSERT INTO notification_delivery_events (
           id, notification_id, channel, dedupe_key, status, policy_snapshot,
           payload_snapshot, created_at
         ) VALUES ($1, $2, 'web_push', $3, 'pending', '{}'::jsonb, '{}'::jsonb, $4)`,
        [
          `delivery-${input.exceptionId}`,
          notificationId,
          `web_push:${notificationId}:initial`,
          incidentAt,
        ],
      );
      if (input.withTask) {
        const taskId = financeAttentionTaskId(signal);
        await pool.query(
          `INSERT INTO tasks (
             id, source_id, connector_type, connector_instance_id, title, status,
             local_disposition, priority, created_at, updated_at, metadata,
             sync_status, last_synced_at
           ) VALUES (
             $1, $2, 'mission-control', 'mission-control',
             'Review a finance attribution exception', 'todo', 'active', 'medium',
             $3, $3, $4::jsonb, 'synced', $3
           )`,
          [
            taskId,
            sourceId,
            incidentAt,
            JSON.stringify({
              financeAttention: {
                connectorRef: CONNECTOR_ID,
                sourceRef: input.exceptionId,
                signalKind: 'attributionReviewRequired',
                route: 'task',
              },
            }),
          ],
        );
        await pool.query(
          `INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
           VALUES ($1, $2, $3, $4, true, 1)`,
          [`my-day-${input.exceptionId}`, taskId, incidentAt.slice(0, 10), incidentAt],
        );
      }
    },
    async markDeliveryInFlight(exceptionId) {
      const sourceId = financeAttentionSourceId(attributionSignal(exceptionId));
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM notifications WHERE source_id = $1`,
        [sourceId],
      );
      const notification = result.rows[0];
      if (!notification) throw new Error(`No notification seeded for ${exceptionId}`);
      await pool.query(
        `UPDATE notification_delivery_events SET status = 'sending' WHERE notification_id = $1`,
        [notification.id],
      );
    },
    async repairAuditCount() {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM finance_attention_repair_audit`,
      );
      return Number(result.rows[0]!.count);
    },
    async installRepairAbortTrigger() {
      await pool.query(`
        CREATE OR REPLACE FUNCTION contract_abort_finance_attention_repair()
        RETURNS trigger AS $trigger$
        BEGIN
          IF NEW.auto_resolve_reason = 'status_only' THEN
            RAISE EXCEPTION 'contract induced repair failure';
          END IF;
          RETURN NEW;
        END;
        $trigger$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        DROP TRIGGER IF EXISTS contract_abort_finance_attention_repair_trigger ON notifications;
      `);
      await pool.query(`
        CREATE TRIGGER contract_abort_finance_attention_repair_trigger
        BEFORE UPDATE ON notifications
        FOR EACH ROW EXECUTE FUNCTION contract_abort_finance_attention_repair();
      `);
    },
    async removeRepairAbortTrigger() {
      await pool.query(`
        DROP TRIGGER IF EXISTS contract_abort_finance_attention_repair_trigger ON notifications;
      `);
      await pool.query(`DROP FUNCTION IF EXISTS contract_abort_finance_attention_repair();`);
    },
  };
}

if (connectionString) {
  describeFinanceAttentionPersistenceContract('PostgreSQL', createHarness);
} else {
  describe('PostgreSQL finance attention persistence contract', () => {
    it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
  });
}

afterAll(async () => {
  if (!initialized) return;
  const harness = await createHarness();
  await harness.reset();
  await backend.shutdown();
  initialized = false;
});
