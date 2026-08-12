CREATE TABLE `finance_insight_occurrence_cache_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`source_generation` text NOT NULL,
	`item_count` integer NOT NULL,
	`source_as_of` text NOT NULL,
	`refreshed_at` text NOT NULL,
	`summary_expires_at` text NOT NULL,
	`purge_after` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_insight_occurrences` (
	`connector_id` text NOT NULL,
	`occurrence_id` text NOT NULL,
	`insight_id` text NOT NULL,
	`delivery_revision` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_source_ref` text NOT NULL,
	`entity_label` text NOT NULL,
	`analysis_state` text NOT NULL,
	`source_lifecycle` text,
	`severity` text NOT NULL,
	`confidence` text NOT NULL,
	`baseline_sufficiency` text NOT NULL,
	`headline` text NOT NULL,
	`freshness_state` text NOT NULL,
	`source_as_of` text,
	`target_descriptors` text NOT NULL,
	`summary_payload` text,
	`source_updated_at` text NOT NULL,
	`cached_at` text NOT NULL,
	PRIMARY KEY(`connector_id`, `occurrence_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_finance_insight_occurrence_connector_updated` ON `finance_insight_occurrences` (`connector_id`,`source_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_occurrence_connector_lifecycle` ON `finance_insight_occurrences` (`connector_id`,`source_lifecycle`,`source_updated_at`);--> statement-breakpoint
CREATE TABLE `finance_insight_publication_facts` (
	`publication_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_ref` text NOT NULL,
	`batch_index` integer NOT NULL,
	`fact_index` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`publication_id`, `kind`, `source_ref`),
	FOREIGN KEY (`publication_id`) REFERENCES `finance_insight_publications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_publication_fact_position` ON `finance_insight_publication_facts` (`publication_id`,`kind`,`batch_index`,`fact_index`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_publication_fact_batch` ON `finance_insight_publication_facts` (`publication_id`,`kind`,`batch_index`);--> statement-breakpoint
CREATE TABLE `finance_insight_publication_state` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`provider_type` text NOT NULL,
	`latest_publication_id` text,
	`latest_generation_identity` text,
	`last_source_sequence` integer DEFAULT 0 NOT NULL,
	`last_capture_attempt_at` text,
	`last_capture_outcome` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_insight_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`generation_identity` text NOT NULL,
	`contract_version` text NOT NULL,
	`provider_type` text NOT NULL,
	`source_as_of` text NOT NULL,
	`coverage_start` text NOT NULL,
	`coverage_end` text NOT NULL,
	`currency` text NOT NULL,
	`bridge_contract_version` text NOT NULL,
	`captured_constituents` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`create_request` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`alert_capable` integer DEFAULT false NOT NULL,
	`captured_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_publication_connector_sequence` ON `finance_insight_publications` (`connector_id`,`source_sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_publication_connector_identity` ON `finance_insight_publications` (`connector_id`,`generation_identity`);--> statement-breakpoint
CREATE INDEX `idx_finance_insight_publication_connector_captured` ON `finance_insight_publications` (`connector_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_generation_id` text;
--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_source_as_of` text;