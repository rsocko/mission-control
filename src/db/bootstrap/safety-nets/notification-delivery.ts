import type Database from 'better-sqlite3';
import { execSafe } from './exec-safe';

export function applyNotificationDeliverySafetyNets(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
  // Push preferences: add do_not_disturb column (safety-net for Drizzle migration 0026)
  const pushPrefColumns = _sqlite.prepare("PRAGMA table_info('push_preferences')").all() as Array<{ name: string }>;
  if (pushPrefColumns.length > 0 && !pushPrefColumns.some(c => c.name === 'do_not_disturb')) {
    _execSafe('ALTER TABLE push_preferences ADD COLUMN do_not_disturb INTEGER NOT NULL DEFAULT 0');
  }

  // Connector push rules (safety-net for Drizzle migration 0035)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_push_rules (
      id TEXT PRIMARY KEY NOT NULL,
      connector_instance_id TEXT NOT NULL,
      template_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      min_level TEXT NOT NULL,
      preview TEXT NOT NULL,
      max_per_hour INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_push_rules_connector ON notification_push_rules(connector_instance_id)',
  );
  _sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_push_rules_connector_template ON notification_push_rules(connector_instance_id, template_key)',
  );

  // Durable push delivery outbox (safety-net for Drizzle migration 0036)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_delivery_events (
      id TEXT PRIMARY KEY NOT NULL,
      notification_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'web_push',
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      suppression_reason TEXT,
      policy_snapshot TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_expires_at TEXT,
      subscriptions_attempted INTEGER NOT NULL DEFAULT 0,
      subscriptions_sent INTEGER NOT NULL DEFAULT 0,
      subscriptions_failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      last_error TEXT,
      FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
    )
  `);
  _sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_delivery_events_dedupe ON notification_delivery_events(dedupe_key)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_dispatch ON notification_delivery_events(status, next_attempt_at, lease_expires_at)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_notification ON notification_delivery_events(notification_id)',
  );
  _sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_notification_delivery_events_created_at ON notification_delivery_events(created_at)',
  );
}
