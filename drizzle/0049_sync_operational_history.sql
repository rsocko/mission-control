ALTER TABLE `sync_log` ADD `job_id` text;
--> statement-breakpoint
ALTER TABLE `sync_log` ADD `trigger` text;
--> statement-breakpoint
ALTER TABLE `sync_log` ADD `scheduled_for` text;
--> statement-breakpoint
ALTER TABLE `sync_log` ADD `started_at` text;
--> statement-breakpoint
ALTER TABLE `sync_log` ADD `attempt` integer;
--> statement-breakpoint
ALTER TABLE `sync_log` ADD `max_attempts` integer;
--> statement-breakpoint
CREATE INDEX `idx_sync_log_job_id` ON `sync_log` (`job_id`);
