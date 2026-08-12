CREATE INDEX `idx_focus_items_task_id` ON `focus_items` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_related_task_id` ON `notifications` (`related_task_id`);--> statement-breakpoint
CREATE INDEX `idx_priority_sync_log_task_id` ON `priority_sync_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_depends_on` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE INDEX `idx_weekly_one_thing_task_id` ON `weekly_one_thing` (`task_id`);