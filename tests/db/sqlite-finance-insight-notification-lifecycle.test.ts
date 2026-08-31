import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import * as schema from '@/db/schema';
import { createSqliteFinanceInsightNotificationLifecyclePersistence } from '@/db/persistence/sqlite-finance-insight-notification-lifecycle';
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

const dataDirectory = resolve(process.cwd(), 'data');
const databasePath = resolve(
  dataDirectory,
  `finance-insight-notification-lifecycle-contract-${process.pid}.db`,
);
let sqlite: Database.Database | null = null;

async function createHarness(): Promise<FinanceInsightNotificationLifecycleContractHarness> {
  if (!sqlite) {
    mkdirSync(dataDirectory, { recursive: true });
    rmSync(databasePath, { force: true });
    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  }
  const database = sqlite;
  const db = drizzle(database, { schema });
  const notifications = createSqliteFinanceInsightNotificationLifecyclePersistence({
    sqlite: database,
    db,
  });

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
        database.prepare(`DELETE FROM ${table}`).run();
      }
      database.prepare(
        `DROP TRIGGER IF EXISTS contract_abort_finance_insight_notification_ingest`,
      ).run();
    },
    async seedConnector() {
      database.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES (?, 'finance-manager', ?, 1, 'poll', '{}', '{}', '{}', '[]', ?, ?)
      `).run(CONNECTOR_ID, CONNECTOR_ID, BASE_TIME, BASE_TIME);
      // Satisfies the generic notification push-policy's subscription gate so
      // a freshly created notification's delivery event lands as `pending`
      // (rather than `suppressed: no_subscription`), matching a realistic
      // configured environment.
      database.prepare(`
        INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
        VALUES ('contract-subscription', 'web', 'https://push.example.test/contract', ?, ?)
      `).run(JSON.stringify({ p256dh: 'key', auth: 'auth-secret' }), BASE_TIME);
    },
    async notificationBySourceId(sourceId) {
      const row = database.prepare(`
        SELECT id, source_id AS sourceId, title, body, state, source_state AS sourceState,
               is_actionable AS isActionable, primary_action_id AS primaryActionId,
               group_key AS groupKey, dedupe_key AS dedupeKey
        FROM notifications WHERE source_id = ?
      `).get(sourceId) as {
        id: string;
        sourceId: string;
        title: string;
        body: string | null;
        state: string;
        sourceState: string;
        isActionable: number;
        primaryActionId: string | null;
        groupKey: string | null;
        dedupeKey: string | null;
      } | undefined;
      return row ? { ...row, isActionable: row.isActionable === 1 } : null;
    },
    async countNotifications() {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM notifications`).get() as {
        count: number;
      };
      return row.count;
    },
    async actionCount(notificationId) {
      const row = database.prepare(`
        SELECT COUNT(*) AS count FROM notification_actions WHERE notification_id = ?
      `).get(notificationId) as { count: number };
      return row.count;
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
    async setGlobalPushEnabled(enabled) {
      database.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('push_delivery_enabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(enabled), BASE_TIME);
    },
    async deliveryPayloadTitles(notificationId) {
      const rows = database.prepare(`
        SELECT payload_snapshot AS payloadSnapshot FROM notification_delivery_events
        WHERE notification_id = ?
      `).all(notificationId) as Array<{ payloadSnapshot: string }>;
      return rows.map((row) => {
        const parsed = JSON.parse(row.payloadSnapshot) as { title?: unknown };
        return typeof parsed.title === 'string' ? parsed.title : '';
      });
    },
    async installIngestAbortTrigger() {
      const poisonSourceId = financeInsightContractSourceId(POISON_OCCURRENCE_ID);
      database.exec(`
        CREATE TRIGGER contract_abort_finance_insight_notification_ingest
        BEFORE INSERT ON notifications
        WHEN NEW.source_id = '${poisonSourceId}'
        BEGIN
          SELECT RAISE(ABORT, 'contract induced ingest failure');
        END;
      `);
    },
    async removeIngestAbortTrigger() {
      database.exec(`DROP TRIGGER IF EXISTS contract_abort_finance_insight_notification_ingest`);
    },
  };
}

describeFinanceInsightNotificationLifecycleContract('SQLite', createHarness);

afterAll(() => {
  sqlite?.close();
  sqlite = null;
  rmSync(databasePath, { force: true });
});
