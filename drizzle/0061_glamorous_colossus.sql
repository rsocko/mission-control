CREATE TABLE `inbound_webhook_replays` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`received_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbound_webhook_replays_delivery` ON `inbound_webhook_replays` (`webhook_id`,`delivery_key`);--> statement-breakpoint
CREATE INDEX `idx_inbound_webhook_replays_expiry` ON `inbound_webhook_replays` (`expires_at`);--> statement-breakpoint
CREATE TABLE `notification_writeback_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`source_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_expires_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_writeback_jobs_dedupe` ON `notification_writeback_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_writeback_jobs_dispatch` ON `notification_writeback_jobs` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_writeback_jobs_connector` ON `notification_writeback_jobs` (`connector_instance_id`,`status`);