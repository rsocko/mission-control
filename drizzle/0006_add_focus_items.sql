CREATE TABLE IF NOT EXISTS `focus_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`scope` text NOT NULL,
	`date` text NOT NULL,
	`slot` integer NOT NULL,
	`added_at` text NOT NULL,
	`is_ai_suggested` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_focus_items_scope_date` ON `focus_items` (`scope`, `date`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_focus_items_scope_date_slot` ON `focus_items` (`scope`, `date`, `slot`);
