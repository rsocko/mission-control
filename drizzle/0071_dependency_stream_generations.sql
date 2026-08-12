ALTER TABLE `dependency_reconciliation_snapshots` ADD `phase` text DEFAULT 'reconciling' NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `read_mode` text;--> statement-breakpoint
ALTER TABLE `dependency_reconciliation_snapshots` ADD `collection_completed_at` text;--> statement-breakpoint
UPDATE `dependency_reconciliation_snapshots`
SET `read_mode` = 'legacy'
WHERE `read_mode` IS NULL;