ALTER TABLE `tasks` ADD `planning_horizon` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_planning_horizon` ON `tasks` (`planning_horizon`);
