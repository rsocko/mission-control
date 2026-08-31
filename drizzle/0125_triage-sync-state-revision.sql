CREATE TABLE IF NOT EXISTS `triage_sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_cursor` text,
	`last_synced_at` text,
	`total_imported` integer DEFAULT 0 NOT NULL,
	`total_skipped` integer DEFAULT 0 NOT NULL,
	`last_run_imported` integer DEFAULT 0 NOT NULL,
	`last_run_skipped` integer DEFAULT 0 NOT NULL,
	`last_run_errors` text DEFAULT '[]' NOT NULL,
	`last_run_duration_ms` integer
);
--> statement-breakpoint
ALTER TABLE `triage_sync_state` ADD `revision` integer DEFAULT 0 NOT NULL;