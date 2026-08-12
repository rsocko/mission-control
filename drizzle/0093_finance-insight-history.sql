CREATE TABLE `finance_insight_transaction_projection_facts` (
	`connector_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`occurred_on` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`connector_id`, `generation_id`, `source_ref`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_finance_insight_transaction_projection_date` ON `finance_insight_transaction_projection_facts` (`connector_id`,`generation_id`,`occurred_on`);--> statement-breakpoint
CREATE TABLE `finance_insight_transaction_projection_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_attempt_id` text,
	`last_attempt_at` text,
	`last_successful_at` text,
	`successful_generation_id` text,
	`source_as_of` text,
	`item_count` integer,
	`content_digest` text,
	`coverage_start` text,
	`coverage_end` text,
	`window_count` integer,
	`windows_digest` text,
	`bridge_contract_version` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_finance_insight_transaction_projection_status` ON `finance_insight_transaction_projection_state` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `finance_insight_transaction_projection_windows` (
	`connector_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`window_index` integer NOT NULL,
	`coverage_start` text NOT NULL,
	`coverage_end` text NOT NULL,
	`source_as_of` text NOT NULL,
	`item_count` integer NOT NULL,
	`content_digest` text NOT NULL,
	PRIMARY KEY(`connector_id`, `generation_id`, `window_index`),
	FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_transaction_window_coverage` ON `finance_insight_transaction_projection_windows` (`connector_id`,`generation_id`,`coverage_start`,`coverage_end`);