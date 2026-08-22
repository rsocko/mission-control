CREATE TABLE `connector_sync_controls` (
  `connector_id` text PRIMARY KEY NOT NULL,
  `scheduler_state` text DEFAULT 'scheduled' NOT NULL,
  `quarantine_id` text,
  `quarantined_at` text,
  `released_at` text,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_connector_sync_controls_state` ON `connector_sync_controls` (`scheduler_state`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `connector_sync_operator_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_id` text NOT NULL,
  `quarantine_id` text,
  `operation` text NOT NULL,
  `actor_type` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `job_id` text,
  `result_code` text NOT NULL,
  `cancelled_queued_count` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`job_id`) REFERENCES `sync_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connector_sync_operator_idempotency` ON `connector_sync_operator_runs` (`connector_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_connector_sync_operator_canary` ON `connector_sync_operator_runs` (`connector_id`,`quarantine_id`,`operation`) WHERE `operation` = 'canary';
--> statement-breakpoint
CREATE INDEX `idx_connector_sync_operator_connector` ON `connector_sync_operator_runs` (`connector_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `finance_insight_cutover_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_id` text NOT NULL,
  `operation` text NOT NULL,
  `actor_type` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `source_generation` text,
  `result_code` text NOT NULL,
  `blocker_codes` text DEFAULT '[]' NOT NULL,
  `legacy_expired_count` integer DEFAULT 0 NOT NULL,
  `imported_count` integer DEFAULT 0 NOT NULL,
  `suppressed_delivery_count` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text NOT NULL,
  FOREIGN KEY (`connector_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finance_insight_cutover_audit_idempotency` ON `finance_insight_cutover_audit` (`connector_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_finance_insight_cutover_audit_connector` ON `finance_insight_cutover_audit` (`connector_id`,`created_at`);