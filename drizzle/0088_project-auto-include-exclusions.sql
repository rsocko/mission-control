CREATE TABLE `project_auto_include_exclusions` (
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`excluded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_auto_include_exclusions_project_task` ON `project_auto_include_exclusions` (`project_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_project_auto_include_exclusions_task` ON `project_auto_include_exclusions` (`task_id`);