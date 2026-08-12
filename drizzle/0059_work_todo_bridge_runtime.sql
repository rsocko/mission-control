CREATE TABLE `work_todo_bridge_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`transport` text NOT NULL,
	`capability_profile` text NOT NULL,
	`list_delta_link` text,
	`reset_required` integer DEFAULT false NOT NULL,
	`last_ingest_at` text,
	`last_ingest_mode` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_todo_list_delta_state` (
	`connector_id` text NOT NULL,
	`list_source_id` text NOT NULL,
	`delta_link` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `list_source_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_work_todo_list_delta_connector` ON `work_todo_list_delta_state` (`connector_id`);--> statement-breakpoint
CREATE TABLE `work_todo_outbound_changes` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`task_id` text NOT NULL,
	`source_id` text NOT NULL,
	`list_source_id` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`operation` text NOT NULL,
	`fields` text,
	`task_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_id` text,
	`leased_at` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_work_todo_change_task_version` ON `work_todo_outbound_changes` (`connector_id`,`task_id`,`task_version`);--> statement-breakpoint
CREATE INDEX `idx_work_todo_change_ready` ON `work_todo_outbound_changes` (`connector_id`,`status`,`lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_work_todo_change_task` ON `work_todo_outbound_changes` (`task_id`);