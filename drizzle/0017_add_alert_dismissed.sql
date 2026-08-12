-- Add dismissed tracking columns to alerts so dismiss persists across page loads.
ALTER TABLE alerts ADD COLUMN is_dismissed INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE alerts ADD COLUMN dismissed_at TEXT;
