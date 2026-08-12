CREATE INDEX IF NOT EXISTS `idx_triage_items_canonical_url` ON `triage_items` (`canonical_url`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sync_log_connector_success_synced_at` ON `sync_log` (`connector_id`,`success`,`synced_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_list_counts` ON `tasks` (`is_checklist_item`,`connector_instance_id`,`source_list_id`,`status`);
