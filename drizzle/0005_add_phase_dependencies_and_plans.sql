-- Add dependency tracking and plan lifecycle columns to project_phases
-- These columns may already exist via the safety-net in db/index.ts
ALTER TABLE `project_phases` ADD COLUMN `start_after_phase_id` text;
--> statement-breakpoint
ALTER TABLE `project_phases` ADD COLUMN `plan_name` text;
--> statement-breakpoint
ALTER TABLE `project_phases` ADD COLUMN `plan_status` text DEFAULT 'draft';
