ALTER TABLE `task_source_write_leases` ADD `intent_kind` text;--> statement-breakpoint
ALTER TABLE `task_source_write_leases` ADD `intent_digest` text;--> statement-breakpoint
ALTER TABLE `task_source_write_leases` ADD `result_digest` text;--> statement-breakpoint
CREATE TABLE `github_write_outcome_events` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `cycle_id` text NOT NULL,
  `lease_id` text NOT NULL,
  `task_id` text NOT NULL,
  `operation` text NOT NULL,
  `task_version` text NOT NULL,
  `expected_mode_revision` integer NOT NULL,
  `outcome` text NOT NULL,
  `proof_kind` text NOT NULL,
  `proof_digest` text NOT NULL,
  `remote_state` text NOT NULL,
  `actor` text NOT NULL,
  `reason` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`cycle_id`) REFERENCES `github_identity_write_cycles`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`lease_id`) REFERENCES `task_source_write_leases`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `github_write_outcome_events_outcome_check` CHECK(`outcome` IN ('proven_applied', 'proven_not_applied_retryable')),
  CONSTRAINT `github_write_outcome_events_proof_check` CHECK(
    (`proof_kind` = 'issue_state'
      AND `remote_state` IN ('open', 'closed', 'authoritative_absent'))
    OR (`proof_kind` = 'local_finalization'
      AND `remote_state` IN ('locally_succeeded', 'locally_failed_pre_dispatch'))
  ),
  CONSTRAINT `github_write_outcome_events_audit_check` CHECK(
    length(`actor`) BETWEEN 1 AND 80
    AND length(`reason`) BETWEEN 3 AND 500
    AND length(`idempotency_key`) BETWEEN 8 AND 192
    AND length(`proof_digest`) = 64
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_write_outcome_events_connector_key`
  ON `github_write_outcome_events` (`connector_instance_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_write_outcome_events_lease`
  ON `github_write_outcome_events` (`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_github_write_outcome_events_cycle`
  ON `github_write_outcome_events` (`cycle_id`,`created_at`);
