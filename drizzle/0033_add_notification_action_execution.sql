ALTER TABLE notification_actions ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE notification_actions ADD COLUMN claimed_at TEXT;--> statement-breakpoint
ALTER TABLE notification_actions ADD COLUMN completed_at TEXT;--> statement-breakpoint
ALTER TABLE notification_actions ADD COLUMN last_error TEXT;
