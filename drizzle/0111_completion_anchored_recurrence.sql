ALTER TABLE `task_schedules` ADD `recurrence_mode` text NOT NULL DEFAULT 'schedule';--> statement-breakpoint
ALTER TABLE `tasks` ADD `recurrence_generated_from_task_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_recurrence_generated_from`
ON `tasks` (`recurrence_generated_from_task_id`)
WHERE `recurrence_generated_from_task_id` IS NOT NULL;
