CREATE TABLE `alert_projects` (
	`alert_id` text NOT NULL,
	`project_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_tags` (
	`alert_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`severity` text DEFAULT 'info' NOT NULL,
	`category` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`is_actionable` integer DEFAULT false NOT NULL,
	`action_url` text,
	`received_at` text NOT NULL,
	`expires_at` text,
	`related_task_id` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connector_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sync_mode` text DEFAULT 'poll' NOT NULL,
	`poll_interval_minutes` integer DEFAULT 5,
	`capabilities` text NOT NULL,
	`credentials` text DEFAULT '{}' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`synced_lists` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `epic_tags` (
	`epic_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_alert_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`kid_id` text,
	`period` text,
	`threshold_amount` real,
	`enabled` integer DEFAULT true NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`merchant_name` text,
	`original_category` text,
	`confirmed_category` text,
	`account_id` text,
	`account_name` text,
	`card_last4` text,
	`assigned_kid_id` text,
	`kid_assignment_method` text,
	`triage_status` text DEFAULT 'pending' NOT NULL,
	`flag_reason` text,
	`is_recurring` integer DEFAULT false NOT NULL,
	`notes` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_epics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text DEFAULT '#8b5cf6' NOT NULL,
	`icon` text,
	`category` text,
	`status` text DEFAULT 'active' NOT NULL,
	`status_override` text,
	`target_date` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hub_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text DEFAULT '#3b82f6' NOT NULL,
	`icon` text,
	`source_bindings` text DEFAULT '[]' NOT NULL,
	`auto_include_rules` text DEFAULT '[]' NOT NULL,
	`kanban_columns` text DEFAULT '[]' NOT NULL,
	`default_view` text DEFAULT 'list' NOT NULL,
	`default_filters` text,
	`status` text DEFAULT 'active' NOT NULL,
	`status_override` text,
	`epic_id` text,
	`category` text,
	`target_date` text,
	`started_at` text,
	`completed_at` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`api_key` text,
	`enabled` integer DEFAULT true NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kid_card_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`kid_id` text NOT NULL,
	`card_last4` text NOT NULL,
	`account_id` text,
	`confidence` real DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kid_merchant_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`kid_id` text NOT NULL,
	`merchant_pattern` text NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kid_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#3b82f6' NOT NULL,
	`avatar` text,
	`daily_limit` real,
	`weekly_limit` real,
	`monthly_limit` real
);
--> statement-breakpoint
CREATE TABLE `my_day_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`date` text NOT NULL,
	`added_at` text NOT NULL,
	`is_auto_included` integer DEFAULT false NOT NULL,
	`order` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbound_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`event_types` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_triggered_at` text,
	`last_status` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `priority_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`previous_priority` text NOT NULL,
	`new_priority` text NOT NULL,
	`direction` text NOT NULL,
	`write_back_triggered` integer DEFAULT false NOT NULL,
	`note` text,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`target_date` text,
	`completed_at` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_tags` (
	`project_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`task_count` integer DEFAULT 0 NOT NULL,
	`last_synced_at` text
);
--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`success` integer NOT NULL,
	`tasks_added` integer DEFAULT 0 NOT NULL,
	`tasks_updated` integer DEFAULT 0 NOT NULL,
	`tasks_removed` integer DEFAULT 0 NOT NULL,
	`alerts_added` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`synced_at` text NOT NULL,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`source` text,
	`color` text,
	`confirmed` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_projects` (
	`task_id` text NOT NULL,
	`project_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_schedules` (
	`task_id` text PRIMARY KEY NOT NULL,
	`scheduled_date` text NOT NULL,
	`scheduled_time` text,
	`estimated_duration` integer,
	`is_time_blocked` integer DEFAULT false NOT NULL,
	`recurrence` text
);
--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`due_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`parent_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`is_checklist_item` integer DEFAULT false NOT NULL,
	`source_list_id` text,
	`source_list_name` text,
	`assignee` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`last_synced_at` text NOT NULL,
	`kanban_column` text,
	`kanban_order` real
);
