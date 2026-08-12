CREATE TABLE `github_bulk_transfer_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `phase` text NOT NULL,
  `actor` text NOT NULL,
  `source_repository` text NOT NULL,
  `target_repository` text NOT NULL,
  `plan_hash` text NOT NULL,
  `plan` text NOT NULL,
  `connector_was_enabled` integer NOT NULL,
  `transferred_count` integer DEFAULT 0 NOT NULL,
  `skipped_count` integer DEFAULT 0 NOT NULL,
  `failed_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT "github_bulk_transfer_runs_phase_check" CHECK("github_bulk_transfer_runs"."phase" IN ('running', 'completed', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_bulk_transfer_runs_idempotency` ON `github_bulk_transfer_runs` (`connector_instance_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_bulk_transfer_runs_active_connector` ON `github_bulk_transfer_runs` (`connector_instance_id`) WHERE "github_bulk_transfer_runs"."phase" = 'running';
--> statement-breakpoint
CREATE INDEX `idx_github_bulk_transfer_runs_phase` ON `github_bulk_transfer_runs` (`phase`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `github_bulk_transfer_items` (
  `run_id` text NOT NULL,
  `task_id` text NOT NULL,
  `issue_entity_id` text NOT NULL,
  `issue_stable_id` text NOT NULL,
  `source_number` integer NOT NULL,
  `target_number` integer,
  `state` text DEFAULT 'pending' NOT NULL,
  `before_digest` text NOT NULL,
  `new_source_id` text,
  `last_error` text,
  `started_at` text,
  `completed_at` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`run_id`, `task_id`),
  FOREIGN KEY (`run_id`) REFERENCES `github_bulk_transfer_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`issue_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "github_bulk_transfer_items_state_check" CHECK("github_bulk_transfer_items"."state" IN ('pending', 'transferring', 'transferred', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_bulk_transfer_items_issue` ON `github_bulk_transfer_items` (`run_id`,`issue_stable_id`);
--> statement-breakpoint
CREATE INDEX `idx_github_bulk_transfer_items_state` ON `github_bulk_transfer_items` (`run_id`,`state`,`source_number`);
--> statement-breakpoint
CREATE TABLE `github_bulk_transfer_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `run_id` text NOT NULL,
  `task_id` text,
  `event_type` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `github_bulk_transfer_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_github_bulk_transfer_events_run` ON `github_bulk_transfer_events` (`run_id`,`id`);
