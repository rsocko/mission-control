ALTER TABLE `tasks`
ADD COLUMN `local_disposition` text NOT NULL DEFAULT 'active'
CHECK (`local_disposition` IN ('active', 'handled', 'dismissed'));
--> statement-breakpoint
CREATE INDEX `idx_tasks_local_disposition`
ON `tasks` (`local_disposition`);
