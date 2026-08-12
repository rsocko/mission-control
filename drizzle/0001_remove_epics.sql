DROP TABLE IF EXISTS `epic_tags`;--> statement-breakpoint
DROP TABLE IF EXISTS `hub_epics`;--> statement-breakpoint
-- Remove epics concept: drop hub_epics and epic_tags tables, remove epic_id from hub_projects
-- Note: SQLite < 3.35 does not support DROP COLUMN; this is a no-op if column was already removed.
-- The safety-net in db/index.ts handles this for older SQLite versions.
ALTER TABLE `hub_projects` DROP COLUMN `epic_id`;
