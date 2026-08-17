ALTER TABLE `task_triage_log` ADD `operation_id` text;--> statement-breakpoint
ALTER TABLE `task_triage_log` ADD `reversed_at` text;--> statement-breakpoint
CREATE TABLE `quick_sort_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`mode` text NOT NULL,
	`action` text NOT NULL,
	`label` text NOT NULL,
	`context_key` text NOT NULL,
	`queue_index` integer NOT NULL,
	`before_snapshot` text NOT NULL,
	`after_snapshot` text NOT NULL,
	`state` text NOT NULL,
	`ai_accepted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`undone_at` text
);--> statement-breakpoint
CREATE INDEX `idx_quick_sort_operations_task_created` ON `quick_sort_operations` (`task_id`,`created_at`);
