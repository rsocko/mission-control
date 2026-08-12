-- Add micro_status column to tasks table (idempotent via safety-net in db/index.ts)
-- SQLite does not support IF NOT EXISTS for ADD COLUMN. These statements will
-- harmlessly error if columns already exist; the Drizzle migrator records the
-- migration as applied regardless (statement-breakpoint splits execution).
-- The safety-net in db/index.ts pre-adds these columns before migrate() runs.
ALTER TABLE `tasks` ADD COLUMN `micro_status` text;
--> statement-breakpoint
ALTER TABLE `subtask_templates` ADD COLUMN `category` text;
--> statement-breakpoint
ALTER TABLE `subtask_templates` ADD COLUMN `type` text NOT NULL DEFAULT 'single';
--> statement-breakpoint
ALTER TABLE `subtask_templates` ADD COLUMN `workflow_tasks` text;
--> statement-breakpoint
ALTER TABLE `subtask_templates` ADD COLUMN `icon` text;
