CREATE TABLE `notification_delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`channel` text DEFAULT 'web_push' NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`suppression_reason` text,
	`policy_snapshot` text NOT NULL,
	`payload_snapshot` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_expires_at` text,
	`subscriptions_attempted` integer DEFAULT 0 NOT NULL,
	`subscriptions_sent` integer DEFAULT 0 NOT NULL,
	`subscriptions_failed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	`last_error` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_delivery_events_dedupe` ON `notification_delivery_events` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `idx_notification_delivery_events_dispatch` ON `notification_delivery_events` (`status`,`next_attempt_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_notification_delivery_events_notification` ON `notification_delivery_events` (`notification_id`);
--> statement-breakpoint
CREATE INDEX `idx_notification_delivery_events_created_at` ON `notification_delivery_events` (`created_at`);
