ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_deleted_at` ON `tasks` (`deleted_at`);