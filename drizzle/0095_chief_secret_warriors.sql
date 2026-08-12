CREATE TABLE `finance_insight_transaction_backfill_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`horizon_months` integer NOT NULL,
	`coverage_start` text NOT NULL,
	`coverage_end` text NOT NULL,
	`currency` text NOT NULL,
	`bridge_contract_version` text NOT NULL,
	`window_count` integer NOT NULL,
	`next_window_ordinal` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`last_error_code` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_backfill_plan_idempotency` ON `finance_insight_transaction_backfill_plans` (`connector_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_backfill_plan_status` ON `finance_insight_transaction_backfill_plans` (`connector_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `finance_insight_transaction_window_proofs` (
	`plan_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`window_ordinal` integer NOT NULL,
	`generation_ref` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`source_as_of` text NOT NULL,
	`item_count` integer NOT NULL,
	`content_digest` text NOT NULL,
	`currency` text NOT NULL,
	`bridge_contract_version` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`plan_id`, `window_ordinal`),
	FOREIGN KEY (`plan_id`) REFERENCES `finance_insight_transaction_backfill_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_window_generation` ON `finance_insight_transaction_window_proofs` (`connector_id`,`generation_ref`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_window_coverage` ON `finance_insight_transaction_window_proofs` (`connector_id`,`window_start`,`window_end`);