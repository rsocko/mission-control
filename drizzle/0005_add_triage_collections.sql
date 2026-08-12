-- Add triage_collections table and collection_id to triage_items
CREATE TABLE IF NOT EXISTS `triage_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`color` text NOT NULL DEFAULT '#3b82f6',
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `triage_items` ADD COLUMN `collection_id` text;
