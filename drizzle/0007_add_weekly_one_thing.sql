CREATE TABLE IF NOT EXISTS `weekly_one_thing` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`week_monday` text NOT NULL,
	`is_manual_override` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_weekly_one_thing_week` ON `weekly_one_thing` (`week_monday`);
