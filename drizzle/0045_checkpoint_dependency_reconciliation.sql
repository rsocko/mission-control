CREATE TABLE `dependency_reconciliation_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `status` text NOT NULL,
  `cursor` integer DEFAULT 0 NOT NULL,
  `total` integer NOT NULL,
  `batch_size` integer NOT NULL,
  `failure_count` integer DEFAULT 0 NOT NULL,
  `imported_count` integer DEFAULT 0 NOT NULL,
  `removed_count` integer DEFAULT 0 NOT NULL,
  `started_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  `failed_at` text,
  `next_attempt_at` text,
  `failure_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dependency_snapshot_active_connector`
ON `dependency_reconciliation_snapshots` (`connector_instance_id`)
WHERE `status` IN ('running', 'failed');
--> statement-breakpoint
CREATE INDEX `idx_dependency_snapshot_connector_updated`
ON `dependency_reconciliation_snapshots` (`connector_instance_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_dependency_snapshot_connector_status_completed`
ON `dependency_reconciliation_snapshots` (`connector_instance_id`, `status`, `completed_at`);
--> statement-breakpoint
CREATE INDEX `idx_dependency_snapshot_resume`
ON `dependency_reconciliation_snapshots` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE TABLE `dependency_reconciliation_items` (
  `snapshot_id` text NOT NULL,
  `position` integer NOT NULL,
  `source_id` text NOT NULL,
  `verified` integer DEFAULT false NOT NULL,
  PRIMARY KEY (`snapshot_id`, `position`),
  FOREIGN KEY (`snapshot_id`)
    REFERENCES `dependency_reconciliation_snapshots` (`id`)
    ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dependency_snapshot_item_source`
ON `dependency_reconciliation_items` (`snapshot_id`, `source_id`);
--> statement-breakpoint
CREATE TABLE `dependency_reconciliation_edges` (
  `snapshot_id` text NOT NULL,
  `blocker_source_id` text NOT NULL,
  `blocked_source_id` text NOT NULL,
  PRIMARY KEY (`snapshot_id`, `blocker_source_id`, `blocked_source_id`),
  FOREIGN KEY (`snapshot_id`)
    REFERENCES `dependency_reconciliation_snapshots` (`id`)
    ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dependency_snapshot_edge_blocked`
ON `dependency_reconciliation_edges` (`snapshot_id`, `blocked_source_id`);
--> statement-breakpoint
CREATE TABLE `dependency_reconciliation_candidates` (
  `snapshot_id` text NOT NULL,
  `dependency_id` text NOT NULL,
  PRIMARY KEY (`snapshot_id`, `dependency_id`),
  FOREIGN KEY (`snapshot_id`)
    REFERENCES `dependency_reconciliation_snapshots` (`id`)
    ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dependency_snapshot_candidate_dependency`
ON `dependency_reconciliation_candidates` (`dependency_id`);