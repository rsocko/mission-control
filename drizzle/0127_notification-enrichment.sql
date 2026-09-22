ALTER TABLE `notifications` ADD `enrichment_revision` text;
--> statement-breakpoint
ALTER TABLE `notifications` ADD `enrichment_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `notification_enrichment_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`source_generation` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_enrichment_generation` ON `notification_enrichment_jobs` (`notification_id`,`source_generation`);
--> statement-breakpoint
CREATE INDEX `idx_notification_enrichment_claim` ON `notification_enrichment_jobs` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_notification_enrichment_lease` ON `notification_enrichment_jobs` (`status`,`lease_expires_at`);
