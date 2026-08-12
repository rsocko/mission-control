-- Add project_phases and project_phase_items tables (replaces wave_plans concept)
CREATE TABLE IF NOT EXISTS `project_phases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL DEFAULT 'pending',
	`color` text,
	`estimated_days` real,
	`target_start` text,
	`target_end` text,
	`sort_order` real NOT NULL DEFAULT 0,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_phase_items` (
	`id` text PRIMARY KEY NOT NULL,
	`phase_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sort_order` real NOT NULL DEFAULT 0,
	`estimated_effort_hours` real,
	`is_proposed` integer NOT NULL DEFAULT 0,
	`proposal_type` text,
	`created_at` text NOT NULL
);
