ALTER TABLE `finance_accounts` ADD `last_seen_generation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_categories` ADD `last_seen_generation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_category_groups` ADD `last_seen_generation_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_tags` ADD `last_seen_generation_id` text DEFAULT '' NOT NULL;