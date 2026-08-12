-- Add subtask_templates table for persistent template storage
CREATE TABLE IF NOT EXISTS `subtask_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`subtasks` text NOT NULL,
	`is_built_in` integer NOT NULL DEFAULT false,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
