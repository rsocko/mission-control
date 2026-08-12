CREATE TABLE `task_linked_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`linked_at` text NOT NULL,
	`match_confidence` real,
	`metadata` text DEFAULT '{}' NOT NULL
);

CREATE INDEX `idx_task_linked_sources_task_id` ON `task_linked_sources` (`task_id`);
CREATE UNIQUE INDEX `idx_task_linked_sources_unique` ON `task_linked_sources` (`task_id`, `connector_type`, `source_id`);
