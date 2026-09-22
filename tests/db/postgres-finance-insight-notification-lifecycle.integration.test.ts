import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceInsightNotificationLifecyclePersistence } from '@/db/postgres/repositories/finance-insight-notification-lifecycle-repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceInsightNotificationLifecycleContract,
  financeInsightContractSourceId,
  POISON_OCCURRENCE_ID,
  type FinanceInsightNotificationLifecycleContractHarness,
} from '../contracts/finance-insight-notification-lifecycle.contract';

vi.unmock('drizzle-orm');
process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-insight-notification-contract',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function createHarness(): Promise<FinanceInsightNotificationLifecycleContractHarness> {
  await initialize();
  const pool = backend.context.pool;
  const notifications = createPostgresFinanceInsightNotificationLifecyclePersistence(pool);

  return {
    notifications,
    async reset() {
      for (const table of [
        'notification_delivery_events',
        'notification_actions',
        'notifications',
        'connector_configs',
        'push_subscriptions',
        'app_settings',
      ]) {
        await pool.query(`DELETE FROM ${table}`);
      }
      await pool.query(
        `DROP TRIGGER IF EXISTS contract_abort_finance_insight_notification_ingest ON notifications`,
      );
      await pool.query(
        `DROP FUNCTION IF EXISTS contract_abort_finance_insight_notification_ingest()`,
      );
    },
    async seedConnector() {
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, sync_mode, capabilities, credentials,
           settings, synced_lists, created_at, updated_at
         ) VALUES (
           $1, 'finance-manager', $1, true, 'poll',
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $2
         )`,
        [CONNECTOR_ID, BASE_TIME],
      );
      await pool.query(
        `INSERT INTO push_subscriptions (
           id, platform, endpoint, keys, created_at
         ) VALUES (
           'contract-subscription', 'web', 'https://push.example.test/contract',
           '{"p256dh":"key","auth":"auth-secret"}'::jsonb, $1
         )`,
        [BASE_TIME],
      );
    },
    async notificationBySourceId(sourceId) {
      const result = await pool.query<{
        id: string;
        sourceId: string;
        title: string;
        body: string | null;
        state: string;
        sourceState: string;
        isActionable: boolean;
        primaryActionId: string | null;
        groupKey: string | null;
        dedupeKey: string | null;
      }>(
        `SELECT id, source_id AS "sourceId", title, body, state, source_state AS "sourceState",
                is_actionable AS "isActionable", primary_action_id AS "primaryActionId",
                group_key AS "groupKey", dedupe_key AS "dedupeKey"
         FROM notifications WHERE source_id = $1`,
        [sourceId],
      );
      return result.rows[0] ?? null;
    },
    async countNotifications() {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM notifications`);
      return Number(result.rows[0]!.count);
    },
    async actionCount(notificationId) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM notification_actions WHERE notification_id = $1`,
        [notificationId],
      );
      return Number(result.rows[0]!.count);
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
    async setGlobalPushEnabled(enabled) {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('push_delivery_enabled', $1::jsonb, $2)
         ON CONFLICT(key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(enabled), BASE_TIME],
      );
    },
    async deliveryPayloadTitles(notificationId) {
      const result = await pool.query<{ payloadSnapshot: { title?: unknown } }>(
        `SELECT payload_snapshot AS "payloadSnapshot" FROM notification_delivery_events
         WHERE notification_id = $1`,
        [notificationId],
      );
      return result.rows.map((row) => (
        typeof row.payloadSnapshot?.title === 'string' ? row.payloadSnapshot.title : ''
      ));
    },
    async installIngestAbortTrigger() {
      const poisonSourceId = financeInsightContractSourceId(POISON_OCCURRENCE_ID);
      await pool.query(`
        CREATE OR REPLACE FUNCTION contract_abort_finance_insight_notification_ingest()
        RETURNS trigger AS $trigger$
        BEGIN
          IF NEW.source_id = '${poisonSourceId}' THEN
            RAISE EXCEPTION 'contract induced ingest failure';
          END IF;
          RETURN NEW;
        END;
        $trigger$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        DROP TRIGGER IF EXISTS contract_abort_finance_insight_notification_ingest ON notifications;
      `);
      await pool.query(`
        CREATE TRIGGER contract_abort_finance_insight_notification_ingest
        BEFORE INSERT ON notifications
        FOR EACH ROW EXECUTE FUNCTION contract_abort_finance_insight_notification_ingest();
      `);
    },
    async removeIngestAbortTrigger() {
      await pool.query(`
        DROP TRIGGER IF EXISTS contract_abort_finance_insight_notification_ingest ON notifications;
      `);
      await pool.query(
        `DROP FUNCTION IF EXISTS contract_abort_finance_insight_notification_ingest();`,
      );
    },
  };
}

if (connectionString) {
  describeFinanceInsightNotificationLifecycleContract('PostgreSQL', createHarness);
} else {
  describe('PostgreSQL finance insight notification lifecycle contract', () => {
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
