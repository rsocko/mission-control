CREATE TABLE `task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	`depends_on_task_id` text NOT NULL REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	`type` text DEFAULT 'blocks' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_dependencies_pair_type` ON `task_dependencies` (`task_id`,`depends_on_task_id`,`type`);
