CREATE TABLE `notification_saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_saved_views_name` ON `notification_saved_views` (`name`);--> statement-breakpoint
CREATE INDEX `idx_notification_saved_views_updated_at` ON `notification_saved_views` (`updated_at`);
