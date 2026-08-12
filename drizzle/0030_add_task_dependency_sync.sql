ALTER TABLE `task_dependencies` ADD `connector_instance_id` text;
--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD `sync_status` text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD `sync_action` text;
--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD `sync_error` text;
--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD `last_synced_at` text;
