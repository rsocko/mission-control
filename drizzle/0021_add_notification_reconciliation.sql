-- Add reconciliation tracking columns to notifications table
-- Enables auto-resolution of stale notifications and staleness-based archival

ALTER TABLE notifications ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN last_reconciled_at TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN stale_since TEXT;--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN auto_resolve_reason TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notifications_reconcile ON notifications(connector_instance_id, state, last_reconciled_at);
