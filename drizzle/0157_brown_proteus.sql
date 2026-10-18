CREATE TABLE `my_day_suggestion_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`date` text NOT NULL,
	`excluded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_my_day_suggestion_exclusions_task_date` ON `my_day_suggestion_exclusions` (`task_id`,`date`);