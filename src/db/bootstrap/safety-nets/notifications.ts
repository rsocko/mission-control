import type Database from 'better-sqlite3';

export function applyNotificationSafetyNets(_sqlite: Database.Database): void {
  // Notifications (safety-net for Drizzle migration 0018)
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      level TEXT NOT NULL DEFAULT 'fyi',
      level_rank INTEGER NOT NULL DEFAULT 3,
      category TEXT NOT NULL DEFAULT 'system',
      template_key TEXT,
      state TEXT NOT NULL DEFAULT 'unread',
      read_state TEXT NOT NULL DEFAULT 'unread',
      disposition TEXT NOT NULL DEFAULT 'inbox',
      source_state TEXT NOT NULL DEFAULT 'active',
      sync_state TEXT NOT NULL DEFAULT 'synced',
      read_at TEXT,
      handled_at TEXT,
      dismissed_at TEXT,
      resolved_at TEXT,
      archived_at TEXT,
      snoozed_until TEXT,
      source_resolved_at TEXT,
      last_source_activity_at TEXT,
      last_source_activity_key TEXT,
      handled_source_activity_at TEXT,
      handled_source_activity_key TEXT,
      last_source_synced_at TEXT,
      is_actionable INTEGER NOT NULL DEFAULT 0,
      primary_action_id TEXT,
      ai_suggested_action_id TEXT,
      received_at TEXT NOT NULL,
      sort_at TEXT NOT NULL,
      expires_at TEXT,
      group_key TEXT,
      dedupe_key TEXT,
      related_task_id TEXT,
      related_project_id TEXT,
      related_entity_type TEXT,
      related_entity_id TEXT,
      navigation_target TEXT,
      reconcile_attempts INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at TEXT,
      stale_since TEXT,
      auto_resolve_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      presentation TEXT NOT NULL DEFAULT '{}'
    )
  `);
  // Safety-net ALTERs for existing databases missing lifecycle/reconciliation columns.
  for (const col of [
    ['read_state', "TEXT NOT NULL DEFAULT 'unread'"],
    ['disposition', "TEXT NOT NULL DEFAULT 'inbox'"],
    ['source_state', "TEXT NOT NULL DEFAULT 'active'"],
    ['sync_state', "TEXT NOT NULL DEFAULT 'synced'"],
    ['handled_at', 'TEXT'],
    ['snoozed_until', 'TEXT'],
    ['source_resolved_at', 'TEXT'],
    ['last_source_activity_at', 'TEXT'],
    ['last_source_activity_key', 'TEXT'],
    ['handled_source_activity_at', 'TEXT'],
    ['handled_source_activity_key', 'TEXT'],
    ['last_source_synced_at', 'TEXT'],
    ['reconcile_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_reconciled_at', 'TEXT'],
    ['stale_since', 'TEXT'],
    ['auto_resolve_reason', 'TEXT'],
  ]) {
    try { _sqlite.exec(`ALTER TABLE notifications ADD COLUMN ${col[0]} ${col[1]}`); } catch { /* already exists */ }
  }
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notification_actions (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT,
      variant TEXT NOT NULL DEFAULT 'secondary',
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT '{}',
      opens_external INTEGER NOT NULL DEFAULT 0,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      execution_state TEXT NOT NULL DEFAULT 'pending',
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT
    )
  `);
  // Safety-net ALTERs for existing databases missing workflow execution state (migration 0032)
  for (const col of [
    ['execution_state', "TEXT NOT NULL DEFAULT 'pending'"],
    ['claimed_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['last_error', 'TEXT'],
  ]) {
    try { _sqlite.exec(`ALTER TABLE notification_actions ADD COLUMN ${col[0]} ${col[1]}`); } catch { /* already exists */ }
  }
  _sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_source_id ON notifications(source_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_state ON notifications(state)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_sort_at ON notifications(state, sort_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON notifications(disposition, source_state, snoozed_until, sort_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_attention ON notifications(disposition, source_state, read_state, level)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_reconcile_source ON notifications(connector_instance_id, source_state, last_reconciled_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_level ON notifications(level)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications(received_at)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_connector ON notifications(connector_type)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notification_actions_notification ON notification_actions(notification_id)');
  _sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_reconcile ON notifications(connector_instance_id, state, last_reconciled_at)');
}
