CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cadence_type` text NOT NULL,
	`cadence_config` text DEFAULT '{}' NOT NULL,
	`icon` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routine_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`date` text NOT NULL,
	`notes` text,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_routine_completions_routine_date` ON `routine_completions` (`routine_id`,`date`);
--> statement-breakpoint
CREATE INDEX `idx_routine_completions_date` ON `routine_completions` (`date`);
