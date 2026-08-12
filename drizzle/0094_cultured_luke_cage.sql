CREATE TABLE `finance_insight_cutovers` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`cutover_at` text NOT NULL,
	`source_generation` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`legacy_disabled` integer DEFAULT false NOT NULL,
	`delivery_enabled` integer DEFAULT false NOT NULL,
	`legacy_expired_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`result` text DEFAULT '{}' NOT NULL,
	`rolled_back_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_finance_insight_cutover_delivery` ON `finance_insight_cutovers` (`delivery_enabled`,`updated_at`);--> statement-breakpoint
CREATE TABLE `finance_insight_publication_delivery` (
	`publication_id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`stage` text DEFAULT 'captured' NOT NULL,
	`next_batch_ordinal` integer DEFAULT 0 NOT NULL,
	`detector_set_version` text,
	`policy_version` integer,
	`evaluation_sequence` integer,
	`evaluation_state` text,
	`evaluation_idempotency_key` text,
	`last_attempt_at` text,
	`last_successful_at` text,
	`last_error_code` text,
	`last_error_retryable` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `finance_insight_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_delivery_connector_sequence` ON `finance_insight_publication_delivery` (`connector_id`,`source_sequence`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_delivery_stage` ON `finance_insight_publication_delivery` (`connector_id`,`stage`,`updated_at`);--> statement-breakpoint
ALTER TABLE `finance_insight_occurrences` ADD `revision_digest` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_insight_occurrences` ADD `source_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_finance_insight_occurrence_connector_series` ON `finance_insight_occurrences` (`connector_id`,`insight_id`,`source_updated_at`);