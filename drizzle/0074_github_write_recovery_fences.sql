-- Fence comparison-mode GitHub writes and deletion recovery.
CREATE TABLE `task_source_write_leases` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL,
  `connector_instance_id` text NOT NULL,
  `task_id` text NOT NULL,
  `operation` text NOT NULL,
  `task_version` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `effective_mode` text NOT NULL,
  `mode_revision` integer NOT NULL,
  `comparison_run_id` text,
  `route` text NOT NULL DEFAULT 'legacy',
  `state` text NOT NULL DEFAULT 'claimed',
  `block_reason` text,
  `unknown_reason` text,
  `dispatched_at` text,
  `finalized_at` text,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`comparison_run_id`) REFERENCES `github_identity_comparison_runs`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `task_source_write_leases_operation_check` CHECK(`operation` IN ('create', 'update', 'complete', 'delete', 'label', 'comment', 'dependency', 'sub_issue', 'transfer')),
  CONSTRAINT `task_source_write_leases_state_check` CHECK(`state` IN ('claimed', 'authorized', 'dispatched', 'succeeded', 'failed', 'blocked', 'unknown', 'expired')),
  CONSTRAINT `task_source_write_leases_route_check` CHECK(`route` = 'legacy'),
  CONSTRAINT `task_source_write_leases_reason_check` CHECK((`block_reason` IS NULL OR length(`block_reason`) <= 100) AND (`unknown_reason` IS NULL OR length(`unknown_reason`) <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_source_write_leases_token` ON `task_source_write_leases` (`token`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_source_write_leases_task_operation_active` ON `task_source_write_leases` (`connector_instance_id`,`task_id`,`operation`) WHERE `state` IN ('claimed', 'authorized', 'dispatched', 'unknown');
--> statement-breakpoint
CREATE INDEX `idx_task_source_write_leases_connector_expiry` ON `task_source_write_leases` (`connector_instance_id`,`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_source_write_leases_operator` ON `task_source_write_leases` (`connector_instance_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `task_source_write_lease_targets` (
  `lease_id` text NOT NULL,
  `role` text NOT NULL,
  `external_entity_id` text,
  `repository_entity_id` text,
  `host_key` text,
  `locator_revision` integer,
  `binding_revision` text,
  `legacy_locator_digest` text,
  `owner` text,
  `repository` text,
  `issue_number` integer,
  PRIMARY KEY(`lease_id`, `role`),
  FOREIGN KEY (`lease_id`) REFERENCES `task_source_write_leases`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`external_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`repository_entity_id`) REFERENCES `external_entities`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `task_source_write_lease_targets_role_check` CHECK(`role` IN ('primary_issue', 'parent_issue', 'blocker_issue', 'blocked_issue', 'source_repository', 'target_repository')),
  CONSTRAINT `task_source_write_lease_targets_locator_check` CHECK(`locator_revision` IS NULL OR `locator_revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `idx_task_source_write_lease_targets_entity` ON `task_source_write_lease_targets` (`external_entity_id`,`repository_entity_id`);
--> statement-breakpoint
CREATE TABLE `github_identity_write_cycles` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `comparison_run_id` text,
  `job_id` text,
  `effective_mode` text NOT NULL,
  `mode_revision` integer NOT NULL,
  `pending_candidate_count` integer NOT NULL DEFAULT 0,
  `observed_route_count` integer NOT NULL DEFAULT 0,
  `legacy_applied_count` integer NOT NULL DEFAULT 0,
  `blocked_count` integer NOT NULL DEFAULT 0,
  `failed_count` integer NOT NULL DEFAULT 0,
  `unknown_count` integer NOT NULL DEFAULT 0,
  `state` text NOT NULL DEFAULT 'running',
  `started_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`comparison_run_id`) REFERENCES `github_identity_comparison_runs`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `github_identity_write_cycles_state_check` CHECK(`state` IN ('running', 'completed', 'interrupted')),
  CONSTRAINT `github_identity_write_cycles_count_check` CHECK(`pending_candidate_count` >= 0 AND `observed_route_count` >= 0 AND `legacy_applied_count` >= 0 AND `blocked_count` >= 0 AND `failed_count` >= 0 AND `unknown_count` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_github_identity_write_cycles_connector` ON `github_identity_write_cycles` (`connector_instance_id`,`completed_at`);
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `identity_mode` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `identity_mode_revision` integer;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `issue_entity_id` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `repository_entity_id` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `host_key` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `locator_revision` integer;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `binding_state` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_candidates` ADD `binding_revision` text;
--> statement-breakpoint
CREATE INDEX `idx_sync_deletion_candidate_fence` ON `sync_deletion_candidates` (`connector_id`,`identity_mode_revision`,`issue_entity_id`);
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `identity_mode` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `identity_mode_revision` integer;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `issue_entity_id` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `repository_entity_id` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `host_key` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `locator_revision` integer;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `binding_state` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `binding_revision` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `recovery_state` text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `recovery_claim_token` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `recovery_validation` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `quarantine_reason` text;
--> statement-breakpoint
ALTER TABLE `sync_deletion_snapshots` ADD `recovery_claimed_at` text;
--> statement-breakpoint
CREATE INDEX `idx_sync_deletion_snapshot_recovery` ON `sync_deletion_snapshots` (`connector_id`,`recovery_state`,`deleted_at`);
