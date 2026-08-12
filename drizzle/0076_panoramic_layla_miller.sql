CREATE TABLE `finance_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`upstream_account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`type` text NOT NULL,
	`institution` text,
	`mask` text,
	`is_active` integer DEFAULT true NOT NULL,
	`source_is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`deactivated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_accounts_connector_upstream` ON `finance_accounts` (`connector_id`,`upstream_account_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_accounts_connector_active` ON `finance_accounts` (`connector_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `finance_budget_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`upstream_category_id` text NOT NULL,
	`category_name` text NOT NULL,
	`budgeted` real NOT NULL,
	`spent` real NOT NULL,
	`remaining` real NOT NULL,
	`percent_used` real,
	`is_current` integer DEFAULT true NOT NULL,
	`source_as_of` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_budgets_generation_category` ON `finance_budget_snapshots` (`connector_id`,`generation_id`,`period_start`,`upstream_category_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_budgets_current` ON `finance_budget_snapshots` (`connector_id`,`is_current`,`period_start`);--> statement-breakpoint
CREATE TABLE `finance_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`upstream_category_id` text NOT NULL,
	`name` text NOT NULL,
	`upstream_group_id` text,
	`group_name` text,
	`icon` text,
	`is_active` integer DEFAULT true NOT NULL,
	`source_is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`deactivated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_categories_connector_upstream` ON `finance_categories` (`connector_id`,`upstream_category_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_categories_connector_active` ON `finance_categories` (`connector_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `idx_finance_categories_connector_group` ON `finance_categories` (`connector_id`,`upstream_group_id`);--> statement-breakpoint
CREATE TABLE `finance_category_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`upstream_group_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`source_is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`deactivated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_category_groups_connector_upstream` ON `finance_category_groups` (`connector_id`,`upstream_group_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_category_groups_connector_active` ON `finance_category_groups` (`connector_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `finance_dataset_sync_state` (
	`connector_id` text NOT NULL,
	`dataset` text NOT NULL,
	`last_attempt_at` text,
	`last_attempt_outcome` text,
	`last_successful_at` text,
	`source_as_of` text,
	`fresh_until` text,
	`coverage_start` text,
	`coverage_end` text,
	`current_generation_id` text,
	`previous_generation_id` text,
	`schema_version` text DEFAULT '1.0' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`published_item_count` integer DEFAULT 0 NOT NULL,
	`source_limit` integer NOT NULL,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `dataset`)
);
--> statement-breakpoint
CREATE INDEX `idx_finance_dataset_state_freshness` ON `finance_dataset_sync_state` (`connector_id`,`fresh_until`);--> statement-breakpoint
CREATE TABLE `finance_recurring_obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`upstream_recurring_id` text NOT NULL,
	`merchant` text NOT NULL,
	`amount` real NOT NULL,
	`frequency` text NOT NULL,
	`next_expected_date` text,
	`upstream_account_id` text,
	`account_name` text,
	`upstream_category_id` text,
	`category_name` text,
	`is_current` integer DEFAULT true NOT NULL,
	`source_as_of` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_recurring_generation_upstream` ON `finance_recurring_obligations` (`connector_id`,`generation_id`,`upstream_recurring_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_recurring_current` ON `finance_recurring_obligations` (`connector_id`,`is_current`);--> statement-breakpoint
CREATE TABLE `finance_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`upstream_tag_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`source_is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`deactivated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_tags_connector_upstream` ON `finance_tags` (`connector_id`,`upstream_tag_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_tags_connector_active` ON `finance_tags` (`connector_id`,`is_active`);