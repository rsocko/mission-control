DROP INDEX IF EXISTS idx_notifications_reconcile;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN read_state TEXT NOT NULL DEFAULT 'unread'
  CHECK (read_state IN ('unread', 'read'));--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN disposition TEXT NOT NULL DEFAULT 'inbox'
  CHECK (disposition IN ('inbox', 'handled', 'dismissed'));--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active'
  CHECK (source_state IN ('active', 'resolved', 'deleted', 'unknown'));--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced'
  CHECK (sync_state IN ('synced', 'pending', 'failed'));--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN handled_at TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN snoozed_until TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN source_resolved_at TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN last_source_activity_at TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN last_source_activity_key TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN handled_source_activity_at TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN handled_source_activity_key TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN last_source_synced_at TEXT;--> statement-breakpoint
UPDATE notifications
SET
  read_state = CASE WHEN state = 'unread' THEN 'unread' ELSE 'read' END,
  disposition = CASE
    WHEN state = 'archived' THEN 'handled'
    WHEN state = 'dismissed' THEN 'dismissed'
    ELSE 'inbox'
  END,
  source_state = CASE WHEN state = 'resolved' THEN 'resolved' ELSE 'active' END,
  sync_state = CASE
    WHEN EXISTS (
      SELECT 1 FROM notification_writeback_jobs jobs
      WHERE jobs.notification_id = notifications.id AND jobs.status = 'failed'
    ) THEN 'failed'
    WHEN EXISTS (
      SELECT 1 FROM notification_writeback_jobs jobs
      WHERE jobs.notification_id = notifications.id AND jobs.status IN ('pending', 'sending')
    ) THEN 'pending'
    ELSE 'synced'
  END,
  handled_at = CASE WHEN state = 'archived' THEN COALESCE(archived_at, sort_at) END,
  source_resolved_at = CASE WHEN state = 'resolved' THEN COALESCE(resolved_at, sort_at) END,
  last_source_activity_at = sort_at,
  handled_source_activity_at = CASE WHEN state = 'archived' THEN sort_at END,
  last_source_synced_at = COALESCE(last_reconciled_at, received_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications(disposition, source_state, snoozed_until, sort_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_attention
  ON notifications(disposition, source_state, read_state, level);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_reconcile_source
  ON notifications(connector_instance_id, source_state, last_reconciled_at);
