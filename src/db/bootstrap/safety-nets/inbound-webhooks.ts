import type Database from 'better-sqlite3';

export function applyInboundWebhookSafetyNets(_sqlite: Database.Database): void {
  // Inbound Webhooks (safety-net for Drizzle migration 0004)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbound_webhooks (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT 'webhook',
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      default_action TEXT NOT NULL DEFAULT 'auto',
      field_mappings TEXT NOT NULL DEFAULT '{}',
      total_received INTEGER NOT NULL DEFAULT 0,
      last_received_at TEXT,
      last_status INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbound_webhook_log (
      id TEXT PRIMARY KEY NOT NULL,
      webhook_id TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      created_type TEXT,
      created_id TEXT,
      error_message TEXT,
      payload_preview TEXT,
      received_at TEXT NOT NULL
    )
  `);
}
