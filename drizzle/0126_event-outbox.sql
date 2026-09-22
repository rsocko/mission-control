CREATE TABLE IF NOT EXISTS `event_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stable_key` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `event_outbox_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_sequence` integer NOT NULL,
	`webhook_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`last_error` text,
	`last_status` integer,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_sequence`) REFERENCES `event_outbox`(`sequence`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`webhook_id`) REFERENCES `outbound_webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_event_outbox_stable_key` ON `event_outbox` (`stable_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_outbox_type` ON `event_outbox` (`event_type`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_event_outbox_deliveries_pair` ON `event_outbox_deliveries` (`event_sequence`,`webhook_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_outbox_deliveries_dispatch` ON `event_outbox_deliveries` (`status`,`next_attempt_at`,`event_sequence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_outbox_deliveries_webhook_order` ON `event_outbox_deliveries` (`webhook_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_event_outbox_deliveries_lease` ON `event_outbox_deliveries` (`status`,`lease_expires_at`);
