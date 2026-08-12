CREATE TABLE `resets` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`went_well` text,
	`needs_adjustment` text,
	`notes` text,
	`stats` text,
	`ai_summary` text,
	`stale_actions` text DEFAULT '[]' NOT NULL,
	`carry_forward_items` text DEFAULT '[]' NOT NULL,
	`monthly_win` text,
	`monthly_change` text,
	`intentions` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_resets_type_period` ON `resets` (`type`, `period_start`);
