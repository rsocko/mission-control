-- Permanent GitHub NodeID cutover.
--
-- Production already runs NodeID-first identity, so the comparison evidence
-- tables are pure cutover exhaust: `github_identity_comparison_records`
-- (~1.28 GiB) and `github_identity_sub_issue_population_members` (~822 MiB)
-- described what the cutover observed, not what the hierarchy is. Actual task
-- hierarchy lives in `tasks.parent_id`, `tasks.depth`, and `tasks.metadata`, and
-- canonical identity lives in `external_entities.stable_id` plus
-- `external_entity_bindings`/`external_entity_locators`; none of that is
-- touched here.
--
-- Operator steps (requires a short web/worker downtime):
--   1. Stop every connector-capable process (web and sync worker).
--   2. Reconcile any quarantined or interrupted write cycle first with
--      `github-identity-operator write-cycle-reconcile` / `write-outcome-resolve`.
--      Active, dispatched, and unknown write leases and their targets are
--      preserved verbatim by this migration, so they can also be reconciled
--      afterwards.
--   3. Start the web process so this migration applies, then start the worker.
--   4. Reclaim the freed pages with a manual `VACUUM` during a maintenance
--      window. This migration deliberately does not VACUUM.
--
-- Every statement below is re-runnable: table rebuilds copy only columns that
-- exist in both the old and new shape, and each rebuild swap is one statement.
PRAGMA foreign_keys = OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_task_source_write_leases`;
CREATE TABLE `__new_task_source_write_leases` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL,
  `connector_instance_id` text NOT NULL,
  `task_id` text NOT NULL,
  `operation` text NOT NULL,
  `task_version` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `mode_revision` integer NOT NULL,
  `write_cycle_id` text,
  `state` text DEFAULT 'claimed' NOT NULL,
  `cycle_observed_at` text,
  `cycle_outcome` text,
  `intent_kind` text,
  `intent_digest` text,
  `result_digest` text,
  `block_reason` text,
  `unknown_reason` text,
  `dispatched_at` text,
  `finalized_at` text,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`write_cycle_id`) REFERENCES `github_identity_write_cycles`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `task_source_write_leases_operation_check` CHECK(`operation` IN ('create', 'update', 'complete', 'delete', 'label', 'comment', 'dependency', 'sub_issue', 'transfer')),
  CONSTRAINT `task_source_write_leases_state_check` CHECK(`state` IN ('claimed', 'authorized', 'dispatched', 'succeeded', 'failed', 'blocked', 'unknown', 'expired')),
  CONSTRAINT `task_source_write_leases_reason_check` CHECK((`block_reason` IS NULL OR length(`block_reason`) <= 100) AND (`unknown_reason` IS NULL OR length(`unknown_reason`) <= 100))
);
INSERT INTO `__new_task_source_write_leases` (
  `id`, `token`, `connector_instance_id`, `task_id`, `operation`, `task_version`,
  `idempotency_key`, `mode_revision`, `write_cycle_id`, `state`, `cycle_observed_at`,
  `cycle_outcome`, `intent_kind`, `intent_digest`, `result_digest`, `block_reason`,
  `unknown_reason`, `dispatched_at`, `finalized_at`, `expires_at`, `created_at`, `updated_at`
)
SELECT
  `id`, `token`, `connector_instance_id`, `task_id`, `operation`, `task_version`,
  `idempotency_key`, `mode_revision`, `write_cycle_id`, `state`, `cycle_observed_at`,
  `cycle_outcome`, `intent_kind`, `intent_digest`, `result_digest`, `block_reason`,
  `unknown_reason`, `dispatched_at`, `finalized_at`, `expires_at`, `created_at`, `updated_at`
FROM `task_source_write_leases`;
DROP TABLE `task_source_write_leases`;
ALTER TABLE `__new_task_source_write_leases` RENAME TO `task_source_write_leases`;
CREATE UNIQUE INDEX IF NOT EXISTS `idx_task_source_write_leases_token` ON `task_source_write_leases` (`token`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_task_source_write_leases_task_operation_active` ON `task_source_write_leases` (`connector_instance_id`,`task_id`,`operation`) WHERE `state` IN ('claimed', 'authorized', 'dispatched', 'unknown');
CREATE INDEX IF NOT EXISTS `idx_task_source_write_leases_connector_expiry` ON `task_source_write_leases` (`connector_instance_id`,`state`,`expires_at`);
CREATE INDEX IF NOT EXISTS `idx_task_source_write_leases_operator` ON `task_source_write_leases` (`connector_instance_id`,`created_at`);
CREATE INDEX IF NOT EXISTS `idx_task_source_write_leases_cycle` ON `task_source_write_leases` (`write_cycle_id`);--> statement-breakpoint
DROP TABLE IF EXISTS `__new_github_identity_write_cycles`;
CREATE TABLE `__new_github_identity_write_cycles` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `job_id` text,
  `mode_revision` integer NOT NULL,
  `pending_candidate_count` integer DEFAULT 0 NOT NULL,
  `observed_route_count` integer DEFAULT 0 NOT NULL,
  `applied_count` integer DEFAULT 0 NOT NULL,
  `blocked_count` integer DEFAULT 0 NOT NULL,
  `failed_count` integer DEFAULT 0 NOT NULL,
  `unknown_count` integer DEFAULT 0 NOT NULL,
  `state` text DEFAULT 'running' NOT NULL,
  `reconciliation_state` text DEFAULT 'unresolved' NOT NULL,
  `reconciliation_reason` text,
  `reconciliation_code` text,
  `reconciled_at` text,
  `reconciled_by` text,
  `reconciliation_idempotency_key` text,
  `started_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `github_identity_write_cycles_state_check` CHECK(`state` IN ('running', 'completed', 'interrupted')),
  CONSTRAINT `github_identity_write_cycles_count_check` CHECK(`pending_candidate_count` >= 0 AND `observed_route_count` >= 0 AND `applied_count` >= 0 AND `blocked_count` >= 0 AND `failed_count` >= 0 AND `unknown_count` >= 0)
);
INSERT INTO `__new_github_identity_write_cycles` (
  `id`, `connector_instance_id`, `job_id`, `mode_revision`, `pending_candidate_count`,
  `observed_route_count`, `applied_count`, `blocked_count`, `failed_count`, `unknown_count`,
  `state`, `reconciliation_state`, `reconciliation_reason`, `reconciliation_code`,
  `reconciled_at`, `reconciled_by`, `reconciliation_idempotency_key`, `started_at`, `completed_at`
)
SELECT
  `cycle`.`id`, `cycle`.`connector_instance_id`, `cycle`.`job_id`, `cycle`.`mode_revision`,
  `cycle`.`pending_candidate_count`, `cycle`.`observed_route_count`,
  (
    SELECT COUNT(*)
    FROM `task_source_write_leases` AS `lease`
    WHERE `lease`.`write_cycle_id` = `cycle`.`id`
      AND `lease`.`cycle_outcome` = 'succeeded'
  ),
  `cycle`.`blocked_count`, `cycle`.`failed_count`, `cycle`.`unknown_count`,
  `cycle`.`state`, `cycle`.`reconciliation_state`, `cycle`.`reconciliation_reason`,
  `cycle`.`reconciliation_code`, `cycle`.`reconciled_at`, `cycle`.`reconciled_by`,
  `cycle`.`reconciliation_idempotency_key`, `cycle`.`started_at`, `cycle`.`completed_at`
FROM `github_identity_write_cycles` AS `cycle`;
DROP TABLE `github_identity_write_cycles`;
ALTER TABLE `__new_github_identity_write_cycles` RENAME TO `github_identity_write_cycles`;
CREATE INDEX IF NOT EXISTS `idx_github_identity_write_cycles_connector` ON `github_identity_write_cycles` (`connector_instance_id`,`completed_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_github_identity_write_cycles_active` ON `github_identity_write_cycles` (`connector_instance_id`) WHERE `state` = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS `idx_github_identity_write_cycles_reconciliation_key` ON `github_identity_write_cycles` (`connector_instance_id`,`reconciliation_idempotency_key`) WHERE `reconciliation_idempotency_key` IS NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_github_identity_exception_events`;
CREATE TABLE `__new_github_identity_exception_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `connector_instance_id` text NOT NULL,
  `binding_type` text NOT NULL,
  `local_id` text NOT NULL,
  `category` text NOT NULL,
  `action` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `actor` text NOT NULL,
  `reason` text NOT NULL,
  `proof_type` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `github_identity_exception_events_type_check` CHECK(`binding_type` IN ('task', 'source_list')),
  CONSTRAINT `github_identity_exception_events_category_check` CHECK(`category` IN ('terminal_inaccessible')),
  CONSTRAINT `github_identity_exception_events_action_check` CHECK(`action` IN ('accept', 'revoke')),
  CONSTRAINT `github_identity_exception_events_proof_check` CHECK(`proof_type` IS NULL OR `proof_type` IN ('stage1_inaccessible', 'post_backfill_authoritative_deletion', 'legacy_comparison_evidence')),
  CONSTRAINT `github_identity_exception_events_proof_state_check` CHECK((`action` = 'revoke' AND `proof_type` IS NULL) OR (`action` = 'accept' AND `proof_type` IS NOT NULL))
);
INSERT INTO `__new_github_identity_exception_events` (
  `id`, `connector_instance_id`, `binding_type`, `local_id`, `category`, `action`,
  `idempotency_key`, `actor`, `reason`, `proof_type`, `created_at`
)
SELECT
  `id`, `connector_instance_id`, `binding_type`, `local_id`, `category`, `action`,
  `idempotency_key`, `actor`, `reason`,
  CASE
    WHEN `action` <> 'accept' THEN NULL
    WHEN `proof_type` IN ('stage1_inaccessible', 'post_backfill_authoritative_deletion', 'legacy_comparison_evidence')
      THEN `proof_type`
    -- Accepts proven only by a comparison run keep an honest archival label
    -- rather than being relabelled as a proof they never had.
    ELSE 'legacy_comparison_evidence'
  END,
  `created_at`
FROM `github_identity_exception_events`;
DROP TABLE `github_identity_exception_events`;
ALTER TABLE `__new_github_identity_exception_events` RENAME TO `github_identity_exception_events`;
CREATE UNIQUE INDEX IF NOT EXISTS `idx_github_identity_exception_events_idempotency` ON `github_identity_exception_events` (`connector_instance_id`,`idempotency_key`);
CREATE INDEX IF NOT EXISTS `idx_github_identity_exception_events_local` ON `github_identity_exception_events` (`connector_instance_id`,`binding_type`,`local_id`,`id`);--> statement-breakpoint
DROP TABLE IF EXISTS `github_identity_sub_issue_population_members`;--> statement-breakpoint
DROP TABLE IF EXISTS `github_identity_comparison_records`;--> statement-breakpoint
DROP TABLE IF EXISTS `github_identity_comparison_runs`;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_github_identity_controls`;
CREATE TABLE `__new_github_identity_controls` (
  `connector_instance_id` text PRIMARY KEY NOT NULL,
  `mode_revision` integer DEFAULT 1 NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `github_identity_controls_revision_check` CHECK(`mode_revision` >= 1)
);
INSERT INTO `__new_github_identity_controls` (`connector_instance_id`, `mode_revision`, `updated_at`)
SELECT `connector_instance_id`, MAX(`mode_revision`, 1), `updated_at`
FROM `github_identity_controls`;
DROP TABLE `github_identity_controls`;
ALTER TABLE `__new_github_identity_controls` RENAME TO `github_identity_controls`;--> statement-breakpoint
INSERT INTO `github_identity_controls` (`connector_instance_id`, `mode_revision`, `updated_at`)
SELECT `id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `connector_configs`
WHERE `type` = 'github-issues'
  AND `id` NOT IN (SELECT `connector_instance_id` FROM `github_identity_controls`);--> statement-breakpoint
DROP TABLE IF EXISTS `__new_github_identity_migrations`;
CREATE TABLE `__new_github_identity_migrations` (
  `connector_instance_id` text PRIMARY KEY NOT NULL,
  `phase` text DEFAULT 'disabled' NOT NULL,
  `task_cursor` text,
  `source_list_cursor` text,
  `batch_size` integer DEFAULT 100 NOT NULL,
  `started_at` text,
  `updated_at` text NOT NULL,
  `completed_at` text,
  `last_error` text,
  `counters` text DEFAULT '{"eligible":0,"bound":0,"legacyOnly":0,"inaccessible":0,"pending":0,"collisions":0,"batches":0,"retries":0,"rateLimitPauses":0}' NOT NULL,
  FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_configs`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `github_identity_migrations_phase_check` CHECK(`phase` IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'paused', 'complete')),
  CONSTRAINT `github_identity_migrations_batch_size_check` CHECK(`batch_size` BETWEEN 1 AND 500)
);
INSERT INTO `__new_github_identity_migrations` (
  `connector_instance_id`, `phase`, `task_cursor`, `source_list_cursor`, `batch_size`,
  `started_at`, `updated_at`, `completed_at`, `last_error`, `counters`
)
SELECT
  `connector_instance_id`,
  CASE `phase`
    WHEN 'comparing' THEN 'complete'
    WHEN 'stable_primary' THEN 'complete'
    WHEN 'compatibility' THEN 'complete'
    WHEN 'rollback_legacy' THEN 'complete'
    ELSE `phase`
  END,
  `task_cursor`, `source_list_cursor`, `batch_size`, `started_at`, `updated_at`,
  `completed_at`, `last_error`, `counters`
FROM `github_identity_migrations`;
DROP TABLE `github_identity_migrations`;
ALTER TABLE `__new_github_identity_migrations` RENAME TO `github_identity_migrations`;
CREATE INDEX IF NOT EXISTS `idx_github_identity_migrations_phase` ON `github_identity_migrations` (`phase`,`updated_at`);--> statement-breakpoint
UPDATE `sync_jobs` SET `identity_mode` = 'stable' WHERE `identity_mode` IS NOT NULL AND `identity_mode` <> 'stable';--> statement-breakpoint
DROP TABLE IF EXISTS `__new_dependency_reconciliation_snapshots`;
CREATE TABLE `__new_dependency_reconciliation_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `connector_instance_id` text NOT NULL,
  `status` text NOT NULL,
  `phase` text DEFAULT 'reconciling' NOT NULL,
  `read_mode` text,
  `cursor` integer DEFAULT 0 NOT NULL,
  `total` integer NOT NULL,
  `batch_size` integer NOT NULL,
  `failure_count` integer DEFAULT 0 NOT NULL,
  `imported_count` integer DEFAULT 0 NOT NULL,
  `removed_count` integer DEFAULT 0 NOT NULL,
  `started_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `completed_at` text,
  `collection_completed_at` text,
  `collection_page_count` integer DEFAULT 0 NOT NULL,
  `overflow_fetch_count` integer DEFAULT 0 NOT NULL,
  `identity_mode` text DEFAULT 'stable' NOT NULL,
  `identity_mode_revision` integer DEFAULT 0 NOT NULL,
  `identity_evidence_source` text DEFAULT 'legacy-unavailable' NOT NULL,
  `identity_evidence_eligible` integer DEFAULT false NOT NULL,
  `identity_evidence_failure_reason` text,
  `failed_at` text,
  `next_attempt_at` text,
  `failure_reason` text,
  `last_resume_attempt_at` text,
  `last_resume_outcome` text,
  `last_resume_reason` text
);
INSERT INTO `__new_dependency_reconciliation_snapshots` (
  `id`, `connector_instance_id`, `status`, `phase`, `read_mode`, `cursor`, `total`,
  `batch_size`, `failure_count`, `imported_count`, `removed_count`, `started_at`,
  `updated_at`, `completed_at`, `collection_completed_at`, `collection_page_count`,
  `overflow_fetch_count`, `identity_mode`, `identity_mode_revision`,
  `identity_evidence_source`, `identity_evidence_eligible`,
  `identity_evidence_failure_reason`, `failed_at`, `next_attempt_at`, `failure_reason`,
  `last_resume_attempt_at`, `last_resume_outcome`, `last_resume_reason`
)
SELECT
  `id`, `connector_instance_id`, `status`, `phase`, `read_mode`, `cursor`, `total`,
  `batch_size`, `failure_count`, `imported_count`, `removed_count`, `started_at`,
  `updated_at`, `completed_at`, `collection_completed_at`, `collection_page_count`,
  `overflow_fetch_count`, 'stable', `identity_mode_revision`,
  `identity_evidence_source`, `identity_evidence_eligible`,
  `identity_evidence_failure_reason`, `failed_at`, `next_attempt_at`, `failure_reason`,
  `last_resume_attempt_at`, `last_resume_outcome`, `last_resume_reason`
FROM `dependency_reconciliation_snapshots`;
DROP TABLE `dependency_reconciliation_snapshots`;
ALTER TABLE `__new_dependency_reconciliation_snapshots` RENAME TO `dependency_reconciliation_snapshots`;
CREATE UNIQUE INDEX IF NOT EXISTS `idx_dependency_snapshot_active_connector` ON `dependency_reconciliation_snapshots` (`connector_instance_id`) WHERE `status` IN ('running', 'failed');
CREATE INDEX IF NOT EXISTS `idx_dependency_snapshot_connector_updated` ON `dependency_reconciliation_snapshots` (`connector_instance_id`,`updated_at`);
CREATE INDEX IF NOT EXISTS `idx_dependency_snapshot_connector_status_completed` ON `dependency_reconciliation_snapshots` (`connector_instance_id`,`status`,`completed_at`);
CREATE INDEX IF NOT EXISTS `idx_dependency_snapshot_resume` ON `dependency_reconciliation_snapshots` (`status`,`next_attempt_at`);--> statement-breakpoint
PRAGMA foreign_keys = ON;
