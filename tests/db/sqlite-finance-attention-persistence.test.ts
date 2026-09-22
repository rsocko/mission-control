import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import * as schema from '@/db/schema';
import {
  createSqliteFinanceAttentionRepairPersistence,
  createSqliteFinanceAttentionRoutingPersistence,
} from '@/db/persistence/sqlite-finance-attention-repositories';
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
process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

const dataDirectory = resolve(process.cwd(), 'data');
const databasePath = resolve(
  dataDirectory,
  `finance-attention-contract-${process.pid}.db`,
);
let sqlite: Database.Database | null = null;

function attributionSignal(sourceRef: string) {
  return {
    connectorId: CONNECTOR_ID,
    signalKind: 'attributionReviewRequired' as const,
    sourceRef,
  };
}

async function createHarness(): Promise<FinanceAttentionContractHarness> {
  if (!sqlite) {
    mkdirSync(dataDirectory, { recursive: true });
    rmSync(databasePath, { force: true });
    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  }
  const database = sqlite;
  const db = drizzle(database, { schema });
  const routing = createSqliteFinanceAttentionRoutingPersistence({ sqlite: database, db });
  const repair = createSqliteFinanceAttentionRepairPersistence(database);

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
        'push_subscriptions',
      ]) {
        database.prepare(`DELETE FROM ${table}`).run();
      }
    },
    async seedConnector(input = {}) {
      database.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES (?, 'finance-manager', ?, ?, 'poll', '{}', '{}', '{}', '[]', ?, ?)
      `).run(
        CONNECTOR_ID,
        CONNECTOR_ID,
        input.enabled === false ? 0 : 1,
        BASE_TIME,
        BASE_TIME,
      );
      // Satisfies the generic notification push-policy's subscription gate so
      // a freshly created notification's delivery event lands as `pending`
      // (rather than `suppressed: no_subscription`), matching a realistic
      // configured environment.
      database.prepare(`
        INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
        VALUES ('contract-subscription', 'web', 'https://push.example.test/contract', ?, ?)
      `).run(JSON.stringify({ p256dh: 'key', auth: 'auth-secret' }), BASE_TIME);
    },
    async seedAttributionException(input) {
      database.prepare(`
        INSERT INTO finance_attribution_exceptions (
          id, connector_id, transaction_id, source_ref, status, reason_code,
          retryable, review_state, source_fingerprint, policy_version,
          occurrence_count, created_at, first_observed_at, last_observed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          status = excluded.status, review_state = excluded.review_state,
          reason_code = excluded.reason_code, retryable = excluded.retryable,
          first_observed_at = excluded.first_observed_at,
          last_observed_at = excluded.last_observed_at,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        CONNECTOR_ID,
        `transaction-${input.id}`,
        `source-${input.id}`,
        input.status ?? 'open',
        input.reasonCode ?? 'attribution_ambiguous',
        input.retryable ? 1 : 0,
        input.reviewState ?? 'pending',
        `fingerprint-${input.id}`,
        input.firstObservedAt,
        input.firstObservedAt,
        input.lastObservedAt,
        input.updatedAt ?? input.lastObservedAt,
      );
    },
    async seedWriteBackAudit(input) {
      database.prepare(`
        INSERT INTO finance_mutation_audit (
          id, idempotency_key, connector_id, transaction_id, upstream_transaction_id,
          operation, requested_value, status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'set_category', '"contract-category"', ?, ?, ?, ?)
      `).run(
        input.id,
        `idempotency-${input.id}`,
        CONNECTOR_ID,
        `transaction-${input.id}`,
        `upstream-${input.id}`,
        input.status ?? 'failed',
        input.attemptCount ?? 3,
        input.updatedAt,
        input.updatedAt,
      );
    },
    async notificationBySourceId(sourceId) {
      const row = database.prepare(`
        SELECT id, state, source_state AS sourceState, is_actionable AS isActionable,
               primary_action_id AS primaryActionId, auto_resolve_reason AS autoResolveReason,
               related_task_id AS relatedTaskId
        FROM notifications WHERE source_id = ?
      `).get(sourceId) as {
        id: string;
        state: string;
        sourceState: string;
        isActionable: number;
        primaryActionId: string | null;
        autoResolveReason: string | null;
        relatedTaskId: string | null;
      } | undefined;
      return row ? { ...row, isActionable: row.isActionable === 1 } : null;
    },
    async deliveryEventCount(notificationId) {
      const row = database.prepare(`
        SELECT COUNT(*) AS count FROM notification_delivery_events WHERE notification_id = ?
      `).get(notificationId) as { count: number };
      return row.count;
    },
    async pendingDeliveryCount(notificationId) {
      const row = database.prepare(`
        SELECT COUNT(*) AS count FROM notification_delivery_events
        WHERE notification_id = ? AND status = 'pending'
      `).get(notificationId) as { count: number };
      return row.count;
    },
    async taskBySourceId(sourceId) {
      const row = database.prepare(`
        SELECT id, status, local_disposition AS localDisposition, status_reason AS statusReason
        FROM tasks WHERE source_id = ?
      `).get(sourceId) as {
        id: string;
        status: string;
        localDisposition: string;
        statusReason: string | null;
      } | undefined;
      return row ?? null;
    },
    async countNotifications() {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM notifications`).get() as {
        count: number;
      };
      return row.count;
    },
    async countTasks() {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as {
        count: number;
      };
      return row.count;
    },
    async myDayTaskIds(date) {
      const rows = database.prepare(`
        SELECT task_id AS taskId FROM my_day_items WHERE date = ?
      `).all(date) as Array<{ taskId: string }>;
      return rows.map((row) => row.taskId);
    },
    async seedRepairProjection(input) {
      const incidentAt = FINANCE_ATTENTION_REPAIR_WINDOW_START;
      const signal = attributionSignal(input.exceptionId);
      const sourceId = financeAttentionSourceId(signal);
      database.prepare(`
        INSERT INTO finance_attribution_exceptions (
          id, connector_id, transaction_id, status, reason_code, retryable,
          review_state, source_fingerprint, occurrence_count, created_at,
          first_observed_at, last_observed_at, updated_at
        ) VALUES (?, ?, ?, 'open', ?, 0, 'pending', ?, 1, ?, ?, ?, ?)
      `).run(
        input.exceptionId,
        CONNECTOR_ID,
        `transaction-${input.exceptionId}`,
        FINANCE_ATTENTION_REPAIR_REASON,
        `fingerprint-${input.exceptionId}`,
        incidentAt,
        incidentAt,
        incidentAt,
        incidentAt,
      );
      const notificationId = `notification-${input.exceptionId}`;
      const actionId = `action-${input.exceptionId}`;
      database.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, body,
          level, level_rank, category, template_key, state, read_state,
          disposition, source_state, sync_state, is_actionable, primary_action_id,
          received_at, sort_at, related_entity_type, related_entity_id,
          metadata, presentation
        ) VALUES (
          ?, ?, 'finance-manager', ?, 'Review finance attribution',
          'contract body', 'heads_up', 2, 'finance', 'finance-attribution-review',
          'unread', 'unread', 'inbox', 'active', 'synced', 1, ?, ?, ?,
          'finance-attribution-exception', ?, ?, '{}'
        )
      `).run(
        notificationId,
        sourceId,
        CONNECTOR_ID,
        actionId,
        incidentAt,
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
      );
      database.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, label, created_by, execution_state
        ) VALUES (?, ?, 'navigate', 'Review', 'connector', 'pending')
      `).run(actionId, notificationId);
      database.prepare(`
        INSERT INTO notification_delivery_events (
          id, notification_id, channel, dedupe_key, status, policy_snapshot,
          payload_snapshot, created_at
        ) VALUES (?, ?, 'web_push', ?, 'pending', '{}', '{}', ?)
      `).run(
        `delivery-${input.exceptionId}`,
        notificationId,
        `web_push:${notificationId}:initial`,
        incidentAt,
      );
      if (input.withTask) {
        const taskId = financeAttentionTaskId(signal);
        database.prepare(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            local_disposition, priority, created_at, updated_at, metadata,
            sync_status, last_synced_at
          ) VALUES (
            ?, ?, 'mission-control', 'mission-control',
            'Review a finance attribution exception', 'todo', 'active', 'medium',
            ?, ?, ?, 'synced', ?
          )
        `).run(
          taskId,
          sourceId,
          incidentAt,
          incidentAt,
          JSON.stringify({
            financeAttention: {
              connectorRef: CONNECTOR_ID,
              sourceRef: input.exceptionId,
              signalKind: 'attributionReviewRequired',
              route: 'task',
            },
          }),
          incidentAt,
        );
        database.prepare(`
          INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
          VALUES (?, ?, ?, ?, 1, 1)
        `).run(`my-day-${input.exceptionId}`, taskId, incidentAt.slice(0, 10), incidentAt);
      }
    },
    async markDeliveryInFlight(exceptionId) {
      const sourceId = financeAttentionSourceId(attributionSignal(exceptionId));
      const notification = database.prepare(`
        SELECT id FROM notifications WHERE source_id = ?
      `).get(sourceId) as { id: string } | undefined;
      if (!notification) throw new Error(`No notification seeded for ${exceptionId}`);
      database.prepare(`
        UPDATE notification_delivery_events SET status = 'sending' WHERE notification_id = ?
      `).run(notification.id);
    },
    async repairAuditCount() {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM finance_attention_repair_audit`,
      ).get() as { count: number };
      return row.count;
    },
    async installRepairAbortTrigger() {
      database.exec(`
        CREATE TRIGGER contract_abort_finance_attention_repair
        BEFORE UPDATE ON notifications
        WHEN NEW.auto_resolve_reason = 'status_only'
        BEGIN
          SELECT RAISE(ABORT, 'contract induced repair failure');
        END;
      `);
    },
    async removeRepairAbortTrigger() {
      database.exec(`DROP TRIGGER IF EXISTS contract_abort_finance_attention_repair`);
    },
  };
}

describeFinanceAttentionPersistenceContract('SQLite', createHarness);

afterAll(() => {
  sqlite?.close();
  sqlite = null;
  rmSync(databasePath, { force: true });
});
