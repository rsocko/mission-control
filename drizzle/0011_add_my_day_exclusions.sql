CREATE TABLE IF NOT EXISTS `my_day_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`date` text NOT NULL,
	`removed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_my_day_exclusions_date` ON `my_day_exclusions` (`date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_my_day_exclusions_task_date` ON `my_day_exclusions` (`task_id`, `date`);
