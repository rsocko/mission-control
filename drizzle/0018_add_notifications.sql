-- Notifications system: replaces alerts with richer notification model
-- Adds notifications table, notification_actions table, and backfills from alerts.

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
  read_at TEXT,
  dismissed_at TEXT,
  resolved_at TEXT,
  archived_at TEXT,

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

  metadata TEXT NOT NULL DEFAULT '{}',
  presentation TEXT NOT NULL DEFAULT '{}'
);--> statement-breakpoint
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
  created_by TEXT NOT NULL DEFAULT 'system'
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_state ON notifications(state);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_level ON notifications(level);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications(received_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_connector ON notifications(connector_type);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_sort_at ON notifications(state, sort_at);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_source_id ON notifications(source_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_actions_notification ON notification_actions(notification_id);--> statement-breakpoint
-- Backfill from existing alerts table (use INSERT OR IGNORE to handle duplicates gracefully)
INSERT OR IGNORE INTO notifications (
  id, source_id, connector_type, connector_instance_id,
  title, body, level, level_rank, category, template_key,
  state, read_at, dismissed_at,
  is_actionable, received_at, sort_at, expires_at,
  related_task_id, metadata, presentation
)
SELECT
  id, source_id, connector_type, connector_instance_id,
  title, body,
  CASE severity
    WHEN 'critical' THEN 'urgent'
    WHEN 'high' THEN 'action_needed'
    WHEN 'medium' THEN 'heads_up'
    WHEN 'low' THEN 'fyi'
    WHEN 'info' THEN 'digest'
    ELSE 'fyi'
  END,
  CASE severity
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    WHEN 'info' THEN 4
    ELSE 3
  END,
  category,
  NULL,
  CASE
    WHEN is_dismissed = 1 THEN 'dismissed'
    WHEN is_read = 1 THEN 'read'
    ELSE 'unread'
  END,
  CASE WHEN is_read = 1 THEN received_at ELSE NULL END,
  dismissed_at,
  is_actionable,
  received_at,
  received_at,
  expires_at,
  related_task_id,
  metadata,
  '{}'
FROM alerts
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='alerts');--> statement-breakpoint
-- Create actions for alerts that had action URLs
INSERT OR IGNORE INTO notification_actions (
  id, notification_id, action_type, label, icon, variant, is_primary, sort_order, payload, opens_external, created_by
)
SELECT
  id || '-action-open',
  id,
  'open_url',
  'Open',
  'external-link',
  'primary',
  1,
  0,
  json_object('url', action_url),
  1,
  'system'
FROM alerts
WHERE action_url IS NOT NULL AND action_url != ''
AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='alerts');
