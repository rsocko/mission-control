CREATE TABLE `finance_attribution_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`exception_id` text,
	`idempotency_key` text NOT NULL,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`requested_kid_id` text,
	`requested_decision` text,
	`result_status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_attribution_audit_idempotency` ON `finance_attribution_audit` (`connector_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_finance_attribution_audit_transaction` ON `finance_attribution_audit` (`connector_id`,`transaction_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `finance_attribution_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`source_ref` text,
	`status` text DEFAULT 'open' NOT NULL,
	`reason_code` text NOT NULL,
	`retryable` integer DEFAULT false NOT NULL,
	`review_state` text DEFAULT 'pending' NOT NULL,
	`source_fingerprint` text NOT NULL,
	`policy_version` integer,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolution` text,
	`created_at` text NOT NULL,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`resolved_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_attribution_exception_current` ON `finance_attribution_exceptions` (`connector_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_attribution_exception_queue` ON `finance_attribution_exceptions` (`connector_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `finance_attribution_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`kid_id` text NOT NULL,
	`policy_version` integer NOT NULL,
	`engine_version` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_attribution_subject_unique` ON `finance_attribution_subjects` (`connector_id`,`kid_id`);--> statement-breakpoint
CREATE INDEX `idx_finance_attribution_subject_policy` ON `finance_attribution_subjects` (`connector_id`,`policy_version`);--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_last_attempt_at` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_last_successful_at` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_last_error_code` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_policy_version` integer;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `attribution_engine_version` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `manual_decision_action` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `manual_decided_at` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_source_ref` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_contract_version` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_confidence` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_method` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_explanation` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_reasons` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_decision_source` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_policy_version` integer;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_engine_version` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_evaluated_at` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_review_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_provenance` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_last_error_code` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_retryable` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `attribution_updated_at` text;--> statement-breakpoint
UPDATE `finance_transactions`
SET `manual_decision_action` = CASE
      WHEN `assigned_kid_id` IS NULL THEN 'parent-expense'
      ELSE 'assign-kid'
    END,
    `manual_decided_at` = COALESCE(`last_seen_at`, `synced_at`),
    `attribution_status` = CASE
      WHEN `assigned_kid_id` IS NULL THEN 'unassigned'
      ELSE 'attributed'
    END,
    `attribution_confidence` = 'definite',
    `attribution_method` = 'manual',
    `attribution_explanation` = 'Preserved existing manual decision',
    `attribution_reasons` = '[]',
    `attribution_decision_source` = 'manual',
    `attribution_evaluated_at` = COALESCE(`last_seen_at`, `synced_at`),
    `attribution_review_state` = 'resolved',
    `attribution_provenance` = 'mission-control-legacy-manual-v1',
    `attribution_updated_at` = COALESCE(`last_seen_at`, `synced_at`),
    `kid_assignment_method` = 'manual'
WHERE `kid_assignment_method` = 'manual'
   OR (`kid_assignment_method` IS NULL AND `assigned_kid_id` IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_transactions_connector_source_ref` ON `finance_transactions` (`connector_instance_id`,`attribution_source_ref`);--> statement-breakpoint
CREATE INDEX `idx_finance_transactions_attribution_review` ON `finance_transactions` (`connector_instance_id`,`attribution_review_state`,`attribution_updated_at`);