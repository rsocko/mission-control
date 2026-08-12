CREATE TABLE `maintenance_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_type` text NOT NULL,
	`status` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`checkpoint_start` text,
	`checkpoint_end` text,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`mutation_count` integer DEFAULT 0 NOT NULL,
	`has_more` integer DEFAULT false NOT NULL,
	`lease_expires_at` text NOT NULL,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_maintenance_agent_runs_active` ON `maintenance_agent_runs` (`agent_type`) WHERE "maintenance_agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `idx_maintenance_agent_runs_resume` ON `maintenance_agent_runs` (`agent_type`,`dry_run`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_maintenance_agent_runs_history` ON `maintenance_agent_runs` (`started_at`);