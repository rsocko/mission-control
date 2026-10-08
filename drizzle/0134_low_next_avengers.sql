ALTER TABLE `task_reminder_occurrences` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `task_reminder_occurrences` ADD `sequence` integer;--> statement-breakpoint
CREATE INDEX `idx_task_reminder_occurrences_series_sequence` ON `task_reminder_occurrences` (`series_id`,`sequence`) WHERE "task_reminder_occurrences"."series_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminder_nag_interval` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminder_nag_stop_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminder_nag_series_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminder_nag_sequence` integer DEFAULT 0 NOT NULL;