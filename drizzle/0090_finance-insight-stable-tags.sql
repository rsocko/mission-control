ALTER TABLE `finance_transactions` ADD `tag_references` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE finance_sync_state
SET last_successful_window_end = NULL
WHERE connector_id IN (
	SELECT DISTINCT connector_instance_id
	FROM finance_transactions
	WHERE lifecycle_status = 'active' AND tags <> '[]'
);