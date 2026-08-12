CREATE TABLE `sync_deletion_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_id` text NOT NULL,
  `task_id` text NOT NULL,
  `source_id` text NOT NULL,
  `first_missing_at` text NOT NULL,
  `last_missing_at` text NOT NULL,
  `missing_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_deletion_candidate_source`
ON `sync_deletion_candidates` (`connector_id`, `source_id`);
--> statement-breakpoint
CREATE INDEX `idx_sync_deletion_candidate_task`
ON `sync_deletion_candidates` (`task_id`);
--> statement-breakpoint
CREATE TABLE `sync_deletion_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `original_task_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `source_id` text NOT NULL,
  `task_title` text NOT NULL,
  `reason` text NOT NULL,
  `task_data` text NOT NULL,
  `relationship_data` text NOT NULL,
  `deleted_at` text NOT NULL,
  `restored_at` text,
  `restored_task_id` text,
  `restore_mode` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_deletion_snapshot_task`
ON `sync_deletion_snapshots` (`original_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_sync_deletion_snapshot_deleted`
ON `sync_deletion_snapshots` (`deleted_at`);