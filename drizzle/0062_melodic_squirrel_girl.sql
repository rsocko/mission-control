CREATE TABLE `finance_mutation_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`connector_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`upstream_transaction_id` text NOT NULL,
	`operation` text NOT NULL,
	`requested_value` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_mutation_idempotency` ON `finance_mutation_audit` (`connector_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_finance_mutation_status` ON `finance_mutation_audit` (`connector_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_finance_mutation_transaction` ON `finance_mutation_audit` (`transaction_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `finance_sync_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_generation_id` text,
	`current_window_start` text,
	`current_window_end` text,
	`last_mode` text,
	`last_attempt_at` text,
	`last_successful_sync_at` text,
	`last_successful_window_start` text,
	`last_successful_window_end` text,
	`last_error_code` text,
	`last_error_message` text,
	`last_added` integer DEFAULT 0 NOT NULL,
	`last_updated` integer DEFAULT 0 NOT NULL,
	`last_deleted` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_finance_sync_state_status` ON `finance_sync_state` (`status`,`updated_at`);--> statement-breakpoint
INSERT INTO `connector_configs` (
	`id`, `type`, `name`, `enabled`, `sync_mode`, `poll_interval_minutes`,
	`capabilities`, `credentials`, `settings`, `synced_lists`, `created_at`, `updated_at`
)
SELECT
	'finance-manager-default', 'finance-manager', 'Finance Manager', 1, 'poll', 240,
	'{"read":true,"write":true,"delete":false,"sync":true,"subtasks":false,"lists":false,"tags":true,"tagWriteBack":false}',
	'{}', '{"bridgeUrl":"http://localhost:8100"}', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM `finance_transactions`)
	AND NOT EXISTS (
		SELECT 1 FROM `connector_configs`
		WHERE `type` IN ('finance-manager', 'monarch-money') AND `enabled` = 1
	);--> statement-breakpoint
CREATE TABLE `__new_finance_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text DEFAULT 'finance-manager-default' NOT NULL,
	`upstream_transaction_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` real NOT NULL,
	`merchant_name` text,
	`merchant_logo_url` text,
	`category_id` text,
	`original_category` text,
	`confirmed_category` text,
	`account_id` text,
	`account_name` text,
	`card_last4` text,
	`assigned_kid_id` text,
	`kid_assignment_method` text,
	`triage_status` text DEFAULT 'pending' NOT NULL,
	`flag_reason` text,
	`is_pending` integer DEFAULT false NOT NULL,
	`is_recurring` integer DEFAULT false NOT NULL,
	`notes` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`lifecycle_status` text DEFAULT 'active' NOT NULL,
	`deleted_at` text,
	`provenance_provider` text,
	`provenance_fetched_at` text,
	`source_fingerprint` text DEFAULT '' NOT NULL,
	`source_url` text,
	`last_seen_generation_id` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`synced_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_finance_transactions` (
	`id`, `connector_instance_id`, `upstream_transaction_id`, `date`, `amount`, `merchant_name`,
	`original_category`, `confirmed_category`, `account_id`, `account_name`,
	`card_last4`, `assigned_kid_id`, `kid_assignment_method`, `triage_status`,
	`flag_reason`, `is_recurring`, `notes`, `tags`, `first_seen_at`,
	`last_seen_at`, `synced_at`
)
SELECT
	`id`,
	COALESCE((
		SELECT `id` FROM `connector_configs`
		WHERE `type` IN ('finance-manager', 'monarch-money') AND `enabled` = 1
		ORDER BY CASE WHEN `id` = 'finance-manager-default' THEN 0 ELSE 1 END, `created_at`
		LIMIT 1
	), 'finance-manager-default'),
	`id`, `date`, `amount`, `merchant_name`, `original_category`,
	`confirmed_category`, `account_id`, `account_name`, `card_last4`,
	`assigned_kid_id`, `kid_assignment_method`, `triage_status`, `flag_reason`,
	`is_recurring`, `notes`, `tags`, `synced_at`, `synced_at`, `synced_at`
FROM `finance_transactions`;--> statement-breakpoint
DROP TABLE `finance_transactions`;--> statement-breakpoint
ALTER TABLE `__new_finance_transactions` RENAME TO `finance_transactions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_transactions_connector_upstream` ON `finance_transactions` (`connector_instance_id`,`upstream_transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_connector_date` ON `finance_transactions` (`connector_instance_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_connector_lifecycle` ON `finance_transactions` (`connector_instance_id`,`lifecycle_status`,`date`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_generation` ON `finance_transactions` (`connector_instance_id`,`last_seen_generation_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_date` ON `finance_transactions` (`date` DESC);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_assigned_kid_id` ON `finance_transactions` (`assigned_kid_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_confirmed_category` ON `finance_transactions` (`confirmed_category`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_triage_status` ON `finance_transactions` (`triage_status`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_kid_date` ON `finance_transactions` (`assigned_kid_id`,`date` DESC);