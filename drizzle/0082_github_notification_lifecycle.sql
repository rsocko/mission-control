ALTER TABLE `notifications` ADD `muted_at` text;
--> statement-breakpoint
ALTER TABLE `notification_writeback_jobs` ADD `action_type` text DEFAULT 'mark_done' NOT NULL;
--> statement-breakpoint
ALTER TABLE `notification_writeback_jobs` ADD `retryable` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_notification_writeback_jobs_notification` ON `notification_writeback_jobs` (`notification_id`,`status`);
