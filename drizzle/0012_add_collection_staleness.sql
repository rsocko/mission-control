-- Add staleness resurfacing support: maxAgeDays on collections, collectedAt on items
ALTER TABLE `triage_collections` ADD COLUMN `max_age_days` integer NOT NULL DEFAULT 14;
--> statement-breakpoint
ALTER TABLE `triage_items` ADD COLUMN `collected_at` text;
