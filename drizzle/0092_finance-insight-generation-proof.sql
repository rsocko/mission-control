ALTER TABLE `finance_dataset_sync_state` ADD `insight_item_count` integer;--> statement-breakpoint
ALTER TABLE `finance_dataset_sync_state` ADD `insight_content_digest` text;--> statement-breakpoint
ALTER TABLE `finance_dataset_sync_state` ADD `insight_bridge_contract_version` text;--> statement-breakpoint
ALTER TABLE `finance_insight_occurrences` ADD `source_generation` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_insight_occurrences` ADD `is_tombstone` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `finance_insight_occurrences`
SET `source_generation` = COALESCE((
	SELECT `source_generation`
	FROM `finance_insight_occurrence_cache_state`
	WHERE `finance_insight_occurrence_cache_state`.`connector_id` =
		`finance_insight_occurrences`.`connector_id`
), '')
WHERE `source_generation` = '';--> statement-breakpoint
UPDATE `finance_insight_occurrence_cache_state`
SET `purge_after` = strftime('%Y-%m-%dT%H:%M:%fZ', `source_as_of`, '+90 days');--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_item_count` integer;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_content_digest` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_projection_start_date` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_projection_coverage_start` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_projection_coverage_end` text;--> statement-breakpoint
ALTER TABLE `finance_sync_state` ADD `last_successful_bridge_contract_version` text;